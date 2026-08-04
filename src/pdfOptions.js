// pdfOptions.js — user-adjustable PDF/print appearance (font sizes, beat
// spacing, paper size, margins).
//
// Design notes:
//  • All print geometry in this app flows through `--print-*` CSS custom
//    properties defined once in styles/preview.css `:root`. Those tokens are
//    consumed ONLY by print-scoped rules (`@media print` + `html.is-print-layout`),
//    so overriding them on documentElement affects BOTH the real PDF export and
//    the on-screen "PDF layout" preview — and has ZERO effect on the live editor.
//  • Defaults below EXACTLY match the CSS `:root` values. When the user has not
//    customised anything we DO NOT write inline overrides at all, so the printed
//    output is byte-identical to before (keeps the regression suite intact).
//  • Paper size + margins can't be set inline (they live in `@page`), so we inject
//    a tiny <style id="pdfPageStyle"> only when the user picks a non-default page.
//
// This module is UI-agnostic at its core: apply/read/reset are pure state, and
// initPdfOptions() wires the modal. Import order: leaf-ish (only dom.js).

import { $, toast } from "./dom.js?v=20260810-devicehint-modal";
import { markMidRowBars, clearMidRowBars } from "./pdf.js?v=20260810-devicehint-modal";

const STORAGE_KEY = "chordSheetPdfOptions";

// Tunable tokens. `prop` is the CSS custom property; values are in mm.
export const PDF_TOKENS = {
   chord: { prop: "--print-chord-size", min: 3.4, max: 5.6, step: 0.1, default: 4.3, label: "Chord size" },
   lyric: { prop: "--print-lyric-size", min: 2.6, max: 4.4, step: 0.1, default: 3.2, label: "Lyric size" },
   slot: { prop: "--print-slot", min: 5.0, max: 9.0, step: 0.1, default: 6.2, label: "Beat spacing" },
};

// One-click presets set all three tokens at once.
export const PDF_PRESETS = {
   compact: { chord: 3.8, lyric: 2.8, slot: 5.4 },
   normal: { chord: 4.3, lyric: 3.2, slot: 6.2 },
   large: { chord: 4.8, lyric: 3.6, slot: 7.2 },
   xlarge: { chord: 5.3, lyric: 4.0, slot: 8.2 },
};

// Paper + margin geometry (consumed via injected @page rules).
// `width`/`height` are the true physical dimensions, used to draw the live
// preview at real paper size so it matches the generated PDF exactly.
export const PDF_PAPER = {
   a4: { size: "A4", label: "A4", width: "210mm", height: "297mm" },
   letter: { size: "Letter", label: "Letter", width: "215.9mm", height: "279.4mm" },
};
export const PDF_MARGINS = {
   narrow: { all: "12mm 7mm 9mm", first: "7mm", label: "Narrow" },
   normal: { all: "18mm 9mm 12mm", first: "9mm", label: "Normal" },
   wide: { all: "24mm 14mm 16mm", first: "14mm", label: "Wide" },
};

export function defaultPdfOptions() {
   return {
      chord: PDF_TOKENS.chord.default,
      lyric: PDF_TOKENS.lyric.default,
      slot: PDF_TOKENS.slot.default,
      paper: "a4",
      margin: "normal",
   };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Normalise + clamp any partial/legacy stored object into a valid settings shape. */
function sanitize(raw) {
   const base = defaultPdfOptions();
   if (!raw || typeof raw !== "object") return base;
   for (const key of ["chord", "lyric", "slot"]) {
      const meta = PDF_TOKENS[key];
      const value = Number(raw[key]);
      if (Number.isFinite(value)) base[key] = clamp(Math.round(value * 10) / 10, meta.min, meta.max);
   }
   if (raw.paper && PDF_PAPER[raw.paper]) base.paper = raw.paper;
   if (raw.margin && PDF_MARGINS[raw.margin]) base.margin = raw.margin;
   return base;
}

export function readPdfOptions() {
   try {
      return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
   } catch {
      return defaultPdfOptions();
   }
}

function persist(settings) {
   try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
   } catch {
      /* storage may be unavailable (private mode) — apply still works for the session */
   }
}

const isDefaultSize = (settings) =>
   settings.chord === PDF_TOKENS.chord.default &&
   settings.lyric === PDF_TOKENS.lyric.default &&
   settings.slot === PDF_TOKENS.slot.default;

/**
 * Apply settings to the document. Only writes inline token overrides / injects a
 * page <style> when values differ from the CSS defaults, so the untouched state
 * stays byte-identical to the original stylesheet.
 */
export function applyPdfOptions(settings = readPdfOptions()) {
   const root = document.documentElement;
   // Font/spacing tokens.
   if (isDefaultSize(settings)) {
      for (const key of ["chord", "lyric", "slot"]) root.style.removeProperty(PDF_TOKENS[key].prop);
   } else {
      for (const key of ["chord", "lyric", "slot"]) {
         root.style.setProperty(PDF_TOKENS[key].prop, `${settings[key]}mm`);
      }
   }
   // Paper size + margins via injected @page (only when non-default).
   const existing = document.getElementById("pdfPageStyle");
   const isDefaultPage = settings.paper === "a4" && settings.margin === "normal";
   if (isDefaultPage) {
      existing?.remove();
   } else {
      const paper = PDF_PAPER[settings.paper] || PDF_PAPER.a4;
      const margin = PDF_MARGINS[settings.margin] || PDF_MARGINS.normal;
      const css = `@page { size: ${paper.size}; margin: ${margin.all}; }\n@page :first { margin-top: ${margin.first}; }`;
      const style = existing || Object.assign(document.createElement("style"), { id: "pdfPageStyle" });
      style.textContent = css;
      if (!existing) document.head.appendChild(style);
   }
   return settings;
}

/** Which preset (if any) exactly matches the current size trio. */
function matchingPreset(settings) {
   return (
      Object.keys(PDF_PRESETS).find((name) => {
         const p = PDF_PRESETS[name];
         return p.chord === settings.chord && p.lyric === settings.lyric && p.slot === settings.slot;
      }) || null
   );
}

/**
 * Wire the PDF Options modal.
 * @param {object} deps
 * @param {(on:boolean, opts?:object)=>void} deps.setPreview  toggles the live "PDF layout" preview
 * @param {()=>boolean} deps.isPreviewOn                       current preview state
 * @param {()=>void} deps.onExport                             triggers the existing Export-PDF flow
 */
export function initPdfOptions({ setPreview, isPreviewOn, onExport } = {}) {
   // The "Export .pdf" button is the sole entry point now — the old dedicated
   // "PDF options" button was removed, so opening the options dialog and the
   // export flow live behind one primary action.
   const openBtn = $("#exportBtn");
   const modal = $("#pdfOptionsModal");
   if (!openBtn || !modal) return; // feature markup absent → no-op

   const backdrop = modal.querySelector(".pdf-options-backdrop");
   const closeBtn = $("#pdfOptionsClose");
   const resetBtn = $("#pdfOptionsReset");
   const exportBtn = $("#pdfOptionsExport");
   const presetWrap = $("#pdfPresetGroup");
   const paperWrap = $("#pdfPaperGroup");
   const marginWrap = $("#pdfMarginGroup");

   let settings = readPdfOptions();
   let previewWasOn = false;
   let lastFocused = null;
   // Where #previewCard normally lives, so we can put it back on close.
   let cardHome = null;
   let cardNextSibling = null;
   let cardInlineZoom = "";

   const previewHost = $("#pdfPreviewHost");
   const previewScroll = $("#pdfPreviewScroll");
   const scaleLabel = $("#pdfPreviewScale");

   /**
    * Move the REAL #previewCard into the dialog. Using the live node (instead of
    * a clone) means the same ids/print CSS/token overrides apply, so what you see
    * here is exactly what prints.
    */
   function adoptPreview() {
      const card = document.getElementById("previewCard");
      if (!card || !previewHost) return;
      cardHome = card.parentNode;
      cardNextSibling = card.nextSibling;
      cardInlineZoom = card.style.zoom || "";
      card.style.zoom = 1; // paper scale; visual fit handled by CSS transform
      // A wrapper that represents one physical page (paper size + @page margins),
      // so the card's content box equals the real printable area.
      let page = previewHost.querySelector(".pdf-preview-page");
      if (!page) {
         page = document.createElement("div");
         page.className = "pdf-preview-page";
         previewHost.appendChild(page);
      }
      page.appendChild(card);
      fitPreviewToPane();
   }

   function releasePreview() {
      const card = document.getElementById("previewCard");
      if (!card || !cardHome) return;
      card.style.zoom = cardInlineZoom;
      // Drop the print-only barline tags so the live editor is untouched.
      clearMidRowBars();
      cardHome.insertBefore(card, cardNextSibling || null);
      previewHost?.querySelector(".pdf-preview-page")?.remove();
      cardHome = null;
      cardNextSibling = null;
   }

   /**
    * Size the simulated page from the current settings, then scale it so a whole
    * page fits the pane. Keeping the page at real mm dimensions is what makes the
    * preview match the printed PDF.
    */
   function fitPreviewToPane() {
      const page = previewHost?.querySelector(".pdf-preview-page");
      if (!page || !previewHost || !previewScroll) return;
      const paper = PDF_PAPER[settings.paper] || PDF_PAPER.a4;
      const margin = PDF_MARGINS[settings.margin] || PDF_MARGINS.normal;
      previewHost.style.setProperty("--pdf-page-w", paper.width);
      previewHost.style.setProperty("--pdf-page-h", paper.height);
      // `margin.all` is "<top> <x> <bottom>"; the FIRST page uses margin.first.
      const [, marginX, marginBottom] = margin.all.split(/\s+/);
      previewHost.style.setProperty("--pdf-page-margin-top", margin.first);
      previewHost.style.setProperty("--pdf-page-margin-x", marginX);
      previewHost.style.setProperty("--pdf-page-margin-bottom", marginBottom);
      // How many physical pages does the content need? Grow the paper so pages
      // 2+ are visible instead of clipped, mirroring the real multi-page PDF.
      previewHost.style.setProperty("--pdf-page-count", "1");
      const onePageH = page.offsetHeight;
      const card = document.getElementById("previewCard");
      const styles = getComputedStyle(page);
      const usableH = page.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
      const pageCount = usableH > 0 ? Math.max(1, Math.ceil((card?.offsetHeight || 0) / usableH)) : 1;
      previewHost.style.setProperty("--pdf-page-count", String(pageCount));

      // Fit: scale the paper down so its full WIDTH fits the pane; tall multi-page
      // documents then scroll vertically, like a real PDF viewer.
      previewHost.style.setProperty("--pdf-preview-scale", "1");
      const naturalWidth = page.offsetWidth;
      // Subtract the pane's real padding so the paper never causes a scrollbar.
      const scrollStyles = getComputedStyle(previewScroll);
      const padX = parseFloat(scrollStyles.paddingLeft) + parseFloat(scrollStyles.paddingRight);
      const padY = parseFloat(scrollStyles.paddingTop) + parseFloat(scrollStyles.paddingBottom);
      const availableW = previewScroll.clientWidth - padX;
      const availableH = previewScroll.clientHeight - padY;
      if (!naturalWidth || availableW <= 0) return;
      let scale = Math.min(1, Math.max(0.2, availableW / naturalWidth));
      // Single-page docs: also fit the height so the whole page is visible at once.
      if (pageCount === 1 && availableH > 0) {
         scale = Math.min(scale, Math.max(0.2, availableH / onePageH));
      }
      previewHost.style.setProperty("--pdf-preview-scale", String(scale));
      if (scaleLabel) scaleLabel.textContent = `${Math.round(scale * 100)}%`;
      // Match the REAL PDF: hide the redundant leading barline on any bar that
      // isn't the first on its printed row (same logic pdf.js runs on print).
      // Run after the page width is final so row-wrapping is decided correctly.
      markMidRowBars();
   }

   const sliders = {};
   for (const key of ["chord", "lyric", "slot"]) {
      sliders[key] = { input: $(`#pdfOpt_${key}`), out: $(`#pdfOptVal_${key}`) };
   }

   // ---- View sync ----
   function syncControls() {
      for (const key of ["chord", "lyric", "slot"]) {
         const s = sliders[key];
         if (!s.input) continue;
         s.input.value = String(settings[key]);
         if (s.out) s.out.textContent = `${settings[key].toFixed(1)} mm`;
      }
      const activePreset = matchingPreset(settings);
      presetWrap?.querySelectorAll("[data-preset]").forEach((btn) => {
         btn.classList.toggle("is-active", btn.dataset.preset === activePreset);
         btn.setAttribute("aria-pressed", String(btn.dataset.preset === activePreset));
      });
      paperWrap?.querySelectorAll("[data-paper]").forEach((btn) => {
         const on = btn.dataset.paper === settings.paper;
         btn.classList.toggle("is-active", on);
         btn.setAttribute("aria-pressed", String(on));
      });
      marginWrap?.querySelectorAll("[data-margin]").forEach((btn) => {
         const on = btn.dataset.margin === settings.margin;
         btn.classList.toggle("is-active", on);
         btn.setAttribute("aria-pressed", String(on));
      });
   }

   function commit({ persistNow = true } = {}) {
      applyPdfOptions(settings);
      if (persistNow) persist(settings);
      syncControls();
      // Geometry changed → re-fit the paper inside the preview pane. Done
      // synchronously: reading offsetWidth forces layout anyway, and relying on
      // requestAnimationFrame can silently skip when the tab isn't rendering.
      if (!modal.hidden) fitPreviewToPane();
   }

   // ---- Open / close ----
   function open() {
      settings = readPdfOptions();
      lastFocused = document.activeElement;
      previewWasOn = typeof isPreviewOn === "function" ? Boolean(isPreviewOn()) : false;
      if (!previewWasOn && typeof setPreview === "function") setPreview(true, { announce: false });
      applyPdfOptions(settings);
      syncControls();
      modal.hidden = false;
      // Force a style flush so the `is-open` transition always runs from the
      // hidden state (rAF alone can be skipped in background/headless tabs).
      void modal.offsetHeight;
      modal.classList.add("is-open");
      adoptPreview();
      closeBtn?.focus();
      document.addEventListener("keydown", onKeydown, true);
      window.addEventListener("resize", fitPreviewToPane);
   }

   function close() {
      modal.classList.remove("is-open");
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("resize", fitPreviewToPane);
      // Hand the score back to the editor BEFORE restoring layout state so the
      // editor re-measures with the card in its normal place.
      releasePreview();
      // Restore the preview state we found on open (don't disturb a user who had
      // the PDF layout preview on already).
      if (!previewWasOn && typeof setPreview === "function") setPreview(false, { announce: false });
      const done = () => {
         modal.hidden = true;
         modal.removeEventListener("transitionend", done);
      };
      modal.addEventListener("transitionend", done);
      setTimeout(done, 260); // fallback if transitionend doesn't fire
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
   }

   function onKeydown(event) {
      if (event.key === "Escape") {
         event.preventDefault();
         close();
      }
   }

   // ---- Wire events ----
   openBtn.addEventListener("click", open);
   closeBtn?.addEventListener("click", close);
   backdrop?.addEventListener("click", close);

   for (const key of ["chord", "lyric", "slot"]) {
      const meta = PDF_TOKENS[key];
      const input = sliders[key].input;
      if (!input) continue;
      input.min = String(meta.min);
      input.max = String(meta.max);
      input.step = String(meta.step);
      input.addEventListener("input", () => {
         settings[key] = clamp(Math.round(Number(input.value) * 10) / 10, meta.min, meta.max);
         commit();
      });
   }

   presetWrap?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-preset]");
      if (!btn) return;
      const preset = PDF_PRESETS[btn.dataset.preset];
      if (!preset) return;
      Object.assign(settings, preset);
      commit();
   });

   paperWrap?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-paper]");
      if (!btn || !PDF_PAPER[btn.dataset.paper]) return;
      settings.paper = btn.dataset.paper;
      commit();
   });

   marginWrap?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-margin]");
      if (!btn || !PDF_MARGINS[btn.dataset.margin]) return;
      settings.margin = btn.dataset.margin;
      commit();
   });

   resetBtn?.addEventListener("click", () => {
      settings = defaultPdfOptions();
      commit();
      toast("PDF options reset to defaults");
   });

   exportBtn?.addEventListener("click", () => {
      persist(settings);
      applyPdfOptions(settings);
      // close() returns #previewCard to the editor, which the export flow needs.
      close();
      // Wait for the card to be back in place, then run the existing export flow.
      setTimeout(() => {
         if (typeof onExport === "function") onExport();
      }, 300);
   });

   // Ensure saved prefs are live even before the modal is opened.
   applyPdfOptions(settings);

   // Expose the dialog controls so other features can drive it (e.g. the
   // per-card "Export .pdf" action in My Songs opens the song then this dialog).
   return { open, close };
}
