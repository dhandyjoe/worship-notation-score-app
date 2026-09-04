// pdf.js — PDF / print export.
//
// Encapsulates everything involved in turning the on-screen score into a clean
// printed page or "Save as PDF" output. Keeping this separate from events.js
// makes the export flow easy to reason about and extend.
//
// Design notes:
//  • We use the browser's native window.print(). This keeps text SELECTABLE and
//    SHARP (vector), which is exactly what you want for music/chord sheets — a
//    canvas rasterizer (html2canvas/jsPDF) would blur the notation and lose
//    selectable lyrics. Do NOT switch to a rasterizer.
//  • Print geometry is driven entirely by the `is-print-layout` class + the
//    @media print rules in styles/preview.css & ui.css. The beforeprint listener
//    (registered here) guarantees that class is present during ANY print, so the
//    Export button and a manual Cmd/Ctrl+P produce identical output.
//  • We temporarily set document.title to "<Song> — <Artist>" so the browser's
//    "Save as PDF" dialog proposes a meaningful default filename, then restore
//    the original title afterward.

import { $ } from "./dom.js?v=20260904-marginnarrow0";
import { safeFileName } from "./notation.js?v=20260904-marginnarrow0";

// Whether WE added the is-print-layout class for the current print job. We only
// strip it in afterprint if we added it — this preserves a manual "PDF layout"
// preview toggle that the user may have switched on themselves.
let printClassAddedForJob = false;

// CSS class marking bars that are NOT the first bar on their printed row. Their
// left barline overlaps the previous bar's right barline (doubling thickness),
// so we hide it via CSS (see styles/preview.css). Bars at the start of a row
// keep their left barline so every row opens with a clean divider.
const MID_BAR_CLASS = "pdf-mid-bar";

// Paper width (mm) by id, mirroring PDF_PAPER in src/pdfOptions.js.
const PDF_PAPER_MM = { a4: 210, letter: 215.9 };
// Horizontal side margin (mm) per preset — 2nd token of PDF_MARGINS[.all].
const PDF_SIDE_MARGIN_MM = { narrow: 7, normal: 9, wide: 14 };
// Narrow's margins for the ACTUAL print/export job only. The on-screen PDF
// options preview keeps the (unchanged) PDF_MARGINS value from pdfOptions.js -
// this override is applied only while a print job runs (beforeprint ->
// afterprint) and removed right after, so the live preview/dialog/web layout
// are never affected.
const EXPORT_PAGE_MARGINS = {
   narrow: { all: "0mm 0mm 0mm", first: "0mm" },
   // The default "normal" preset also exports with NARROWER side margins than
   // its preview counterpart (9mm), so every printed row is WIDER and can fit
   // more chords on one line. Only the side value differs; top/bottom match
   // Normal. This is the single knob that controls how wide printed rows are.
   normal: { all: "18mm 5mm 12mm", first: "9mm" },
};
// Side (left/right) margin used to compute printable width during a real print.
const EXPORT_SIDE_MARGIN_MM = { narrow: 0, normal: 5 };
const PDF_OPTIONS_KEY = "chordSheetPdfOptions";
const PX_PER_MM = 96 / 25.4;

// Original inline widths saved while we pin the score to the printed title
// box, so clearMidRowBars() can restore the editor layout as it was.
const pinnedWidths = new Map(); // element -> original inline width

export function printContentWidthPx({ forExport = false } = {}) {
   let paper = "a4", margin = "normal";
   try {
      const raw = JSON.parse(localStorage.getItem(PDF_OPTIONS_KEY) || "null");
      if (raw && PDF_PAPER_MM[raw.paper]) paper = raw.paper;
      if (raw && raw.margin in PDF_SIDE_MARGIN_MM) margin = raw.margin;
   } catch { /* keep defaults */ }
   // During an actual export the printed side margins can differ from the
   // preview ones (see EXPORT_* above) - use the job-specific value then.
   const sideMM =
      forExport && EXPORT_SIDE_MARGIN_MM[margin] != null
         ? EXPORT_SIDE_MARGIN_MM[margin]
         : PDF_SIDE_MARGIN_MM[margin];
   const contentMM = PDF_PAPER_MM[paper] - 2 * sideMM;
   return Math.max(1, contentMM * PX_PER_MM);
}

/*
 * Tag every bar that does not start a printed row with MID_BAR_CLASS so its
 * redundant left barline can be hidden (the previous bar's RIGHT barline
 * stays as the single divider).
 *
 * IMPORTANT (root cause of `wrong export but correct preview`):
 *  • The score is pinned to the paper content WIDTH here and KEPT, so
 *    window.print actually paginates at the same width we classified at.
 *    clearMidRowBars() (afterprint / preview close) restores afterwards.
 *  • Bar at grid's left edge starts a row -> keep its left barline.
 *  • Others: the left barline would sit on top of previous right one
 *    (doubling thickness), so we drop it.
 */
export function markMidRowBars({ forExport = false } = {}) {
   const printWidth = printContentWidthPx({ forExport });
   document.querySelectorAll(".bar-grid").forEach((grid) => {
      if (!grid.querySelector(".bar")) return;
      const card = grid.closest("#previewCard");
      if (card && !pinnedWidths.has(card)) pinnedWidths.set(card, card.style.width);
      if (card) card.style.width = `${printWidth}px`;

      if (!pinnedWidths.has(grid)) pinnedWidths.set(grid, grid.style.width);
      grid.style.width = `${grid.clientWidth}px`;

      const gridLeft = grid.getBoundingClientRect().left;
      grid.querySelectorAll(".bar").forEach((bar) => {
         const left = bar.getBoundingClientRect().left;
         // row start = left edge glued to the grid's edge.
         if (Math.abs(left - gridLeft) <= 1) {
            bar.classList.remove(MID_BAR_CLASS);
         } else {
            bar.classList.add(MID_BAR_CLASS);
         }
      });
   });
}

/** Remove MID tags AND restore widths pinned by markMidRowBars(). */
export function clearMidRowBars() {
   document.querySelectorAll(`.${MID_BAR_CLASS}`).forEach((b) => b.classList.remove(MID_BAR_CLASS));
   pinnedWidths.forEach((originalWidth, el) => {
      el.style.width = originalWidth;
   });
   pinnedWidths.clear();
}

/**
 * Apply the export-only @page margins for the current print job (if any) and
 * remove the helper <style> otherwise. The style is appended AFTER #pdfPageStyle
 * (managed by pdfOptions.js) so it overrides the same @page properties at equal
 * specificity while a job runs; afterprint removes it again, so the on-screen
 * preview, dialog and live editor are never affected.
 */
function applyExportPageMargins() {
   let margin = null;
   try {
      const raw = JSON.parse(localStorage.getItem(PDF_OPTIONS_KEY) || "null");
      margin = raw && EXPORT_PAGE_MARGINS[raw.margin] ? raw.margin : null;
   } catch {
      margin = null;
   }
   const style = document.getElementById("pdfExportPageStyle");
   if (!margin) {
      style?.remove();
      return;
   }
   const m = EXPORT_PAGE_MARGINS[margin];
   const css = `@page { margin: ${m.all}; }\n@page :first { margin-top: ${m.first}; }`;
   if (!style) {
      const s = Object.assign(document.createElement("style"), { id: "pdfExportPageStyle" });
      s.textContent = css;
      document.head.appendChild(s);
   } else {
      style.textContent = css;
      // Keep it last in source order so it wins over pdfPageStyle.
      document.head.appendChild(style);
   }
}

/**
 * Register the global beforeprint/afterprint listeners that make the
 * `is-print-layout` geometry the single source of truth for printed output.
 * Call once during app init.
 */
export function initPrintListeners() {
   window.addEventListener("beforeprint", () => {
      const root = document.documentElement;
      if (!root.classList.contains("is-print-layout")) {
         root.classList.add("is-print-layout");
         printClassAddedForJob = true;
      }
      // Export-only page margins (Normal -> narrower side margins for wider rows,
      // Narrow -> 0mm) for THIS job; the preview keeps its own PDF_MARGINS values.
      applyExportPageMargins();
      // Tag mid-row bars now that print geometry is active, so overlapping
      // left barlines can be hidden (classified against the exported margins).
      markMidRowBars({ forExport: true });
   });
   window.addEventListener("afterprint", () => {
      // Drop the export-only @page override so nothing leaks into the app.
      document.getElementById("pdfExportPageStyle")?.remove();
      clearMidRowBars();
      if (printClassAddedForJob) {
         document.documentElement.classList.remove("is-print-layout");
         printClassAddedForJob = false;
      }
   });
}

/**
 * Build the document title used as the "Save as PDF" default filename.
 * Produces e.g. "Amazing Grace — John Newton"; falls back gracefully.
 */
export function buildPdfDocumentTitle() {
   const title = ($("#songTitle")?.value || "").trim();
   const artist = ($("#artist")?.value || "").trim();
   const cleanTitle = title && title !== "Song Title" ? title : "";
   const cleanArtist = artist && artist !== "Artist / Composer" ? artist : "";
   if (cleanTitle && cleanArtist) return `${cleanTitle} — ${cleanArtist}`;
   if (cleanTitle) return cleanTitle;
   return "WorshipNotationScore";
}

/**
 * Export the current score to PDF / printer.
 *
 * @param {object} opts
 * @param {boolean} opts.printLayoutPreview  Whether the manual "PDF layout"
 *        preview is currently active (so we restore zoom correctly).
 * @param {() => void} [opts.onAfterFrame]   Optional callback run after layout
 *        is restored (e.g. to refresh viewport overflow chrome).
 */
export function exportToPdf({ printLayoutPreview = false, onAfterFrame } = {}) {
   const viewport = $("#previewViewport");
   const card = $("#previewCard");
   const root = document.documentElement;

   // Save everything we are about to mutate so we can restore it afterward.
   const pagePosition = { x: window.scrollX, y: window.scrollY };
   const canvasPosition = { x: viewport.scrollLeft, y: viewport.scrollTop };
   const scrollBehavior = root.style.scrollBehavior;
   const previousZoom = card?.style.zoom;
   const previousDocTitle = document.title;

   // Give the print dialog a meaningful default filename.
   document.title = buildPdfDocumentTitle();

   // Export always uses the print stylesheet at paper scale (zoom 1) from the
   // top-left origin so nothing is clipped.
   root.style.scrollBehavior = "auto";
   window.scrollTo(0, 0);
   viewport.scrollTo(0, 0);
   if (card) card.style.zoom = 1;

   requestAnimationFrame(() => {
      window.print();
      // Restore the editor exactly as the user left it.
      if (card) card.style.zoom = printLayoutPreview ? 1 : previousZoom || "";
      window.scrollTo(pagePosition.x, pagePosition.y);
      viewport.scrollTo(canvasPosition.x, canvasPosition.y);
      root.style.scrollBehavior = scrollBehavior;
      document.title = previousDocTitle;
      if (typeof onAfterFrame === "function") {
         requestAnimationFrame(onAfterFrame);
      }
   });
}
