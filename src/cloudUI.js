// cloudUI.js — DOM wiring for the cloud login modal + My Songs gallery.
//
// Kept separate from events.js so the cloud feature is self-contained. It talks
// to Firebase only through cloud.js, and to the editor only through injected
// callbacks (getProject / applyProject / getCloudContext / setCloudContext). This
// keeps the module graph acyclic: cloudUI → { cloud, dom }, and events.js → cloudUI.
import { $, toast } from "./dom.js?v=20260927-dirty";
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
   listSongs,
   loadSong,
   loadSongMeta,
   loadVersion,
   listVersions,
   createSong,
   updateSongMeta,
   saveVersion,
   updateLatestVersion,
   deleteVersion,
   composeSong,
   deleteSong,
   duplicateSong,
} from "./cloud.js?v=20260927-dirty";

// Injected editor bridge (set in init).
import { buildShareLink, decodeShare, extractPayloadFromLink, IMPORT_ROUTE } from "./share.js?v=20260927-dirty";
import { parseYoutubeUrl, canonicalUrl, thumbnailUrl } from "./youtube.js?v=20260927-dirty";

let bridge = {
   getProject: () => ({}),
   applyProject: () => {},
   getCloudContext: () => null,
   setCloudContext: () => {},
   getPendingVersionDetails: () => null,
   setPendingVersionDetails: () => {},
   markDirty: () => {},
   openPdfOptions: () => {},
   hasUnsavedChanges: () => false,
   markSaved: () => {},
   isPlaying: () => false,
   stopPlayback: () => {},
};

// Distinguish Firestore permission errors (security rules) from real data
// errors, so the UI can point users at the rules instead of a generic failure.
function isFirestorePermissionsError(error) {
   const code = String(error?.code || "");
   const message = String(error?.message || error || "");
   return code === "permission-denied" || /Missing or insufficient permissions/i.test(message);
}

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

// Themed replacement for prompt(): opens the Attach Link dialog with a textarea
// and resolves to the pasted text (trimmed) or null if cancelled/empty. Kept
// separate from openConfirmDialog because it needs a free-text field.
let activeAttachCleanup = null;
function openAttachLinkDialog() {
   const dialog = $("#attachLinkDialog");
   // No markup (e.g. old tests) → degrade to the native prompt.
   if (!dialog) {
      const text = window.prompt("Paste a share link:");
      return Promise.resolve(text ? text.trim() : null);
   }
   if (activeAttachCleanup) activeAttachCleanup(null);

   const confirmBtn = $("#attachLinkConfirm");
   const cancelBtn = $("#attachLinkCancel");
   const input = $("#attachLinkInput");
   const previouslyFocused = document.activeElement;
   if (input) input.value = "";
   // Reset the header/labels in case showShareLinkFallback() repurposed them.
   const title = $("#attachLinkTitle");
   const desc = $("#attachLinkDesc");
   if (title) title.textContent = "Attach a shared song";
   if (desc)
      desc.textContent =
         "Paste a share link (or payload) from another user. The link fragment is decoded locally — nothing is sent to a server.";
   if (confirmBtn) confirmBtn.textContent = "Preview";

   return new Promise((resolve) => {
      const finish = (result) => {
         if (activeAttachCleanup !== cleanup) return;
         cleanup(result);
      };
      const onConfirm = () => {
         const val = input ? input.value.trim() : "";
         finish(val || null);
      };
      const onDismiss = () => finish(null);
      const onKey = (e) => {
         if (e.key === "Escape") finish(null);
      };
      const onBackdrop = (e) => {
         if (e.target.closest("[data-attach-dismiss]")) finish(null);
      };

      function cleanup(result) {
         activeAttachCleanup = null;
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

      activeAttachCleanup = cleanup;
      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onDismiss);
      dialog.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
      openModal(dialog);
      setTimeout(() => input && input.focus(), 40);
   });
}

// Three-choice "unsaved changes" dialog, shown when leaving the editor with
// edits that haven't reached the cloud. Resolves to one of:
//   "save"    → user wants to save then leave  (recommended primary action)
//   "discard" → leave without saving
//   "cancel"  → stay in the editor (backdrop / Cancel / Escape)
let activeUnsavedCleanup = null;
function openUnsavedChangesDialog() {
   const dialog = $("#unsavedDialog");
   // No markup (e.g. old tests) → degrade to the native confirm: OK = save.
   if (!dialog) {
      return Promise.resolve(
         window.confirm("You have unsaved changes. Save to cloud before leaving?") ? "save" : "discard",
      );
   }
   if (activeUnsavedCleanup) activeUnsavedCleanup("cancel");

   const saveBtn = $("#unsavedSaveBtn");
   const discardBtn = $("#unsavedDiscardBtn");
   const cancelBtn = $("#unsavedCancelBtn");
   const previouslyFocused = document.activeElement;

   return new Promise((resolve) => {
      const finish = (result) => {
         if (activeUnsavedCleanup !== cleanup) return;
         cleanup(result);
      };
      const onSave = () => finish("save");
      const onDiscard = () => finish("discard");
      const onCancel = () => finish("cancel");
      const onKey = (e) => {
         if (e.key === "Escape") finish("cancel");
      };
      const onBackdrop = (e) => {
         if (e.target.closest("[data-unsaved-dismiss]")) finish("cancel");
      };

      function cleanup(result) {
         activeUnsavedCleanup = null;
         saveBtn.removeEventListener("click", onSave);
         discardBtn.removeEventListener("click", onDiscard);
         cancelBtn.removeEventListener("click", onCancel);
         dialog.removeEventListener("click", onBackdrop);
         document.removeEventListener("keydown", onKey);
         closeModal(dialog);
         if (previouslyFocused && typeof previouslyFocused.focus === "function") {
            previouslyFocused.focus();
         }
         resolve(result);
      }

      activeUnsavedCleanup = cleanup;
      saveBtn.addEventListener("click", onSave);
      discardBtn.addEventListener("click", onDiscard);
      cancelBtn.addEventListener("click", onCancel);
      dialog.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
      openModal(dialog);
      // Focus the recommended (Save) action so Enter keeps the user's work.
      setTimeout(() => saveBtn.focus(), 40);
   });
}

// Guarded navigation back to My Songs. If the open document has unsaved cloud
// changes, ask first; otherwise leave immediately.
async function leaveEditorToHome() {
   // If audio is still playing, confirm before leaving so the user isn't
   // surprised the sound cuts out when they land on My Songs. Playback is
   // stopped automatically on confirmation.
   if (!(await confirmStopPlayback())) return;
   await guardUnsavedThen(() => navigate(HOME_ROUTE));
}

// If playback is currently active, ask the user before stopping it. Returns
// true when we may proceed (nothing was playing, or they chose "Stop & leave");
// returns false when they cancelled, in which case callers must stay put.
async function confirmStopPlayback() {
   if (!bridge.isPlaying || !bridge.isPlaying()) return true;
   const confirmed = await openConfirmDialog({
      title: "Playback in progress",
      message: "The score is still playing. Stop playback and return to My Songs?",
      confirmLabel: "Stop & leave",
      cancelLabel: "Stay",
      icon: "⏹",
   });
   if (!confirmed) return false;
   if (bridge.stopPlayback) bridge.stopPlayback();
   return true;
}

// Central unsaved-changes gate. Runs `proceed` immediately when there is nothing
// to lose; otherwise shows the 3-choice dialog and only proceeds on save-success
// or explicit discard. Returns true if `proceed` ran, false if the user cancelled.
// A single gate means EVERY way of leaving the editor (Back button, New song,
// opening another song, browser Back) prompts consistently — no silent data loss.
//
// #2 fix: the dialog is a *cloud* save prompt, so it only makes sense when cloud
// is usable. When cloud isn't configured or the user isn't signed in, there is
// no "Save to cloud" action to offer — we skip the dialog and proceed (the
// in-session autosave note in the topbar already sets expectations, and Export
// .file remains the persistence path).
async function guardUnsavedThen(proceed) {
   if (!bridge.hasUnsavedChanges() || !cloudSaveAvailable()) {
      proceed();
      return true;
   }
   const choice = await openUnsavedChangesDialog();
   if (choice === "cancel") return false;
   if (choice === "save") {
      const saved = await saveToCloud();
      // If the save failed (offline, transient error) keep the user where they
      // are so their work isn't lost behind a silent navigation.
      if (!saved) return false;
   }
   // "discard" (or a successful save) → proceed. Clear the flag either way so we
   // don't re-prompt if nothing else changes. A staged version-details edit is
   // also dropped (it is only persisted via Save to Cloud).
   bridge.markSaved();
   bridge.setPendingVersionDetails(null);
   proceed();
   return true;
}

// ======================================================================
// Hash routing
// ----------------------------------------------------------------------
// My Songs is the home screen and the editor is a sub-page, so each gets a
// real URL: #/songs (home) and #/song/:songId[/v/:versionId] (editor, or
// #/song/new for an unsaved draft, or #/song/:songId/new for a song that still
// has no versions). That makes the browser Back button and page reloads behave
// the way the visual hierarchy promises. All screen changes go through
// navigate() → applyRoute(), so the URL is always the single source of truth.
// ======================================================================
const HOME_ROUTE = "#/songs";
// Guards the hashchange handler while navigate() is writing the hash itself.
let suppressHashHandling = false;
// Snapshot of the last route we applied, so the hashchange handler can detect a
// browser Back that leaves the editor while there are unsaved changes.
let lastRoute = { name: "home" };
let lastHash = "";
// True while importFromPayload() is running, so a directly-opened #/import link
// isn't re-triggered by the navigate() that runs after a successful load.
let importInFlight = false;

function editorRoute() {
   const ctx = bridge.getCloudContext() || {};
   if (ctx.songId && ctx.versionId) {
      return `#/song/${encodeURIComponent(ctx.songId)}/v/${encodeURIComponent(ctx.versionId)}`;
   }
   if (ctx.songId) return `#/song/${encodeURIComponent(ctx.songId)}/new`;
   return "#/song/new";
}

function parseRoute(hash) {
   const raw = String(hash || "").replace(/^#/, "");
   // Import link: #/import?d=<payload>. Opened directly (address bar / shared
   // link) it should trigger the same preview→load flow as the Attach button.
   const imp = raw.match(/^\/import\b/);
   if (imp) {
      const q = raw.indexOf("?");
      const params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "");
      return { name: "import", payload: params.get("d") || null };
   }
   // Specific version route: #/song/:songId/v/:versionId.
   const versioned = raw.match(/^\/song\/([^/]+)\/v\/([^/]+)$/);
   if (versioned) {
      return { name: "editor", id: decodeURIComponent(versioned[1]), versionId: decodeURIComponent(versioned[2]) };
   }
   // Add-first-version route: #/song/:songId/new — a song that currently has no
   // versions (last one deleted) opens here so the user can add one.
   const addVersion = raw.match(/^\/song\/([^/]+)\/new$/);
   if (addVersion && addVersion[1] !== "new") {
      return { name: "editor", id: decodeURIComponent(addVersion[1]), versionId: null, addVersion: true };
   }
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
   if (route.name === "import") {
      // A shared link was opened directly. Show the gallery behind it, then run
      // the same preview→load flow used by the Attach Link button. We guard with
      // a flag so re-entrancy (e.g. navigate() after load) doesn't double-fire.
      showGalleryScreen();
      document.documentElement.dataset.screen = "home";
      if (route.payload && !importInFlight) {
         importFromPayload(route.payload);
      }
      lastRoute = route;
      lastHash = location.hash;
      return;
   }
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
   if (resume) resume.hidden = route.name !== "home" || !(bridge.getCloudContext()?.songId);
   // Remember where we are so the hashchange guard can detect an editor→home
   // transition triggered by the browser Back button (see the init listener).
   syncVersionPill();
   lastRoute = route;
   lastHash = location.hash;
}
const escapeHtml = (s) =>
   String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
   );

// Whether a "Save to cloud" action can actually complete right now. The unsaved
// guard and the dirty badge both hinge on this: there's no point prompting to
// save (or nagging with a badge) when Firebase isn't configured or nobody is
// signed in. TEST_MODE stands in for an authenticated session in the harness.
function cloudSaveAvailable() {
   return isConfigured() && (!!getCurrentUser() || TEST_MODE);
}

// #4 dirty indicator: toggle the "unsaved changes" state on the Save to Cloud
// button. Only surface it when cloud save is actually available, otherwise the
// badge would nag about an action the user can't complete.
function updateSaveButtonDirty(dirty) {
   const btn = $("#saveCloudBtn");
   if (!btn) return;
   const show = !!dirty && cloudSaveAvailable();
   btn.classList.toggle("is-unsaved", show);
   btn.setAttribute("aria-label", show ? "Save to Cloud (unsaved changes)" : "Save to Cloud");
}

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

   // Cloud availability just changed (sign in/out): re-evaluate the unsaved
   // badge so it only shows when the user can actually save to the cloud.
   updateSaveButtonDirty(bridge?.hasUnsavedChanges?.() ?? false);

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
      // Honour a shared import link even in the test harness — call import directly
      // so we don't depend on route-specific logic in applyRoute().
      const rawHash = location.hash.replace(/^#/, "");
      const imp = rawHash.match(/^\/import\b/);
      if (imp) {
         const q = rawHash.indexOf("?");
         const params = new URLSearchParams(q >= 0 ? rawHash.slice(q + 1) : "");
         const payload = params.get("d");
         if (payload) {
            await importFromPayload(payload);
            return;
         }
      }
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
   // A shared import link (#/import?d=...) opened directly → run the preview flow.
   if (route.name === "import") {
      applyRoute();
      return;
   }
   // A reload on #/song/:id[/v/:versionId] should reopen that song, not
   // silently drop to home.
   if (route.name === "editor" && route.id) {
      openSongInEditor(route.id, route.versionId);
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
   const key = escapeHtml(song.latestKey || song.key || "");
   const meter = escapeHtml(song.latestMeter || song.meter || "");
   const sectionCount = Array.isArray(song.sections) ? song.sections.length : 0;
   const updated = song.updatedAt ? new Date(song.updatedAt).toLocaleDateString() : "";
   // Versioned songs carry the denormalized latest summary on the metadata;
   // legacy flat song objects (and the test seeds) still render via sections.
   const versioned = typeof song.versionCount === "number";
   const detail = versioned
      ? (updated ? `updated ${escapeHtml(updated)}` : "")
      : `${sectionCount} section${sectionCount === 1 ? "" : "s"}${updated ? ` · updated ${escapeHtml(updated)}` : ""}`;
   const mode = (song.latestEditorMode || song.editorMode) === "numbers" ? "numbers" : "chords";
   // Match the edit page's editor-mode glyphs: ♪ for Chord Chart, # for Numbers.
   const modeGlyph = mode === "numbers" ? "#" : "\u266A";
   const modeTitle = mode === "numbers" ? "Nashville Number" : "Chord Chart";
   const keyChip = key ? `<span class="song-card-chip"><small>Key</small> ${key}</span>` : "";
   const meterChip = meter ? `<span class="song-card-chip"><small>Time</small> ${meter}</span>` : "";
   // Show the number of arrangements (number-first), with the count emphasised.
   const versionLabel = versioned
      ? `<span class="song-card-chip is-version" title="Arrangements"><strong>${song.versionCount}</strong> version${song.versionCount === 1 ? "" : "s"}</span>`
      : "";
   return `
      <article class="song-card is-${mode}" role="listitem" tabindex="0" data-id="${escapeHtml(song.cloudId)}"
               aria-label="${escapeHtml(title)} by ${creator}">
         <span class="song-card-mode-mark" aria-hidden="true">${modeGlyph}</span>
         <h3 class="song-card-title">${title}</h3>
         <div class="song-card-creator">${creator}</div>
         <div class="song-card-detail">
            ${detail}
         </div>
         <div class="song-card-dock">
            <div class="song-card-meta">
               ${keyChip}
               ${meterChip}
               ${versionLabel}
            </div>
            <div class="song-card-actions">
               <button class="song-card-action is-edit" type="button" data-act="edit" data-label="Edit" title="Edit" aria-label="Edit ${title}">✎</button>
               <button class="song-card-action is-pdf" type="button" data-act="pdf" data-label="Export .pdf" title="Export .pdf" aria-label="Export ${title} as PDF">↗</button>
               <button class="song-card-action is-export" type="button" data-act="export" data-label="Copy Link" title="Copy a share link for this song" aria-label="Copy share link for ${title}">🔗</button>
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
      toast(isFirestorePermissionsError(error) ? "Could not load — check Firestore security rules" : "Could not load your songs");
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

// ======================================================================
// New Song / add-first-version dialog (version name + mode picker)
// ======================================================================
// The dialog is a single #newSongDialog instance; listeners are installed once
// (initNewSongDialog) and openNewSongDialog only flips it open with fresh copy,
// so multiple opens can never stack duplicate handlers.
let newSongDialogResolve = null; // current open promise (null = dialog closed)

function closeNewSongDialog(result) {
   const resolve = newSongDialogResolve;
   newSongDialogResolve = null;
   const dialog = $("#newSongDialog");
   if (!dialog) {
      resolve?.(null);
      return;
   }
   dialog.classList.remove("is-open");
   setTimeout(() => {
      dialog.hidden = true;
      resolve?.(result);
   }, 260);
}

/**
 * Open the version-name + mode dialog. Resolves with { mode, label } when the
 * user picks a mode card with a non-empty version name, or null on cancel.
 * The version name is REQUIRED (Logic 1): picking a card with an empty name
 * shows an inline error and keeps the dialog open.
 */
function openNewSongDialog({ title = "New Song", desc = "", defaultLabel = "Version 1" } = {}) {
   const dialog = $("#newSongDialog");
   if (!dialog) return Promise.resolve(null);
   const nameInput = $("#newSongVersionName");
   const nameError = $("#newSongVersionError");
   // Re-opening the dialog resolves any previous pending open as cancelled.
   if (newSongDialogResolve) {
      const previous = newSongDialogResolve;
      newSongDialogResolve = null;
      previous(null);
   }
   const nameLabel = $("#newSongTitle");
   const nameDesc = $("#newSongDesc");
   if (nameLabel) nameLabel.textContent = title;
   if (nameDesc) nameDesc.textContent = desc;
   if (nameInput) {
      nameInput.value = defaultLabel;
      nameInput.classList.remove("is-invalid");
      nameInput.oninput = () => {
         if (nameError) nameError.hidden = true;
         nameInput.classList.remove("is-invalid");
      };
   }
   if (nameError) nameError.hidden = true;
   return new Promise((resolve) => {
      newSongDialogResolve = resolve;
      dialog.hidden = false;
      void dialog.offsetHeight;
      setTimeout(() => dialog.classList.add("is-open"), 20);
      setTimeout(() => nameInput?.focus(), 60);
   });
}

// Install the dialog's once-only listeners (mode cards, dismiss + Escape).
function initNewSongDialog() {
   const dialog = $("#newSongDialog");
   const nameInput = $("#newSongVersionName");
   const nameError = $("#newSongVersionError");
   if (!dialog) return;
   dialog.querySelectorAll(".mode-card").forEach((card) => {
      card.addEventListener("click", () => {
         const mode = card.dataset.mode;
         if (!["chords", "numbers"].includes(mode)) return;
         const label = (nameInput?.value || "").trim();
         if (!label) {
            if (nameError) nameError.hidden = false;
            nameInput?.classList.add("is-invalid");
            nameInput?.focus();
            return;
         }
         closeNewSongDialog({ mode, label });
      });
   });
   dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-mode-dismiss]")) closeNewSongDialog(null);
   });
   document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && newSongDialogResolve) closeNewSongDialog(null);
   });
}

/** Fresh blank project for a chosen writing mode (extra meta overridable). */
function blankProject(mode, { title = "New Song", artist = "Artist / Composer" } = {}) {
   return {
      format: "chord-sheet",
      version: 2,
      title,
      artist,
      key: "C",
      meter: "4/4",
      sections: [{ name: "Intro", bars: [] }],
      slashChords: [],
      editorMode: mode,
      lyricsEnabled: false, // lyrics start OFF in both modes; users opt in via the toggle
   };
}

// ======================================================================
// Version CRUD in the editor — version pill + popover + dialogs
//   • #newVersionNameDialog — name a NEW blank version (create flow)
//   • #versionDetailsDialog — rename / attach YouTube / delete ONE version
// ======================================================================
let versionNameDialogResolve = null; // open promise for the new-version name prompt
let versionDetailsResolve = null;    // open promise for the details dialog
let versionDetailsTarget = null;     // { songId, versionId } being edited
let youtubePreviewGeneration = 0;    // guards stale thumbnail onload callbacks
// Element selectors for the two YouTube fields (create-version + details dialogs).
const YT_DETAILS_IDS = {
   preview: "#versionDetailsYoutubePreview",
   thumb: "#versionDetailsThumb",
   hint: "#versionDetailsYoutubeHint",
};
const YT_NEW_VERSION_IDS = {
   preview: "#newVersionYoutubePreview",
   thumb: "#newVersionThumb",
   hint: "#newVersionYoutubeHint",
};

function closeVersionNameDialog(label) {
   const resolve = versionNameDialogResolve;
   versionNameDialogResolve = null;
   const dialog = $("#newVersionNameDialog");
   if (!dialog) return resolve?.(null);
   dialog.classList.remove("is-open");
   setTimeout(() => {
      dialog.hidden = true;
      resolve?.(label);
   }, 260);
}

// Name prompt for creating a new blank arrangement. Resolves with the name, or
// null on cancel. The name is REQUIRED.
function openVersionNameDialog({ title = "New Version", desc = "", defaultLabel = "Version 1" } = {}) {
   const dialog = $("#newVersionNameDialog");
   if (!dialog) return Promise.resolve(null);
   const input = $("#newVersionNameInput");
   const error = $("#newVersionNameError");
   if (versionNameDialogResolve) {
      const prev = versionNameDialogResolve;
      versionNameDialogResolve = null;
      prev(null);
   }
   const titleEl = $("#newVersionNameTitle");
   const descEl = $("#newVersionNameDesc");
   if (titleEl) titleEl.textContent = title;
   if (descEl) descEl.textContent = desc;
   if (input) {
      input.value = defaultLabel;
      input.classList.remove("is-invalid");
      input.oninput = () => {
         if (error) error.hidden = true;
         input.classList.remove("is-invalid");
      };
   }
   if (error) error.hidden = true;
   // Fresh dialog: start with an empty, optional YouTube field.
   const ytInput = $("#newVersionYoutube");
   if (ytInput) ytInput.value = "";
   syncYoutubePreview("", YT_NEW_VERSION_IDS);
   return new Promise((resolve) => {
      versionNameDialogResolve = resolve;
      dialog.hidden = false;
      void dialog.offsetHeight;
      setTimeout(() => dialog.classList.add("is-open"), 20);
      setTimeout(() => input?.focus(), 60);
   });
}

function closeVersionDetailsDialog(result) {
   const resolve = versionDetailsResolve;
   versionDetailsResolve = null;
   versionDetailsTarget = null;
   const dialog = $("#versionDetailsDialog");
   if (!dialog) return resolve?.(null);
   dialog.classList.remove("is-open");
   setTimeout(() => {
      dialog.hidden = true;
      resolve?.(result);
   }, 260);
}

/**
 * Open the "Version details" dialog for one arrangement.
 * Resolves with { status:'save', label, youtubeUrl, youtubeId },
 *         or { status:'delete' }, or null on cancel.
 */
function openVersionDetailsDialog({ songId, versionId, label = "", youtubeUrl = "", youtubeId = "" }) {
   const dialog = $("#versionDetailsDialog");
   if (!dialog) return Promise.resolve(null);
   if (versionDetailsResolve) {
      const prev = versionDetailsResolve;
      versionDetailsResolve = null;
      prev(null);
   }
   versionDetailsTarget = { songId, versionId };
   const nameInput = $("#versionDetailsName");
   if (nameInput) {
      nameInput.value = label || "Version 1";
      nameInput.classList.remove("is-invalid");
   }
   const nameError = $("#versionDetailsNameError");
   if (nameError) nameError.hidden = true;
   const initialUrl = youtubeUrl || (youtubeId ? canonicalUrl(youtubeId) : "");
   const youtubeInput = $("#versionDetailsYoutube");
   if (youtubeInput) youtubeInput.value = initialUrl;
   syncYoutubePreview(initialUrl);
   return new Promise((resolve) => {
      versionDetailsResolve = resolve;
      dialog.hidden = false;
      void dialog.offsetHeight;
      setTimeout(() => dialog.classList.add("is-open"), 20);
      setTimeout(() => nameInput?.focus(), 60);
   });
}

/**
 * Live preview + validation for a YouTube field. The thumbnail (and its ✕
 * remove button) only appear once the link is valid AND the image has fully
 * loaded. The thumbnail itself is the "open" affordance — clicking it opens the
 * video on YouTube in a new tab. Shared by the "Create new version" dialog and
 * the "Version details" dialog (pass `ids` for the latter).
 */
function syncYoutubePreview(value, { preview: previewSel, thumb: thumbSel, hint: hintSel } = YT_DETAILS_IDS) {
   const preview = $(previewSel);
   const thumb = $(thumbSel);
   const hint = $(hintSel);
   const parsed = parseYoutubeUrl(value || "");
   const gen = ++youtubePreviewGeneration;
   if (!parsed) {
      if (preview) preview.hidden = true;
      if (thumb) {
         // Never let a stale thumbnail (from a previously opened version) linger.
         thumb.removeAttribute("src");
         delete thumb.dataset.ytUrl;
      }
      return parsed;
   }
   if (thumb) {
      thumb.dataset.ytUrl = parsed.url;
      thumb.src = thumbnailUrl(parsed.videoId, "mqdefault");
   }
   const show = () => {
      if (gen === youtubePreviewGeneration && preview) preview.hidden = false;
   };
   const hide = () => {
      if (gen === youtubePreviewGeneration && preview) preview.hidden = true;
   };
   if (thumb) {
      thumb.onload = show;
      thumb.onerror = hide;
      if (thumb.complete) show(); // cached image → already decoded
   }
   if (hint) hint.hidden = true;
   return parsed;
}

function openVersionPopover() {
   const pill = $("#versionSwitcherBtn");
   const pop = $("#versionPopover");
   if (!pop) return;
   pop.hidden = false;
   void pop.offsetHeight;
   pop.classList.add("is-open");
   pill?.setAttribute("aria-expanded", "true");
   renderVersionList();
   // Adding another version needs a saved song — disable the action on drafts.
   const newBtn = $("#versionNewBtn");
   if (newBtn) {
      const canCreate = Boolean((bridge.getCloudContext?.() || {}).songId);
      newBtn.disabled = !canCreate;
      newBtn.title = canCreate ? "Add a new arrangement" : "Save your song to cloud first";
   }
}

function closeVersionPopover() {
   const pill = $("#versionSwitcherBtn");
   const pop = $("#versionPopover");
   if (!pop) return;
   pop.classList.remove("is-open");
   pill?.setAttribute("aria-expanded", "false");
   setTimeout(() => {
      pop.hidden = true;
   }, 160);
}

// Install the version pill/popover + name & details dialog listeners once.
function initVersionCrud() {
   // ---- New-version name prompt ----
   const nameDialog = $("#newVersionNameDialog");
   const nameInput = $("#newVersionNameInput");
   const nameError = $("#newVersionNameError");
   if (nameDialog && nameInput) {
      const confirmLabel = () => {
         const label = (nameInput.value || "").trim();
         if (!label) {
            if (nameError) nameError.hidden = false;
            nameInput.classList.add("is-invalid");
            nameInput.focus();
            return;
         }
         const ytValue = (ytInput?.value || "").trim();
         const parsed = ytValue ? syncYoutubePreview(ytValue, YT_NEW_VERSION_IDS) : null;
         if (ytValue && !parsed) return; // invalid link → block create (hint shown)
         closeVersionNameDialog({
            label,
            youtubeUrl: parsed ? parsed.url : null,
            youtubeId: parsed ? parsed.videoId : null,
         });
      };
      $("#newVersionNameOk")?.addEventListener("click", confirmLabel);
      $("#newVersionNameCancel")?.addEventListener("click", () => closeVersionNameDialog(null));
      nameInput.addEventListener("keydown", (event) => {
         if (event.key === "Enter") {
            event.preventDefault();
            confirmLabel();
         }
      });
      // Optional YouTube link on the new version: live preview + validation.
      const ytInput = $("#newVersionYoutube");
      ytInput?.addEventListener("input", () => {
         const value = ytInput.value.trim();
         const parsed = syncYoutubePreview(ytInput.value, YT_NEW_VERSION_IDS);
         const hint = $("#newVersionYoutubeHint");
         if (hint) hint.hidden = !(value && !parsed);
      });
      $("#newVersionThumb")?.addEventListener("click", () => {
         const url = $("#newVersionThumb")?.dataset.ytUrl;
         if (url) window.open(url, "_blank", "noopener");
      });
      $("#newVersionYoutubeRemove")?.addEventListener("click", () => {
         if (ytInput) ytInput.value = "";
         syncYoutubePreview("", YT_NEW_VERSION_IDS);
      });
      nameDialog.addEventListener("click", (event) => {
         if (event.target.closest("[data-newversionname-dismiss]")) closeVersionNameDialog(null);
      });
   }
   document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && versionNameDialogResolve) closeVersionNameDialog(null);
   });

   // ---- Version details dialog (rename + YouTube + delete) ----
   const detailsDialog = $("#versionDetailsDialog");
   const detName = $("#versionDetailsName");
   const detNameError = $("#versionDetailsNameError");
   const detYoutube = $("#versionDetailsYoutube");
   if (detailsDialog) {
      detailsDialog.addEventListener("click", (event) => {
         if (event.target.closest("[data-versiondetails-dismiss]")) closeVersionDetailsDialog(null);
      });
      detYoutube?.addEventListener("input", () => {
         const value = detYoutube.value.trim();
         const parsed = syncYoutubePreview(detYoutube.value);
         const hint = $("#versionDetailsYoutubeHint");
         if (hint) hint.hidden = !(value && !parsed);
      });
      $("#versionDetailsThumb")?.addEventListener("click", () => {
         const url = $("#versionDetailsThumb")?.dataset.ytUrl;
         if (url) window.open(url, "_blank", "noopener");
      });
      $("#versionDetailsRemove")?.addEventListener("click", () => {
         if (detYoutube) detYoutube.value = "";
         syncYoutubePreview("");
      });
      $("#versionDetailsSave")?.addEventListener("click", () => {
         const label = (detName?.value || "").trim();
         if (!label) {
            if (detNameError) detNameError.hidden = false;
            detName?.classList.add("is-invalid");
            detName?.focus();
            return;
         }
         const value = (detYoutube?.value || "").trim();
         const parsed = value ? syncYoutubePreview(value) : null;
         if (value && !parsed) return; // invalid link → block save (hint shown)
         closeVersionDetailsDialog({
            status: "save",
            label,
            youtubeUrl: parsed ? parsed.url : null,
            youtubeId: parsed ? parsed.videoId : null,
         });
      });
      $("#versionDetailsDelete")?.addEventListener("click", () => {
         closeVersionDetailsDialog({ status: "delete" });
      });
   }
   document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && versionDetailsResolve) closeVersionDetailsDialog(null);
   });

   // ---- Version pill + popover ----
   const pill = $("#versionSwitcherBtn");
   if (pill) {
      pill.addEventListener("click", () => {
         if ($("#versionPopover")?.classList.contains("is-open")) closeVersionPopover();
         else openVersionPopover();
      });
   }
   document.addEventListener("click", (event) => {
      if ($("#versionPopover")?.classList.contains("is-open") && !event.target.closest(".version-switcher")) {
         closeVersionPopover();
      }
   });
   document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && $("#versionPopover")?.classList.contains("is-open")) closeVersionPopover();
   });

   $("#versionNewBtn")?.addEventListener("click", onNewVersion);
}

// Reflect the current arrangement in the topbar version pill.
function syncVersionPill() {
   const wrap = $("#versionSwitcherWrap");
   if (!wrap) return;
   const ctx = bridge.getCloudContext?.() || null;
   // Always show the pill when something is being edited — a saved song (songId)
   // OR a brand-new draft that already has its first version name.
   wrap.hidden = !ctx || (!ctx.songId && !ctx.versionLabel);
   if (wrap.hidden) return;
   const labelEl = $("#versionSwitcherLabel");
   if (labelEl) {
      const pending = bridge.getPendingVersionDetails?.() || null;
      labelEl.textContent =
         pending && pending.versionId === ctx.versionId && pending.label
            ? pending.label
            : ctx.versionLabel || "Version 1";
   }
}

// Populate the popover's list of arrangements (newest first) and bind switching.
async function renderVersionList() {
   const listEl = $("#versionList");
   if (!listEl) return;
   const ctx = bridge.getCloudContext?.() || null;
   if (!ctx?.songId) {
      // Brand-new (unsaved) draft: show the pending first-version name instead
      // of an empty list, and hint that saving unlocks version management.
      if (ctx?.versionLabel) {
         listEl.innerHTML = `<div class="version-list-empty">Current: <strong>${escapeHtml(ctx.versionLabel)}</strong> — save to cloud first to manage versions.</div>`;
      } else {
         listEl.innerHTML = `<div class="version-list-empty">Save a song first to manage its versions.</div>`;
      }
      return;
   }
   const versions = await listVersions(ctx.songId);
   if (!versions.length) {
      listEl.innerHTML = `<div class="version-list-empty">No versions yet — create one below.</div>`;
      return;
   }
   listEl.innerHTML = versions
      .map((v) => {
         const current = v.versionId === ctx.versionId;
         const pending = bridge.getPendingVersionDetails?.() || null;
         const isPending = pending && pending.versionId === v.versionId;
         const name = escapeHtml((isPending && pending.label) || v.label || "Untitled");
         const ytIcon = (isPending ? pending.youtubeId : v.youtubeId) ? `<span class="version-item-yt" title="Has YouTube link">▶</span>` : "";
         const pendingDot = isPending ? `<span class="version-item-pending" title="Pending — save to cloud">●</span>` : "";
         const currentMark = current ? `<span class="version-item-current">Current</span>` : "";
         return `
            <div class="version-list-item${current ? " is-current" : ""}">
               <button class="version-item-switch" type="button" data-version-id="${escapeHtml(v.versionId)}" title="Open this version">
                  <span class="version-item-label">${name}${ytIcon}</span>
                  ${pendingDot}
                  ${currentMark}
               </button>
               <button class="version-item-edit" type="button" data-version-id="${escapeHtml(v.versionId)}" aria-label="Edit details" title="Edit details">✎</button>
            </div>`;
      })
      .join("");
   listEl.querySelectorAll(".version-item-switch").forEach((btn) => {
      btn.addEventListener("click", () => selectVersion(btn.dataset.versionId));
   });
   listEl.querySelectorAll(".version-item-edit").forEach((btn) => {
      btn.addEventListener("click", (event) => {
         event.stopPropagation();
         editVersionDetails(btn.dataset.versionId);
      });
   });
}

// Switch the editor to another arrangement of the same song.
async function selectVersion(versionId) {
   const ctx = bridge.getCloudContext?.() || null;
   if (!ctx?.songId || versionId === ctx.versionId) {
      closeVersionPopover();
      return;
   }
   await guardUnsavedThen(async () => {
      closeVersionPopover();
      try {
         const meta = await loadSongMeta(ctx.songId);
         const version = await loadVersion(ctx.songId, versionId);
         bridge.applyProject(composeSong(meta, version));
         bridge.setCloudContext({ songId: ctx.songId, versionId, versionLabel: version.label || "" });
         navigate(`#/song/${encodeURIComponent(ctx.songId)}/v/${encodeURIComponent(versionId)}`);
         syncVersionPill();
         toast(`Opened "${meta.title || "Untitled"}" — ${version.label || "Version"}`);
      } catch (error) {
         toast("Could not open that version");
      }
   });
}

// New version… — starts a BLANK arrangement (like a new song), without copying
// the current score. Guarded so unsaved edits to the current version can be
// saved (or discarded) before leaving it.
async function onNewVersion() {
   const ctx = bridge.getCloudContext?.() || null;
   closeVersionPopover();
   if (!ctx?.songId) return;
   const current = bridge.getProject();
   const mode = current?.editorMode === "numbers" ? "numbers" : "chords";
   const blank = blankProject(mode, {
      title: current?.title || "Song Title",
      artist: current?.artist || "Artist / Composer",
   });

   if (!ctx.versionId) {
      // Add-state: no arrangement exists yet — create the first (blank) one.
      const input = await openVersionNameDialog({
         title: "New Version",
         desc: "Start a new, blank arrangement.",
         defaultLabel: "Version 1",
      });
      if (!input) return;
      try {
         const payload = { ...blank, youtubeUrl: input.youtubeUrl, youtubeId: input.youtubeId };
         const created = await saveVersion(ctx.songId, null, payload, { label: input.label });
         await updateLatestVersion(ctx.songId, created.versionId, created.label, 1, blank.editorMode, input.youtubeId, blank.key, blank.meter);
         bridge.applyProject(blank);
         bridge.setCloudContext({ songId: ctx.songId, versionId: created.versionId, versionLabel: created.label });
         navigate(`#/song/${encodeURIComponent(ctx.songId)}/v/${encodeURIComponent(created.versionId)}`);
         syncVersionPill();
         toast(`Version "${created.label}" created`);
      } catch (error) {
         toast("Could not create version");
      }
      return;
   }

   // Editing an existing song: guard unsaved edits on the current version, then
   // create a NEW blank arrangement (no cloning of the current score).
   await guardUnsavedThen(async () => {
      try {
         const count = (await listVersions(ctx.songId)).length;
         const input = await openVersionNameDialog({
            title: "New Version",
            desc: "Start a new, blank arrangement — it will not copy the current score.",
            defaultLabel: `Version ${count + 1}`,
         });
         if (!input) return;
         const payload = { ...blank, youtubeUrl: input.youtubeUrl, youtubeId: input.youtubeId };
         const created = await saveVersion(ctx.songId, null, payload, { label: input.label });
         await updateLatestVersion(ctx.songId, created.versionId, created.label, count + 1, blank.editorMode, input.youtubeId, blank.key, blank.meter);
         bridge.applyProject(blank);
         bridge.setCloudContext({ songId: ctx.songId, versionId: created.versionId, versionLabel: created.label });
         navigate(`#/song/${encodeURIComponent(ctx.songId)}/v/${encodeURIComponent(created.versionId)}`);
         syncVersionPill();
         toast(`Version "${created.label}" created`);
      } catch (error) {
         toast("Could not create version");
      }
   });
}

// Edit details (pencil on a version row) — opens the "Version details" dialog
// (rename + YouTube + delete) for THAT version and applies the result. Works for
// any version, not just the currently open one.
async function editVersionDetails(versionId) {
   const ctx = bridge.getCloudContext?.() || null;
   closeVersionPopover();
   if (!ctx?.songId || !versionId) return;
   let version;
   try {
      version = await loadVersion(ctx.songId, versionId);
   } catch (error) {
      toast("Could not open version details");
      return;
   }
   const result = await openVersionDetailsDialog({
      songId: ctx.songId,
      versionId,
      label: version.label || (ctx.versionId === versionId ? ctx.versionLabel : "") || "",
      youtubeUrl: version.youtubeUrl || "",
      youtubeId: version.youtubeId || "",
   });
   if (!result) return;
   if (result.status === "delete") {
      // Deleting the CURRENT version runs the full recompute/add-state flow;
      // deleting another version just removes it and refreshes the list.
      if (ctx.versionId === versionId) {
         onDeleteVersion();
         return;
      }
      try {
         await deleteVersion(ctx.songId, versionId);
         // A pending edit of this version is gone with it.
         const pending = bridge.getPendingVersionDetails?.() || null;
         if (pending?.versionId === versionId) bridge.setPendingVersionDetails(null);
         toast("Version deleted");
      } catch (error) {
         toast(isFirestorePermissionsError(error) ? "Delete blocked — check Firestore security rules" : "Could not delete version");
      }
      return;
   }
   // Stage the rename + YouTube edit as PENDING. It is only written to the cloud
   // together with the next "Save to Cloud" — until then a yellow badge on that
   // button reminds the user the version details were edited.
   bridge.setPendingVersionDetails({
      versionId,
      label: result.label,
      youtubeUrl: result.youtubeUrl,
      youtubeId: result.youtubeId,
   });
   bridge.markDirty();
   // Reflect the edit locally (without touching Firestore yet).
   if (ctx.versionId === versionId) {
      bridge.setCloudContext({ songId: ctx.songId, versionId, versionLabel: result.label });
   }
   syncVersionPill();
   renderVersionList();
   toast("Version details pending — Save to Cloud to persist");
}

// Delete version… — removes that arrangement. The song itself survives (Opsi A).
async function onDeleteVersion() {
   const ctx = bridge.getCloudContext?.() || null;
   closeVersionPopover();
   if (!ctx?.songId || !ctx.versionId) return;
   const confirmed = await openConfirmDialog({
      title: "Delete version?",
      message: `Delete version "${ctx.versionLabel || "Version 1"}"? This cannot be undone.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      icon: "🗑",
      danger: true,
   });
   if (!confirmed) return;
   try {
      const result = await deleteVersion(ctx.songId, ctx.versionId);
      const meta = await loadSongMeta(ctx.songId);
      if (result.versionId) {
         const version = await loadVersion(ctx.songId, result.versionId);
         bridge.applyProject(composeSong(meta, version));
         bridge.setCloudContext({ songId: ctx.songId, versionId: result.versionId, versionLabel: version.label || "" });
         navigate(`#/song/${encodeURIComponent(ctx.songId)}/v/${encodeURIComponent(result.versionId)}`);
         toast("Version deleted");
      } else {
         // Last arrangement removed → song stays; the editor asks for a first version.
         bridge.applyProject(
            blankProject("chords", { title: meta.title || "Song Title", artist: meta.artist || "Artist / Composer" }),
         );
         bridge.setCloudContext({ songId: ctx.songId, versionId: null, versionLabel: "" });
         navigate(`#/song/${encodeURIComponent(ctx.songId)}/new`);
         toast("Last version deleted — add a new one to continue");
      }
      syncVersionPill();
   } catch (error) {
      toast("Could not delete version");
   }
}

async function openSongInEditor(songId, versionId) {
   // Guarded so replacing the open document (e.g. opening another song while
   // one is already loaded with edits) can't silently discard unsaved work.
   await guardUnsavedThen(async () => {
      try {
         const meta = await loadSongMeta(songId);
         if (meta.legacy) {
            // Firestore rules still deny the versions subcollection: open the
            // legacy flat arrangement directly so nothing looks lost.
            bridge.applyProject(meta);
            bridge.setCloudContext({ songId, versionId: null, versionLabel: "" });
            navigate(`#/song/${encodeURIComponent(songId)}`);
            toast(`Opened "${meta.title || "Untitled"}"`);
            return;
         }
         let version = null;
         if (versionId) {
            version = await loadVersion(songId, versionId);
         } else if (meta.latestVersionId) {
            // Default (Logic 2): open the latest arrangement of the song.
            version = await loadVersion(songId, meta.latestVersionId);
         }
         if (version) {
            bridge.applyProject(composeSong(meta, version));
            bridge.setCloudContext({ songId, versionId: version.versionId, versionLabel: version.label || "" });
            navigate(`#/song/${encodeURIComponent(songId)}/v/${encodeURIComponent(version.versionId)}`);
            toast(`Opened "${meta.title || "Untitled"}" — ${version.label || "Version"}`);
         } else {
            // The song has no versions yet (e.g. the last one was deleted) →
            // require a version name FIRST (Opsi A), then land in the editor in
            // "add first version" mode.
            const created = await openNewSongDialog({
               title: "Add First Version",
               desc: `"${meta.title || "Untitled"}" has no versions yet. Enter a version name, then pick a writing mode to start.`,
               defaultLabel: "Version 1",
            });
            if (!created) {
               navigate(HOME_ROUTE);
               return;
            }
            bridge.applyProject(
               blankProject(created.mode, { title: meta.title || "Song Title", artist: meta.artist || "Artist / Composer" }),
            );
            bridge.setCloudContext({ songId, versionId: null, versionLabel: created.label });
            navigate(`#/song/${encodeURIComponent(songId)}/new`);
            toast(`Version "${created.label}" ready for "${meta.title || "Untitled"}"`);
         }
      } catch (error) {
         toast("Could not open that song");
      }
   });
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
         bridge.setCloudContext({ songId: cloudId, versionId: full.versionId || null, versionLabel: full.label || "" });
         navigate(
            full.versionId
               ? `#/song/${encodeURIComponent(cloudId)}/v/${encodeURIComponent(full.versionId)}`
               : `#/song/${encodeURIComponent(cloudId)}/new`,
         );
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
         const current = bridge.getCloudContext();
         if (current?.songId === cloudId) bridge.setCloudContext(null);
         toast("Song deleted");
         await refreshSongs();
      } catch (error) {
         toast(isFirestorePermissionsError(error) ? "Delete blocked — check Firestore security rules" : "Could not delete that song");
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
      // Generate a share link and copy it to the clipboard. If the clipboard
      // API is unavailable/blocked (permissions, non-secure context, not
      // focused), fall back to showing the link so the user can copy manually.
      try {
         const song = await loadSong(cloudId);
         // Strip the version-model meta fields so the shared payload is a clean
         // self-contained project (the editor imports it as a new song + v1).
         const project = { ...song };
         delete project.cloudId;
         delete project.songId;
         delete project.versionId;
         delete project.label;
         delete project.updatedAt;
         delete project.hasNoVersions;
         const link = await buildShareLink(project, `${location.origin}${location.pathname}`);
         const copied = await copyTextToClipboard(link);
         if (copied) {
            toast("Share link copied to clipboard!");
         } else {
            await showShareLinkFallback(link);
         }
      } catch (error) {
         console.error("[cloudUI] Share link error:", error);
         toast("Could not create share link");
      }
   }
}

// Copy text to clipboard with a legacy fallback. Returns true on success.
async function copyTextToClipboard(text) {
   try {
      if (navigator.clipboard && window.isSecureContext) {
         await navigator.clipboard.writeText(text);
         return true;
      }
   } catch {
      // fall through to legacy path
   }
   try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
   } catch {
      return false;
   }
}

// When clipboard copy fails, present the link in the Attach Link dialog's
// textarea (reused, read-only) so the user can select and copy it by hand.
async function showShareLinkFallback(link) {
   const input = $("#attachLinkInput");
   const dialog = $("#attachLinkDialog");
   const title = $("#attachLinkTitle");
   const desc = $("#attachLinkDesc");
   if (!input || !dialog) {
      window.prompt("Copy this share link:", link);
      return;
   }
   if (title) title.textContent = "Copy this link";
   if (desc) desc.textContent = "Automatic copy was blocked by the browser. Select the link below and copy it manually.";
   input.value = link;
   openModal(dialog);
   setTimeout(() => {
      input.focus();
      input.select();
   }, 40);
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

   // New song (Logic 1): the user MUST name the version, then pick a mode,
   // before the editor opens. Guarded so starting fresh doesn't silently
   // discard unsaved edits.
   $("#newSongBtn")?.addEventListener("click", () => {
      guardUnsavedThen(() => {
         openNewSongDialog({
            title: "New Song",
            desc: "Name the first arrangement, then pick a writing mode to start.",
            defaultLabel: "Version 1",
         }).then((result) => {
            if (!result) return; // user cancelled
            initNewSong(result.mode, result.label);
         });
      });
   });

   /** Initialize a blank project and land on the edit page (Logic 1). */
   function initNewSong(mode, versionLabel) {
      const isNumbers = mode === "numbers";
      bridge.applyProject(blankProject(mode));
      bridge.setCloudContext({ songId: null, versionId: null, versionLabel });
      // A brand-new draft exists only in the editor — mark it as unsaved from
      // the start so the yellow badge on "Save to Cloud" is lit and leaving to
      // My Songs (or browser back) validates via the unsaved-changes guard.
      bridge.markDirty();
      navigate("#/song/new");
      toast(`Started a new ${isNumbers ? "Nashville numbers" : "chord chart"} song`);
   }

   // Attach Link: open a themed dialog to paste a share link, decode it, and
   // show a confirm preview before applying to the editor.
   $("#attachLinkBtn")?.addEventListener("click", async () => {
      const text = await openAttachLinkDialog();
      if (!text) return;
      const payload = extractPayloadFromLink(text);
      if (!payload) {
         await openConfirmDialog({
            title: "Invalid link",
            message:
               "That does not look like a valid share link. Please check that you copied the whole link and try again.",
            confirmLabel: "OK",
            cancelLabel: "Close",
            icon: "⚠",
         });
         return;
      }
      await importFromPayload(payload);
   });
}

// Shared import flow: decode a payload, show a preview confirm, and (on accept)
// load it into the editor. Used by BOTH the Attach Link button and a directly
// opened #/import?d=... link. Guarded by importInFlight so an in-progress import
// (e.g. from the route) isn't re-triggered by a subsequent navigate/applyRoute.
async function importFromPayload(payload) {
   if (importInFlight) return;
   importInFlight = true;
   try {
      let song;
      try {
         song = await decodeShare(payload);
      } catch (error) {
         console.error("[cloudUI] Import decode error:", error);
         await openConfirmDialog({
            title: "Could not read link",
            message:
               "This link could not be decoded. It may be from a different app version or was corrupted during copy/paste.",
            confirmLabel: "OK",
            cancelLabel: "Close",
            icon: "⚠",
         });
         return;
      }
      const previewText = `Import this song?\n\nTitle: ${(song.title || "Untitled").trim() || "Untitled"}\nArtist: ${(song.artist || "").trim() || "—"}\nKey: ${song.key || "—"}\nMeter: ${song.meter || "—"}\nSections: ${(song.sections || []).length}`;
      const confirmed = await openConfirmDialog({
         title: "Import Shared Song",
         message: previewText,
         confirmLabel: "Load & Use",
         cancelLabel: "Cancel",
         icon: "🔗",
      });
      if (!confirmed) return;
      bridge.applyProject(song);
      bridge.setCloudContext(null);
      // Go to the editor screen (NOT #/import, which would re-run this flow).
      navigate("#/song/new");
      toast("Song loaded — click Save to Cloud to keep it");
   } finally {
      importInFlight = false;
   }
}

// ======================================================================
// Save to Cloud (topbar)
// ======================================================================
async function saveToCloud() {
   if (!isConfigured()) {
      toast("Cloud is not configured yet");
      return false;
   }
   if (!getCurrentUser()) {
      showLoginPage();
      toast("Sign in to save to the cloud");
      return false;
   }
   try {
      const project = bridge.getProject();
      const ctx = bridge.getCloudContext() || {};
      const title = project.title || "Untitled";
      const artist = project.artist || "";
      let nextContext;
      if (ctx.songId) {
         const songId = ctx.songId;
         if (ctx.versionId) {
            // Editing an existing arrangement: update the version doc in place.
            await saveVersion(songId, ctx.versionId, project, { label: ctx.versionLabel });
            nextContext = { songId, versionId: ctx.versionId, versionLabel: ctx.versionLabel };
         } else {
            // Song exists but currently has no versions (add-state): this save
            // becomes its (new) first version.
            const created = await saveVersion(songId, null, project, { label: ctx.versionLabel || "Version 1" });
            await updateLatestVersion(songId, created.versionId, created.label, 1, project.editorMode, undefined, project.key, project.meter);
            nextContext = { songId, versionId: created.versionId, versionLabel: created.label };
         }
         await updateSongMeta(songId, {
            title,
            artist,
            latestEditorMode: project.editorMode === "numbers" ? "numbers" : "chords",
            latestKey: project.key || "",
            latestMeter: project.meter || "",
         });
      } else {
         // Brand-new song: metadata + its first version are created together.
         const createdSong = await createSong({ title, artist });
         const created = await saveVersion(createdSong.songId, null, project, { label: ctx.versionLabel || "Version 1" });
         await updateLatestVersion(createdSong.songId, created.versionId, created.label, 1, project.editorMode, undefined, project.key, project.meter);
         nextContext = { songId: createdSong.songId, versionId: created.versionId, versionLabel: created.label };
      }
      // Persist any staged version-details edit (name / YouTube link) together
      // with this "Save to Cloud".
      const pending = bridge.getPendingVersionDetails?.() || null;
      if (pending?.versionId && nextContext.songId) {
         await saveVersion(nextContext.songId, pending.versionId, {
            youtubeUrl: pending.youtubeUrl,
            youtubeId: pending.youtubeId,
         }, { label: pending.label });
         const versions = await listVersions(nextContext.songId);
         if (versions[0]?.versionId === pending.versionId) {
            await updateSongMeta(nextContext.songId, {
               latestVersionLabel: pending.label,
               latestYoutubeId: pending.youtubeId || null,
            });
         }
         if (nextContext.versionId === pending.versionId) {
            nextContext.versionLabel = pending.label;
         }
         bridge.setPendingVersionDetails(null);
      }
      bridge.setCloudContext(nextContext);
      syncVersionPill();
      bridge.markSaved();
      toast("Saved to cloud");
      return true;
   } catch (error) {
      toast(isFirestorePermissionsError(error) ? "Save blocked — check Firestore security rules" : "Could not save to cloud");
      return false;
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
         bridge.setCloudContext(null);
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
   initNewSongDialog();
   initVersionCrud();
   initAccountButton();
   // Test hook: the per-card Export .file path can't reach Firebase in headless
   // CI, so expose the pure download helper for the regression suite to exercise.
   if (TEST_MODE) window.__cloudDownloadSong = downloadSongFile;
   // Test hook: the old file-upload import flow (an <input type=file> triggered
   // applyProject) was replaced by share-link import, so expose the real
   // applyProject path for the regression suite to import a project directly.
   if (TEST_MODE) window.__cloudImportForTest = (project) => bridge.applyProject(project);
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
            versionCount: 3,
            latestVersionId: `v${i}`,
            latestVersionLabel: `Version ${(i % 3) + 1}`,
            latestEditorMode: i % 2 ? "numbers" : "chords",
            latestKey: "G",
            latestMeter: "4/4",
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
   // #4 unsaved-changes indicator: the editor broadcasts a dirty-state change
   // whenever the document is edited (or saved/loaded). Reflect it as a badge on
   // the Save to Cloud button so the user can see at a glance that there is work
   // to persist. The badge is only meaningful when cloud save is possible.
   window.addEventListener("chordsheet:dirtychange", (e) => {
      updateSaveButtonDirty(!!e.detail?.dirty);
   });
   // Editor header: Back returns to home (the library). Guarded so unsaved cloud
   // changes prompt a Save & leave / Leave without saving / Cancel choice first.
   $("#backToSongsBtn")?.addEventListener("click", () => leaveEditorToHome());
   // Browser Back/Forward and manual hash edits re-render the matching screen.
   window.addEventListener("hashchange", () => {
      if (suppressHashHandling) return;
      // Detect a browser Back/Forward (or manual hash edit) that leaves an open
      // editor for home. When audio is playing or there are unsaved cloud
      // changes, we re-pin the editor URL (no new history entry) and route
      // through the async guards so a "Cancel" keeps the user in the editor.
      const from = lastRoute;
      const to = parseRoute(location.hash);
      const leavingEditor = from.name === "editor" && to.name === "home";
      if (leavingEditor && (bridge.isPlaying?.() || (bridge.hasUnsavedChanges() && cloudSaveAvailable()))) {
         const editorHash = editorRoute();
         // Re-pin the URL to the editor without a new history entry, then prompt.
         suppressHashHandling = true;
         history.replaceState(null, "", editorHash);
         suppressHashHandling = false;
         lastHash = editorHash;
         handleLeaveWithGuard();
         return;
      }
      applyRoute();
   });
   // Async tail of the hashchange guard: confirm stopping playback first (if
   // active), then run the unsaved-changes dialog (if needed) before completing
   // the navigation home. Cancelling any step keeps the (re-pinned) editor open.
   async function handleLeaveWithGuard() {
      if (!(await confirmStopPlayback())) {
         applyRoute();
         return;
      }
      if (bridge.hasUnsavedChanges() && cloudSaveAvailable()) {
         guardUnsavedThen(() => navigate(HOME_ROUTE));
      } else {
         navigate(HOME_ROUTE);
      }
   }
   // Reload / tab close protection. Custom dialogs can't run here — the browser
   // shows its own native "Leave site?" prompt when we cancel the event. Only
   // arm it when there is genuinely unsaved cloud work to lose. NEVER arm it in
   // TEST_MODE: the regression harness drives navigation via CDP Page.navigate,
   // and a native beforeunload prompt is unanswerable headless — it deadlocks
   // the harness.
   window.addEventListener("beforeunload", (e) => {
      if (TEST_MODE) return;
      if (bridge.hasUnsavedChanges() && cloudSaveAvailable()) {
         e.preventDefault();
         e.returnValue = "";
      }
   });
   // Reflect auth state in the topbar (and route on sign-in/out) as it changes.
   onAuth(reflectAuth);
   // Decide the initial screen (login page vs My Songs) from the restored session.
   routeOnLoad();
}
