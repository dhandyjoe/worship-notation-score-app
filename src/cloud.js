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
import { firebaseConfig } from "./firebase-config.js?v=__BUILD__";
import { normalizeEditorMode } from "./notation.js?v=__BUILD__";

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
   // Tanpa orderBy: Cloud Firestore secara DIAM-DIAM mengecualikan dokumen yang
   // tidak memiliki field yang dipakai untuk sorting (number). Akibatnya versi
   // yang field `number`-nya hilang (mis. data hasil migrasi/copy lama) jadi
   // tak terlihat di dropdown. Ambil semuanya lalu urutkan di sisi client.
   const snapshot = await dbFns.getDocs(versionsCollection(songId));
   const versions = snapshot.docs.map((snap) => {
      const data = snap.data();
      return {
         versionId: snap.id,
         label: data.label || "",
         number: data.number,
         updatedAt: data.updatedAt,
         youtubeId: data.youtubeId || "",
         editorMode: normalizeEditorMode(data.editorMode),
         key: data.key || "",
         meter: data.meter || "",
      };
   });
   // Nomor terbaru pertama; dokumen tanpa `number` dianggap 0 (terakhir).
   return versions.sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
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
   const versions = await listVersions(songId);
   const highest = versions.reduce((max, v) => Math.max(max, Number(v.number) || 0), 0);
   return highest + 1;
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
         latestEditorMode: normalizeEditorMode(latestEditorMode),
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
      latestEditorMode: normalizeEditorMode(legacyData.editorMode),
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
   const snapshot = await dbFns.getDocs(versionsCollection(cloudId));
   // Urutkan ascending di sisi client agar copy tidak kehilangan versi yang
   // field `number`-nya hilang (sama seperti listVersions).
   const versionDocs = snapshot.docs.slice().sort(
      (a, b) => (Number(a.data().number) || 0) - (Number(b.data().number) || 0),
   );
   let latestId = null;
   let latestLabel = "";
   let count = 0;
   for (const snap of versionDocs) {
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
// ======================================================================
// ALBUM (Fase 3/4) — shared albums with invite-code self-join.
// ======================================================================
// Audience: GKJ Nehemia — an owner-curated album of arrangements that every
// member can READ. Joining is self-service via a server-verified invite code
// (verified by Firestore security rules, NOT by client code).
//
// Data model:
//   albums/{albumId}                               → { name, description, createdBy,
//                                                      createdAt, updatedAt, songCount }
//   albums/{albumId}/songs/{songId}                → song metadata (same shape as a
//                                                      users/{uid}/songs/{songId} doc)
//   albums/{albumId}/songs/{songId}/versions/{id}  → ONE arrangement (same shape as
//                                                      user versions → editor untouched)
//   albums/{albumId}/members/{uid}                 → { uid, role: "owner"|"member",
//                                                      name, email, joinedAt, addedBy }
//   albums/{albumId}/invites/{code}                → { active, createdAt, createdBy }
//                                                      (doc ID = the invite code)
//   users/{uid}/albumMemberships/{albumId}         → enumerable pointer (existing
//                                                      users/{uid}/** rules already allow)

// ---- Path helpers ----
function albumsCollection() {
   const { db, dbFns } = sdk;
   return dbFns.collection(db, "albums");
}
function albumRef(albumId) {
   const { db, dbFns } = sdk;
   return dbFns.doc(db, "albums", albumId);
}
function albumSongsCollection(albumId) {
   const { db, dbFns } = sdk;
   return dbFns.collection(db, "albums", albumId, "songs");
}
function albumSongRef(albumId, songId) {
   const { db, dbFns } = sdk;
   return dbFns.doc(db, "albums", albumId, "songs", songId);
}
function albumVersionsCollection(albumId, songId) {
   const { db, dbFns } = sdk;
   return dbFns.collection(db, "albums", albumId, "songs", songId, "versions");
}
function albumVersionRef(albumId, songId, versionId) {
   const { db, dbFns } = sdk;
   return dbFns.doc(db, "albums", albumId, "songs", songId, "versions", versionId);
}
function membersCollection(albumId) {
   const { db, dbFns } = sdk;
   return dbFns.collection(db, "albums", albumId, "members");
}
function memberRef(albumId, uid) {
   const { db, dbFns } = sdk;
   return dbFns.doc(db, "albums", albumId, "members", uid);
}
function inviteCodeRef(code) {
   const { db, dbFns } = sdk;
   return dbFns.doc(db, "inviteCodes", code);
}
function myMembershipsCollection() {
   const { db, dbFns } = sdk;
   return dbFns.collection(db, "users", currentUser.uid, "albumMemberships");
}
function myMembershipRef(albumId) {
   const { db, dbFns } = sdk;
   return dbFns.doc(db, "users", currentUser.uid, "albumMemberships", albumId);
}

// ---- Invite codes ----
// Unambiguous alphabet: no I/O/0/1 so a code typed from a photo is never a guess.
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateInviteCode() {
   const pick = (length) =>
      Array.from({ length }, () => INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)]).join("");
   return `${pick(4)}-${pick(4)}`;
}
// Accept "7FQ3-XK2N" or "7FQ3XK2N"; returns canonical "7FQ3-XK2N" or null.
export function normalizeInviteCode(raw) {
   const token = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
   if (token.length !== 8) return null;
   return `${token.slice(0, 4)}-${token.slice(4, 8)}`;
}

// Current user's membership row in this album, or null when not a member.
async function getOwnMembership(albumId) {
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDoc(memberRef(albumId, currentUser.uid));
   return snapshot.exists() ? { uid: snapshot.id, ...snapshot.data() } : null;
}
// ---- Album version helpers (album-path mirrors of the user-song version API) ----
async function nextAlbumVersionNumber(albumId, songId) {
   const versions = await listAlbumVersions(albumId, songId);
   const highest = versions.reduce((max, v) => Math.max(max, Number(v.number) || 0), 0);
   return highest + 1;
}

export async function saveAlbumVersion(albumId, songId, versionId, data = {}, { label, number } = {}) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const now = Date.now();
   if (versionId) {
      const patch = { ...data, updatedAt: now };
      delete patch.cloudId;
      delete patch.songId;
      delete patch.versionId;
      if (Object.prototype.hasOwnProperty.call(data, "youtubeUrl") && patch.youtubeUrl === null) {
         patch.youtubeUrl = dbFns.deleteField();
      }
      if (Object.prototype.hasOwnProperty.call(data, "youtubeId") && patch.youtubeId === null) {
         patch.youtubeId = dbFns.deleteField();
      }
      if (label !== undefined) patch.label = label;
      if (number !== undefined) patch.number = number;
      await dbFns.setDoc(albumVersionRef(albumId, songId, versionId), patch, { merge: true });
      return { versionId, label: patch.label ?? data.label, number: patch.number ?? data.number };
   }
   const nextNumber = typeof number === "number" && number > 0 ? number : await nextAlbumVersionNumber(albumId, songId);
   const resolvedLabel = (label !== undefined ? label : data.label) || "Version 1";
   const payload = { ...data, label: resolvedLabel, number: nextNumber, createdAt: now, updatedAt: now };
   delete payload.cloudId;
   delete payload.songId;
   delete payload.versionId;
   const ref = await dbFns.addDoc(albumVersionsCollection(albumId, songId), payload);
   return { versionId: ref.id, label: resolvedLabel, number: nextNumber };
}
export async function loadAlbumVersion(albumId, songId, versionId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDoc(albumVersionRef(albumId, songId, versionId));
   if (!snapshot.exists()) throw new Error("Version not found.");
   return { versionId: snapshot.id, ...snapshot.data() };
}

// Lightweight version summaries (label/number), newest number first.
export async function listAlbumVersions(albumId, songId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   // Sama seperti listVersions: hindari orderBy("number") karena Firestore
   // mendiamkan dokumen yang field `number`-nya hilang — ambil semua, urutkan
   // di client (nomor terbaru pertama; tanpa `number` dianggap 0 / terakhir).
   const snapshot = await dbFns.getDocs(albumVersionsCollection(albumId, songId));
   const versions = snapshot.docs.map((snap) => {
      const data = snap.data();
      return {
         versionId: snap.id,
         label: data.label || "",
         number: data.number,
         updatedAt: data.updatedAt,
         youtubeId: data.youtubeId || "",
         editorMode: normalizeEditorMode(data.editorMode),
         key: data.key || "",
         meter: data.meter || "",
      };
   });
   return versions.sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
}

// Denormalize the "latest version" summary on an album song doc.
async function writeAlbumLatestMeta(
   albumId,
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
      albumSongRef(albumId, songId),
      {
         latestVersionId,
         latestVersionLabel,
         versionCount,
         latestEditorMode: normalizeEditorMode(latestEditorMode),
         ...(latestYoutubeId ? { latestYoutubeId } : { latestYoutubeId: dbFns.deleteField() }),
         latestKey: latestKey || "",
         latestMeter: latestMeter || "",
         updatedAt: Date.now(),
      },
      { merge: true },
   );
}

// Public wrapper for writeAlbumLatestMeta — used when a (first) album version is
// created and must immediately become the song's "latest" on the metadata.
export async function updateAlbumLatestVersion(albumId, songId, versionId, label, count, editorMode, youtubeId, key, meter) {
   await ensureFirebase();
   requireUser();
   await writeAlbumLatestMeta(albumId, songId, versionId, label || "", count, editorMode, youtubeId, key, meter);
}

async function recomputeAlbumLatestMeta(albumId, songId) {
   const { dbFns } = sdk;
   const versions = await listAlbumVersions(albumId, songId);
   if (!versions.length) {
      await dbFns.setDoc(
         albumSongRef(albumId, songId),
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
   await writeAlbumLatestMeta(
      albumId,
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

export async function deleteAlbumVersion(albumId, songId, versionId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   await dbFns.deleteDoc(albumVersionRef(albumId, songId, versionId));
   return recomputeAlbumLatestMeta(albumId, songId);
}
// ---- Album song metadata helpers ----
async function createAlbumSong(albumId, meta = {}) {
   const { dbFns } = sdk;
   const now = Date.now();
   const ref = await dbFns.addDoc(albumSongsCollection(albumId), {
      title: meta.title || "Untitled",
      artist: meta.artist || "",
      createdAt: now,
      updatedAt: now,
   });
   return { songId: ref.id };
}

// Patch an album song's metadata (merge). Exported so the editor can keep the
// denormalized latest-* fields in sync when only a version changed (e.g. a
// staged rename / YouTube link that is persisted on the next Save).
export async function updateAlbumSongMeta(albumId, songId, patch = {}) {
   const { dbFns } = sdk;
   const clean = { ...patch };
   delete clean.cloudId;
   delete clean.songId;
   delete clean.versionId;
   await dbFns.setDoc(albumSongRef(albumId, songId), { ...clean, updatedAt: Date.now() }, { merge: true });
}

export async function loadAlbumSongMeta(albumId, songId) {
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDoc(albumSongRef(albumId, songId));
   if (!snapshot.exists()) throw new Error("Song not found in album.");
   return { songId, ...snapshot.data() };
}

// Bump the album's updatedAt + recompute songCount (denormalized for cards),
// and mirror the number into the current user's membership pointer.
async function bumpAlbumActivity(albumId) {
   const { dbFns } = sdk;
   const now = Date.now();
   const songs = await dbFns.getDocs(albumSongsCollection(albumId));
   const count = songs.docs.length;
   await dbFns.setDoc(albumRef(albumId), { songCount: count, updatedAt: now }, { merge: true });
   try {
      await dbFns.setDoc(myMembershipRef(albumId), { albumUpdatedAt: now, songCount: count }, { merge: true });
   } catch {
      /* membership pointer is best-effort; listing self-heals */
   }
}
// ---- Album CRUD ----
export async function createAlbum({ name, description } = {}) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const now = Date.now();
   const title = (name || "").trim() || "Untitled Album";
   const ref = await dbFns.addDoc(albumsCollection(), {
      name: title,
      description: (description || "").trim(),
      createdBy: currentUser.uid,
      createdAt: now,
      updatedAt: now,
      songCount: 0,
   });
   const albumId = ref.id;
   await dbFns.setDoc(memberRef(albumId, currentUser.uid), {
      uid: currentUser.uid,
      role: "owner",
      name: currentUser.displayName || "",
      email: currentUser.email || "",
      joinedAt: now,
      addedBy: null,
   });
   const code = generateInviteCode();
   await dbFns.setDoc(inviteCodeRef(code), { albumId, active: true, createdAt: now, createdBy: currentUser.uid });
   await dbFns.setDoc(albumRef(albumId), { activeInviteCode: code }, { merge: true });
   await dbFns.setDoc(myMembershipRef(albumId), {
      role: "owner",
      joinedAt: now,
      albumUpdatedAt: now,
      songCount: 0,
   });
   return { albumId, inviteCode: code };
}

export async function updateAlbum(albumId, { name, description } = {}) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const patch = {};
   if (name !== undefined) patch.name = (name || "").trim() || "Untitled Album";
   if (description !== undefined) patch.description = (description || "").trim();
   patch.updatedAt = Date.now();
   await dbFns.setDoc(albumRef(albumId), patch, { merge: true });
   return { albumId };
}

// Delete an album AND everything inside it (Firestore has no cascade).
export async function deleteAlbum(albumId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const songs = await dbFns.getDocs(albumSongsCollection(albumId));
   for (const song of songs.docs) {
      const versions = await dbFns.getDocs(albumVersionsCollection(albumId, song.id));
      await Promise.all(versions.docs.map((snap) => dbFns.deleteDoc(snap.ref)));
      await dbFns.deleteDoc(song.ref);
   }
   const members = await dbFns.getDocs(membersCollection(albumId));
   // Rule 3 forbids an owner from deleting their own membership (protects the
   // last owner) — skip our own row; the album doc itself is deleted below and
   // its invite codes go stale, so the leftover membership is inert.
   await Promise.all(
      members.docs.filter((snap) => snap.id !== currentUser.uid).map((snap) => dbFns.deleteDoc(snap.ref)),
   );
   // Invite code docs are tiny and immutable; once the album is gone the rules
   // deny every join attempt, so no cleanup (and no collection list permission).
   await dbFns.deleteDoc(albumRef(albumId));
   try {
      await dbFns.deleteDoc(myMembershipRef(albumId));
   } catch {
      /* own pointer is best-effort */
   }
   return { albumId };
}

// The current user's album view: metadata + my live role (authoritative from the
// member doc, so a promotion/demotion elsewhere is reflected on the next open).
export async function getAlbum(albumId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const member = await getOwnMembership(albumId);
   if (!member) throw new Error("You are not a member of this album.");
   const snapshot = await dbFns.getDoc(albumRef(albumId));
   if (!snapshot.exists()) throw new Error("Album not found.");
   const data = snapshot.data();
   return {
      albumId,
      name: data.name || "Untitled Album",
      description: data.description || "",
      createdBy: data.createdBy || "",
      createdAt: data.createdAt || 0,
      updatedAt: data.updatedAt || 0,
      songCount: typeof data.songCount === "number" ? data.songCount : 0,
      role: member.role === "owner" ? "owner" : "member",
   };
}

// Albums the current user belongs to, most recently active first. Enumerated via
// the users/{uid}/albumMemberships pointer; stale pointers self-heal (if the
// album or membership vanished, the pointer is dropped on the next list).
export async function listAlbums() {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   // Ordering by albumUpdatedAt uses the automatic single-field index. Should a
   // deployment ever reject that query (index not yet created / emulator quirk),
   // fall back to an unordered read (plain collection reads never need an index)
   // and sort client-side — the album list must keep working either way.
   let markers;
   try {
      markers = await dbFns.getDocs(
         dbFns.query(myMembershipsCollection(), dbFns.orderBy("albumUpdatedAt", "desc")),
      );
   } catch (orderError) {
      console.warn("[cloud] albumMemberships orderBy read failed, falling back to unordered:", orderError);
      markers = await dbFns.getDocs(myMembershipsCollection());
   }
   const docs = [...markers.docs].sort((a, b) => {
      const ta = Number(a.data().albumUpdatedAt || 0);
      const tb = Number(b.data().albumUpdatedAt || 0);
      return tb - ta;
   });
   const albums = [];
   for (const snap of docs) {
      const albumId = snap.id;
      try {
         albums.push(await getAlbum(albumId));
      } catch (error) {
         // A REAL permission problem must bubble up (the UI points at the rules).
         if (isFirestoreDeny(error)) throw error;
         // Only a genuinely GONE album/membership is a stale pointer → remove it.
         // Anything else (transient, partial data) must NOT silently drop the
         // album from the list — log it so the exact failure stays visible.
         const msg = String(error?.message || error || "");
         if (/not found|are not a member/i.test(msg)) {
            try {
               await dbFns.deleteDoc(myMembershipRef(albumId));
            } catch {
               /* keep going */
            }
            console.warn(`[cloud] listAlbums: dropped stale pointer ${albumId} (${msg})`);
         } else {
            console.error(`[cloud] listAlbums: skipping marker ${albumId}, keeping it:`, error);
         }
      }
   }
   return albums;
}

// Firestore "missing/insufficient permissions" detector (per-collection rules).
function isFirestoreDeny(error) {
   const code = String(error?.code || "");
   const message = String(error?.message || error || "");
   return code === "permission-denied" || /Missing or insufficient permissions/i.test(message);
}
// ---- Album songs ----
export async function listAlbumSongs(albumId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDocs(
      dbFns.query(albumSongsCollection(albumId), dbFns.orderBy("updatedAt", "desc")),
   );
   return snapshot.docs.map((snap) => {
      const data = snap.data();
      return {
         cloudId: snap.id,
         songId: snap.id,
         title: data.title || "Untitled",
         artist: data.artist || "",
         updatedAt: data.updatedAt || 0,
         versionCount: data.versionCount,
         latestVersionId: data.latestVersionId,
         latestVersionLabel: data.latestVersionLabel,
         latestYoutubeId: data.latestYoutubeId,
         latestEditorMode: data.latestEditorMode,
         latestKey: data.latestKey,
         latestMeter: data.latestMeter,
      };
   });
}

// Load a song for the editor: metadata + the latest version, composed into the
// same project shape the editor consumes (mirrors loadSong for album scope).
export async function loadAlbumSong(albumId, songId) {
   await ensureFirebase();
   requireUser();
   const meta = await loadAlbumSongMeta(albumId, songId);
   if (!meta.latestVersionId) {
      return {
         cloudId: songId,
         albumId,
         songId,
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
   const version = await loadAlbumVersion(albumId, songId, meta.latestVersionId);
   return {
      cloudId: songId,
      albumId,
      songId,
      versionId: version.versionId,
      label: version.label || "",
      updatedAt: version.updatedAt,
      ...composeSong(meta, version),
   };
}
// Save the open score into an album song — creates the song inside the album
// directly (NO touch on users/{uid}/songs) or updates it when ctx.songId.
// Returns the next editor cloud-context { scope, albumId, songId, versionId, versionLabel }.
export async function saveToAlbum(albumId, project = {}, ctx = {}) {
   await ensureFirebase();
   requireUser();
   const title = project.title || "Untitled";
   const artist = project.artist || "";
   const data = { ...project };
   delete data.cloudId;
   delete data.songId;
   delete data.versionId;
   let songId = ctx.songId;
   let nextVersionId = ctx.versionId;
   let nextLabel = ctx.versionLabel;
   if (songId) {
      const meta = await loadAlbumSongMeta(albumId, songId);
      if (meta.latestVersionId) {
         if (nextVersionId) {
            await saveAlbumVersion(albumId, songId, nextVersionId, data, { label: nextLabel });
         } else {
            const created = await saveAlbumVersion(albumId, songId, null, data, { label: ctx.versionLabel || "Version 1" });
            await writeAlbumLatestMeta(albumId, songId, created.versionId, created.label, 1, data.editorMode, undefined, data.key, data.meter);
            nextVersionId = created.versionId;
            nextLabel = created.label;
         }
      } else {
         // Song exists in the album but has no versions (last deleted) → first save becomes v1.
         const created = await saveAlbumVersion(albumId, songId, null, data, { label: ctx.versionLabel || "Version 1" });
         await writeAlbumLatestMeta(albumId, songId, created.versionId, created.label, 1, data.editorMode, undefined, data.key, data.meter);
         nextVersionId = created.versionId;
         nextLabel = created.label;
      }
      await updateAlbumSongMeta(albumId, songId, {
         title,
         artist,
         latestEditorMode: normalizeEditorMode(data.editorMode),
         latestKey: data.key || "",
         latestMeter: data.meter || "",
      });
   } else {
      // Brand-new song created directly IN the album (no My Songs copy).
      const createdSong = await createAlbumSong(albumId, { title, artist });
      songId = createdSong.songId;
      const created = await saveAlbumVersion(albumId, songId, null, data, { label: ctx.versionLabel || "Version 1" });
      await writeAlbumLatestMeta(albumId, songId, created.versionId, created.label, 1, data.editorMode, undefined, data.key, data.meter);
      nextVersionId = created.versionId;
      nextLabel = created.label;
   }
   await bumpAlbumActivity(albumId);
   return { scope: "album", albumId, songId, versionId: nextVersionId, versionLabel: nextLabel };
}

export async function deleteAlbumSong(albumId, songId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const versions = await dbFns.getDocs(albumVersionsCollection(albumId, songId));
   await Promise.all(versions.docs.map((snap) => dbFns.deleteDoc(snap.ref)));
   await dbFns.deleteDoc(albumSongRef(albumId, songId));
   await bumpAlbumActivity(albumId);
   return { albumId };
}
// Transport-only fields are stripped before a version payload is re-created
// under another parent (the album copy). `label`/`number` are intentionally
// removed too — saveAlbumVersion assigns them, so the copied album version
// ALWAYS ends up with proper version metadata (the album's version list is
// sorted and labelled from those fields).
// Exported for the pure unit tests: it must never mutate its input and must keep
// every content field (sections/bars/chords/lyrics/key/meter/editorMode/YouTube).
export function versionCopyPayload(source) {
   const payload = { ...source };
   delete payload.cloudId;
   delete payload.songId;
   delete payload.versionId;
   delete payload.label;
   delete payload.number;
   delete payload.createdAt;
   delete payload.updatedAt;
   delete payload.legacy;
   delete payload.hasNoVersions;
   return payload;
}

// Copy an EXISTING My Songs song (metadata + EVERY arrangement, with its full
// content: sections/bars/chords/lyrics/key/meter/editorMode/YouTube link) into
// the album. Every source version is enumerated (listVersions does NOT use an
// orderBy, so versions without a `number` field can't be silently skipped by
// Firestore) and re-created through saveAlbumVersion.
// The copy is all-or-nothing: if any write fails midway, the partially copied
// album song is removed again so the album never keeps a half-copied song.
export async function addSongToAlbum(albumId, mySongId) {
   await ensureFirebase();
   requireUser();
   const meta = await loadSongMeta(mySongId);
   const created = await createAlbumSong(albumId, { title: meta.title, artist: meta.artist || "" });
   const newSongId = created.songId;
   let versionCount = 0;
   try {
      if (meta.legacy) {
         // Legacy flat song doc: the whole project IS the single arrangement.
         const payload = versionCopyPayload(meta);
         const version = await saveAlbumVersion(albumId, newSongId, null, payload, { label: "Version 1" });
         await writeAlbumLatestMeta(albumId, newSongId, version.versionId, version.label, 1, payload.editorMode, undefined, payload.key, payload.meter);
         versionCount = 1;
      } else {
         const versions = await listVersions(mySongId);
         for (const v of versions) {
            const source = await loadVersion(mySongId, v.versionId);
            const payload = versionCopyPayload(source);
            // label/number are carried over so the album keeps the SAME version
            // names and ordering as the source song.
            await saveAlbumVersion(albumId, newSongId, null, payload, { label: v.label || source.label || "", number: v.number });
            versionCount += 1;
         }
         if (!versionCount) {
            // Lagu sumber tidak punya dokumen versi yang terbaca (mis. lagu tanpa
            // versi tersisa setelah versi terakhir dihapus, atau data legacy yang
            // migrasinya belum jalan) → buat minimal satu versi dari konten yang
            // tersedia (loadSong sudah menggabungkan versi terakhir / data legacy /
            // draft kosong) sehingga salinan album tidak pernah tanpa versi.
            const source = await loadSong(mySongId);
            const fallbackData = versionCopyPayload(source);
            fallbackData.title = meta.title || "Untitled";
            fallbackData.artist = meta.artist || "";
            await saveAlbumVersion(albumId, newSongId, null, fallbackData, { label: meta.latestVersionLabel || "Version 1" });
            versionCount = 1;
         }
         // "Latest" = the album copy with the HIGHEST version number
         // (listAlbumVersions is sorted newest-first) — independent of the
         // iteration order of the source versions.
         const copied = await listAlbumVersions(albumId, newSongId);
         const latest = copied[0] || null;
         await writeAlbumLatestMeta(
            albumId,
            newSongId,
            latest?.versionId || null,
            latest?.label || "",
            versionCount,
            latest?.editorMode,
            latest?.youtubeId,
            latest?.key,
            latest?.meter,
         );
      }
   } catch (error) {
      // Roll the partial copy back so "Add from My Songs" never leaves a song
      // with only some of its arrangements in the album.
      try {
         await deleteAlbumSong(albumId, newSongId);
      } catch {
         /* best-effort cleanup — the original error is what matters */
      }
      throw error;
   }
   await bumpAlbumActivity(albumId);
   return { albumId, songId: newSongId, versionCount };
}

// Member "Save a copy" — duplicates an album song into the user's own library.
// When preferVersionId is given, the returned versionId/versionLabel describe the
// copied version matching that album version (so the editor can keep pointing at
// the arrangement the user was viewing).
export async function copyAlbumSongToMySongs(albumId, songId, { preferVersionId } = {}) {
   await ensureFirebase();
   requireUser();
   const meta = await loadAlbumSongMeta(albumId, songId);
   const created = await createSong({ title: meta.title, artist: meta.artist || "" });
   const newSongId = created.songId;
   const versions = await listAlbumVersions(albumId, songId);
   if (!versions.length) {
      await updateSongMeta(newSongId, { versionCount: 0 });
      return { songId: newSongId, versionId: null, versionLabel: "" };
   }
   let latestId = null;
   let latestLabel = "";
   let count = 0;
   let latestEditorMode = "";
   let latestYoutubeId = "";
   let latestKey = "";
   let latestMeter = "";
   let preferredId = null;
   let preferredLabel = "";
   for (const v of versions) {
      const version = await loadAlbumVersion(albumId, songId, v.versionId);
      const payload = { ...version };
      delete payload.cloudId;
      delete payload.songId;
      delete payload.versionId;
      delete payload.label;
      delete payload.number;
      const createdVersion = await saveVersion(newSongId, null, payload, { label: v.label, number: v.number });
      latestId = createdVersion.versionId;
      latestLabel = createdVersion.label;
      count += 1;
      latestEditorMode = normalizeEditorMode(version.editorMode || latestEditorMode);
      latestYoutubeId = version.youtubeId || latestYoutubeId;
      latestKey = version.key || latestKey;
      latestMeter = version.meter || latestMeter;
      if (preferVersionId && v.versionId === preferVersionId) {
         preferredId = createdVersion.versionId;
         preferredLabel = createdVersion.label;
      }
   }
   await writeLatestMeta(newSongId, latestId, latestLabel, count, latestEditorMode, latestYoutubeId, latestKey, latestMeter);
   await updateSongMeta(newSongId, { title: meta.title, artist: meta.artist || "" });
   return { songId: newSongId, versionId: preferredId || latestId, versionLabel: preferredLabel || latestLabel };
}
// ---- Join + membership (invite-code self-service) ----
// The current code is mirrored on the album doc (activeInviteCode) so reading it
// needs no collection query; inviteCodes/{code} keeps the server-side mapping.
export async function getInviteCode(albumId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDoc(albumRef(albumId));
   if (!snapshot.exists()) return null;
   return snapshot.data().activeInviteCode || null;
}

// Deactivate the current code and issue a fresh one. Old codes stop working
// immediately (rules check `active == true`), so they cannot be reused.
export async function rotateInviteCode(albumId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const previous = await getInviteCode(albumId);
   if (previous) {
      await dbFns.setDoc(inviteCodeRef(previous), { active: false }, { merge: true });
   }
   const code = generateInviteCode();
   await dbFns.setDoc(inviteCodeRef(code), { albumId, active: true, createdAt: Date.now(), createdBy: currentUser.uid });
   await dbFns.setDoc(albumRef(albumId), { activeInviteCode: code }, { merge: true });
   return { inviteCode: code };
}

/**
 * Self-service join. The invite code is VERIFIED SERVER-SIDE by the Firestore
 * rules: this client writes a member doc carrying the raw `inviteCode` field, and
 * the rules grant `create` only when that code exists, is active and belongs to
 * the album path being written. On success the code field is stripped again so
 * it is never persisted.
 */
export async function joinAlbum(rawCode) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const code = normalizeInviteCode(rawCode);
   if (!code) throw new Error("Invalid invite code.");
   const invite = await dbFns.getDoc(inviteCodeRef(code));
   if (!invite.exists()) throw new Error("That invite code is not valid.");
   const inviteData = invite.data();
   if (inviteData.active !== true) throw new Error("That invite code is no longer active.");
   const albumId = inviteData.albumId;
   if (typeof albumId !== "string" || !albumId) throw new Error("That invite code is not valid.");
   // A NON-member cannot read their own (absent) membership row — the rules only
   // grant member reads — so the check must tolerate the permission denial and
   // treat it as "not a member yet".
   let existing = null;
   try {
      existing = await getOwnMembership(albumId);
   } catch (membershipRead) {
      existing = null;
   }
   if (existing) {
      return { albumId, role: existing.role === "owner" ? "owner" : "member", alreadyMember: true };
   }
   const now = Date.now();
   try {
      // The rules verify request.resource.data.inviteCode here.
      await dbFns.setDoc(memberRef(albumId, currentUser.uid), {
         uid: currentUser.uid,
         role: "member",
         inviteCode: code,
         name: currentUser.displayName || "",
         email: currentUser.email || "",
         joinedAt: now,
         addedBy: null,
      });
   } catch (error) {
      throw new Error("That invite code is not valid for this album.");
   }
   // Strip the inviteCode so it never persists (the self-update rule lets a
   // member change ONLY the inviteCode field; role stays locked).
   try {
      await dbFns.setDoc(memberRef(albumId, currentUser.uid), { inviteCode: dbFns.deleteField() }, { merge: true });
   } catch {
      /* rule allows it, but never fail a successful join on the cleanup */
   }
   await dbFns.setDoc(myMembershipRef(albumId), { role: "member", joinedAt: now, albumUpdatedAt: now, songCount: 0 });
   return { albumId, role: "member" };
}

export async function listMembers(albumId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const snapshot = await dbFns.getDocs(dbFns.query(membersCollection(albumId), dbFns.orderBy("joinedAt", "asc")));
   return snapshot.docs.map((snap) => ({
      uid: snap.id,
      role: snap.data().role === "owner" ? "owner" : "member",
      name: snap.data().name || "",
      email: snap.data().email || "",
      joinedAt: snap.data().joinedAt || 0,
   }));
}

// Promote/demote. Any owner may change any OTHER member's role (equal owners);
// the rules forbid writing your own membership, protecting the last owner.
export async function setMemberRole(albumId, uid, role) {
   await ensureFirebase();
   requireUser();
   if (uid === currentUser.uid) throw new Error("You cannot change your own role.");
   const { dbFns } = sdk;
   await dbFns.setDoc(memberRef(albumId, uid), { role: role === "owner" ? "owner" : "member" }, { merge: true });
}

// Owners remove members (any other member); members self-remove via leaveAlbum.
export async function removeMember(albumId, uid) {
   await ensureFirebase();
   requireUser();
   if (uid === currentUser.uid) throw new Error("Use Leave album to remove yourself.");
   const { dbFns } = sdk;
   await dbFns.deleteDoc(memberRef(albumId, uid));
}

// A MEMBER may leave an album at any time (self-serve, like joining).
export async function leaveAlbum(albumId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const me = await getOwnMembership(albumId);
   if (!me) return;
   if (me.role === "owner") {
      throw new Error("Owners cannot leave. Ask another owner to change your role, or delete the album.");
   }
   await dbFns.deleteDoc(memberRef(albumId, currentUser.uid));
   try {
      await dbFns.deleteDoc(myMembershipRef(albumId));
   } catch {
      /* best-effort */
   }
}
