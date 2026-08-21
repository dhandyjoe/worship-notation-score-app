// cloud.js — Firebase cloud sync (auth + Firestore CRUD).
//
// Design notes:
//  - Leaf-ish module: only depends on dom.js (toast) + firebase-config.js.
//  - The Firebase SDK is loaded LAZILY via dynamic import() from the gstatic CDN.
//    This keeps the app fully static (no build step) AND means the editor still
//    boots fine offline / in tests — nothing here runs until the user actually
//    opens the cloud UI or signs in.
//  - Data model: users/{uid}/songs/{songId} = { ...projectData(), createdAt, updatedAt }.
//  - Auth methods: Email/Password + Google popup.
//
// Public API is promise-based and always returns plain data (never SDK objects)
// so callers in events.js stay decoupled from Firebase internals.
import { firebaseConfig } from "./firebase-config.js?v=20260821-import24";

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
// Reference helper: the current user's songs collection.
function songsCollection() {
   const { db, dbFns } = sdk;
   return dbFns.collection(db, "users", currentUser.uid, "songs");
}

function requireUser() {
   if (!currentUser) throw new Error("You must be signed in to use cloud storage.");
}

// Save (create or update). If project.cloudId is present, update in place;
// otherwise create a new document and return its id.
export async function saveSong(project) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const now = Date.now();
   const payload = {
      ...project,
      title: project.title || "Untitled",
      artist: project.artist || "",
      updatedAt: now,
   };
   delete payload.cloudId; // never persist the client-side id inside the doc body
   if (project.cloudId) {
      const ref = dbFns.doc(songsCollection(), project.cloudId);
      await dbFns.setDoc(ref, payload, { merge: true });
      return project.cloudId;
   }
   payload.createdAt = now;
   const ref = await dbFns.addDoc(songsCollection(), payload);
   return ref.id;
}

// List all songs for the current user, newest-updated first.
export async function listSongs() {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const q = dbFns.query(songsCollection(), dbFns.orderBy("updatedAt", "desc"));
   const snapshot = await dbFns.getDocs(q);
   return snapshot.docs.map((docSnap) => ({ cloudId: docSnap.id, ...docSnap.data() }));
}

// Load a single song by id.
export async function loadSong(cloudId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   const ref = dbFns.doc(songsCollection(), cloudId);
   const snapshot = await dbFns.getDoc(ref);
   if (!snapshot.exists()) throw new Error("Song not found.");
   return { cloudId: snapshot.id, ...snapshot.data() };
}

export async function deleteSong(cloudId) {
   await ensureFirebase();
   requireUser();
   const { dbFns } = sdk;
   await dbFns.deleteDoc(dbFns.doc(songsCollection(), cloudId));
}

// Duplicate an existing song into a new document ("<title> (copy)").
export async function duplicateSong(cloudId) {
   const original = await loadSong(cloudId);
   const copy = { ...original };
   delete copy.cloudId;
   copy.title = `${original.title || "Untitled"} (copy)`;
   const now = Date.now();
   copy.createdAt = now;
   copy.updatedAt = now;
   const { dbFns } = sdk;
   const ref = await dbFns.addDoc(songsCollection(), copy);
   return ref.id;
}
