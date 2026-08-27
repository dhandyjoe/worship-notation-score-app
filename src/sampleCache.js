// sampleCache.js — minimal IndexedDB cache for downloaded piano samples.
//
// Purpose: persist the raw (encoded) sample bytes in the browser's IndexedDB so
// that, after the first download, samples survive refreshes and can be reused
// offline without re-downloading. Storage is indexed by a cache key (the sample
// set version) + note name, so bumping the key forces a clean re-download.
//
// Notes:
//  • We store the RAW bytes (ArrayBuffer/Blob), NOT decoded AudioBuffers —
//    AudioBuffers aren't cloneable into IDB. They are decoded on load instead.
//  • Failures are non-fatal: every function resolves gracefully (never rejects
//    in a way that breaks playback).

const DB_NAME = "wns-sample-cache";
const DB_VERSION = 1;
const STORE = "samples";

let dbPromise = null;

/** Open (and lazily create) the IndexedDB database. */
function openDb() {
   if (dbPromise) return dbPromise;
   dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
         const db = req.result;
         if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "id" });
         }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
   });
   return dbPromise;
}

/**
 * Save a batch of raw sample bytes.
 * @param {string} cacheKey Sample-set key (e.g. SAMPLE_CACHE_KEY).
 * @param {Array<{name: string, raw: ArrayBuffer}>} entries
 * @returns {Promise<void>}
 */
export async function saveSamples(cacheKey, entries) {
   try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
         const tx = db.transaction(STORE, "readwrite");
         entries.forEach((e) => tx.store.put({ id: `${cacheKey}#${e.name}`, key: cacheKey, name: e.name, raw: e.raw }));
         tx.oncomplete = resolve;
         tx.onerror = () => reject(tx.error);
      });
   } catch (err) {
      console.warn("sampleCache.saveSamples failed:", err);
   }
}

/**
 * Load raw sample bytes for a cache key.
 * @param {string} cacheKey
 * @returns {Promise<Array<{name: string, raw: ArrayBuffer}>>} Empty when none cached.
 */
export async function loadSamples(cacheKey) {
   try {
      const db = await openDb();
      const out = await new Promise((resolve, reject) => {
         const store = db.transaction(STORE, "readonly").store;
         const req = store.openCursor();
         const res = [];
         req.onsuccess = () => {
            const cur = req.result;
            if (cur) {
               if (cur.value && cur.value.key === cacheKey) {
                  res.push({ name: cur.value.name, raw: cur.value.raw });
               }
               cur.continue();
            } else {
               resolve(res);
            }
         };
         req.onerror = () => reject(req.error);
      });
      // Normalize any Blob payloads into ArrayBuffers (some engines store Blob).
      return Promise.all(
         out.map(async ({ name, raw }) => ({ name, raw: raw instanceof Blob ? await raw.arrayBuffer() : raw })),
      );
   } catch (err) {
      console.warn("sampleCache.loadSamples failed:", err);
      return [];
   }
}

/**
 * Remove all entries for a cache key (e.g. when clearing data).
 * @param {string} cacheKey
 * @returns {Promise<void>}
 */
export async function clearSamples(cacheKey) {
   try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
         const tx = db.transaction(STORE, "readwrite");
         const store = tx.store;
         const req = store.openCursor();
         req.onsuccess = () => {
            const cur = req.result;
            if (cur) {
               if (cur.value && cur.value.key === cacheKey) store.delete(cur.primaryKey);
               cur.continue();
            } else {
               resolve();
            }
         };
         req.onerror = () => reject(req.error);
      });
   } catch (err) {
      console.warn("sampleCache.clearSamples failed:", err);
   }
}