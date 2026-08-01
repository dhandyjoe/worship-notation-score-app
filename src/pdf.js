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

import { $ } from "./dom.js";
import { safeFileName } from "./notation.js";

// Whether WE added the is-print-layout class for the current print job. We only
// strip it in afterprint if we added it — this preserves a manual "PDF layout"
// preview toggle that the user may have switched on themselves.
let printClassAddedForJob = false;

// CSS class marking bars that are NOT the first bar on their printed row. Their
// left barline overlaps the previous bar's right barline (doubling thickness),
// so we hide it via CSS (see styles/preview.css). Bars at the start of a row
// keep their left barline so every row opens with a clean divider.
const MID_BAR_CLASS = "pdf-mid-bar";

/**
 * Tag every bar that does not start a printed row with MID_BAR_CLASS so its
 * redundant left barline can be hidden. Must run while `is-print-layout` is
 * active (its geometry decides where bars wrap). Row membership is derived from
 * each bar's vertical offset within its .bar-grid (bars on the same row share a
 * top; a new top means a new row → that bar is a row start → keep its barline).
 */
export function markMidRowBars() {
   document.querySelectorAll(".bar-grid").forEach((grid) => {
      let rowTop = null;
      grid.querySelectorAll(".bar").forEach((bar) => {
         const top = Math.round(bar.getBoundingClientRect().top);
         // First bar overall, or first bar whose top differs from the current
         // row, starts a new row → keep its left barline.
         if (rowTop === null || Math.abs(top - rowTop) > 1) {
            rowTop = top;
            bar.classList.remove(MID_BAR_CLASS);
         } else {
            bar.classList.add(MID_BAR_CLASS);
         }
      });
   });
}

/** Remove all MID_BAR_CLASS tags added by markMidRowBars(). */
export function clearMidRowBars() {
   document.querySelectorAll(`.${MID_BAR_CLASS}`).forEach((bar) => bar.classList.remove(MID_BAR_CLASS));
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
      // Tag mid-row bars now that print geometry is active, so overlapping
      // left barlines can be hidden.
      markMidRowBars();
   });
   window.addEventListener("afterprint", () => {
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
