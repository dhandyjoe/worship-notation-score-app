// cloudUI.js — DOM wiring for the cloud login modal + My Songs gallery.
//
// Kept separate from events.js so the cloud feature is self-contained. It talks
// to Firebase only through cloud.js, and to the editor only through injected
// callbacks (getProject / applyProject / getCloudId / setCloudId). This keeps
// the module graph acyclic: cloudUI → { cloud, dom }, and events.js → cloudUI.
import { $, toast } from "./dom.js?v=20260810-devicehint-modal";
import {
   isConfigured,
   onAuth,
   authReady,
   getCurrentUser,
   signInWithGoogle,
   signInWithEmail,
   signUpWithEmail,
   signOutUser,
   friendlyAuthError,
   saveSong,
   listSongs,
   loadSong,
   deleteSong,
   duplicateSong,
} from "./cloud.js?v=20260810-devicehint-modal";

// Injected editor bridge (set in init).
let bridge = {
   getProject: () => ({}),
   applyProject: () => {},
   getCloudId: () => null,
   setCloudId: () => {},
   openPdfOptions: () => {},
};

let cachedSongs = []; // last-fetched list (for client-side search filtering)

// Test mode (regression harness appends ?test=...): skip the auth gate entirely
// so the editor suite runs without a real Firebase sign-in.
const TEST_MODE = new URLSearchParams(location.search).has("test");
// True once the app content has been revealed at least once (post initial route).
let hasRouted = false;
// Identity we last routed for (uid or null) — prevents redundant re-routing when
// onAuthStateChanged re-emits the same user right after the initial route.
let routedUid = undefined;

// ---- Small DOM helpers ----
function openModal(el) {
   if (!el) return;
   el.hidden = false;
   // Force a reflow so the hidden→visible start state (opacity:0) is committed
   // before we add .is-open to fade in. A short timeout is a robust fallback to
   // rAF, which can be throttled in background tabs (matches device-hint).
   void el.offsetHeight;
   setTimeout(() => el.classList.add("is-open"), 20);
}
function closeModal(el) {
   if (!el) return;
   el.classList.remove("is-open");
   setTimeout(() => {
      el.hidden = true;
   }, 300);
}

// Themed replacement for window.confirm(). Resolves to true when the user
// confirms and false when they cancel / dismiss (backdrop, Cancel button or
// Escape). One dialog element is reused; its copy, icon and confirm-button
// accent are set per call. Only one confirm can be open at a time — opening a
// second resolves the first as cancelled.
let activeConfirmCleanup = null;
function openConfirmDialog({
   title = "Are you sure?",
   message = "",
   confirmLabel = "Confirm",
   cancelLabel = "Cancel",
   icon = "?",
   danger = false,
} = {}) {
   const dialog = $("#confirmDialog");
   // No markup (e.g. old tests) → fall back to the native confirm.
   if (!dialog) return Promise.resolve(window.confirm(message || title));
   // Tear down any dialog already on screen (resolves it as cancelled).
   if (activeConfirmCleanup) activeConfirmCleanup(false);

   const confirmBtn = $("#confirmDialogConfirm");
   const cancelBtn = $("#confirmDialogCancel");
   $("#confirmDialogTitle").textContent = title;
   $("#confirmDialogDesc").textContent = message;
   $("#confirmDialogIcon").textContent = icon;
   confirmBtn.textContent = confirmLabel;
   cancelBtn.textContent = cancelLabel;
   confirmBtn.classList.toggle("is-danger", !!danger);

   const previouslyFocused = document.activeElement;

   return new Promise((resolve) => {
      const finish = (result) => {
         if (activeConfirmCleanup !== cleanup) return;
         cleanup(result);
      };
      const onConfirm = () => finish(true);
      const onDismiss = () => finish(false);
      const onKey = (e) => {
         if (e.key === "Escape") finish(false);
      };
      const onBackdrop = (e) => {
         if (e.target.closest("[data-confirm-dismiss]")) finish(false);
      };

      function cleanup(result) {
         activeConfirmCleanup = null;
         confirmBtn.removeEventListener("click", onConfirm);
         cancelBtn.removeEventListener("click", onDismiss);
         dialog.removeEventListener("click", onBackdrop);
         document.removeEventListener("keydown", onKey);
         closeModal(dialog);
         if (previouslyFocused && typeof previouslyFocused.focus === "function") {
            previouslyFocused.focus();
         }
         resolve(result);
      }

      activeConfirmCleanup = cleanup;
      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onDismiss);
      dialog.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
      openModal(dialog);
      // Focus the confirm button so the dialog is keyboard-operable at once.
      setTimeout(() => confirmBtn.focus(), 40);
   });
}

// ======================================================================
// Hash routing
// ----------------------------------------------------------------------
// My Songs is the home screen and the editor is a sub-page, so each gets a
// real URL: #/songs (home) and #/song/:cloudId (editor, or #/song/new for an
// unsaved draft). That makes the browser Back button and page reloads behave
// the way the visual hierarchy promises. All screen changes go through
// navigate() → applyRoute(), so the URL is always the single source of truth.
// ======================================================================
const HOME_ROUTE = "#/songs";
// Guards the hashchange handler while navigate() is writing the hash itself.
let suppressHashHandling = false;

function editorRoute() {
   const id = bridge.getCloudId();
   return id ? `#/song/${encodeURIComponent(id)}` : "#/song/new";
}

function parseRoute(hash) {
   const raw = String(hash || "").replace(/^#/, "");
   const song = raw.match(/^\/song\/(.+)$/);
   if (song) return { name: "editor", id: song[1] === "new" ? null : decodeURIComponent(song[1]) };
   return { name: "home" };
}

// Change screens by changing the URL. replace: true rewrites the current entry
// instead of pushing a new one (used to normalise the initial/blank hash).
function navigate(hash, { replace = false } = {}) {
   if (location.hash === hash) {
      applyRoute();
      return;
   }
   suppressHashHandling = true;
   if (replace) history.replaceState(null, "", hash);
   else location.hash = hash;
   suppressHashHandling = false;
   applyRoute();
}

// Render whatever screen the current hash asks for. Home shows the gallery;
// the editor hides it. Opening a song by id is handled by openSongInEditor,
// which loads the document and then navigates here.
function applyRoute() {
   const route = parseRoute(location.hash);
   const modal = $("#mySongsModal");
   if (route.name === "home") {
      showGalleryScreen();
   } else {
      closeModal(modal);
   }
   // Home covers the whole viewport, so lock the page behind it — otherwise the
   // editor underneath still shows its own scrollbar on the right.
   document.documentElement.dataset.screen = route.name;
   // The contextual "Back to editor" button only makes sense when a document is
   // actually open, otherwise home would offer a dead end.
   const resume = $("#backToEditorBtn");
   if (resume) resume.hidden = route.name !== "home" || !bridge.getCloudId();
}
const escapeHtml = (s) =>
   String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
   );

// ======================================================================
// Auth state → topbar reflection
// ======================================================================
function reflectAuth(user) {
   const btn = $("#accountBtn");
   const avatar = $("#accountAvatar");
   const label = $("#accountLabel");
   if (btn) {
      if (user) {
         btn.classList.add("is-authed");
         const initial = (user.displayName || user.email || "?").trim().charAt(0).toUpperCase();
         if (user.photoURL) {
            avatar.innerHTML = `<img src="${escapeHtml(user.photoURL)}" alt="" referrerpolicy="no-referrer" />`;
         } else {
            avatar.textContent = initial || "●";
         }
         label.textContent = user.displayName || user.email || "Account";
         btn.title = "Your account";
      } else {
         btn.classList.remove("is-authed");
         avatar.textContent = "◔";
         label.textContent = "Sign in";
         btn.title = "Sign in to sync your songs";
      }
      // Mirror the identity into the profile card.
      const pAvatar = $("#accountPopoverAvatar");
      const pName = $("#accountPopoverName");
      const pEmail = $("#accountPopoverEmail");
      if (pAvatar) pAvatar.innerHTML = avatar.innerHTML;
      if (pName) pName.textContent = user ? user.displayName || user.email || "Signed in" : "Not signed in";
      if (pEmail) {
         const email = user ? user.email || "" : "";
         pEmail.textContent = email;
         pEmail.hidden = !email;
      }
      const signOut = $("#signOutBtn");
      if (signOut) signOut.hidden = !user;
   }

   // Route on auth changes that happen AFTER the initial load routing (e.g. the
   // user signs in from the login page, or signs out from the topbar). The very
   // first route is handled by routeOnLoad() via authReady().
   if (TEST_MODE || !hasRouted) return;
   const uid = user ? user.uid : null;
   if (uid === routedUid) return; // no identity change → nothing to route
   routedUid = uid;
   if (user) {
      hideLoginPage();
      openGallery();
   } else {
      showLoginPage();
   }
}

// Decide the initial screen once Firebase has restored (or failed to restore)
// the persisted session: signed-in → the route in the URL (defaulting to home);
// otherwise → login page.
async function routeOnLoad() {
   if (TEST_MODE) {
      document.documentElement.dataset.authGate = "app";
      hasRouted = true;
      return;
   }
   let user = null;
   try {
      user = await authReady();
   } catch {
      user = null;
   }
   hasRouted = true;
   routedUid = user ? user.uid : null;
   if (!user) {
      showLoginPage();
      return;
   }
   hideLoginPage();
   const route = parseRoute(location.hash);
   // A reload on #/song/:id should reopen that song, not silently drop to home.
   if (route.name === "editor" && route.id) {
      openSongInEditor(route.id);
      return;
   }
   // Blank/unknown hash (or #/song/new with nothing loaded) → normalise to home
   // without leaving a junk entry in the history stack.
   navigate(HOME_ROUTE, { replace: true });
}

// ======================================================================
// Login page (full-screen auth gate)
// ======================================================================
function showAuthError(message) {
   const box = $("#authError");
   if (!box) return;
   if (!message) {
      box.hidden = true;
      box.textContent = "";
      return;
   }
   box.textContent = message;
   box.hidden = false;
}

// Show the full-screen login page (used when signed out / after sign-out).
function showLoginPage() {
   const page = $("#loginPage");
   if (!page) return;
   showAuthError("");
   document.documentElement.dataset.authGate = "login";
   page.hidden = false;
   void page.offsetHeight;
   setTimeout(() => page.classList.add("is-open"), 20);
   setTimeout(() => $("#authEmail")?.focus(), 160);
}

// Hide the login page and reveal the app (used once authenticated).
function hideLoginPage() {
   const page = $("#loginPage");
   document.documentElement.dataset.authGate = "app";
   if (!page) return;
   page.classList.remove("is-open");
   setTimeout(() => {
      page.hidden = true;
   }, 320);
}

function initLogin() {
   const page = $("#loginPage");
   if (!page) return;

   $("#googleSignInBtn")?.addEventListener("click", async () => {
      try {
         showAuthError("");
         await signInWithGoogle();
         toast("Signed in");
      } catch (error) {
         showAuthError(friendlyAuthError(error));
      }
   });

   const emailFlow = async (fn, successMsg) => {
      const email = $("#authEmail")?.value.trim();
      const password = $("#authPassword")?.value;
      if (!email || !password) {
         showAuthError("Enter your email and password.");
         return;
      }
      try {
         showAuthError("");
         await fn(email, password);
         toast(successMsg);
      } catch (error) {
         showAuthError(friendlyAuthError(error));
      }
   };

   $("#emailAuthForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      emailFlow(signInWithEmail, "Signed in");
   });
   $("#emailSignUpBtn")?.addEventListener("click", () => emailFlow(signUpWithEmail, "Account created"));
}

// ======================================================================
// My Songs gallery — scrolling 2-row zigzag grid
// ======================================================================
// Cards flow into a two-row grid (column by column) that scrolls horizontally
// inside a bounded container. Columns alternate a small vertical offset for a
// zigzag wave. Cards near the left/right scroll edges are blurred; the ones in
// the clear middle are sharp. The grid is the scroll container, so it never
// pushes the shell (or header) wider than the viewport — fixing the drift bug.
let renderedCount = 0; // how many cards are currently in the DOM

function setGalleryState(state) {
   // state: "loading" | "empty" | "no-results" | "ready"
   $("#galleryLoading").hidden = state !== "loading";
   $("#galleryEmpty").hidden = state !== "empty";
   $("#galleryNoResults").hidden = state !== "no-results";
}

function cardMarkup(song) {
   const title = escapeHtml(song.title || "Untitled");
   const creator = escapeHtml(song.artist || "Unknown");
   const key = escapeHtml(song.key || "—");
   const meter = escapeHtml(song.meter || "—");
   const sectionCount = Array.isArray(song.sections) ? song.sections.length : 0;
   const updated = song.updatedAt ? new Date(song.updatedAt).toLocaleDateString() : "";
   return `
      <article class="song-card" role="listitem" tabindex="0" data-id="${escapeHtml(song.cloudId)}"
               aria-label="${title} by ${creator}">
         <h3 class="song-card-title">${title}</h3>
         <div class="song-card-creator">${creator}</div>
         <div class="song-card-detail">
            ${sectionCount} section${sectionCount === 1 ? "" : "s"}${updated ? ` · updated ${escapeHtml(updated)}` : ""}
         </div>
         <div class="song-card-dock">
            <div class="song-card-meta">
               <span class="song-card-chip"><small>Key</small> ${key}</span>
               <span class="song-card-chip"><small>Time</small> ${meter}</span>
            </div>
            <div class="song-card-actions">
               <button class="song-card-action is-edit" type="button" data-act="edit" data-label="Edit" title="Edit" aria-label="Edit ${title}">✎</button>
               <button class="song-card-action is-pdf" type="button" data-act="pdf" data-label="Export .pdf" title="Export .pdf" aria-label="Export ${title} as PDF">↗</button>
               <button class="song-card-action is-export" type="button" data-act="export" data-label="Export .file" title="Export .file" aria-label="Export ${title} as file">↓</button>
               <button class="song-card-action is-duplicate" type="button" data-act="duplicate" data-label="Duplicate" title="Duplicate" aria-label="Duplicate ${title}">⧉</button>
               <button class="song-card-action is-delete" type="button" data-act="delete" data-label="Delete" title="Delete" aria-label="Delete ${title}">🗑</button>
            </div>
         </div>
      </article>`;
}

// Keep the middle columns sharp and blur cards the further they sit from the
// horizontal center of the viewport. Cards within the clear middle band stay
// crisp; by roughly the 4th column out they are fully blurred. Called on
// render, on scroll, and on resize, so it tracks the cards as they move.
const CLEAR_BAND = 240; // px each side of center that stays fully sharp
const BLUR_SPAN = 320; // px beyond the clear band over which blur ramps to max
function updateEdgeBlur() {
   const track = $("#songCards");
   if (!track) return;
   const cards = track.querySelectorAll(".song-card");
   renderedCount = cards.length;
   if (!renderedCount) return;
   // Phones lay the gallery out as a natural vertical-scrolling grid (see the
   // <=680px CSS), where cards are NOT arranged around a horizontal center.
   // The edge-blur/dim logic below is meaningless there and would wrongly blur
   // and disable side cards, so reset every card to sharp + interactive and bail.
   if (window.matchMedia("(max-width: 680px)").matches) {
      cards.forEach((card) => {
         card.style.setProperty("--blur", "0px");
         card.style.setProperty("--scale", "1");
         card.style.opacity = "";
         card.classList.remove("is-dim");
         card.setAttribute("aria-hidden", "false");
         card.tabIndex = 0;
      });
      return;
   }
   const view = track.getBoundingClientRect();
   const mid = view.left + view.width / 2;
   cards.forEach((card) => {
      const r = card.getBoundingClientRect();
      const center = r.left + r.width / 2;
      const dist = Math.abs(center - mid);
      const past = Math.max(0, dist - CLEAR_BAND); // distance beyond the sharp band
      const t = Math.min(1, past / BLUR_SPAN); // 0 = sharp, 1 = fully blurred
      card.style.setProperty("--blur", t <= 0 ? "0px" : `${(t * 4).toFixed(2)}px`);
      card.style.setProperty("--scale", `${(1 - t * 0.08).toFixed(3)}`);
      card.style.opacity = `${(1 - t * 0.45).toFixed(3)}`;
      // Only sharp (centered) cards are interactive. Blurred cards can't be
      // clicked, hovered, or focused — they must be scrolled into the middle
      // first. A small epsilon keeps a barely-blurred card still tappable.
      const active = t <= 0.04;
      card.classList.toggle("is-dim", !active);
      card.setAttribute("aria-hidden", active ? "false" : "true");
      card.tabIndex = active ? 0 : -1;
   });
}

// Scroll the grid by roughly one column-pair in the given direction. Uses a
// timer-based tween (native "smooth" behavior and rAF are unreliable in
// headless test browsers) and refreshes edge blur + nudge visibility as it
// moves.
let scrollTimer = 0;
function nudgeCarousel(dir) {
   const track = $("#songCards");
   if (!track) return;
   const card = track.querySelector(".song-card");
   const cardW = card ? card.offsetWidth : 210;
   const step = (cardW + 28) * 1.4; // ~one column plus gap
   const max = track.scrollWidth - track.clientWidth;
   const from = track.scrollLeft;
   const to = Math.max(0, Math.min(max, from + dir * step));
   if (scrollTimer) clearInterval(scrollTimer);
   const start = Date.now();
   const dur = 300;
   const easeOut = (t) => 1 - Math.pow(1 - t, 3);
   scrollTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / dur);
      track.scrollLeft = from + (to - from) * easeOut(t);
      updateEdgeBlur();
      updateNudgeVisibility();
      if (t >= 1) {
         clearInterval(scrollTimer);
         scrollTimer = 0;
      }
   }, 16);
}

function renderCards(songs) {
   const track = $("#songCards");
   if (!track) return;
   track.innerHTML = songs.map(cardMarkup).join("");
   track.scrollLeft = 0;
   renderedCount = track.querySelectorAll(".song-card").length;
   updateEdgeBlur();
   updateNudgeVisibility();
}

// Phone-only: clear the tapped-card action overlay. Safe to call on any layout
// (it's a no-op when no card is selected).
function clearCardSelection() {
   document.querySelectorAll(".song-card.is-selected").forEach((c) => c.classList.remove("is-selected"));
}

function applyFilter() {
   const term = ($("#songSearch")?.value || "").trim().toLowerCase();
   const filtered = term ? cachedSongs.filter((s) => (s.title || "").toLowerCase().includes(term)) : cachedSongs;
   if (!cachedSongs.length) {
      setGalleryState("empty");
      renderCards([]);
      return;
   }
   if (!filtered.length) {
      setGalleryState("no-results");
      renderCards([]);
      return;
   }
   setGalleryState("ready");
   renderCards(filtered);
}

async function refreshSongs() {
   setGalleryState("loading");
   try {
      cachedSongs = await listSongs();
      // The hero copy is static; the live library count goes in its own slot so
      // the headline never gets overwritten.
      const count = $("#libraryCount");
      if (count) {
         count.textContent = cachedSongs.length
            ? `${cachedSongs.length} song${cachedSongs.length === 1 ? "" : "s"} in your library`
            : "Your library is empty";
      }
      applyFilter();
   } catch (error) {
      setGalleryState("empty");
      toast("Could not load your songs");
   }
}

// Render the home screen (gallery). Called by the router; use navigate(HOME_ROUTE)
// from UI handlers so the URL stays in sync.
async function showGalleryScreen() {
   // Gallery requires auth.
   if (!getCurrentUser() && !TEST_MODE) {
      showLoginPage();
      toast("Sign in to view your library");
      return;
   }
   openModal($("#mySongsModal"));
   const search = $("#songSearch");
   if (search) search.value = "";
   await refreshSongs();
   // The screen fades in from hidden; card widths read as 0 until visible, so
   // recompute edge blur + nudge visibility once real dimensions are committed.
   setTimeout(() => {
      updateEdgeBlur();
      updateNudgeVisibility();
   }, 60);
}

function openGallery() {
   navigate(HOME_ROUTE);
}

async function openSongInEditor(cloudId) {
   try {
      const song = await loadSong(cloudId);
      bridge.applyProject(song);
      bridge.setCloudId(cloudId);
      navigate(`#/song/${encodeURIComponent(cloudId)}`);
      toast(`Opened "${song.title || "Untitled"}"`);
   } catch (error) {
      toast("Could not open that song");
   }
}

async function handleCardAction(act, cloudId, card) {
   const song = cachedSongs.find((s) => s.cloudId === cloudId);
   const title = song?.title || "this song";
   if (act === "edit") {
      // Explicit "open in editor" — the phone tap-reveal's primary action.
      openSongInEditor(cloudId);
      return;
   }
   if (act === "pdf") {
      // Load the song into the editor first, then hand over to the editor's PDF
      // options dialog — its live preview renders the real #previewCard, so the
      // user sees THIS song's score (not whatever was open before).
      try {
         const full = await loadSong(cloudId);
         bridge.applyProject(full);
         bridge.setCloudId(cloudId);
         navigate(`#/song/${encodeURIComponent(cloudId)}`);
         // Wait for the gallery to finish closing so the dialog can adopt the
         // preview card once the editor layout is settled.
         setTimeout(() => bridge.openPdfOptions(), 340);
      } catch (error) {
         toast("Could not open that song");
      }
      return;
   }
   if (act === "delete") {
      if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
      try {
         await deleteSong(cloudId);
         if (bridge.getCloudId() === cloudId) bridge.setCloudId(null);
         toast("Song deleted");
         await refreshSongs();
      } catch (error) {
         toast("Could not delete that song");
      }
   } else if (act === "duplicate") {
      try {
         await duplicateSong(cloudId);
         toast("Song duplicated");
         await refreshSongs();
      } catch (error) {
         toast("Could not duplicate that song");
      }
   } else if (act === "export") {
      try {
         const song = await loadSong(cloudId);
         downloadSongFile(song);
         toast(`Exported "${song.title || "Untitled"}"`);
      } catch (error) {
         toast("Could not export that song");
      }
   }
}

// Download a song project as a .chordsheet.json file (mirrors the editor's
// export, but self-contained so the gallery doesn't depend on events.js).
function downloadSongFile(song) {
   const project = { ...song };
   delete project.cloudId;
   const base =
      (song.title || "song")
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, "-")
         .replace(/^-+|-+$/g, "") || "song";
   const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
   const url = URL.createObjectURL(blob);
   const link = document.createElement("a");
   link.href = url;
   link.download = `${base}.chordsheet.json`;
   document.body.append(link);
   link.click();
   link.remove();
   URL.revokeObjectURL(url);
}

function updateNudgeVisibility() {
   const prev = $("#galleryPrev");
   const next = $("#galleryNext");
   const track = $("#songCards");
   if (!prev || !next || !track) return;
   const overflow = track.scrollWidth - track.clientWidth;
   const many = overflow > 4; // only show nudges when there's something to scroll to
   const atStart = track.scrollLeft <= 2;
   const atEnd = track.scrollLeft >= overflow - 2;
   prev.hidden = !many || atStart;
   next.hidden = !many || atEnd;
}

function initGallery() {
   const modal = $("#mySongsModal");
   if (!modal) return;
   const track = $("#songCards");

   // Home is a page, not a dismissible dialog: no close button, and clicking the
   // backdrop does nothing. The only way "out" is opening a song (or the
   // contextual Back to editor button when a document is already open).
   $("#backToEditorBtn")?.addEventListener("click", () => navigate(editorRoute()));

   $("#songSearch")?.addEventListener("input", applyFilter);

   // Card interactions (delegated). Clicking a card opens it; the action buttons
   // (export / duplicate / delete) act on that card without opening it.
   track?.addEventListener("click", (e) => {
      const actionBtn = e.target.closest(".song-card-action");
      const card = e.target.closest(".song-card");
      if (!card) return;
      if (card.classList.contains("is-dim")) return; // blurred cards aren't interactive
      if (actionBtn) {
         e.stopPropagation();
         handleCardAction(actionBtn.dataset.act, card.dataset.id, card);
         return;
      }
      // Phones: a tap doesn't open the song directly — it reveals the card's
      // action overlay (Edit / Export / Duplicate / Delete) floated over a
      // blurred card. Tapping the same card again (or another card) toggles it.
      // Opening is then an explicit choice via the Edit action.
      if (window.matchMedia("(max-width: 680px)").matches) {
         const wasSelected = card.classList.contains("is-selected");
         clearCardSelection();
         if (!wasSelected) card.classList.add("is-selected");
         return;
      }
      openSongInEditor(card.dataset.id);
   });
   // Phones: tapping anywhere off a card dismisses the open action overlay.
   modal.addEventListener("click", (e) => {
      if (!window.matchMedia("(max-width: 680px)").matches) return;
      if (e.target.closest(".song-card")) return;
      clearCardSelection();
   });
   // Keyboard: arrows scroll the grid; Enter/Space opens the focused card.
   track?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") {
         e.preventDefault();
         nudgeCarousel(1);
      } else if (e.key === "ArrowLeft") {
         e.preventDefault();
         nudgeCarousel(-1);
      } else if (e.key === "Enter" || e.key === " ") {
         const card = e.target.closest(".song-card");
         if (card) {
            e.preventDefault();
            openSongInEditor(card.dataset.id);
         }
      }
   });

   // Nudge buttons (desktop): scroll the grid by ~one column.
   $("#galleryPrev")?.addEventListener("click", () => nudgeCarousel(-1));
   $("#galleryNext")?.addEventListener("click", () => nudgeCarousel(1));

   // As the grid scrolls (buttons, wheel, or touch swipe), refresh which cards
   // are blurred near the edges and whether the nudge buttons apply.
   let scrollRaf = 0;
   track?.addEventListener(
      "scroll",
      () => {
         if (scrollRaf) return;
         scrollRaf = requestAnimationFrame(() => {
            scrollRaf = 0;
            updateEdgeBlur();
            updateNudgeVisibility();
         });
      },
      { passive: true },
   );

   window.addEventListener(
      "resize",
      () => {
         updateEdgeBlur();
         updateNudgeVisibility();
      },
      { passive: true },
   );

   // New song: reset to a blank project (clears cloud link so Save creates new).
   $("#newSongBtn")?.addEventListener("click", () => {
      bridge.applyProject({
         format: "chord-sheet",
         version: 2,
         title: "New Song",
         artist: "Artist / Composer",
         key: "C",
         meter: "4/4",
         sections: [{ name: "Intro", bars: [] }],
         slashChords: [],
      });
      bridge.setCloudId(null);
      navigate("#/song/new");
      toast("Started a new song");
   });

   // Upload a .json straight into the editor (does not auto-save to cloud).
   $("#galleryUploadInput")?.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
         const data = JSON.parse(await file.text());
         bridge.applyProject(data);
         bridge.setCloudId(null);
         closeModal(modal);
         toast("File loaded — click Save to Cloud to keep it");
      } catch (error) {
         toast("Invalid file or not a WorshipNotationScore project");
      } finally {
         e.target.value = "";
      }
   });
}

// ======================================================================
// Save to Cloud (topbar)
// ======================================================================
async function saveToCloud() {
   if (!isConfigured()) {
      toast("Cloud is not configured yet");
      return;
   }
   if (!getCurrentUser()) {
      showLoginPage();
      toast("Sign in to save to the cloud");
      return;
   }
   try {
      const project = bridge.getProject();
      project.cloudId = bridge.getCloudId() || undefined;
      const id = await saveSong(project);
      bridge.setCloudId(id);
      toast("Saved to cloud");
   } catch (error) {
      toast("Could not save to cloud");
   }
}

// ======================================================================
// Account menu (profile card with sign out; login prompt when signed out)
// ======================================================================
function closeAccountMenu() {
   const pop = $("#accountPopover");
   const btn = $("#accountBtn");
   if (!pop || pop.hidden) return;
   pop.classList.remove("is-open");
   btn?.setAttribute("aria-expanded", "false");
   setTimeout(() => {
      pop.hidden = true;
   }, 160);
}

function initAccountButton() {
   const btn = $("#accountBtn");
   const pop = $("#accountPopover");

   btn?.addEventListener("click", (e) => {
      // Signed out: the button is a straight call to action, not a menu.
      if (!getCurrentUser()) {
         showLoginPage();
         return;
      }
      if (!pop) return;
      e.stopPropagation();
      const isOpen = !pop.hidden;
      if (isOpen) {
         closeAccountMenu();
         return;
      }
      pop.hidden = false;
      void pop.offsetHeight; // commit the closed start state before animating
      pop.classList.add("is-open");
      btn.setAttribute("aria-expanded", "true");
   });

   // Dismiss on outside click and on Escape (standard menu behaviour).
   document.addEventListener("click", (e) => {
      if (!pop || pop.hidden) return;
      if (e.target.closest(".account-menu")) return;
      closeAccountMenu();
   });
   document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pop && !pop.hidden) {
         closeAccountMenu();
         btn?.focus();
      }
   });
   // The theme switch lives inside the card; keep the card open after toggling
   // so the user can see the result (events.js handles the actual theming).
   $("#themeToggle")?.addEventListener("click", (e) => e.stopPropagation());

   $("#signOutBtn")?.addEventListener("click", async () => {
      const confirmed = await openConfirmDialog({
         title: "Sign out?",
         message: "You'll need to sign in again to open your cloud library.",
         confirmLabel: "Sign out",
         cancelLabel: "Cancel",
         icon: "⇥",
         danger: true,
      });
      if (!confirmed) return;
      closeAccountMenu();
      try {
         await signOutUser();
         bridge.setCloudId(null);
         toast("Signed out");
      } catch (error) {
         toast("Could not sign out");
      }
   });
}

// ======================================================================
// Public init
// ======================================================================
export function initCloudUI(editorBridge) {
   bridge = { ...bridge, ...editorBridge };
   initLogin();
   initGallery();
   initAccountButton();
   // Test hook: the per-card Export .file path can't reach Firebase in headless
   // CI, so expose the pure download helper for the regression suite to exercise.
   if (TEST_MODE) window.__cloudDownloadSong = downloadSongFile;
   // Test hook: render N mock cards through the real grid path so the
   // regression suite exercises actual layout (not a DOM stub).
   if (TEST_MODE) {
      window.__cloudRenderMock = (n) => {
         const songs = Array.from({ length: n }, (_, i) => ({
            cloudId: `id${i}`,
            title: ["Amazing Grace", "How Great Is Our God", "10,000 Reasons", "Cornerstone", "Oceans"][i % 5],
            artist: `Artist ${i}`,
            key: "G",
            meter: "4/4",
            sections: [{ name: "Verse" }, { name: "Chorus" }, { name: "Bridge" }],
            updatedAt: Date.now(),
         }));
         renderCards(songs);
         return $("#songCards")?.querySelectorAll(".song-card").length || 0;
      };
      window.__cloudNudge = (dir) => nudgeCarousel(dir);
      window.__cloudScrollLeft = () => $("#songCards")?.scrollLeft || 0;
      window.__cloudUpdateBlur = () => {
         updateEdgeBlur();
         updateNudgeVisibility();
      };
   }
   $("#saveCloudBtn")?.addEventListener("click", saveToCloud);
   // Editor header: Back returns to home (the library).
   $("#backToSongsBtn")?.addEventListener("click", () => navigate(HOME_ROUTE));
   // Browser Back/Forward and manual hash edits re-render the matching screen.
   window.addEventListener("hashchange", () => {
      if (suppressHashHandling) return;
      applyRoute();
   });
   // Reflect auth state in the topbar (and route on sign-in/out) as it changes.
   onAuth(reflectAuth);
   // Decide the initial screen (login page vs My Songs) from the restored session.
   routeOnLoad();
}
