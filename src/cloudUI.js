// cloudUI.js — DOM wiring for the cloud login modal + My Songs gallery.
//
// Kept separate from events.js so the cloud feature is self-contained. It talks
// to Firebase only through cloud.js, and to the editor only through injected
// callbacks (getProject / applyProject / getCloudContext / setCloudContext). This
// keeps the module graph acyclic: cloudUI → { cloud, dom }, and events.js → cloudUI.
import { $, toast } from "./dom.js?v=__BUILD__";
import { friendlyName } from "./identity.js?v=__BUILD__";
import { editorModeMeta, normalizeEditorMode } from "./notation.js?v=__BUILD__";
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
   createAlbum,
   updateAlbum,
   deleteAlbum,
   getAlbum,
   listAlbums,
   listAlbumSongs,
   loadAlbumSong,
   loadAlbumSongMeta,
   updateAlbumSongMeta,
   saveToAlbum,
   deleteAlbumSong,
   addSongToAlbum,
   copyAlbumSongToMySongs,
   listAlbumVersions,
   loadAlbumVersion,
   saveAlbumVersion,
   updateAlbumLatestVersion,
   deleteAlbumVersion,
   getInviteCode,
   rotateInviteCode,
   joinAlbum,
   listMembers,
   setMemberRole,
   removeMember,
   leaveAlbum,
   normalizeInviteCode,
} from "./cloud.js?v=__BUILD__";

// Injected editor bridge (set in init).
import { buildShareLink, decodeShare, extractPayloadFromLink, IMPORT_ROUTE } from "./share.js?v=__BUILD__";
import { parseYoutubeUrl, canonicalUrl, thumbnailUrl } from "./youtube.js?v=__BUILD__";

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
// Where "Back to My Songs" should land: the album detail when the open document
// is an album arrangement, the My Songs home otherwise.
function homeTarget() {
   const ctx = bridge.getCloudContext?.() || null;
   if (isAlbumCtx(ctx) && ctx.albumId) return `#/albums/${encodeURIComponent(ctx.albumId)}`;
   // Robustness: even if the context was lost, a URL that is an album editor
   // route must still land back on the album's song list.
   const route = parseRoute(location.hash);
   if (route.name === "editor" && route.albumId) return `#/albums/${encodeURIComponent(route.albumId)}`;
   return HOME_ROUTE;
}
async function leaveEditorToHome() {
   // If audio is still playing, confirm before leaving so the user isn't
   // surprised the sound cuts out when they land on the album / My Songs.
   // Playback is stopped automatically on confirmation.
   if (!(await confirmStopPlayback())) return;
   await guardUnsavedThen(() => navigate(homeTarget()));
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

// ===== Album (Fase 3/4) UI state =====
let homeTab = "songs"; // active home tab: "songs" | "albums"
let pendingHomeTab = "songs"; // tab to activate when showing the home screen
let currentAlbum = null; // { ..., role } being viewed in #albumModal
let cachedAlbums = []; // albums of the current user (Albums tab)
let cachedAlbumSongs = []; // songs of the open album (for search filtering)
let albumSelectedSongId = null; // candidate song in #addSongDialog
// Album scope currently open in the editor. Kept SEPARATELY from the cloud
// context so the save direction stays correct even if the context (or the URL)
// has been overwritten by a version switch / New Version flow. The cloud
// context remains the primary source of truth; this is the safety net.
let activeAlbumCtx = null; // { albumId, albumName, role } | null
function setActiveAlbumCtx(next) {
   activeAlbumCtx = next && next.albumId ? { albumId: next.albumId, albumName: next.albumName || "", role: next.role || null } : null;
}

function editorRoute() {
   const ctx = bridge.getCloudContext() || {};
   // Album-scoped arrangements use #/album/... routes.
   if (ctx.scope === "album" && ctx.albumId) {
      if (!ctx.songId) return `#/album/${encodeURIComponent(ctx.albumId)}/new`;
      return ctx.versionId
         ? `#/album/${encodeURIComponent(ctx.albumId)}/${encodeURIComponent(ctx.songId)}/v/${encodeURIComponent(ctx.versionId)}`
         : `#/album/${encodeURIComponent(ctx.albumId)}/${encodeURIComponent(ctx.songId)}`;
   }
   // Safety net: never downgrade an album editor URL to a My Songs URL. If the
   // hash still says "#/album/..." AND the open document is still that album song
   // (no songId yet, or the same id), keep the album route — otherwise a stray My
   // Songs URL would make the next "Save to Cloud" write into the user's library.
   const route = parseRoute(location.hash);
   if (route.name === "editor" && route.albumId && (!ctx.songId || ctx.songId === route.id)) {
      const songId = ctx.songId || route.id || null;
      const versionId = ctx.versionId ?? route.versionId ?? null;
      if (!songId) return `#/album/${encodeURIComponent(route.albumId)}/new`;
      return versionId
         ? `#/album/${encodeURIComponent(route.albumId)}/${encodeURIComponent(songId)}/v/${encodeURIComponent(versionId)}`
         : `#/album/${encodeURIComponent(route.albumId)}/${encodeURIComponent(songId)}`;
   }
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
   // Album routes (Fase 3/4).
   const albumVersioned = raw.match(/^\/album\/([^/]+)\/([^/]+)\/v\/([^/]+)$/);
   if (albumVersioned) {
      return { name: "editor", albumId: decodeURIComponent(albumVersioned[1]), id: decodeURIComponent(albumVersioned[2]), versionId: decodeURIComponent(albumVersioned[3]) };
   }
   const albumAddVersion = raw.match(/^\/album\/([^/]+)\/([^/]+)\/new$/);
   if (albumAddVersion) {
      return { name: "editor", albumId: decodeURIComponent(albumAddVersion[1]), id: decodeURIComponent(albumAddVersion[2]), versionId: null, addVersion: true };
   }
   const albumSongNew = raw.match(/^\/album\/([^/]+)\/new$/);
   if (albumSongNew) return { name: "editor", albumId: decodeURIComponent(albumSongNew[1]), id: null };
   const albumSong = raw.match(/^\/album\/([^/]+)\/([^/]+)$/);
   if (albumSong) return { name: "editor", albumId: decodeURIComponent(albumSong[1]), id: decodeURIComponent(albumSong[2]) };
   const albumDetail = raw.match(/^\/albums\/([^/]+)$/);
   if (albumDetail) return { name: "album-detail", id: decodeURIComponent(albumDetail[1]) };
   if (raw === "/albums" || raw === "/albums/") return { name: "albums" };
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
      pendingHomeTab = "songs";
      closeModal($("#albumModal"));
      showGalleryScreen();
   } else if (route.name === "albums") {
      pendingHomeTab = "albums";
      closeModal($("#albumModal"));
      showGalleryScreen("albums");
   } else if (route.name === "album-detail") {
      openAlbumDetail(route.id);
      lastRoute = route;
      lastHash = location.hash;
      return;
   } else {
      closeModal(modal);
      closeModal($("#albumModal"));
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

// Display names are derived by identity.js → friendlyName() (imported at the top):
// Auth displayName when present (Google), otherwise a readable name from the email
// local part. Callers keep their own fallback ("Musician" in the member list, the
// email in the account menu).

// Whether a "Save to cloud" action can actually complete right now. The unsaved
// guard and the dirty badge both hinge on this: there's no point prompting to
// save (or nagging with a badge) when Firebase isn't configured or nobody is
// signed in. TEST_MODE stands in for an authenticated session in the harness.
function cloudSaveAvailable() {
   return isConfigured() && (!!getCurrentUser() || TEST_MODE);
}

// #4 dirty indicator: toggle the "unsaved changes" state on the Save button.
// Only surface it when cloud save is actually available, otherwise the badge
// would nag about an action the user can't complete.
// The badge (amber dot) rides the top-right corner of the button, and the
// accessible label follows the ACTIVE scope ("Save to Album" inside an album,
// "Save a copy" for members) so the hint never contradicts the visible text.
function updateSaveButtonDirty(dirty) {
   const btn = $("#saveCloudBtn");
   if (!btn) return;
   const show = !!dirty && cloudSaveAvailable();
   btn.classList.toggle("is-unsaved", show);
   const label = btn.dataset.saveLabel || "Save to Cloud";
   btn.setAttribute("aria-label", show ? `${label} (unsaved changes)` : label);
}

// ======================================================================
// Auth state → topbar reflection
// ======================================================================
function reflectAuth(user) {
   const btn = $("#accountBtn");
   const avatar = $("#accountAvatar");
   const label = $("#accountLabel");
   if (btn) {
      // One derived name for the whole account UI: Auth displayName when present
      // (Google), otherwise a readable name from the email's local part — an
      // email/password account has no displayName at all.
      const accountName = friendlyName(user || {}) || user?.email || "";
      if (user) {
         btn.classList.add("is-authed");
         const initial = (accountName || "?").trim().charAt(0).toUpperCase();
         if (user.photoURL) {
            avatar.innerHTML = `<img src="${escapeHtml(user.photoURL)}" alt="" referrerpolicy="no-referrer" />`;
         } else {
            avatar.textContent = initial || "●";
         }
         label.textContent = accountName || "Account";
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
      if (pName) pName.textContent = user ? accountName || "Signed in" : "Not signed in";
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
   if (route.name === "editor" && route.albumId) {
      if (route.id) openAlbumSongInEditor(route.albumId, route.id, route.versionId);
      else openAlbumNewSongFlow(route.albumId, { replaceHistory: true });
      return;
   }
   if (route.name === "editor" && route.id) {
      openSongInEditor(route.id, route.versionId);
      return;
   }
   // Album gallery/detail routes loaded directly (address bar / reload).
   if (route.name === "albums" || route.name === "album-detail") {
      applyRoute();
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
   // Glyph + label come from notation.js so the library card can never drift from
   // the editor's mode badge (♪ Chord Chart, # Nashville Numbers, ♬ ChordPro).
   const mode = normalizeEditorMode(song.latestEditorMode || song.editorMode);
   const modeGlyph = editorModeMeta[mode].cardMark;
   const modeTitle = editorModeMeta[mode].badge;
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
   // Modern skeleton loader: shimmer cards while the library is being fetched.
   setGalleryState("skeleton");
   renderSkeletonCards($("#songCards"));
   updateNudgeVisibility();
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

// Switch which home tab is visible (My Songs vs Albums) without navigating.
function setHomeTab(tab) {
   const isAlbums = tab === "albums";
   homeTab = isAlbums ? "albums" : "songs";
   const songsPanel = $("#songsPanel");
   const albumsPanel = $("#albumsPanel");
   const btnSongs = $("#tabMySongs");
   const btnAlbums = $("#tabAlbums");
   if (songsPanel) songsPanel.hidden = homeTab !== "songs";
   if (albumsPanel) albumsPanel.hidden = homeTab !== "albums";
   if (btnSongs) {
      btnSongs.classList.toggle("is-active", homeTab === "songs");
      btnSongs.setAttribute("aria-selected", homeTab === "songs" ? "true" : "false");
   }
   if (btnAlbums) {
      btnAlbums.classList.toggle("is-active", homeTab === "albums");
      btnAlbums.setAttribute("aria-selected", homeTab === "albums" ? "true" : "false");
   }
   // "New Song" and "Attach Link" are MY SONGS actions (starting your own score /
   // importing someone else's share link). Album songs are created from inside the
   // album itself (album detail → New Song), and the Albums tab carries its own
   // actions (New Album / Join with code), so both buttons are hidden there.
   const newSongBtn = $("#newSongBtn");
   const attachLinkBtn = $("#attachLinkBtn");
   if (newSongBtn) newSongBtn.hidden = isAlbums;
   if (attachLinkBtn) attachLinkBtn.hidden = isAlbums;
}

// Render the home screen (gallery). Called by the router; use navigate(HOME_ROUTE)
// from UI handlers so the URL stays in sync. `tab` selects which pane shows.
async function showGalleryScreen(tab) {
   // Gallery requires auth.
   if (!getCurrentUser() && !TEST_MODE) {
      showLoginPage();
      toast("Sign in to view your library");
      return;
   }
   if (tab) pendingHomeTab = tab;
   openModal($("#mySongsModal"));
   setHomeTab(pendingHomeTab);
   const search = $("#songSearch");
   if (search) search.value = "";
   await refreshSongs();
   if (pendingHomeTab === "albums" && !TEST_MODE) await refreshAlbums();
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
         if (!["chords", "numbers", "chordpro"].includes(mode)) return;
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
// ChordPro starts with TWO sections so the format is obvious at a glance: an Intro
// holding a chord progression, and a Verse showing chords over lyrics (same
// deletable-sample convention as the "Song Title" / "Artist / Composer" placeholders).
const CHORDPRO_INTRO_STARTER = "[C] [Am7] [Dm7] [G7] [Cmaj7]";
const CHORDPRO_VERSE_STARTER = "[C]Type your lyric here and wrap each [G]chord in square [Am]brackets [F]";

function blankProject(mode, { title = "New Song", artist = "Artist / Composer" } = {}) {
   const chordpro = normalizeEditorMode(mode) === "chordpro";
   return {
      format: "chord-sheet",
      version: 2,
      title,
      artist,
      key: "C",
      meter: "4/4",
      sections: chordpro
         ? [
              { name: "Intro", chordPro: CHORDPRO_INTRO_STARTER },
              { name: "Verse", chordPro: CHORDPRO_VERSE_STARTER },
           ]
         : [{ name: "Intro", bars: [] }],
      slashChords: [],
      editorMode: mode,
      lyricsEnabled: false, // lyrics start OFF in every mode; users opt in via the toggle
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
   // Album context drives topbar pill/banner/save-button labels (Fase 3/4).
   if (typeof syncAlbumContextUI === "function") syncAlbumContextUI();
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
   const versions = await listVersionsFor(ctx);
   if (!versions.length) {
      listEl.innerHTML = `<div class="version-list-empty">No versions yet — create one below.</div>`;
      return;
   }
   const canEditDetails = !(isAlbumCtx(ctx) && ctx.role !== "owner");
   listEl.innerHTML = versions
      .map((v) => {
         const current = v.versionId === ctx.versionId;
         const pending = bridge.getPendingVersionDetails?.() || null;
         const isPending = pending && pending.versionId === v.versionId;
         const name = escapeHtml((isPending && pending.label) || v.label || "Untitled");
         const ytIcon = (isPending ? pending.youtubeId : v.youtubeId) ? `<span class="version-item-yt" title="Has YouTube link">▶</span>` : "";
         const pendingDot = isPending ? `<span class="version-item-pending" title="Pending — save to cloud">●</span>` : "";
         const currentMark = current ? `<span class="version-item-current">Current</span>` : "";
         const editBtn = canEditDetails
            ? `<button class="version-item-edit" type="button" data-version-id="${escapeHtml(v.versionId)}" aria-label="Edit details" title="Edit details">✎</button>`
            : "";
         return `
            <div class="version-list-item${current ? " is-current" : ""}">
               <button class="version-item-switch" type="button" data-version-id="${escapeHtml(v.versionId)}" title="Open this version">
                  <span class="version-item-label">${name}${ytIcon}</span>
                  ${pendingDot}
                  ${currentMark}
               </button>
               ${editBtn}
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
         const meta = await loadSongMetaFor(ctx);
         const version = await loadVersionFor(ctx, versionId);
         bridge.applyProject(composeSong(meta, version));
         bridge.setCloudContext(nextCtx(ctx, { versionId, versionLabel: version.label || "" }));
         navigate(ctxEditorUrl({ ...ctx, versionId }));
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
   const mode = normalizeEditorMode(current?.editorMode);
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
         const created = await saveVersionFor(ctx, null, payload, { label: input.label });
         await updateLatestFor(ctx, created.versionId, created.label, 1, blank.editorMode, input.youtubeId, blank.key, blank.meter);
         bridge.applyProject(blank);
         bridge.setCloudContext(nextCtx(ctx, { versionId: created.versionId, versionLabel: created.label }));
         navigate(ctxEditorUrl({ ...ctx, versionId: created.versionId }));
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
         const count = (await listVersionsFor(ctx)).length;
         const input = await openVersionNameDialog({
            title: "New Version",
            desc: "Start a new, blank arrangement — it will not copy the current score.",
            defaultLabel: `Version ${count + 1}`,
         });
         if (!input) return;
         const payload = { ...blank, youtubeUrl: input.youtubeUrl, youtubeId: input.youtubeId };
         const created = await saveVersionFor(ctx, null, payload, { label: input.label });
         await updateLatestFor(ctx, created.versionId, created.label, count + 1, blank.editorMode, input.youtubeId, blank.key, blank.meter);
         bridge.applyProject(blank);
         bridge.setCloudContext(nextCtx(ctx, { versionId: created.versionId, versionLabel: created.label }));
         navigate(ctxEditorUrl({ ...ctx, versionId: created.versionId }));
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
      version = await loadVersionFor(ctx, versionId);
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
         await deleteVersionFor(ctx, versionId);
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
   // together with the next "Save" — until then a yellow badge on that button
   // reminds the user the version details were edited.
   bridge.setPendingVersionDetails({
      versionId,
      label: result.label,
      youtubeUrl: result.youtubeUrl,
      youtubeId: result.youtubeId,
   });
   bridge.markDirty();
   // Reflect the edit locally (without touching Firestore yet).
   if (ctx.versionId === versionId) {
      bridge.setCloudContext(nextCtx(ctx, { versionId, versionLabel: result.label }));
   }
   syncVersionPill();
   renderVersionList();
   toast("Version details pending — save to persist");
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
      const result = await deleteVersionFor(ctx, ctx.versionId);
      const meta = await loadSongMetaFor(ctx);
      if (result.versionId) {
         const version = await loadVersionFor(ctx, result.versionId);
         bridge.applyProject(composeSong(meta, version));
         bridge.setCloudContext(nextCtx(ctx, { versionId: result.versionId, versionLabel: version.label || "" }));
         navigate(ctxEditorUrl({ ...ctx, versionId: result.versionId }));
         toast("Version deleted");
      } else {
         // Last arrangement removed → song stays; the editor asks for a first version.
         bridge.applyProject(
            blankProject("chords", { title: meta.title || "Song Title", artist: meta.artist || "Artist / Composer" }),
         );
         bridge.setCloudContext(nextCtx(ctx, { versionId: null, versionLabel: "" }));
         navigate(ctxEditorUrl({ ...ctx, versionId: null }));
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
      // Themed confirm (identical to the album delete dialog).
      const confirmed = await openConfirmDialog({
         title: "Delete song?",
         message: `Delete "${title}"? This cannot be undone.`,
         confirmLabel: "Delete",
         cancelLabel: "Cancel",
         icon: "🗑",
         danger: true,
      });
      if (!confirmed) return;
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
   // Fallback: this button is hidden while the ALBUMS tab is active (see
   // setHomeTab) because album songs are created from inside the album. The
   // branch stays as a safety net in case the button is ever exposed there again
   // — it would then create the song DIRECTLY inside an album, not in My Songs.
   $("#newSongBtn")?.addEventListener("click", () => {
      if (homeTab === "albums") {
         openAlbumNewSongFromHome();
         return;
      }
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
// Persist a staged "version details" edit (rename / YouTube link) in the scope
// of the OPEN document: an album version is written to
// albums/{id}/songs/{id}/versions and a My Songs version to
// users/{uid}/songs/{id}/versions. Shared by BOTH branches of saveToCloud so a
// rename can never land in the wrong library, and the denormalized latest-*
// fields on the parent doc follow along.
async function persistPendingVersionDetails(ctx) {
   const pending = bridge.getPendingVersionDetails?.() || null;
   if (!pending?.versionId || !ctx?.songId) return null;
   const payload = { youtubeUrl: pending.youtubeUrl, youtubeId: pending.youtubeId };
   if (isAlbumCtx(ctx)) {
      await saveAlbumVersion(ctx.albumId, ctx.songId, pending.versionId, payload, { label: pending.label });
      const versions = await listAlbumVersions(ctx.albumId, ctx.songId);
      if (versions[0]?.versionId === pending.versionId) {
         await updateAlbumSongMeta(ctx.albumId, ctx.songId, {
            latestVersionLabel: pending.label,
            latestYoutubeId: pending.youtubeId || null,
         });
      }
   } else {
      await saveVersion(ctx.songId, pending.versionId, payload, { label: pending.label });
      const versions = await listVersions(ctx.songId);
      if (versions[0]?.versionId === pending.versionId) {
         await updateSongMeta(ctx.songId, {
            latestVersionLabel: pending.label,
            latestYoutubeId: pending.youtubeId || null,
         });
      }
   }
   if (ctx.versionId === pending.versionId) ctx.versionLabel = pending.label;
   bridge.setPendingVersionDetails(null);
   return pending;
}

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
      // Album scope (Fase 3/4): an OWNER saves in place; a MEMBER can only save a
      // private copy to their own library (the album itself stays read-only).
      // Deteksi album BERLAPIS — context → memo modul → URL saat ini — supaya
      // konteks album tidak pernah "hilang" hanya karena ctx/URL tertimpa oleh
      // alur lain (ganti versi, New Version, dst.). Selama sebuah album terbuka,
      // save TIDAK BOLEH jatuh ke cabang My Songs (apalagi membuat lagu baru di
      // My Songs).
      const route = parseRoute(location.hash);
      const activeAlbumId =
         (ctx.scope === "album" && ctx.albumId)
            ? ctx.albumId
            : activeAlbumCtx?.albumId
               ? activeAlbumCtx.albumId
               : route.name === "editor" && route.albumId
                  ? route.albumId
                  : null;
      if (activeAlbumId) {
         // Ambil role & nama album yang LIVE dari Firestore (bukan ctx.role yang
         // bisa basi/hilang) sebelum memutuskan arah penyimpanan.
         let role = ctx.role || activeAlbumCtx?.role || null;
         let albumName = ctx.albumName || activeAlbumCtx?.albumName || "Album";
         try {
            const album = await getAlbum(activeAlbumId);
            role = album.role;
            albumName = album.name || albumName;
         } catch (error) {
            toast("Could not load the album — please try again");
            return false;
         }
         if (role === "owner") {
            const next = await saveToAlbum(activeAlbumId, project, { songId: ctx.songId, versionId: ctx.versionId, versionLabel: ctx.versionLabel });
            const albumContext = { ...next, scope: "album", albumId: activeAlbumId, albumName, role: "owner" };
            // A staged version-details edit (rename / YouTube link) is persisted in
            // ALBUM scope here — never through the My Songs helpers.
            await persistPendingVersionDetails(albumContext);
            bridge.setCloudContext(albumContext);
            setActiveAlbumCtx(albumContext);
            syncVersionPill();
            bridge.markSaved();
            toast("Saved to album");
            return true;
         }
         const confirmed = await openConfirmDialog({
            title: "Save a copy to My Songs?",
            message: "You are viewing an album arrangement (read-only). Save a private copy to your own library so you can edit it freely.",
            confirmLabel: "Save a copy",
            cancelLabel: "Cancel",
            icon: "⧉",
         });
         if (!confirmed) return false;
         try {
            const copied = await copyAlbumSongToMySongs(activeAlbumId, ctx.songId, { preferVersionId: ctx.versionId || undefined });
            // The editor now owns the user's private COPY: move the context AND the
            // URL to My Songs, so later saves no longer target the album.
            bridge.setCloudContext({ songId: copied.songId, versionId: copied.versionId, versionLabel: copied.versionLabel });
            setActiveAlbumCtx(null);
            if (copied.songId) {
               navigate(
                  copied.versionId
                     ? `#/song/${encodeURIComponent(copied.songId)}/v/${encodeURIComponent(copied.versionId)}`
                     : `#/song/${encodeURIComponent(copied.songId)}/new`,
               );
            }
            syncVersionPill();
            bridge.markSaved();
            toast("Copied to your library");
            return true;
         } catch (error) {
            toast("Could not copy that song");
            return false;
         }
      }
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
            latestEditorMode: normalizeEditorMode(project.editorMode),
            latestKey: project.key || "",
            latestMeter: project.meter || "",
         });
      } else {
         // Brand-new song: metadata + its first version are created together.
         // Final assertion: reaching here with an album still in scope (context,
         // memo or URL) must be impossible — fail loudly instead of silently
         // creating a stray song in My Songs.
         if (ctx.albumId || activeAlbumCtx?.albumId || (route.name === "editor" && route.albumId)) {
            throw new Error("Album save salah arah diblokir — pastikan lagu dibuka dari Album.");
         }
         const createdSong = await createSong({ title, artist });
         const created = await saveVersion(createdSong.songId, null, project, { label: ctx.versionLabel || "Version 1" });
         await updateLatestVersion(createdSong.songId, created.versionId, created.label, 1, project.editorMode, undefined, project.key, project.meter);
         nextContext = { songId: createdSong.songId, versionId: created.versionId, versionLabel: created.label };
      }
      // Persist any staged version-details edit (name / YouTube link) together
      // with this "Save to Cloud" — scope-aware (My Songs here, album earlier).
      await persistPendingVersionDetails(nextContext);
      bridge.setCloudContext(nextContext);
      // This document is a My Songs song from now on: drop any album memo so a
      // later save can never be redirected into an album by stale state.
      setActiveAlbumCtx(null);
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
         setActiveAlbumCtx(null);
         toast("Signed out");
      } catch (error) {
         toast("Could not sign out");
      }
   });
}

// ======================================================================
// Public init
// ======================================================================
// ======================================================================
// ALBUM (Fase 3/4) — Albums tab, detail, join/invite/members + editor scope.
// ======================================================================
let albumInviteResolve = null; // invite dialog promise (null = closed)
let albumJoinResolve = null;
let newAlbumResolve = null;
let addSongResolve = null;
let membersResolve = null;
let chooseAlbumResolve = null; // New-Song-in-Album chooser promise
let chosenAlbumId = null;

function setAlbumsState(state) {
   // "loading" | "skeleton" | "empty" | "no-results" | "error" | "ready"
   const list = $("#albumsGalleryCards");
   const load = $("#albumsLoading");
   const empty = $("#albumsEmpty");
   const err = $("#albumsError");
   const none = $("#albumsNoResults");
   if (list) list.hidden = state !== "ready" && state !== "skeleton";
   if (load) load.hidden = state !== "loading";
   if (empty) empty.hidden = state !== "empty";
   if (err) err.hidden = state !== "error";
   if (none) none.hidden = state !== "no-results";
}

// Modern skeleton loader: shimmer placeholder cards shown while the library /
// albums are still being fetched. Replaced by the real cards on success.
const SKELETON_COUNT = 10;
function renderSkeletonCards(track, count = SKELETON_COUNT) {
   if (!track) return;
   track.innerHTML = Array.from({ length: count }, () => `
      <div class="skeleton-card" aria-hidden="true">
         <span class="sk-mark"></span>
         <span class="sk-title"></span>
         <span class="sk-sub"></span>
         <span class="sk-detail"></span>
         <span class="sk-footer"></span>
      </div>`).join("");
}

// Album cards use the SAME visual language as song cards (shares .song-card
// + .cloud-cards CSS → identical carousel look as the My Songs list).
// Recommended max characters for an album description shown on card hover;
// longer descriptions are truncated with an ellipsis (…).
const ALBUM_DESC_MAX = 500;

function albumCardMarkup(album) {
   const title = escapeHtml(album.name || "Untitled Album");
   const roleLabel = album.role === "owner" ? "Owner" : "Member · read-only";
   const count = `${album.songCount} song${album.songCount === 1 ? "" : "s"}`;
   const updated = album.updatedAt ? new Date(album.updatedAt).toLocaleDateString() : "";
   const detail = `updated ${escapeHtml(updated)}`;
   const actions = album.role === "owner"
      ? `<button class="song-card-action is-edit" type="button" data-act="edit" data-label="Open" title="Open album" aria-label="Open album ${title}">✎</button>
         <button class="song-card-action is-details" type="button" data-act="details" data-label="Edit details" title="Edit album name &amp; description" aria-label="Edit details of ${title}">📝</button>
         <button class="song-card-action is-delete" type="button" data-act="delete" data-label="Delete" title="Delete album" aria-label="Delete album ${title}">🗑</button>`
      : `<button class="song-card-action is-edit" type="button" data-act="edit" data-label="Open" title="Open album" aria-label="Open album ${title}">✎</button>`;
   // Description (revealed on hover/focus). If it reaches the max length the UI
   // shows an ellipsis; the FULL text stays available as a tooltip.
   const fullDesc = String(album.description || "").trim();
   const descSpan = fullDesc
      ? `<span class="song-card-desc-text" title="${escapeHtml(fullDesc)}">${escapeHtml(fullDesc.length > ALBUM_DESC_MAX ? `${fullDesc.slice(0, ALBUM_DESC_MAX)}…` : fullDesc)}</span>`
      : "";
   const metaLine = `<span class="song-card-meta-line">${escapeHtml(count)}${updated ? ` · ${detail}` : ""}</span>`;
   return `
      <article class="song-card is-album" role="listitem" tabindex="0" data-album-id="${escapeHtml(album.albumId)}"
         aria-label="Open album ${title}">
         <span class="song-card-mode-mark" aria-hidden="true">💿</span>
         <h3 class="song-card-title">${title}</h3>
         <div class="song-card-creator">${escapeHtml(roleLabel)}</div>
         <div class="song-card-detail">${descSpan}${metaLine}</div>
         <div class="song-card-dock">
            <div class="song-card-meta">
               <span class="song-card-chip is-version" title="Songs in this album"><small>Songs</small><strong>${album.songCount}</strong></span>
            </div>
            <div class="song-card-actions">${actions}</div>
         </div>
      </article>`;
}

function renderAlbums(list) {
   const grid = $("#albumsGalleryCards");
   if (!grid) return;
   grid.innerHTML = (list || []).map(albumCardMarkup).join("");
   updateAlbumEdgeBlur();
   updateAlbumNudgeVisibility();
}

// Carousel helpers (shared by the Albums tab AND the Album-detail song list) —
// mirrors of the My Songs updateEdgeBlur / updateNudgeVisibility / nudgeCarousel.
function nudgeVisFor(track, prev, next) {
   if (!track || !prev || !next) return;
   const overflow = track.scrollWidth - track.clientWidth;
   const many = overflow > 4;
   prev.hidden = !many || track.scrollLeft <= 2;
   next.hidden = !many || track.scrollLeft >= overflow - 2;
}
function edgeBlurFor(track) {
   if (!track) return;
   const cards = track.querySelectorAll(".song-card");
   if (!cards.length) return;
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
      const dist = Math.abs(r.left + r.width / 2 - mid);
      const t = Math.min(1, Math.max(0, dist - CLEAR_BAND) / BLUR_SPAN);
      card.style.setProperty("--blur", t <= 0 ? "0px" : `${(t * 4).toFixed(2)}px`);
      card.style.setProperty("--scale", `${(1 - t * 0.08).toFixed(3)}`);
      card.style.opacity = `${(1 - t * 0.45).toFixed(3)}`;
      const active = t <= 0.04;
      card.classList.toggle("is-dim", !active);
      card.setAttribute("aria-hidden", active ? "false" : "true");
      card.tabIndex = active ? 0 : -1;
   });
}
let activeAlbumScrollTimer = 0;
function nudgeFor(track, dir, refresh) {
   if (!track) return;
   const card = track.querySelector(".song-card");
   const step = ((card ? card.offsetWidth : 210) + 28) * 1.4;
   const max = track.scrollWidth - track.clientWidth;
   const from = track.scrollLeft;
   const to = Math.max(0, Math.min(max, from + dir * step));
   if (activeAlbumScrollTimer) clearInterval(activeAlbumScrollTimer);
   const start = Date.now();
   const dur = 300;
   const easeOut = (t) => 1 - Math.pow(1 - t, 3);
   activeAlbumScrollTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / dur);
      track.scrollLeft = from + (to - from) * easeOut(t);
      if (refresh) refresh();
      if (t >= 1) {
         clearInterval(activeAlbumScrollTimer);
         activeAlbumScrollTimer = 0;
      }
   }, 16);
}

// Albums tab carousel.
function updateAlbumNudgeVisibility() {
   nudgeVisFor($("#albumsGalleryCards"), $("#albumsGalleryPrev"), $("#albumsGalleryNext"));
}
function updateAlbumEdgeBlur() {
   edgeBlurFor($("#albumsGalleryCards"));
}
function nudgeAlbumsCarousel(dir) {
   nudgeFor($("#albumsGalleryCards"), dir, () => {
      updateAlbumEdgeBlur();
      updateAlbumNudgeVisibility();
   });
}
// Album-detail song list carousel.
function updateAlbumSongNudgeVisibility() {
   nudgeVisFor($("#albumSongCards"), $("#albumSongsGalleryPrev"), $("#albumSongsGalleryNext"));
}
function updateAlbumSongEdgeBlur() {
   edgeBlurFor($("#albumSongCards"));
}
function nudgeAlbumSongsCarousel(dir) {
   nudgeFor($("#albumSongCards"), dir, () => {
      updateAlbumSongEdgeBlur();
      updateAlbumSongNudgeVisibility();
   });
}

// Client-side filter over cachedAlbums — same behaviour as the My Songs search.
function applyAlbumFilter() {
   const term = ($("#albumSearch")?.value || "").trim().toLowerCase();
   const filtered = term
      ? cachedAlbums.filter(
           (a) =>
              (a.name || "").toLowerCase().includes(term) ||
              (a.description || "").toLowerCase().includes(term),
        )
      : cachedAlbums;
   if (!cachedAlbums.length) {
      setAlbumsState("empty");
      renderAlbums([]);
      return;
   }
   if (!filtered.length) {
      setAlbumsState("no-results");
      renderAlbums([]);
      return;
   }
   setAlbumsState("ready");
   renderAlbums(filtered);
}

async function refreshAlbums() {
   setAlbumsState("skeleton");
   renderSkeletonCards($("#albumsGalleryCards"));
   updateAlbumNudgeVisibility();
   try {
      cachedAlbums = await listAlbums();
      applyAlbumFilter();
   } catch (error) {
      setAlbumsState("error");
      const code = String(error?.code || "");
      const message = String(error?.message || error || "");
      console.error(`[cloudUI] listAlbums failed [code=${code}]`, error);
      const indexHint = /requires an index|failed.precondition|index/i.test(message) && !/permission/i.test(message)
         ? " Firebase Console → Firestore → Indexes → create the suggested index."
         : "";
      toast(
         `Could not load albums${isFirestorePermissionsError(error) ? " — check Firestore security rules." : " — check your connection and the Firestore security rules."}${indexHint}`,
      );
   }
}

function albumSongCardMarkup(song, role) {
   const key = escapeHtml(song.latestKey || song.key || "");
   const meter = escapeHtml(song.latestMeter || song.meter || "");
   const counts = typeof song.versionCount === "number" ? `${song.versionCount} version${song.versionCount === 1 ? "" : "s"}` : "";
   const isOwner = role === "owner";
   const actions = isOwner
      ? `<button class="song-card-action is-edit" type="button" data-act="edit" data-label="Edit" title="Edit" aria-label="Edit ${escapeHtml(song.title)}">✎</button>
         <button class="song-card-action is-pdf" type="button" data-act="pdf" data-label="Export .pdf" title="Export .pdf" aria-label="Export ${escapeHtml(song.title)} as PDF">↗</button>
         <button class="song-card-action is-delete" type="button" data-act="delete" data-label="Remove" title="Remove from album" aria-label="Remove ${escapeHtml(song.title)} from album">🗑</button>`
      : `<button class="song-card-action is-edit" type="button" data-act="edit" data-label="Open" title="Open" aria-label="Open ${escapeHtml(song.title)}">✎</button>
         <button class="song-card-action is-pdf" type="button" data-act="pdf" data-label="Export .pdf" title="Export .pdf" aria-label="Export ${escapeHtml(song.title)} as PDF">↗</button>
         <button class="song-card-action is-duplicate" type="button" data-act="copy" data-label="Save a copy" title="Save a copy to My Songs" aria-label="Save a copy of ${escapeHtml(song.title)}">⧉</button>`;
   return `
      <article class="song-card is-${normalizeEditorMode(song.latestEditorMode || song.editorMode)}" role="listitem" tabindex="0"
         data-id="${escapeHtml(song.cloudId)}" aria-label="${escapeHtml(song.title)}">
         <span class="song-card-mode-mark" aria-hidden="true">${
            editorModeMeta[normalizeEditorMode(song.latestEditorMode || song.editorMode)].cardMark
         }</span>
         <h3 class="song-card-title">${escapeHtml(song.title)}</h3>
         <div class="song-card-creator">${escapeHtml(song.artist || "Unknown")}</div>
         <div class="song-card-detail">${escapeHtml(counts)}</div>
         <div class="song-card-dock">
            <div class="song-card-meta">
               ${key ? `<span class="song-card-chip"><small>Key</small> ${key}</span>` : ""}
               ${meter ? `<span class="song-card-chip"><small>Time</small> ${meter}</span>` : ""}
            </div>
            <div class="song-card-actions">${actions}</div>
         </div>
      </article>`;
}

function setAlbumListState(state) {
   // "loading" | "empty" | "no-results" | "ready"
   const list = $("#albumSongCards");
   const load = $("#albumLoading");
   const empty = $("#albumEmpty");
   const none = $("#albumNoResults");
   if (list) list.hidden = state !== "ready";
   if (load) load.hidden = state !== "loading";
   if (empty) empty.hidden = state !== "empty";
   if (none) none.hidden = state !== "no-results";
}

function renderAlbumSongs(list) {
   const track = $("#albumSongCards");
   if (!track) return;
   const role = currentAlbum?.role || "member";
   track.innerHTML = list.map((song) => albumSongCardMarkup(song, role)).join("");
   setAlbumListState(list.length ? "ready" : "empty");
   updateAlbumSongEdgeBlur();
   updateAlbumSongNudgeVisibility();
   if (currentAlbum?.role === "member") {
      const hint = $("#albumEmptyHint");
      if (hint) hint.textContent = "No songs here yet — check back soon, or ask an owner to add arrangements.";
   }
}

function applyAlbumSongFilter() {
   const term = ($("#albumSongSearch")?.value || "").trim().toLowerCase();
   const filtered = term ? cachedAlbumSongs.filter((s) => (s.title || "").toLowerCase().includes(term)) : cachedAlbumSongs;
   if (!cachedAlbumSongs.length) {
      setAlbumListState("empty");
      renderAlbumSongs([]);
      return;
   }
   if (!filtered.length) {
      setAlbumListState("no-results");
      renderAlbumSongs([]);
      return;
   }
   setAlbumListState("ready");
   renderAlbumSongs(filtered);
}

async function refreshAlbumSongs() {
   setAlbumListState("loading");
   try {
      cachedAlbumSongs = await listAlbumSongs(currentAlbum.albumId);
      applyAlbumSongFilter();
   } catch (error) {
      setAlbumListState("empty");
      toast(isFirestorePermissionsError(error) ? "Could not load songs — check Firestore security rules" : "Could not load songs");
   }
}

function renderAlbumHeader() {
   const title = $("#albumTitle");
   const meta = $("#albumMeta");
   if (title) title.textContent = currentAlbum.name;
   if (meta) {
      const roleLabel = currentAlbum.role === "owner" ? "Owner" : "Member";
      const date = currentAlbum.createdAt ? new Date(currentAlbum.createdAt).toLocaleDateString() : "";
      meta.textContent = `${currentAlbum.songCount} song${currentAlbum.songCount === 1 ? "" : "s"} · ${roleLabel}${currentAlbum.role === "member" ? " · read-only" : ""}${date ? ` · created ${date}` : ""}`;
   }
   const isOwner = currentAlbum.role === "owner";
   const invite = $("#albumInviteBtn");
   const addFrom = $("#albumAddFromBtn");
   const newSong = $("#albumNewSongBtn");
   const leave = $("#albumLeaveBtn");
   const members = $("#albumMembersBtn");
   if (invite) invite.hidden = !isOwner;
   if (addFrom) addFrom.hidden = !isOwner;
   if (newSong) newSong.hidden = !isOwner;
   if (leave) leave.hidden = isOwner; // owners leave via the Members management
   if (members) members.hidden = false; // everyone may view the member list
}

async function openAlbumDetail(albumId) {
   const modal = $("#albumModal");
   if (!modal) return;
   closeModal($("#mySongsModal"));
   openModal(modal);
   document.documentElement.dataset.screen = "album-detail";
   currentAlbum = null;
   cachedAlbumSongs = [];
   try {
      currentAlbum = await getAlbum(albumId);
   } catch (error) {
      toast("Could not open that album");
      navigate("#/albums");
      return;
   }
   renderAlbumHeader();
   const search = $("#albumSongSearch");
   if (search) search.value = "";
   await refreshAlbumSongs();
}

function albumEditorUrl(albumId, songId, versionId) {
   if (!songId) return `#/album/${encodeURIComponent(albumId)}/new`;
   return versionId
      ? `#/album/${encodeURIComponent(albumId)}/${encodeURIComponent(songId)}/v/${encodeURIComponent(versionId)}`
      : `#/album/${encodeURIComponent(albumId)}/${encodeURIComponent(songId)}`;
}

// ---- Editor scope helpers: route version CRUD to the active scope ----
function isAlbumCtx(ctx) {
   return !!ctx && ctx.scope === "album" && !!ctx.albumId;
}
async function loadSongMetaFor(ctx) {
   return isAlbumCtx(ctx) ? loadAlbumSongMeta(ctx.albumId, ctx.songId) : loadSongMeta(ctx.songId);
}
async function loadVersionFor(ctx, versionId) {
   return isAlbumCtx(ctx) ? loadAlbumVersion(ctx.albumId, ctx.songId, versionId) : loadVersion(ctx.songId, versionId);
}
async function listVersionsFor(ctx) {
   return isAlbumCtx(ctx) ? listAlbumVersions(ctx.albumId, ctx.songId) : listVersions(ctx.songId);
}
async function saveVersionFor(ctx, versionId, data, opts) {
   return isAlbumCtx(ctx) ? saveAlbumVersion(ctx.albumId, ctx.songId, versionId, data, opts) : saveVersion(ctx.songId, versionId, data, opts);
}
async function deleteVersionFor(ctx, versionId) {
   return isAlbumCtx(ctx) ? deleteAlbumVersion(ctx.albumId, ctx.songId, versionId) : deleteVersion(ctx.songId, versionId);
}
async function updateLatestFor(ctx, versionId, label, count, editorMode, youtubeId, key, meter) {
   if (isAlbumCtx(ctx)) return updateAlbumLatestVersion(ctx.albumId, ctx.songId, versionId, label, count, editorMode, youtubeId, key, meter);
   return updateLatestVersion(ctx.songId, versionId, label, count, editorMode, youtubeId, key, meter);
}
// Preserve scope fields when updating the cloud context in the editor.
// `role` matters too: syncAlbumContextUI derives the pill/label/read-only state
// from it, and saveToCloud prefers the live role from Firestore but falls back
// to this one when the album read fails.
function nextCtx(ctx, patch) {
   if (isAlbumCtx(ctx)) {
      return {
         ...ctx,
         ...patch,
         scope: "album",
         albumId: ctx.albumId,
         albumName: ctx.albumName,
         role: ctx.role || null,
      };
   }
   return { ...ctx, ...patch };
}
// URL for the current version of the active context.
function ctxEditorUrl(ctx) {
   if (isAlbumCtx(ctx)) return albumEditorUrl(ctx.albumId, ctx.songId, ctx.versionId);
   return editorRoute();
}

// Open an album arrangement in the editor (owner edits in place; a member gets a
// read-only session + "Save a copy" action).
async function openAlbumSongInEditor(albumId, songId, versionId) {
   await guardUnsavedThen(async () => {
      try {
         let albumName = currentAlbum?.name || "";
         let role = currentAlbum?.role || "member";
         if (!currentAlbum) {
            try {
               const a = await getAlbum(albumId);
               albumName = a.name;
               role = a.role;
            } catch {
               /* fall back to member */
            }
         }
         const meta = await loadAlbumSongMeta(albumId, songId);
         if (meta.legacy) {
            bridge.applyProject(meta);
            bridge.setCloudContext({ scope: "album", albumId, albumName, songId, versionId: null, versionLabel: "", role });
            navigate(`#/album/${encodeURIComponent(albumId)}/${encodeURIComponent(songId)}`);
            toast(`Opened "${meta.title || "Untitled"}"`);
            return;
         }
         let version = null;
         if (versionId) version = await loadAlbumVersion(albumId, songId, versionId);
         else if (meta.latestVersionId) version = await loadAlbumVersion(albumId, songId, meta.latestVersionId);
         if (version) {
            bridge.applyProject(composeSong(meta, version));
            bridge.setCloudContext({ scope: "album", albumId, albumName, songId, versionId: version.versionId, versionLabel: version.label || "", role });
            navigate(albumEditorUrl(albumId, songId, version.versionId));
            toast(`Opened "${meta.title || "Untitled"}" — ${version.label || "Version"}`);
         } else {
            // No arrangements yet → require a version name first.
            const created = await openNewSongDialog({
               title: "Add First Version",
               desc: `"${meta.title || "Untitled"}" has no versions yet. Enter a version name, then pick a writing mode to start.`,
               defaultLabel: "Version 1",
            });
            if (!created) {
               navigate(`#/albums/${encodeURIComponent(albumId)}`);
               return;
            }
            bridge.applyProject(blankProject(created.mode, { title: meta.title || "Song Title", artist: meta.artist || "Artist / Composer" }));
            bridge.setCloudContext({ scope: "album", albumId, albumName, songId, versionId: null, versionLabel: created.label, role });
            navigate(albumEditorUrl(albumId, songId, null));
            toast(`Version "${created.label}" ready for "${meta.title || "Untitled"}"`);
         }
      } catch (error) {
         toast("Could not open that song");
      }
   });
}

// Owner starts a brand-new song DIRECTLY inside the album (no My Songs copy).
async function openAlbumNewSongFlow(albumId, { replaceHistory } = {}) {
   let album = currentAlbum;
   let albumName = currentAlbum?.name || "";
   let role = currentAlbum?.role || "member";
   if (!album) {
      try {
         album = await getAlbum(albumId);
         albumName = album.name;
         role = album.role;
      } catch {
         toast("Could not open that album");
         navigate("#/albums");
         return;
      }
   }
   const created = await openNewSongDialog({
      title: "New Song in Album",
      desc: `This song will be saved directly to "${albumName}" — your own library is not affected.`,
      defaultLabel: "Version 1",
   });
   if (!created) {
      if (!replaceHistory) navigate(`#/albums/${encodeURIComponent(albumId)}`);
      else navigate(HOME_ROUTE);
      return;
   }
   bridge.applyProject(blankProject(created.mode));
   bridge.setCloudContext({ scope: "album", albumId, albumName, songId: null, versionId: null, versionLabel: created.label, role });
   // A brand-new draft exists only in the editor — mark it unsaved from the start
   // (exactly like "New Song" in My Songs) so the yellow badge lights up on the
   // "Save to Album" button and leaving via Back / browser Back / reload runs the
   // unsaved-changes guard instead of silently dropping the new song.
   bridge.markDirty();
   navigate(albumEditorUrl(albumId, null, null));
   syncAlbumContextUI();
}

// "New Song" pressed while on the ALBUMS tab: create the song DIRECTLY inside an
// owned album (never touches My Songs). One owned album → go; several → ask.
async function openAlbumNewSongFromHome() {
   await guardUnsavedThen(async () => {
      let owned = [];
      try {
         owned = (await listAlbums()).filter((a) => a.role === "owner");
      } catch (error) {
         console.error("[cloudUI] listAlbums failed (New Song in album):", error);
         toast("Could not load your albums — please try again.");
         return;
      }
      if (!owned.length) {
         toast("You need an album first — create one, then songs can be saved directly to it.");
         await openNewAlbumDialog();
         return;
      }
      const album = owned.length === 1 ? owned[0] : await openChooseAlbumDialog(owned);
      if (!album) return;
      openAlbumNewSongFlow(album.albumId, { replaceHistory: false });
   });
}

// Pick which owned album receives a new song (shown only when owning several).
function closeChooseAlbumDialog(result) {
   const resolve = chooseAlbumResolve;
   chooseAlbumResolve = null;
   closeModal($("#chooseAlbumDialog"));
   resolve?.(result);
}
function openChooseAlbumDialog(albums) {
   const d = $("#chooseAlbumDialog");
   const list = $("#chooseAlbumList");
   if (!d) return Promise.resolve(null);
   if (chooseAlbumResolve) { const prev = chooseAlbumResolve; chooseAlbumResolve = null; prev(null); }
   chosenAlbumId = null;
   if (list) {
      list.innerHTML = albums
         .map(
            (a, i) => `<label class="add-song-option">
                 <input type="radio" name="chooseAlbumChoice" value="${escapeHtml(a.albumId)}" ${i === 0 ? "checked" : ""} />
                 <span class="add-song-option-text">
                    <strong>${escapeHtml(a.name)}</strong>
                    <small>${a.songCount} song${a.songCount === 1 ? "" : "s"} · Owner</small>
                 </span>
              </label>`,
         )
         .join("");
      list.querySelectorAll('input[name="chooseAlbumChoice"]').forEach((r) =>
         r.addEventListener("change", () => { chosenAlbumId = r.value; }),
      );
      const first = list.querySelector('input[name="chooseAlbumChoice"]');
      chosenAlbumId = first ? first.value : null;
   }
   return new Promise((resolve) => {
      chooseAlbumResolve = resolve;
      openModal(d);
   });
}
async function submitChooseAlbum() {
   const album = chosenAlbumId ? cachedAlbums.find((a) => a.albumId === chosenAlbumId) || { albumId: chosenAlbumId } : null;
   closeChooseAlbumDialog(album || null);
}

// Reflect the active album context in the editor topbar: a context pill and (for
// members) a read-only banner + a "Save a copy" affordance instead of "Save".
function syncAlbumContextUI() {
   const ctx = bridge.getCloudContext?.() || null;
   const isAlbum = isAlbumCtx(ctx);
   // Keep the album memo in sync with the OPEN document (see activeAlbumCtx):
   // an album-scoped context arms it, anything else (My Songs song or a fresh
   // draft) clears it. Doing it here means no call site can forget it.
   if (isAlbum) setActiveAlbumCtx({ albumId: ctx.albumId, albumName: ctx.albumName, role: ctx.role });
   else setActiveAlbumCtx(null);
   // Role yang belum termuat (null) TIDAK boleh diasumsikan sebagai "member":
   // kalau role hilang, tampilan tetap netral dan saveToCloud akan mengambil
   // role LIVE dari Firestore saat penyimpanan (owner selalu tersimpan ke Album).
   const role = ctx?.role || null;
   const isMember = role === "member";
   const isOwner = role === "owner";
   const name = ctx?.albumName || "Album";
   // Members of an album get a READ-ONLY chord canvas in the editor (events.js
   // checks this flag on every chord-entry path).
   document.body.dataset.memberReadonly = isAlbum && isMember ? "1" : "0";
   const pill = $("#albumPill");
   const pillText = $("#albumPillText");
   if (pill && pillText) {
      pill.hidden = !isAlbum;
      pillText.textContent = isAlbum ? (isOwner ? `Album: ${name}` : isMember ? `Album (read-only): ${name}` : `Album: ${name}`) : "";
      pill.classList.toggle("is-readonly", isAlbum && isMember);
   }
   const banner = $("#albumReadOnlyBanner");
   if (banner) banner.hidden = !(isAlbum && isMember);
   const saveBtn = $("#saveCloudBtn");
   if (saveBtn) {
      const label = isAlbum ? (isMember ? "Save a copy" : "Save to Album") : "Save to Cloud";
      saveBtn.innerHTML = `<span aria-hidden="true">⤒</span> ${label}`;
      saveBtn.setAttribute("data-save-label", label);
      saveBtn.title = label;
   }
   // Version management is owner-only inside an album.
   const newVersionBtn = $("#versionNewBtn");
   if (newVersionBtn) newVersionBtn.hidden = isAlbum && role !== "owner";
   // Back button keeps the generic "← Back" label (album detail has its own
// "← Albums" button); the tooltip stays descriptive.
   const backBtn = $("#backToSongsBtn");
   if (backBtn) {
      // Set the whole content explicitly — never touch "a text node", because
      // the FIRST text node is the whitespace before the arrow (which caused a
      // duplicate "Back" label).
      backBtn.innerHTML = `<span aria-hidden="true">←</span> Back`;
      backBtn.title = isAlbum ? "Back to album songs" : "Back to My Songs";
   }
   // The button label just changed ("Save to Album" / "Save a copy"), so refresh
   // the unsaved-changes badge + its accessible label for the ACTIVE scope.
   updateSaveButtonDirty(bridge.hasUnsavedChanges?.() ?? false);
}

// ---- Join album dialog ----
function closeJoinAlbumDialog(result) {
   const resolve = albumJoinResolve;
   albumJoinResolve = null;
   closeModal($("#joinAlbumDialog"));
   resolve?.(result);
}
function openJoinAlbumDialog() {
   const d = $("#joinAlbumDialog");
   const input = $("#joinAlbumCode");
   const err = $("#joinAlbumError");
   if (!d) return Promise.resolve(null);
   if (albumJoinResolve) { const prev = albumJoinResolve; albumJoinResolve = null; prev(null); }
   if (input) { input.value = ""; input.classList.remove("is-invalid"); }
   if (err) err.hidden = true;
   return new Promise((resolve) => {
      albumJoinResolve = resolve;
      openModal(d);
      setTimeout(() => input?.focus(), 60);
   });
}
async function submitJoinAlbum() {
   const input = $("#joinAlbumCode");
   const err = $("#joinAlbumError");
   const code = (input?.value || "").trim();
   if (!normalizeInviteCode(code)) {
      if (err) { err.textContent = "Enter an 8-character code like ABCD-1234."; err.hidden = false; }
      input?.classList.add("is-invalid");
      return;
   }
   try {
      const result = await joinAlbum(code);
      closeJoinAlbumDialog(result);
      toast(result.alreadyMember ? "You are already a member of that album." : "Joined the album!");
      if (result.albumId) navigate(`#/albums/${encodeURIComponent(result.albumId)}`);
      else await refreshAlbums();
   } catch (error) {
      if (err) { err.textContent = error?.message || "Could not join that album."; err.hidden = false; }
      input?.classList.add("is-invalid");
   }
}

// ---- New album dialog ----
function closeNewAlbumDialog(result) {
   const resolve = newAlbumResolve;
   newAlbumResolve = null;
   closeModal($("#newAlbumDialog"));
   resolve?.(result);
}
function openNewAlbumDialog() {
   const d = $("#newAlbumDialog");
   if (!d) return Promise.resolve(null);
   if (newAlbumResolve) { const prev = newAlbumResolve; newAlbumResolve = null; prev(null); }
   const name = $("#newAlbumName");
   const err = $("#newAlbumNameError");
   const desc = $("#newAlbumDesc");
   if (name) { name.value = ""; name.classList.remove("is-invalid"); }
   if (err) err.hidden = true;
   if (desc) desc.value = "";
   return new Promise((resolve) => {
      newAlbumResolve = resolve;
      openModal(d);
      setTimeout(() => name?.focus(), 60);
   });
}
async function submitNewAlbum() {
   const name = $("#newAlbumName");
   const err = $("#newAlbumNameError");
   const desc = $("#newAlbumDesc");
   const title = (name?.value || "").trim();
   if (!title) {
      if (err) err.hidden = false;
      name?.classList.add("is-invalid");
      name?.focus();
      return;
   }
   try {
      const { albumId } = await createAlbum({ name: title, description: desc?.value || "" });
      closeNewAlbumDialog({ albumId });
      toast("Album created — invite your team from the Invite button.");
      navigate(`#/albums/${encodeURIComponent(albumId)}`);
   } catch (error) {
      console.error("[cloudUI] createAlbum failed:", error);
      if (err) { err.textContent = "Could not create the album."; err.hidden = false; }
      toast(isFirestorePermissionsError(error) ? "Create blocked — check Firestore security rules" : "Could not create the album — try again");
   }
}

// ---- Edit album dialog (owners) ----
// Opened by the pencil action on an album card. This is intentionally its OWN
// dialog instead of switching the New Album dialog into an "edit" mode, so the
// create flow (prefill, autofocus, validation, navigation) stays untouched.
// It prefills the CURRENT values and writes through updateAlbum(); songs,
// members and invite codes are never touched.
let editAlbumResolve = null;
let editAlbumId = null;
function closeEditAlbumDialog(result) {
   const resolve = editAlbumResolve;
   const id = editAlbumId;
   editAlbumResolve = null;
   editAlbumId = null;
   closeModal($("#editAlbumDialog"));
   resolve?.(result ? { ...result, albumId: id } : null);
}
function openEditAlbumDialog(albumId) {
   const d = $("#editAlbumDialog");
   if (!d) return Promise.resolve(null);
   const album = cachedAlbums.find((a) => a.albumId === albumId) || null;
   if (!album) {
      toast("Could not open that album for editing");
      return Promise.resolve(null);
   }
   if (editAlbumResolve) { const prev = editAlbumResolve; editAlbumResolve = null; prev(null); }
   const name = $("#editAlbumName");
   const err = $("#editAlbumNameError");
   const desc = $("#editAlbumDesc");
   if (name) { name.value = album.name || ""; name.classList.remove("is-invalid"); }
   if (err) err.hidden = true;
   if (desc) desc.value = album.description || "";
   editAlbumId = albumId;
   return new Promise((resolve) => {
      editAlbumResolve = resolve;
      openModal(d);
      setTimeout(() => name?.focus(), 60);
   });
}
async function submitEditAlbum() {
   const albumId = editAlbumId;
   if (!albumId) return;
   const name = $("#editAlbumName");
   const err = $("#editAlbumNameError");
   const desc = $("#editAlbumDesc");
   const title = (name?.value || "").trim();
   if (!title) {
      if (err) { err.textContent = "Album name is required."; err.hidden = false; }
      name?.classList.add("is-invalid");
      name?.focus();
      return;
   }
   try {
      await updateAlbum(albumId, { name: title, description: desc?.value || "" });
      // Keep the album detail view (if it is open in memory) and the card list in
      // sync — the cards read name/description from cachedAlbums.
      if (currentAlbum?.albumId === albumId) {
         currentAlbum.name = title;
         currentAlbum.description = desc?.value || "";
         renderAlbumHeader();
      }
      closeEditAlbumDialog({ name: title });
      toast("Album updated");
      await refreshAlbums();
   } catch (error) {
      console.error("[cloudUI] updateAlbum failed:", error);
      if (err) { err.textContent = "Could not save the album."; err.hidden = false; }
      toast(
         isFirestorePermissionsError(error)
            ? "Save blocked — check Firestore security rules"
            : "Could not update the album — try again",
      );
   }
}

// ---- Invite dialog (owners) ----
function closeInviteDialog() {
   const resolve = albumInviteResolve;
   albumInviteResolve = null;
   closeModal($("#inviteDialog"));
   resolve?.(true);
}
async function refreshInviteCodeIntoDialog(andCopy) {
   try {
      const code = (await getInviteCode(currentAlbum.albumId)) || null;
      const value = $("#inviteCodeValue");
      if (value) value.textContent = code || "—";
      if (code && andCopy) {
         const ok = await copyTextToClipboard(code);
         if (ok) toast("Invite code copied!");
      }
   } catch {
      const value = $("#inviteCodeValue");
      if (value) value.textContent = "—";
   }
}
async function openInviteDialog() {
   const d = $("#inviteDialog");
   if (!d) return;
   if (albumInviteResolve) { const prev = albumInviteResolve; albumInviteResolve = null; prev(true); }
   openModal(d);
   albumInviteResolve = new Promise(() => {});
   await refreshInviteCodeIntoDialog(false);
}
async function rotateInviteInDialog() {
   if (!currentAlbum) return;
   const confirmed = await openConfirmDialog({
      title: "Create a new code?",
      message: "The current invite code will stop working immediately.",
      confirmLabel: "Create new code",
      cancelLabel: "Cancel",
      icon: "↻",
   });
   if (!confirmed) return;
   try {
      await rotateInviteCode(currentAlbum.albumId);
      await refreshInviteCodeIntoDialog(true);
      toast("New invite code created and copied!");
   } catch {
      toast("Could not create a new code");
   }
}

// ---- Add song to album dialog (owners) ----
function closeAddSongDialog(result) {
   const resolve = addSongResolve;
   addSongResolve = null;
   closeModal($("#addSongDialog"));
   resolve?.(result);
}
// All My Songs loaded for the Add dialog (kept for client-side search filtering).
let addSongDialogSongs = [];

async function openAddSongDialog() {
   const d = $("#addSongDialog");
   if (!d) return;
   if (addSongResolve) { const prev = addSongResolve; addSongResolve = null; prev(null); }
   albumSelectedSongId = null;
   const search = $("#addSongSearch");
   if (search) search.value = "";
   addSongDialogSongs = await listSongs();
   applyAddSongFilter();
   openModal(d);
}

// Filter the Add-from-My-Songs list by the in-dialog search field.
function applyAddSongFilter() {
   const list = $("#addSongList");
   const empty = $("#addSongEmpty");
   const term = ($("#addSongSearch")?.value || "").trim().toLowerCase();
   if (list) list.innerHTML = "";
   if (!addSongDialogSongs.length) {
      if (empty) { empty.textContent = "Your library is empty — save a song first, or create one directly in the album."; empty.hidden = false; }
      return;
   }
   const filtered = term
      ? addSongDialogSongs.filter((s) => (s.title || "").toLowerCase().includes(term) || (s.artist || "").toLowerCase().includes(term))
      : addSongDialogSongs;
   if (!filtered.length) {
      if (empty) { empty.textContent = "No songs match your search."; empty.hidden = false; }
      return;
   }
   if (empty) empty.hidden = true;
   if (list) {
      list.innerHTML = filtered
         .map(
            (s, i) => `<label class="add-song-option">
                 <input type="radio" name="addSongChoice" value="${escapeHtml(s.cloudId)}" ${i === 0 ? "checked" : ""} />
                 <span class="add-song-option-text">
                    <strong>${escapeHtml(s.title)}</strong>
                    <small>${escapeHtml(s.artist || "Unknown")}</small>
                 </span>
              </label>`,
         )
         .join("");
      list.querySelectorAll('input[name="addSongChoice"]').forEach((r) =>
         r.addEventListener("change", () => { albumSelectedSongId = r.value; }),
      );
      const first = list.querySelector('input[name="addSongChoice"]');
      albumSelectedSongId = first ? first.value : null;
   }
}
async function submitAddSong() {
   if (!currentAlbum || !albumSelectedSongId) return;
   try {
      const result = await addSongToAlbum(currentAlbum.albumId, albumSelectedSongId);
      const count = Number(result?.versionCount) || 0;
      closeAddSongDialog({ added: true });
      toast(count > 1 ? `Added to the album — ${count} versions copied` : "Song added to the album");
      await refreshAlbumSongs();
      renderAlbumHeader();
   } catch (error) {
      toast("Could not add that song");
   }
}

// ---- Members dialog ----
function closeMembersDialog() {
   const resolve = membersResolve;
   membersResolve = null;
   closeModal($("#albumMembersDialog"));
   resolve?.(true);
}
async function openMembersDialog() {
   const d = $("#albumMembersDialog");
   const list = $("#memberList");
   const desc = $("#albumMembersDesc");
   if (!d) return;
   if (membersResolve) { const prev = membersResolve; membersResolve = null; prev(true); }
   const isOwner = currentAlbum?.role === "owner";
   const meUid = getCurrentUser()?.uid;
   try {
      const members = await listMembers(currentAlbum.albumId);
      // Owners first (creation order), then members (join order).
      const rank = (m) => (m.role === "owner" ? 0 : 1);
      members.sort((a, b) => rank(a) - rank(b) || Number(a.joinedAt || 0) - Number(b.joinedAt || 0));
      const ownerCount = members.filter((m) => m.role === "owner").length;
      const memberCount = members.length - ownerCount;
      if (desc) {
         desc.textContent = `${ownerCount} owner${ownerCount === 1 ? "" : "s"}${memberCount ? ` · ${memberCount} member${memberCount === 1 ? "" : "s"}` : ""} — ${isOwner ? "you can change roles and remove members." : "owners can change roles and remove members."}`;
      }
      if (list) {
         list.innerHTML = members
            .map((m) => {
               const isOwnerRow = m.role === "owner";
               const self = m.uid === meUid;
               const you = self ? `<em class="member-you">(you)</em>` : "";
               const chip = `<span class="member-role-chip ${isOwnerRow ? "is-owner" : "is-member"}">${isOwnerRow ? "⭐ Owner" : "Member"}</span>`;
               let controls = "";
               if (isOwner && !self) {
                  const roleBtn = isOwnerRow
                     ? `<button class="button button-ghost button-small" data-member-action="demote" data-uid="${escapeHtml(m.uid)}" type="button" title="Change to a read-only member">↓ Member</button>`
                     : `<button class="button button-ghost button-small" data-member-action="promote" data-uid="${escapeHtml(m.uid)}" type="button" title="Promote to co-owner">⭐ Co-owner</button>`;
                  const removeBtn = `<button class="button button-ghost button-small is-danger" data-member-action="remove" data-uid="${escapeHtml(m.uid)}" type="button" title="Remove from album">🗑 Remove</button>`;
                  controls = `<div class="member-controls">${chip}${roleBtn}${removeBtn}</div>`;
               } else {
                  controls = chip;
               }
               // Name shown for a member: Auth displayName (Google) → derived from
               // the email local part (email/password sign-up has no displayName)
               // → "Musician" as the last resort. The email stays visible below.
               const derived = friendlyName(m);
               const memberName = derived || "Musician";
               const avatarInitial = (derived || m.email || "?").trim().charAt(0).toUpperCase();
               return `<div class="member-row" data-uid="${escapeHtml(m.uid)}">
                       <span class="member-avatar" aria-hidden="true">${escapeHtml(avatarInitial)}</span>
                       <span class="member-who">
                          <strong>${escapeHtml(memberName)} ${you}</strong>
                          <small>${escapeHtml(m.email || "—")}</small>
                       </span>
                       ${controls}
                    </div>`;
            })
            .join("");
         list.querySelectorAll("[data-member-action]").forEach((btn) => {
            btn.addEventListener("click", (event) => {
               event.stopPropagation();
               handleMemberAction(btn.dataset.memberAction, btn.dataset.uid, members);
            });
         });
      }
   } catch (error) {
      console.error("[cloudUI] listMembers failed:", error);
      if (desc) desc.textContent = "Could not load members.";
      if (list) list.innerHTML = "";
   }
   openModal(d);
}
async function handleMemberAction(action, uid, members) {
   if (!currentAlbum) return;
   const member = members.find((m) => m.uid === uid);
   if (!member) return;
   const name = member.name || member.email || "this member";
   let confirmed = false;
   if (action === "promote") {
      confirmed = await openConfirmDialog({ title: "Make co-owner?", message: `${name} will get full owner access (edit songs, invite, manage members).`, confirmLabel: "Make co-owner", cancelLabel: "Cancel", icon: "⭐" });
   } else if (action === "demote") {
      confirmed = await openConfirmDialog({ title: "Change to member?", message: `${name} will become a read-only member.`, confirmLabel: "Make member", cancelLabel: "Cancel", icon: "↓" });
   } else if (action === "remove") {
      confirmed = await openConfirmDialog({ title: "Remove member?", message: `${name} will lose access to this album.`, confirmLabel: "Remove", cancelLabel: "Cancel", icon: "🗑", danger: true });
   }
   if (!confirmed) return;
   try {
      if (action === "promote") await setMemberRole(currentAlbum.albumId, uid, "owner");
      else if (action === "demote") await setMemberRole(currentAlbum.albumId, uid, "member");
      else if (action === "remove") await removeMember(currentAlbum.albumId, uid);
      toast("Members updated");
      await openMembersDialog();
   } catch (error) {
      toast("Could not update the member");
   }
}

// ---- Leave album (members) ----
async function confirmLeaveAlbum() {
   if (!currentAlbum) return;
   const confirmed = await openConfirmDialog({
      title: "Leave album?",
      message: `You will lose access to "${currentAlbum.name}". You can join again with an invite code.`,
      confirmLabel: "Leave album",
      cancelLabel: "Cancel",
      icon: "⇥",
      danger: true,
   });
   if (!confirmed) return;
   try {
      await leaveAlbum(currentAlbum.albumId);
      closeModal($("#albumModal"));
      toast("You left the album");
      navigate("#/albums");
   } catch (error) {
      toast(error?.message || "Could not leave the album");
   }
}

// ---- Delete album (owners, from the album list) ----
async function confirmDeleteAlbum(album) {
   if (!album?.albumId) return;
   const confirmed = await openConfirmDialog({
      title: "Delete album?",
      message: `"${album.name}" and all its songs will be permanently deleted for everyone.`,
      confirmLabel: "Delete album",
      cancelLabel: "Cancel",
      icon: "🗑",
      danger: true,
   });
   if (!confirmed) return;
   try {
      await deleteAlbum(album.albumId);
      closeModal($("#albumModal"));
      toast("Album deleted");
      navigate("#/albums");
   } catch (error) {
      toast("Could not delete the album");
   }
}

// ---- Wire album UI: tabs, buttons, card grids, dialogs ----
function initAlbums() {
   // Home tabs.
   const tabSongs = $("#tabMySongs");
   const tabAlbums = $("#tabAlbums");
   tabSongs?.addEventListener("click", () => navigate("#/songs"));
   tabAlbums?.addEventListener("click", () => navigate("#/albums"));

   // Albums tab actions.
   // Prevent wheel-scrolling while the pointer is over the Albums toolbar.
   document.querySelector(".albums-searchbar")?.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
   $("#newAlbumBtn")?.addEventListener("click", openNewAlbumDialog);
   $("#joinAlbumBtn")?.addEventListener("click", openJoinAlbumDialog);
   $("#albumSearch")?.addEventListener("input", applyAlbumFilter);
   // Albums tab carousel — same interaction model as the My Songs gallery.
   const albumsTrack = $("#albumsGalleryCards");
   albumsTrack?.addEventListener("click", (e) => {
      const actionBtn = e.target.closest(".song-card-action");
      const card = e.target.closest(".song-card");
      if (!card) return;
      const albumId = card.dataset.albumId;
      if (actionBtn) {
         e.stopPropagation();
         const act = actionBtn.dataset.act;
         if (act === "edit") navigate(`#/albums/${encodeURIComponent(albumId)}`);
         else if (act === "details") openEditAlbumDialog(albumId);
         else if (act === "delete") {
            const album = cachedAlbums.find((a) => a.albumId === albumId);
            if (album) confirmDeleteAlbum(album);
         }
         return;
      }
      // Phones: tap reveals the action overlay; opening is the explicit Edit tap.
      if (window.matchMedia("(max-width: 680px)").matches) {
         const wasSelected = card.classList.contains("is-selected");
         document.querySelectorAll("#albumsGalleryCards .song-card.is-selected").forEach((c) => c.classList.remove("is-selected"));
         if (!wasSelected) card.classList.add("is-selected");
         return;
      }
      navigate(`#/albums/${encodeURIComponent(albumId)}`);
   });
   // Phones: tapping off a card dismisses its action overlay.
   $("#albumsPanel")?.addEventListener("click", (e) => {
      if (!window.matchMedia("(max-width: 680px)").matches) return;
      if (e.target.closest(".song-card")) return;
      document.querySelectorAll("#albumsGalleryCards .song-card.is-selected").forEach((c) => c.classList.remove("is-selected"));
   });
   // Keyboard + nudge buttons + live edge-blur (identical to My Songs).
   albumsTrack?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); nudgeAlbumsCarousel(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); nudgeAlbumsCarousel(-1); }
      else if (e.key === "Enter" || e.key === " ") {
         const card = e.target.closest(".song-card");
         if (card) { e.preventDefault(); navigate(`#/albums/${encodeURIComponent(card.dataset.albumId)}`); }
      }
   });
   $("#albumsGalleryPrev")?.addEventListener("click", () => nudgeAlbumsCarousel(-1));
   $("#albumsGalleryNext")?.addEventListener("click", () => nudgeAlbumsCarousel(1));
   albumsTrack?.addEventListener("scroll", () => { updateAlbumEdgeBlur(); updateAlbumNudgeVisibility(); }, { passive: true });
   window.addEventListener("resize", () => { updateAlbumEdgeBlur(); updateAlbumNudgeVisibility(); });

   // Album detail header actions.
   $("#albumBackBtn")?.addEventListener("click", () => navigate("#/albums"));
   $("#albumInviteBtn")?.addEventListener("click", openInviteDialog);
   $("#albumMembersBtn")?.addEventListener("click", openMembersDialog);
   $("#albumAddFromBtn")?.addEventListener("click", openAddSongDialog);
   // New Song inside the open album. Guarded like the My Songs "New Song" button
   // so unsaved edits on the currently open arrangement can't be discarded
   // silently (a new album song opens as an unsaved draft).
   $("#albumNewSongBtn")?.addEventListener("click", () => {
      if (!currentAlbum) return;
      guardUnsavedThen(() => openAlbumNewSongFlow(currentAlbum.albumId));
   });
   $("#albumLeaveBtn")?.addEventListener("click", confirmLeaveAlbum);

   // Album song list (delegated): card opens editor; actions handle the rest.
   const albumTrack = $("#albumSongCards");
   const role = () => currentAlbum?.role || "member";
   albumTrack?.addEventListener("click", (e) => {
      const actionBtn = e.target.closest(".song-card-action");
      const card = e.target.closest(".song-card");
      if (!card) return;
      if (card.classList.contains("is-dim")) return; // blurred cards aren't interactive
      if (actionBtn) {
         e.stopPropagation();
         const act = actionBtn.dataset.act;
         if (act === "edit") openAlbumSongInEditor(currentAlbum.albumId, card.dataset.id);
         else if (act === "pdf") openAlbumSongPdf(card.dataset.id);
         else if (act === "delete") confirmRemoveAlbumSong(card.dataset.id);
         else if (act === "copy") copyAlbumSong(card.dataset.id);
         return;
      }
      // Phones: tap reveals the action overlay; opening is the explicit Edit tap.
      if (window.matchMedia("(max-width: 680px)").matches) {
         const wasSelected = card.classList.contains("is-selected");
         document.querySelectorAll("#albumSongCards .song-card.is-selected").forEach((c) => c.classList.remove("is-selected"));
         if (!wasSelected) card.classList.add("is-selected");
         return;
      }
      openAlbumSongInEditor(currentAlbum.albumId, card.dataset.id);
   });
   // Phones: tapping off a card dismisses its action overlay.
   $("#albumModal")?.addEventListener("click", (e) => {
      if (!window.matchMedia("(max-width: 680px)").matches) return;
      if (e.target.closest(".song-card")) return;
      document.querySelectorAll("#albumSongCards .song-card.is-selected").forEach((c) => c.classList.remove("is-selected"));
   });
   // Keyboard + nudge buttons + live edge-blur (identical to the home carousels).
   albumTrack?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); nudgeAlbumSongsCarousel(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); nudgeAlbumSongsCarousel(-1); }
      else if (e.key === "Enter" || e.key === " ") {
         const card = e.target.closest(".song-card");
         if (card && !card.classList.contains("is-dim")) {
            e.preventDefault();
            openAlbumSongInEditor(currentAlbum.albumId, card.dataset.id);
         }
      }
   });
   $("#albumSongsGalleryPrev")?.addEventListener("click", () => nudgeAlbumSongsCarousel(-1));
   $("#albumSongsGalleryNext")?.addEventListener("click", () => nudgeAlbumSongsCarousel(1));
   albumTrack?.addEventListener("scroll", () => { updateAlbumSongEdgeBlur(); updateAlbumSongNudgeVisibility(); }, { passive: true });
   window.addEventListener("resize", () => { updateAlbumSongEdgeBlur(); updateAlbumSongNudgeVisibility(); });
   $("#albumSongSearch")?.addEventListener("input", applyAlbumSongFilter);

   // Join dialog.
   $("#joinAlbumOk")?.addEventListener("click", submitJoinAlbum);
   $("#joinAlbumCancel")?.addEventListener("click", () => closeJoinAlbumDialog(null));
   $("#joinAlbumDialog")?.addEventListener("click", (e) => { if (e.target.closest("[data-joinalbum-dismiss]")) closeJoinAlbumDialog(null); });
   $("#joinAlbumCode")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitJoinAlbum(); });

   // New album dialog.
   $("#newAlbumOk")?.addEventListener("click", submitNewAlbum);
   $("#newAlbumCancel")?.addEventListener("click", () => closeNewAlbumDialog(null));
   $("#newAlbumDialog")?.addEventListener("click", (e) => { if (e.target.closest("[data-newalbum-dismiss]")) closeNewAlbumDialog(null); });

   // Edit album dialog (album-card pencil action, owners only). Enter in the name
   // field saves, mirroring the join dialog's code field.
   $("#editAlbumOk")?.addEventListener("click", submitEditAlbum);
   $("#editAlbumCancel")?.addEventListener("click", () => closeEditAlbumDialog(null));
   $("#editAlbumDialog")?.addEventListener("click", (e) => { if (e.target.closest("[data-editalbum-dismiss]")) closeEditAlbumDialog(null); });
   $("#editAlbumName")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitEditAlbum(); } });

   // Invite dialog.
   $("#inviteDialogClose")?.addEventListener("click", closeInviteDialog);
   $("#inviteCodeCopy")?.addEventListener("click", () => refreshInviteCodeIntoDialog(true));
   $("#inviteCodeRotate")?.addEventListener("click", rotateInviteInDialog);
   $("#inviteDialog")?.addEventListener("click", (e) => { if (e.target.closest("[data-invite-dismiss]")) closeInviteDialog(); });

   // Add-song dialog.
   $("#addSongSearch")?.addEventListener("input", applyAddSongFilter);
   $("#addSongOk")?.addEventListener("click", submitAddSong);
   $("#addSongCancel")?.addEventListener("click", () => closeAddSongDialog(null));
   $("#addSongDialog")?.addEventListener("click", (e) => { if (e.target.closest("[data-addsong-dismiss]")) closeAddSongDialog(null); });

   // Members dialog.
   $("#albumMembersClose")?.addEventListener("click", closeMembersDialog);
   $("#albumMembersDialog")?.addEventListener("click", (e) => { if (e.target.closest("[data-albummembers-dismiss]")) closeMembersDialog(); });

   // Choose-album dialog (New Song while on the Albums tab).
   $("#chooseAlbumOk")?.addEventListener("click", submitChooseAlbum);
   $("#chooseAlbumCancel")?.addEventListener("click", () => closeChooseAlbumDialog(null));
   $("#chooseAlbumDialog")?.addEventListener("click", (e) => { if (e.target.closest("[data-choosealbum-dismiss]")) closeChooseAlbumDialog(null); });

   // Global: Escape closes album dialogs.
   document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (albumJoinResolve) closeJoinAlbumDialog(null);
      else if (newAlbumResolve) closeNewAlbumDialog(null);
      else if (editAlbumResolve) closeEditAlbumDialog(null);
      else if (addSongResolve) closeAddSongDialog(null);
      else if (membersResolve) closeMembersDialog();
      else if (chooseAlbumResolve) closeChooseAlbumDialog(null);
   });
}

async function openAlbumSongPdf(songId) {
   try {
      const full = await loadAlbumSong(currentAlbum.albumId, songId);
      bridge.applyProject(full);
      bridge.setCloudContext({ scope: "album", albumId: currentAlbum.albumId, albumName: currentAlbum.name, songId, versionId: full.versionId || null, versionLabel: full.label || "", role: currentAlbum?.role || "member" });
      navigate(albumEditorUrl(currentAlbum.albumId, songId, full.versionId || null));
      setTimeout(() => bridge.openPdfOptions(), 340);
   } catch (error) {
      toast("Could not open that song");
   }
}

async function copyAlbumSong(songId) {
   try {
      await copyAlbumSongToMySongs(currentAlbum.albumId, songId);
      toast("Saved a copy to My Songs");
   } catch (error) {
      toast("Could not copy that song");
   }
}

async function confirmRemoveAlbumSong(songId) {
   const song = cachedAlbumSongs.find((s) => s.songId === songId);
   const title = song?.title || "this song";
   const confirmed = await openConfirmDialog({
      title: "Remove song?",
      message: `Remove "${title}" from this album? This does not affect your own library.`,
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
      icon: "🗑",
      danger: true,
   });
   if (!confirmed) return;
   try {
      await deleteAlbumSong(currentAlbum.albumId, songId);
      toast("Song removed from the album");
      await refreshAlbumSongs();
      renderAlbumHeader();
   } catch (error) {
      toast("Could not remove that song");
   }
}


export function initCloudUI(editorBridge) {
   bridge = { ...bridge, ...editorBridge };
   initLogin();
   initGallery();
   initNewSongDialog();
   initVersionCrud();
   initAccountButton();
   initAlbums();
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
         guardUnsavedThen(() => navigate(homeTarget()));
      } else {
         navigate(homeTarget());
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
