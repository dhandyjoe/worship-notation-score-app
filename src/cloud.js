// cloud.js — Firebase cloud sync (auth + Firestore CRUD).
//
// Design notes:
//  - Leaf-ish module: only depends on dom.js (toast) + firebase-config.js.
//  - The Firebase SDK is loaded LAZILY via dynamic import() from the gstatic CDN.
//    This keeps the app fully static (no build step) AND means the editor still
//    boots fine offline / in tests — nothing here runs until the user actually
//    opens the cloud UI or signs in.
//  - Data model (two levels, as of the "versions" feature):
//      users/{uid}/songs/{songId}                      = song metadata (title, artist,
//        timestamps, versionCount, latestVersionId, latestVersionLabel)
//      users/{uid}/songs/{songId}/versions/{versionId} = ONE arrangement: label,
//        number, + the full projectData() of that arrangement.
//    Legacy flat documents (whole project in one song doc) are upgraded lazily on
//    read/write by migrateLegacySong(); old data is never lost.
//  - Auth methods: Email/Password + Google popup.
//
// Public API is promise-based and always returns plain data (never SDK objects)
// so callers in events.js stay decoupled from Firebase internals.
import { firebaseConfig } from "./firebase-config.js?v=20260927-dirty";

const SDK_VERSION = "11.6.1";
const CDN = (name) => `https://www.gstatic.com/firebasejs/${SDK_VERSION}/${name}`;

// Lazily-resolved SDK singletons.
let appPromise = null;
let sdk = null; // { app, auth, db, authFns, dbFns }
let currentUser = null;
const authListeners = new Set();

// Resolves once the FIRST auth-state result is known after boot (either a
// restored session or "signed out"). Routing on load awaits this so we can send
// returning users straight to My Songs and everyone else to the login page.
let resolveAuthReady;
let firstAuthEmitted = false;
const authReadyPromise = new Promise((resolve) => {
   resolveAuthReady = resolve;
});

// Whether a real Firebase config has been provided. If the config still holds a
// placeholder, we surface a friendly message instead of a cryptic SDK error.
export function isConfigured() {
   return Boolean(firebaseConfig?.apiKey && firebaseConfig.apiKey.startsWith("AIza"));
}

// Awaitable: resolves with the initial user (or null) once Firebase has restored
// the persisted session. If Firebase isn't configured, resolves to null so the
// app still shows the login page rather than hanging.
export function authReady() {
   if (!isConfigured()) return Promise.resolve(null);
   ensureFirebase().catch(() => resolveAuthReady(null));
   return authReadyPromise;
}

// Load + initialize Firebase once. Subsequent calls reuse the same promise.
async function ensureFirebase() {
   if (sdk) return sdk;
   if (!appPromise) {
      appPromise = (async () => {
         if (!isConfigured()) throw new Error("Firebase is not configured");
         const [appMod, authMod, dbMod] = await Promise.all([
            import(CDN("firebase-app.js")),
            import(CDN("firebase-auth.js")),
            import(CDN("firebase-firestore.js")),
         ]);
         const app = appMod.initializeApp(firebaseConfig);
         const auth = authMod.getAuth(app);
         const db = dbMod.getFirestore(app);
         sdk = {
            app,
            auth,
            db,
            authFns: authMod,
            dbFns: dbMod,
         };
         // Keep a local mirror of the signed-in user and notify subscribers.
         authMod.onAuthStateChanged(auth, (user) => {
            currentUser = user
               ? { uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL }
               : null;
            if (!firstAuthEmitted) {
               firstAuthEmitted = true;
               resolveAuthReady(currentUser);
            }
            authListeners.forEach((fn) => {
               try {
                  fn(currentUser);
               } catch {
                  /* listener errors must never break auth flow */
               }
            });
         });
         return sdk;
      })();
   }
   return appPromise;
}

// Subscribe to auth-state changes. Returns an unsubscribe function. Safe to call
// before Firebase is initialized — it kicks off init in the background.
export function onAuth(listener) {
   authListeners.add(listener);
   // Fire immediately with the last-known state so UI can render synchronously.
   listener(currentUser);
   ensureFirebase().catch(() => {
      /* config/network errors handled by explicit actions below */
   });
   return () => authListeners.delete(listener);
}

export function getCurrentUser() {
   return currentUser;
}

// ---- Auth actions ----
export async function signInWithGoogle() {
   const { auth, authFns } = await ensureFirebase();
   const provider = new authFns.GoogleAuthProvider();
   const credential = await authFns.signInWithPopup(auth, provider);
   return credential.user;
}

export async function signUpWithEmail(email, password) {
   const { auth, authFns } = await ensureFirebase();
   const credential = await authFns.createUserWithEmailAndPassword(auth, email, password);
   return credential.user;
}

export async function signInWithEmail(email, password) {
   const { auth, authFns } = await ensureFirebase();
   const credential = await authFns.signInWithEmailAndPassword(auth, email, password);
   return credential.user;
}

export async function signOutUser() {
   const { auth, authFns } = await ensureFirebase();
   await authFns.signOut(auth);
}

// Map raw Firebase auth error codes to friendly, localized-ish messages.
export function friendlyAuthError(error) {
   const code = error?.code || "";
   const map = {
      "auth/invalid-email": "Email address is not valid.",
      "auth/user-disabled": "This account has been disabled.",
      "auth/user-not-found": "No account found for that email.",
      "auth/wrong-password": "Incorrect email or password.",
      "auth/invalid-credential": "Incorrect email or password.",
      "auth/email-already-in-use": "An account with that email already exists.",
      "auth/weak-password": "Password should be at least 6 characters.",
      "auth/popup-closed-by-user": "Sign-in popup was closed before completing.",
      "auth/popup-blocked": "Popup was blocked by the browser. Allow popups and retry.",
      "auth/network-request-failed": "Network error. Check your connection and retry.",
   };
   if (map[code]) return map[code];
   if (error?.message === "Firebase is not configured")
      return "Cloud is not configured yet. Add your Firebase config to enable sign-in.";
   return "Something went wrong. Please try again.";
}

// ---- Firestore CRUD ----
// Reference helpers for the current user's library.
function songsCollection() {
   const { db, dbFns } = sdk;
   return dbFns.collection(db, "users", currentUser.uid, "songs");
}
function songRef(songId) {
   const { db, dbFns } = sdk;
   return dbFns.doc(songsCollection(), songId);
}
function versionsCollection(songId) {
   const { db, dbFns } = sdk;
   return dbFns.collection(songsCollection(), songId, "versions");
}
function versionRef(songId, versionId) {
   const { db, dbFns } = sdk;
   return dbFns.doc(versionsCollection(songId), versionId);
}

function requireUser() {
   if (!currentUser) throw new Error("You must be signed in to use cloud storage.");
}

// A song document that still carries the whole project inline is a legacy
// (pre-version) doc — it has a `sections` array directly on the song doc.
// Exported so the pure unit tests can exercise the detection logic.
export function isLegacySongDoc(data) {
   return Boolean(data) && Array.isArray(data.sections);
}

// Compose the editor-ready project from song metadata + one version document.
// The result has EXACTLY the same shape as the pre-version projectData(), so the
// editor, playback and the PDF/export pipeline are untouched by the version model.
export function composeSong(songMeta, version) {
   const project = { ...version };
   delete project.label;
   delete project.number;
   delete project.versionId;
   delete project.createdAt;
   delete project.updatedAt;
   delete project.cloudId;
   delete project.songId;
   delete project.youtubeUrl;
   delete project.youtubeId;
   project.title = songMeta?.title || project.title || "Song Title";
   project.artist = songMeta?.artist !== undefined ? songMeta.artist : project.artist ?? "Artist / Composer";
   return project;
}

// ---- Song metadata (the lightweight identity of a song) ----

// Create a new song (metadata only — the first version is created by saveVersion).
export async function createSong(meta = {}) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const now = Date.now();
   const ref = await dbFns.addDoc(songsCollection(), {
      title: meta.title || "Untitled",
      artist: meta.artist || "",
      createdAt: now,
      updatedAt: now,
   });
   return { songId: ref.id };
}

// Patch a song's metadata (merge). Timestamp is always bumped.
export async function updateSongMeta(songId, patch = {}) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const clean = { ...patch };
   delete clean.songId;
   delete clean.cloudId;
   await dbFns.setDoc(songRef(songId), { ...clean, updatedAt: Date.now() }, { merge: true });
}

// Load a song's metadata. Legacy flat docs are upgraded to the new model first,
// so callers always see the post-migration shape.
export async function loadSongMeta(songId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDoc(songRef(songId));
   if (!snapshot.exists()) throw new Error("Song not found.");
   const data = snapshot.data();
   if (isLegacySongDoc(data)) {
      const migrated = await tryMigrateLegacySong(songId, data);
      if (migrated) {
         const after = await dbFns.getDoc(songRef(songId));
         return { songId, ...after.data() };
      }
      // Upgrade failed (rules still deny the subcollection) — keep serving the
      // flat doc as a single implicit arrangement. The `legacy` flag lets
      // callers compose it directly instead of asking for a "first version".
      return { songId, ...data, legacy: true };
   }
   return { songId, ...data };
}
// ---- Versions (one Firestore document per arrangement) ----

// Create or update a version of a song.
//   - versionId === null → create: auto `number = max existing + 1`.
//   - `data` is the full serializable project (same shape as projectData()).
//   - `label`/`number` are the version's own metadata; label falls back to
//     "Version 1" on create and is kept untouched on update unless provided.
// Returns { versionId, label, number }.
export async function saveVersion(songId, versionId, data = {}, { label, number } = {}) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const now = Date.now();
   if (versionId) {
      const patch = { ...data, updatedAt: now };
      delete patch.cloudId;
      delete patch.songId;
      delete patch.versionId;
      // An explicit "no link" (null) removes the fields instead of storing nulls.
      if (Object.prototype.hasOwnProperty.call(data, "youtubeUrl") && patch.youtubeUrl === null) {
         patch.youtubeUrl = dbFns.deleteField();
      }
      if (Object.prototype.hasOwnProperty.call(data, "youtubeId") && patch.youtubeId === null) {
         patch.youtubeId = dbFns.deleteField();
      }
      if (label !== undefined) patch.label = label;
      if (number !== undefined) patch.number = number;
      await dbFns.setDoc(versionRef(songId, versionId), patch, { merge: true });
      return { versionId, label: patch.label ?? data.label, number: patch.number ?? data.number };
   }
   const nextNumber = typeof number === "number" && number > 0 ? number : await nextVersionNumber(songId);
   const resolvedLabel = (label !== undefined ? label : data.label) || "Version 1";
   const payload = { ...data, label: resolvedLabel, number: nextNumber, createdAt: now, updatedAt: now };
   delete payload.cloudId;
   delete payload.songId;
   delete payload.versionId;
   const ref = await dbFns.addDoc(versionsCollection(songId), payload);
   return { versionId: ref.id, label: resolvedLabel, number: nextNumber };
}

// Load one full version document.
export async function loadVersion(songId, versionId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDoc(versionRef(songId, versionId));
   if (!snapshot.exists()) throw new Error("Version not found.");
   return { versionId: snapshot.id, ...snapshot.data() };
}

// Lightweight version summaries (label/number), newest number first.
export async function listVersions(songId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const q = dbFns.query(versionsCollection(songId), dbFns.orderBy("number", "desc"));
   const snapshot = await dbFns.getDocs(q);
   return snapshot.docs.map((snap) => {
      const data = snap.data();
      return {
         versionId: snap.id,
         label: data.label || "",
         number: data.number,
         updatedAt: data.updatedAt,
         youtubeId: data.youtubeId || "",
         editorMode: data.editorMode === "numbers" ? "numbers" : "chords",
         key: data.key || "",
         meter: data.meter || "",
      };
   });
}

// Delete one version, then re-point the song metadata at the new latest version.
// Returns { versionId } of the new latest, or { versionId: null } when the song
// has no versions left — the song itself survives (Opsi A).
export async function deleteVersion(songId, versionId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   await dbFns.deleteDoc(versionRef(songId, versionId));
   return recomputeLatestMeta(songId);
}

// Highest existing version number + 1 (1 when no versions exist).
async function nextVersionNumber(songId) {
   const { dbFns } = sdk;
   const q = dbFns.query(versionsCollection(songId), dbFns.orderBy("number", "desc"), dbFns.limit(1));
   const snapshot = await dbFns.getDocs(q);
   if (snapshot.empty) return 1;
   const current = snapshot.docs[0].data().number;
   return (typeof current === "number" ? current : 0) + 1;
}

// After a deletion (or when a song loses its last version), refresh the
// denormalized "latest version" fields on the song doc.
async function recomputeLatestMeta(songId) {
   const { dbFns } = sdk;
   const versions = await listVersions(songId);
   if (!versions.length) {
      await dbFns.setDoc(
         songRef(songId),
         {
            latestVersionId: dbFns.deleteField(),
            latestVersionLabel: dbFns.deleteField(),
            latestEditorMode: dbFns.deleteField(),
            latestYoutubeId: dbFns.deleteField(),
            versionCount: 0,
            updatedAt: Date.now(),
         },
         { merge: true },
      );
      return { versionId: null };
   }
   const latest = versions[0];
   await writeLatestMeta(
      songId,
      latest.versionId,
      latest.label || "",
      versions.length,
      latest.editorMode,
      latest.youtubeId,
      latest.key,
      latest.meter,
   );
   return { versionId: latest.versionId };
}

// Denormalize the "latest version" summary that powers the song list, so listing
// the library never needs a per-song version read.
async function writeLatestMeta(
   songId,
   latestVersionId,
   latestVersionLabel,
   versionCount,
   latestEditorMode,
   latestYoutubeId,
   latestKey,
   latestMeter,
) {
   const { dbFns } = sdk;
   await dbFns.setDoc(
      songRef(songId),
      {
         latestVersionId,
         latestVersionLabel,
         versionCount,
         latestEditorMode: latestEditorMode || "chords",
         ...(latestYoutubeId ? { latestYoutubeId } : { latestYoutubeId: dbFns.deleteField() }),
         latestKey: latestKey || "",
         latestMeter: latestMeter || "",
         updatedAt: Date.now(),
      },
      { merge: true },
   );
}

// Public wrapper for writeLatestMeta — used when a (first) version is created and
// must immediately become the song's "latest" on the metadata.
export async function updateLatestVersion(songId, versionId, label, count, editorMode, youtubeId, key, meter) {
   await ensureFirebase();
   requireUser();
   await writeLatestMeta(songId, versionId, label || "", count, editorMode, youtubeId, key, meter);
}
// ---- Legacy flat-document upgrade ----

// A pre-version song doc held the whole project inline. Upgrade it in place:
// move the arrangement into versions/v1 and keep only metadata on the song doc.
async function migrateLegacySong(songId, legacyData) {
   const { dbFns } = sdk;
   const now = Date.now();
   const versionDoc = { ...legacyData };
   delete versionDoc.cloudId;
   delete versionDoc.songId;
   delete versionDoc.versionId;
   delete versionDoc.createdAt;
   delete versionDoc.updatedAt;
   const payload = {
      ...versionDoc,
      label: "Version 1",
      number: 1,
      title: legacyData.title || "Untitled",
      artist: legacyData.artist || "",
      createdAt: legacyData.createdAt || now,
      updatedAt: legacyData.updatedAt || now,
   };
   await dbFns.setDoc(versionRef(songId, VERSION_ONE_ID), payload);
   await dbFns.setDoc(songRef(songId), {
      title: payload.title,
      artist: payload.artist,
      createdAt: payload.createdAt,
      updatedAt: now,
      versionCount: 1,
      latestVersionId: VERSION_ONE_ID,
      latestVersionLabel: "Version 1",
      latestEditorMode: legacyData.editorMode === "numbers" ? "numbers" : "chords",
      latestKey: legacyData.key || "",
      latestMeter: legacyData.meter || "",
   });
}

// Attempt the lazy legacy upgrade. Returns true when migrated; false when the
// upgrade cannot run (e.g. Firestore rules not yet covering the versions
// subcollection) — callers then keep serving the flat document as-is so the
// library is never hidden by a failed upgrade.
async function tryMigrateLegacySong(songId, legacyData) {
   try {
      await migrateLegacySong(songId, legacyData);
      return true;
   } catch (error) {
      return false;
   }
}

// ---- Library CRUD (names kept for the current UI; callers migrate to the
// song + version APIs over the course of the version feature) ----

// Create or update a song + its (single) version in one call — the Save-to-Cloud
// flow used today. When project.cloudId is present the existing song is updated
// (legacy docs are upgraded on the fly); otherwise a new song with its first
// version is created. Returns the song's document id.
export async function saveSong(project = {}, { versionLabel } = {}) {
   await ensureFirebase();
   requireUser();
   const title = project.title || "Untitled";
   const artist = project.artist || "";
   const data = { ...project };
   delete data.cloudId;
   delete data.songId;
   delete data.versionId;
   if (project.cloudId) {
      const songId = project.cloudId;
      const meta = await loadSongMeta(songId);
      if (meta.latestVersionId) {
         await saveVersion(songId, meta.latestVersionId, data, { label: meta.latestVersionLabel });
      } else {
         // Song exists but currently has no versions (last one was deleted) —
         // this save becomes its (new) first version.
         const created = await saveVersion(songId, null, data, { label: versionLabel || "Version 1" });
         await writeLatestMeta(songId, created.versionId, created.label, 1, data.editorMode, undefined, data.key, data.meter);
      }
      await updateSongMeta(songId, { title, artist });
      return songId;
   }
   const createdSong = await createSong({ title, artist });
   const createdVersion = await saveVersion(createdSong.songId, null, data, { label: versionLabel || "Version 1" });
   await writeLatestMeta(createdSong.songId, createdVersion.versionId, createdVersion.label, 1, data.editorMode, undefined, data.key, data.meter);
   return createdSong.songId;
}

// List all songs for the current user, newest-updated first. Returns metadata +
// the denormalized latest-version summary (no per-song version reads). Legacy
// flat docs are migrated lazily as they are encountered.
export async function listSongs() {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const q = dbFns.query(songsCollection(), dbFns.orderBy("updatedAt", "desc"));
   const snapshot = await dbFns.getDocs(q);
   const songs = [];
   for (const snap of snapshot.docs) {
      const data = snap.data();
      if (isLegacySongDoc(data)) {
         const migrated = await tryMigrateLegacySong(snap.id, data);
         if (migrated) {
            songs.push({
               cloudId: snap.id,
               songId: snap.id,
               title: data.title || "Untitled",
               artist: data.artist || "",
               updatedAt: Date.now(),
               versionCount: 1,
               latestVersionId: VERSION_ONE_ID,
               latestVersionLabel: "Version 1",
            });
         } else {
            // Upgrade not possible yet (rules not covering the subcollection):
            // serve the flat document so the library never appears empty.
            songs.push({
               cloudId: snap.id,
               songId: snap.id,
               title: data.title || "Untitled",
               artist: data.artist || "",
               updatedAt: data.updatedAt || Date.now(),
               sections: data.sections,
               key: data.key,
               meter: data.meter,
               editorMode: data.editorMode,
            });
         }
      } else {
         songs.push({
               cloudId: snap.id,
               songId: snap.id,
               title: data.title || "Untitled",
               artist: data.artist || "",
               updatedAt: data.updatedAt,
               versionCount: data.versionCount,
               latestVersionId: data.latestVersionId,
               latestVersionLabel: data.latestVersionLabel,
               latestYoutubeId: data.latestYoutubeId,
               latestEditorMode: data.latestEditorMode,
               latestKey: data.latestKey,
               latestMeter: data.latestMeter,
            });
      }
   }
   return songs;
}
// Load a song for the editor: metadata + the latest version, composed into the
// same project shape the editor has always consumed. Returns
// { cloudId, songId, versionId, label, updatedAt, ...project }. When the song has
// no versions left, returns a minimal blank draft with hasNoVersions: true so the
// UI can prompt for a first version (Opsi A).
export async function loadSong(cloudId) {
   await ensureFirebase();
   requireUser();
   const meta = await loadSongMeta(cloudId);
   if (meta.legacy) {
      // A flat legacy document that couldn't be upgraded yet — serve it whole.
      return { cloudId, songId: cloudId, versionId: null, label: "", ...meta };
   }
   if (!meta.latestVersionId) {
      return {
         cloudId,
         songId: cloudId,
         versionId: null,
         label: "",
         hasNoVersions: true,
         format: "chord-sheet",
         version: 2,
         title: meta.title || "Song Title",
         artist: meta.artist || "Artist / Composer",
         sections: [{ name: "Intro", bars: [] }],
      };
   }
   const version = await loadVersion(cloudId, meta.latestVersionId);
   return {
      cloudId,
      songId: cloudId,
      versionId: version.versionId,
      label: version.label || "",
      updatedAt: version.updatedAt,
      ...composeSong(meta, version),
   };
}

// Delete a song and EVERY version document under it (Firestore has no cascade).
export async function deleteSong(cloudId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDocs(versionsCollection(cloudId));
   await Promise.all(snapshot.docs.map((snap) => dbFns.deleteDoc(snap.ref)));
   await dbFns.deleteDoc(songRef(cloudId));
}

// Duplicate an existing song: metadata + every version, newest number copied
// as-is into fresh documents. Returns the new song's id.
export async function duplicateSong(cloudId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const meta = await loadSongMeta(cloudId);
   const now = Date.now();
   const created = await createSong({ title: `${meta.title || "Untitled"} (copy)`, artist: meta.artist || "" });
   const newSongId = created.songId;
   const q = dbFns.query(versionsCollection(cloudId), dbFns.orderBy("number", "asc"));
   const snapshot = await dbFns.getDocs(q);
   let latestId = null;
   let latestLabel = "";
   let count = 0;
   for (const snap of snapshot.docs) {
      const copy = { ...snap.data(), createdAt: now, updatedAt: now };
      delete copy.cloudId;
      delete copy.songId;
      delete copy.versionId;
      const ref = await dbFns.addDoc(versionsCollection(newSongId), copy);
      latestId = ref.id;
      latestLabel = copy.label || "";
      count += 1;
   }
   if (count) {
      await writeLatestMeta(newSongId, latestId, latestLabel, count);
   } else {
      await updateSongMeta(newSongId, { versionCount: 0 });
   }
   return newSongId;
}

// Stable id used when a legacy flat song doc is upgraded to the new model.
const VERSION_ONE_ID = "v1";
