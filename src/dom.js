// dom.js — thin browser helpers. Leaf module (no app imports).
export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];
// Touch-first interactions (tap-to-place, roomier hit targets): true on phones
// AND tablets — any small OR coarse-pointer device.
export const prefersTap = () => window.matchMedia("(max-width: 680px), (pointer: coarse)").matches;
// Phone-only gate (<= 680px). Tablets/iPads are considered a recommended device
// (desktop / laptop / tablet), so the "use a bigger screen" hint is shown on
// phones ONLY. Kept separate from prefersTap() so tablet touch behaviour is
// unchanged. Tablet range is 681px–1366px; desktop is > 1366px.
export const isPhone = () => window.matchMedia("(max-width: 680px)").matches;

let toastTimer = null;
export const toast = (message) => {
   const el = $("#toast");
   if (!el) return;
   el.textContent = message;
   el.classList.add("show");
   clearTimeout(toastTimer);
   toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
};
