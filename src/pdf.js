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
   });
   window.addEventListener("afterprint", () => {
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
