// sw.js — service worker for WorshipNotationScore (PWA offline shell).
//
// Deploy target is GitHub Pages under a SUBPATH:
//   https://dhandyjoe.github.io/worship-notation-score-app/
// so EVERYTHING here uses RELATIVE URLs resolved against the SW's own scope
// (registration.scope). Never use root-absolute "/..." paths or the cache keys
// break under the /worship-notation-score-app/ prefix.
//
// Strategy:
//   • App shell (HTML/CSS/JS/icons, same-origin) → cache-first with a
//     background refresh (stale-while-revalidate). Instant loads + offline.
//   • Navigations (address bar / launch) → serve cached index.html when the
//     network is unavailable, so the SPA always boots offline.
//   • Cross-origin (Firebase gstatic CDN, Google auth) → NOT intercepted; they
//     fall through to the network. Cloud features simply require connectivity.
//
// Bump CACHE_VERSION whenever shell assets change so old caches are purged.
const CACHE_VERSION = "wns-shell-v20260805-1";

// Relative to the SW scope (the app root). The "?v=..." query strings must match
// exactly what index.html / the ES modules request, or those fetches would miss
// the precache and hit the network. We ALSO match with ignoreSearch as a
// fallback, so a version bump degrades gracefully to a network refresh.
const ASSET_VERSION = "20260808-hide-dot-active";
const CORE_ASSETS = [
   "./",
   "./index.html",
   "./manifest.webmanifest",
   `./styles/styles.css`,
   `./styles/preview.css?v=${ASSET_VERSION}`,
   `./styles/ui.css?v=${ASSET_VERSION}`,
   `./src/app.js?v=${ASSET_VERSION}`,
   `./src/events.js?v=${ASSET_VERSION}`,
   `./src/notation.js?v=${ASSET_VERSION}`,
   `./src/dom.js?v=${ASSET_VERSION}`,
   `./src/store.js?v=${ASSET_VERSION}`,
   `./src/render.js?v=${ASSET_VERSION}`,
   `./src/chordBank.js?v=${ASSET_VERSION}`,
   `./src/chordEditor.js?v=${ASSET_VERSION}`,
   `./src/beatMenu.js?v=${ASSET_VERSION}`,
   `./src/pdf.js?v=${ASSET_VERSION}`,
   `./src/pdfOptions.js?v=${ASSET_VERSION}`,
   `./src/cloud.js?v=${ASSET_VERSION}`,
   `./src/cloudUI.js?v=${ASSET_VERSION}`,
   `./src/firebase-config.js?v=${ASSET_VERSION}`,
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
         await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
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

   // Navigations: network-first so deploys are picked up, offline → cached shell.
   if (request.mode === "navigate") {
      event.respondWith(
         (async () => {
            try {
               const fresh = await fetch(request);
               const cache = await caches.open(CACHE_VERSION);
               cache.put("./index.html", fresh.clone()).catch(() => {});
               return fresh;
            } catch {
               const cache = await caches.open(CACHE_VERSION);
               return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
            }
         })(),
      );
      return;
   }

   // Static assets: stale-while-revalidate.
   event.respondWith(
      (async () => {
         const cache = await caches.open(CACHE_VERSION);
         const cached = (await cache.match(request)) || (await cache.match(request, { ignoreSearch: true }));
         const network = fetch(request)
            .then((response) => {
               if (response && response.ok && response.type === "basic") {
                  cache.put(request, response.clone()).catch(() => {});
               }
               return response;
            })
            .catch(() => null);
         return cached || (await network) || Response.error();
      })(),
   );
});
