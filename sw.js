// sw.js — service worker for WorshipNotationScore (PWA offline shell).
//
// Deploy target is GitHub Pages under a SUBPATH:
//   https://dhandyjoe.github.io/worship-notation-score-app/
// so EVERYTHING here uses RELATIVE URLs resolved against the SW's own scope
// (registration.scope). Never use root-absolute "/..." paths or the cache keys
// break under the /worship-notation-score-app/ prefix.
//
// Strategy (DEPLOY-SAFE: a new deploy must be visible on the FIRST refresh):
//   • Navigations + the un-versioned shell entry points (index.html,
//     styles/styles.css, manifest.webmanifest) → NETWORK-FIRST, revalidated with
//     `cache: "no-cache"` so the browser's own HTTP cache (GitHub Pages sends
//     `Cache-Control: max-age=600`) can never hand back a pre-deploy copy.
//     Offline → the cached shell, so the SPA still boots.
//   • Versioned assets (…?v=ASSET_VERSION) → cache-first with a background
//     refresh (stale-while-revalidate). Because the ?v= value changes on every
//     deploy, a freshly loaded page never matches the previous deploy's cache
//     entries, so cache-first stays instantly fresh after a deploy while also
//     staying instant + offline-capable on repeat visits.
//     ⚠️ `ignoreSearch` is used ONLY when the network fails. Serving it while
//     online (the old behaviour) is what let a previous deploy's CSS/JS be
//     served for one extra load — e.g. old print rules still drawing a green
//     selection ring around the chords in the exported PDF.
//   • Cross-origin (Firebase gstatic CDN, Google auth) → NOT intercepted; they
//     fall through to the network. Cloud features simply require connectivity.
//
// Versioning: every version string in this project is the single placeholder
// `__BUILD__` (here, in index.html's window.__WNS_BUILD__ stamp, in the `?v=`
// cache-buster of every module, and in the chordpro.css marker). The deploy
// workflow (.github/workflows/deploy.yml) replaces that token with a build id
// (r<run>-<sha7>) in ONE pass, so nothing has to be bumped by hand and the
// values can never drift apart — tests/unit.test.mjs asserts they match, both in
// the repo and in the staged artifact.
const CACHE_VERSION = "wns-shell-v__BUILD__";

// Cache Storage is shared by the WHOLE origin (on GitHub Pages every project of
// the account lives under one origin), so every purge is scoped to OUR prefix —
// a reset here must never wipe another app's offline cache.
const CACHE_PREFIX = "wns-shell-";

// Relative to the SW scope (the app root). The "?v=..." query strings must match
// exactly what index.html / the ES modules request, or those fetches would miss
// the precache and hit the network.
const ASSET_VERSION = "__BUILD__";

// Shell entry points that are requested WITHOUT a "?v=" cache-buster (index.html
// itself, the base stylesheet and the manifest). These must be network-first:
// there is no version in the URL, so only a revalidated network read guarantees
// the deploy is picked up. Matched by pathname so both the GitHub Pages subpath
// (/worship-notation-score-app/) and a local http.server behave the same.
const NETWORK_FIRST_PATHS = ["/", "/index.html", "/styles/styles.css", "/manifest.webmanifest"];
const CORE_ASSETS = [
   "./",
   "./index.html",
   "./manifest.webmanifest",
   `./styles/styles.css`,
   `./styles/preview.css?v=${ASSET_VERSION}`,
   `./styles/ui.css?v=${ASSET_VERSION}`,
   `./styles/chordpro.css?v=${ASSET_VERSION}`,
   `./src/app.js?v=${ASSET_VERSION}`,
   `./src/events.js?v=${ASSET_VERSION}`,
   `./src/notation.js?v=${ASSET_VERSION}`,
   `./src/chordPro.js?v=${ASSET_VERSION}`,
   `./src/chordProEditor.js?v=${ASSET_VERSION}`,
   `./src/dom.js?v=${ASSET_VERSION}`,
   `./src/store.js?v=${ASSET_VERSION}`,
   `./src/render.js?v=${ASSET_VERSION}`,
   `./src/chordBank.js?v=${ASSET_VERSION}`,
   `./src/chordEditor.js?v=${ASSET_VERSION}`,
   `./src/beatMenu.js?v=${ASSET_VERSION}`,
   `./src/pdf.js?v=${ASSET_VERSION}`,
   `./src/pdfOptions.js?v=${ASSET_VERSION}`,
   `./src/cloud.js?v=${ASSET_VERSION}`,
   `./src/identity.js?v=${ASSET_VERSION}`,
   `./src/cloudUI.js?v=${ASSET_VERSION}`,
   `./src/share.js?v=${ASSET_VERSION}`,
   `./src/youtube.js?v=${ASSET_VERSION}`,
   `./src/history.js?v=${ASSET_VERSION}`,
   `./src/clipboard.js?v=${ASSET_VERSION}`,
   `./src/firebase-config.js?v=${ASSET_VERSION}`,
   `./src/sampleCache.js?v=${ASSET_VERSION}`,
   "./assets/favicon.svg",
   "./assets/icon-192.png",
   "./assets/icon-512.png",
   "./assets/icon-maskable-512.png",
   "./assets/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
   event.waitUntil(
      (async () => {
         const cache = await caches.open(CACHE_VERSION);
         // Best-effort: add individually so one 404 can't abort the whole install.
         await Promise.all(CORE_ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
         await self.skipWaiting();
      })(),
   );
});

self.addEventListener("activate", (event) => {
   event.waitUntil(
      (async () => {
         const keys = await caches.keys();
         // Only OUR previous shell caches: Cache Storage is origin-wide, so an
         // unfiltered purge could delete another app's offline cache.
         await Promise.all(
            keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION).map((k) => caches.delete(k)),
         );
         await self.clients.claim();
      })(),
   );
});

// Let the page trigger an immediate activation after an update.
self.addEventListener("message", (event) => {
   if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
   const { request } = event;
   if (request.method !== "GET") return;

   const url = new URL(request.url);
   // Only manage our own origin. Firebase/Google/gstatic go straight to network.
   if (url.origin !== self.location.origin) return;

   // Navigations and the un-versioned shell files (no "?v=" cache-buster):
   // NETWORK-FIRST so a deploy is live on the very first refresh. The request is
   // revalidated with `cache: "no-cache"` — the browser may still use its HTTP
   // cache for an unchanged file (fast 304) but can never skip the check, which
   // is what `max-age=600` on GitHub Pages would otherwise do.
   const networkFirst =
      request.mode === "navigate" || NETWORK_FIRST_PATHS.some((path) => url.pathname.endsWith(path));
   if (networkFirst) {
      event.respondWith(
         (async () => {
            const cache = await caches.open(CACHE_VERSION);
            try {
               const fresh = await fetch(new Request(request, { cache: "no-cache" }));
               if (fresh && fresh.ok && fresh.type === "basic") {
                  // Navigations are stored under the canonical shell key so the
                  // offline fallback below has a single entry to serve.
                  const key = request.mode === "navigate" ? "./index.html" : request;
                  cache.put(key, fresh.clone()).catch(() => {});
               }
               return fresh;
            } catch {
               return (
                  (await cache.match(request)) ||
                  (await cache.match(request, { ignoreSearch: true })) ||
                  (await cache.match("./index.html")) ||
                  (await cache.match("./")) ||
                  Response.error()
               );
            }
         })(),
      );
      return;
   }

   // Versioned static assets: stale-while-revalidate. ONLY an exact cache match
   // is served from cache — a new ?v= goes straight to the network (revalidated),
   // instead of matching the previous deploy's entry via ignoreSearch.
   event.respondWith(
      (async () => {
         const cache = await caches.open(CACHE_VERSION);
         const cached = await cache.match(request);
         const network = fetch(new Request(request, { cache: "no-cache" }))
            .then((response) => {
               if (response && response.ok && response.type === "basic") {
                  cache.put(request, response.clone()).catch(() => {});
               }
               return response;
            })
            .catch(() => null);
         if (cached) return cached;
         const fresh = await network;
         if (fresh) return fresh;
         // Offline only: last-resort fallback to an older ?v= of the same asset.
         return (await cache.match(request, { ignoreSearch: true })) || Response.error();
      })(),
   );
});
