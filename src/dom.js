// dom.js — thin browser helpers. Leaf module (no app imports).
export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];
export const prefersTap = () => window.matchMedia("(max-width: 680px), (pointer: coarse)").matches;

let toastTimer = null;
export const toast = (message) => {
   const el = $("#toast");
   if (!el) return;
   el.textContent = message;
   el.classList.add("show");
   clearTimeout(toastTimer);
   toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
};
