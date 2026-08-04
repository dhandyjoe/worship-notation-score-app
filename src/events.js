// events.js — all user interaction: palette selection, drag/drop, preview binding,
// meta editing, ribbon/theme/zoom, import/export, and global listeners.
import {
   keys,
   meters,
   durationMeta,
   nashvilleChoices,
   nashvilleAccidentals,
   lyricsFeatureAvailable,
   newSection,
   isNashvilleChord,
   transposeNote,
   transposeChord,
   normalizeSection,
   safeFileName,
   removeBar,
   beatValue,
   lyricValue,
   setLyric,
   prepareLyricsForDuration,
   barHasContent,
   syllabifyLyrics,
   MAX_SECTIONS,
} from "./notation.js?v=20260810-devicehint-modal";
import { $, prefersTap, isPhone, toast } from "./dom.js?v=20260810-devicehint-modal";
import {
   getState,
   setState,
   resetState,
   findSection,
   getSelectedPaletteItem,
   setSelectedPaletteItem,
} from "./store.js?v=20260810-devicehint-modal";
import {
   initRender,
   renderControls,
   renderPreview,
   renderCustomChord,
   chordLabel,
} from "./render.js?v=20260810-devicehint-modal";
import { initPrintListeners, exportToPdf } from "./pdf.js?v=20260810-devicehint-modal";
import { initPdfOptions } from "./pdfOptions.js?v=20260810-devicehint-modal";
import { initCloudUI } from "./cloudUI.js?v=20260810-devicehint-modal";

// ---- UI-only state (not part of the serializable document) ----
// Firestore doc id of the currently-open cloud song (null = unsaved / local only).
let currentCloudId = null;
let previewZoom = Math.min(1.35, Math.max(0.65, Number(localStorage.getItem("chordSheetZoom")) || 1));
const storedTheme = localStorage.getItem("chordSheetTheme");
let activeTheme =
   storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
let printLayoutPreview = false;
// Handle returned by initPdfOptions(), so features outside the editor (the
// My Songs cards) can open the PDF options dialog for a freshly-loaded song.
let pdfOptionsControl = null;

// Project content intentionally lives in memory only. Use Export .file for persistence.
function save() {}
function syncEditor() {}

// ---- Palette selection ----
function updatePlacingBanner(item) {
   const banner = $("#placingBanner");
   if (!banner) return;
   if (!item) {
      banner.hidden = true;
      return;
   }
   const label =
      item.type === "chord"
         ? item.value
         : `${durationMeta[item.value]?.label || item.value} (${durationMeta[item.value]?.symbol || ""})`;
   const target = $("#placingLabel");
   if (target) target.textContent = label;
   banner.hidden = false;
}
export function clearPaletteSelection() {
   setSelectedPaletteItem(null);
   updatePlacingBanner(null);
   document.querySelectorAll(".palette-selected").forEach((target) => target.classList.remove("palette-selected"));
}
function selectPaletteItem(element, item) {
   setSelectedPaletteItem(item);
   updatePlacingBanner(item);
   document.querySelectorAll(".palette-selected").forEach((target) => target.classList.remove("palette-selected"));
   element.classList.add("palette-selected");
   if (item.type === "chord" && isNashvilleChord(item.value) && $("#nashvilleSelectedPreview"))
      $("#nashvilleSelectedPreview").innerHTML = chordLabel(item.value);
   const itemLabel =
      item.type === "chord"
         ? item.value
         : `${durationMeta[item.value]?.label || item.value} (${durationMeta[item.value]?.symbol || ""} each)`;
   toast(`${itemLabel} selected · ${prefersTap() ? "tap" : "click or drag it onto"} a beat`);
   if (prefersTap()) {
      toggleRibbon(false);
      requestAnimationFrame(() =>
         document.querySelector(".preview-stage")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
   }
}
function buildDragGhost(item) {
   const ghost = document.createElement("div");
   ghost.className = "drag-ghost";
   if (item.type === "chord") {
      ghost.innerHTML = chordLabel(item.value);
   } else {
      ghost.textContent = durationMeta[item.value]?.symbol || item.value;
   }
   // Positioned off-screen so it never flashes at its DOM location before the
   // browser snapshots it for the drag image.
   ghost.style.position = "fixed";
   ghost.style.top = "-1000px";
   ghost.style.left = "-1000px";
   ghost.style.pointerEvents = "none";
   return ghost;
}
function bindPaletteItem(element, item) {
   if (element.dataset.paletteBound) return;
   element.dataset.paletteBound = "true";
   element.tabIndex = 0;
   element.setAttribute("role", "button");
   const selected = getSelectedPaletteItem();
   if (selected?.type === item.type && selected?.value === item.value) element.classList.add("palette-selected");
   const select = () => {
      const current = getSelectedPaletteItem();
      if (current?.type === item.type && current?.value === item.value) {
         clearPaletteSelection();
         toast("Selection cleared · tap a placed chord to remove it");
         return;
      }
      selectPaletteItem(element, item);
   };
   element.addEventListener("click", select);
   element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
         event.preventDefault();
         select();
      }
   });
   element.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/chord-sheet", JSON.stringify(item));
      element.classList.add("is-dragging");
      document.body.classList.add("is-dragging");
      // Uniform drag ghost: chord chips and duration options have very different
      // intrinsic sizes, so the native drag image looked inconsistent ("+"/symbol
      // rendered at different sizes). Use a single fixed-size chip for every item.
      const ghost = buildDragGhost(item);
      if (ghost && event.dataTransfer.setDragImage) {
         document.body.appendChild(ghost);
         event.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
         requestAnimationFrame(() => ghost.remove());
      }
   });
   element.addEventListener("dragend", () => {
      element.classList.remove("is-dragging");
      document.body.classList.remove("is-dragging");
      document.querySelectorAll(".drop-target.dragover").forEach((target) => target.classList.remove("dragover"));
   });
}
function bindDraggableChords() {
   document
      .querySelectorAll(".chord")
      .forEach((chord) => bindPaletteItem(chord, { type: "chord", value: chord.dataset.chord }));
}

// ---- Placing chords/durations ----
function placePaletteItem(section, beat, item) {
   if (!item || !section) return false;
   if (item.type === "chord") {
      const value = beatValue(section, beat.dataset.slot);
      value.chord = item.value;
      section.beats[beat.dataset.slot] = value;
   } else if (item.type === "duration") {
      const level = Number(beat.dataset.level || 0);
      if (level >= 2) {
         toast("Rhythm subdivisions are limited to two levels");
         return false;
      }
      if (level === 1 && item.value === "half" && beat.dataset.parentDuration === "half") {
         const splitSlot = beat.dataset.slot,
            value = beatValue(section, splitSlot),
            lyric = lyricValue(section, splitSlot);
         if (value.chord) {
            section.beats[`${splitSlot}.0`] = { chord: value.chord, duration: null };
            value.chord = null;
         }
         value.duration = "half";
         section.beats[splitSlot] = value;
         if (lyric) {
            setLyric(section, `${splitSlot}.0`, lyric);
            delete section.lyricBeats[splitSlot];
         }
         getState().activeId = section.id;
         return true;
      }
      const baseSlot = beat.dataset.baseSlot;
      prepareLyricsForDuration(section, baseSlot, item.value);
      const value = beatValue(section, baseSlot);
      if (value.chord) {
         section.beats[`${baseSlot}:0`] = { chord: value.chord, duration: null };
         value.chord = null;
      }
      value.duration = item.value;
      section.beats[baseSlot] = value;
   } else return false;
   getState().activeId = section.id;
   return true;
}
function flashDropTarget(sectionId, slot) {
   requestAnimationFrame(() => {
      const target = [...document.querySelectorAll(".drop-target")].find(
         (item) => item.dataset.section === sectionId && item.dataset.slot === slot,
      );
      if (!target) return;
      target.classList.add("drop-success");
      setTimeout(() => target.classList.remove("drop-success"), 450);
   });
}

// ---- Preview binding (re-run after every renderPreview) ----
function bindPreview() {
   const state = getState();
   document.querySelectorAll(".drop-target").forEach((beat) => {
      beat.addEventListener("dragover", (event) => {
         event.preventDefault();
         event.dataTransfer.dropEffect = "copy";
         beat.classList.add("dragover");
      });
      beat.addEventListener("dragleave", () => beat.classList.remove("dragover"));
      beat.addEventListener("drop", (event) => {
         event.preventDefault();
         event.stopPropagation();
         let item;
         try {
            item = JSON.parse(event.dataTransfer.getData("application/chord-sheet"));
         } catch {}
         const section = findSection(beat.dataset.section),
            slot = beat.dataset.slot;
         beat.classList.remove("dragover");
         document.body.classList.remove("is-dragging");
         if (!placePaletteItem(section, beat, item)) return;
         syncEditor();
         renderPreview();
         save();
         flashDropTarget(section.id, slot);
      });
      beat.addEventListener("click", (event) => {
         const selectedItem = getSelectedPaletteItem();
         if (!selectedItem || event.target.closest(".placed-chord,.duration-line,.nested-duration-line,.lyric-input"))
            return;
         event.stopPropagation();
         const section = findSection(beat.dataset.section),
            slot = beat.dataset.slot;
         if (!placePaletteItem(section, beat, selectedItem)) return;
         if (prefersTap()) clearPaletteSelection();
         syncEditor();
         renderPreview();
         save();
         flashDropTarget(section.id, slot);
      });
   });
   document.querySelectorAll(".placed-chord").forEach((chord) => {
      const removeOrReplace = (event) => {
         event.stopPropagation();
         const beat = chord.closest(".drop-target"),
            section = findSection(beat.dataset.section);
         const viaRemoveBadge = event.target?.closest?.(".chord-remove");
         const selectedItem = viaRemoveBadge ? null : getSelectedPaletteItem();
         if (selectedItem) {
            if (!placePaletteItem(section, beat, selectedItem)) return;
            if (prefersTap()) clearPaletteSelection();
            syncEditor();
            renderPreview();
            save();
            flashDropTarget(section.id, beat.dataset.slot);
            return;
         }
         // Animate the chord out before removing
         chord.classList.add("chord-leaving");
         const animEnd = async () => {
            chord.removeEventListener("transitionend", animEnd);
            delete section.beats[beat.dataset.slot];
            renderPreview();
            save();
            toast("Chord removed");
         };
         chord.addEventListener("transitionend", animEnd);
         // Safety net: if transitionend doesn't fire
         setTimeout(() => {
            chord.removeEventListener("transitionend", animEnd);
            if (section.beats[beat.dataset.slot]) {
               delete section.beats[beat.dataset.slot];
               renderPreview();
               save();
               toast("Chord removed");
            }
         }, 200);
      };
      chord.addEventListener("click", removeOrReplace);
      chord.addEventListener("keydown", (event) => {
         if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            removeOrReplace(event);
         }
      });
   });
   document.querySelectorAll(".nested-duration-line").forEach((line) =>
      line.addEventListener("click", (event) => {
         event.stopPropagation();
         const section = findSection(line.dataset.section),
            splitSlots = (line.dataset.splitSlots || "").split("|").filter(Boolean);
         if (!section) return;
         splitSlots.forEach((splitSlot) => {
            const childSlots = Object.keys(section.beats)
               .filter((slot) => slot.startsWith(`${splitSlot}.`))
               .sort();
            const firstChord = childSlots.map((slot) => beatValue(section, slot).chord).find(Boolean) || null;
            const lyricSlots = Object.keys(section.lyricBeats || {})
               .filter((slot) => slot.startsWith(`${splitSlot}.`))
               .sort();
            const mergedLyrics = lyricSlots
               .map((slot) => lyricValue(section, slot))
               .filter(Boolean)
               .join(" ");
            childSlots.forEach((slot) => delete section.beats[slot]);
            lyricSlots.forEach((slot) => delete section.lyricBeats[slot]);
            if (firstChord) section.beats[splitSlot] = { chord: firstChord, duration: null };
            else delete section.beats[splitSlot];
            setLyric(section, splitSlot, mergedLyrics);
         });
         state.activeId = section.id;
         renderPreview();
         save();
         toast("Nested half-beat subdivision removed");
      }),
   );
   document.querySelectorAll(".duration-line").forEach((line) =>
      line.addEventListener("click", (event) => {
         event.stopPropagation();
         const group = line.closest(".beat-group"),
            section = findSection(group.dataset.section),
            baseSlot = group.dataset.baseSlot;
         if (!section) return;
         const descendantSlots = Object.keys(section.beats)
            .filter((slot) => slot.startsWith(`${baseSlot}:`))
            .sort();
         const firstChord = descendantSlots.map((slot) => beatValue(section, slot).chord).find(Boolean) || null;
         const lyricSlots = Object.keys(section.lyricBeats || {})
            .filter((slot) => slot.startsWith(`${baseSlot}:`))
            .sort();
         const mergedLyrics = lyricSlots
            .map((slot) => lyricValue(section, slot))
            .filter(Boolean)
            .join(" ");
         descendantSlots.forEach((slot) => delete section.beats[slot]);
         lyricSlots.forEach((slot) => delete section.lyricBeats[slot]);
         if (firstChord) section.beats[baseSlot] = { chord: firstChord, duration: null };
         else delete section.beats[baseSlot];
         setLyric(section, baseSlot, mergedLyrics);
         state.activeId = section.id;
         renderPreview();
         save();
         toast("Rhythm marker removed");
      }),
   );
   document.querySelectorAll(".lyric-input").forEach((input) => {
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("input", () => {
         const section = findSection(input.dataset.section);
         if (!section) return;
         setLyric(section, input.dataset.slot, input.value);
         state.activeId = section.id;
         save();
      });
      input.addEventListener("blur", () => {
         const section = findSection(input.dataset.section);
         if (!section) return;
         input.value = input.value.trim();
         setLyric(section, input.dataset.slot, input.value);
         save();
      });
      input.addEventListener("keydown", (event) => {
         if (event.key === "Escape") {
            input.blur();
            return;
         }
         if (event.key !== "Enter") return;
         event.preventDefault();
         const inputs = [...document.querySelectorAll(".lyric-input")],
            index = inputs.indexOf(input),
            target = inputs[index + (event.shiftKey ? -1 : 1)];
         target?.focus();
         target?.select();
      });
      input.addEventListener("paste", (event) => {
         const pasted = event.clipboardData?.getData("text") || "",
            words = pasted.trim().split(/\s+/).filter(Boolean);
         if (words.length < 2) return;
         event.preventDefault();
         const inputs = [...document.querySelectorAll(".lyric-input")],
            start = inputs.indexOf(input),
            available = inputs.slice(start);
         available.forEach((field, index) => {
            if (index >= words.length) return;
            const section = findSection(field.dataset.section);
            const value =
               index === available.length - 1 && words.length > available.length
                  ? words.slice(index).join(" ")
                  : words[index];
            field.value = value;
            if (section) setLyric(section, field.dataset.slot, value);
         });
         save();
         const next = available[Math.min(words.length, available.length) - 1];
         next?.focus();
         next?.select();
         toast(`${words.length} words distributed across beats`);
      });
   });
   document.querySelectorAll(".section-lyrics-toggle").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         const section = findSection(button.dataset.section);
         if (!section) return;
         section.lyricsEnabled = section.lyricsEnabled === false;
         state.activeId = section.id;
         renderPreview();
         save();
         toast(`Lyrics ${section.lyricsEnabled ? "enabled" : "hidden"} for ${section.name}`);
      }),
   );
   document.querySelectorAll(".add-bar").forEach((button) =>
      button.addEventListener("click", () => {
         const section = findSection(button.dataset.section);
         if (!section) return;
         section.bars += 1;
         state.activeId = section.id;
         syncEditor();
         renderPreview();
         save();
         toast(`1 bar added to ${section.name}`);
      }),
   );
   document.querySelectorAll(".delete-bar").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         const section = findSection(button.dataset.section),
            bar = Number(button.dataset.bar);
         if (!section) return;
         if (section.bars <= 1) {
            toast("At least one bar must remain");
            return;
         }
         if (
            barHasContent(section, bar) &&
            !window.confirm(`Bar ${bar + 1} contains chords or lyrics. Delete this bar?`)
         )
            return;
         removeBar(section, bar);
         state.activeId = section.id;
         renderPreview();
         save();
         toast(`Bar ${bar + 1} deleted`);
      }),
   );
   // Long-press on mobile must not trigger selection/callout or accidental hover reflow around the bar.
   document.querySelectorAll(".bar").forEach((bar) => {
      bar.addEventListener("contextmenu", (event) => {
         if (event.target.closest(".lyric-input,.section-title-input,input,textarea,select")) return;
         event.preventDefault();
      });
   });
   document.querySelectorAll(".delete-section").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         if (state.sections.length <= 1) {
            toast("At least one section must remain");
            return;
         }
         const index = state.sections.findIndex((item) => item.id === button.dataset.section),
            section = state.sections[index];
         if (!section) return;
         const hasContent =
            Object.keys(section.beats || {}).length ||
            Object.values(section.lyricBeats || {}).some((text) => String(text).trim());
         if (hasContent && !window.confirm(`Section “${section.name}” contains chords or lyrics. Delete this section?`))
            return;
         state.sections.splice(index, 1);
         state.activeId = state.sections[Math.min(index, state.sections.length - 1)].id;
         state.editingId = null;
         syncEditor();
         renderPreview();
         save();
         toast(`Section “${section.name}” deleted`);
      }),
   );
   document
      .querySelectorAll(".section-menu")
      .forEach((menu) => menu.addEventListener("click", (event) => event.stopPropagation()));
   document.querySelectorAll(".section-title").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         state.activeId = button.dataset.section;
         state.editingId = button.dataset.section;
         syncEditor();
         renderPreview();
         requestAnimationFrame(() => $(".section-title-input")?.focus());
      }),
   );
   document.querySelectorAll(".section-title-input").forEach((input) => {
      const commit = () => {
         const section = findSection(input.dataset.section);
         if (!section) return; // bug fix: guard against section removed during blur
         section.name = input.value.trim() || "Untitled section";
         state.activeId = section.id;
         state.editingId = null;
         syncEditor();
         renderPreview();
         save();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (event) => {
         if (event.key === "Enter") {
            event.preventDefault();
            input.blur();
         }
         if (event.key === "Escape") {
            state.editingId = null;
            renderPreview();
         }
      });
      input.addEventListener("click", (event) => event.stopPropagation());
   });
   document.querySelectorAll(".preview-section").forEach((el) =>
      el.addEventListener("click", () => {
         state.activeId = el.dataset.section;
         syncEditor();
         renderPreview();
      }),
   );
}

// ---- Viewport / zoom / print layout ----
// Minimum width for one beat slot ("leaf"). Below this the line scrolls instead
// of shrinking further, so dots never get cramped.
const MIN_LEAF = 60;
/*
  Stretch every beat line so its dots span the full width of the score area —
  from the far-left barline to the right edge — while keeping the gap between
  every dot identical. Each batch (one printed line of up to 4 bars) fills its
  container: leaf = availableWidth / leavesInThatLine, floored at MIN_LEAF. When
  there are too many beats to fit, leaf stays at MIN_LEAF and the line scrolls.
  Lyrics mode uses the SAME dynamic --leaf so the beat pitch never changes when
  lyrics are toggled on/off (lyric columns are min-width:--leaf, width:max-content).
*/
function distributeLeafWidth() {
   // Print-layout preview uses fixed mm geometry, not --leaf; leave it alone.
   if (printLayoutPreview) return;
   document.querySelectorAll(".bar-grid").forEach((grid) => {
      const available = grid.clientWidth;
      if (!available) return;
      grid.querySelectorAll(".bar-batch").forEach((batch) => {
         const leaves =
            batch.querySelectorAll(".beat-column:not(.duration-column)").length +
            batch.querySelectorAll(".sub-beat").length;
         if (!leaves) {
            batch.style.removeProperty("--leaf");
            return;
         }
         const leaf = Math.max(MIN_LEAF, available / leaves);
         batch.style.setProperty("--leaf", `${leaf}px`);
      });
   });
}
function updateViewportOverflow() {
   distributeLeafWidth();
   const viewport = $("#previewViewport"),
      stage = document.querySelector(".preview-stage");
   if (!viewport || !stage) return;
   const overflowing = viewport.scrollWidth > viewport.clientWidth + 3,
      atEnd = viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 8;
   stage.classList.toggle("is-overflowing", overflowing);
   stage.classList.toggle("at-scroll-end", atEnd);
}
function setPreviewZoom(value, { persist = true } = {}) {
   const minimum = prefersTap() ? 1 : 0.65;
   previewZoom = Math.min(1.35, Math.max(minimum, Math.round(value * 20) / 20));
   // PDF layout preview uses the print unit grid at 100% paper scale.
   $("#previewCard").style.zoom = printLayoutPreview ? 1 : previewZoom;
   $("#zoomValue").textContent = `${Math.round((printLayoutPreview ? 1 : previewZoom) * 100)}%`;
   $("#zoomOut").disabled = printLayoutPreview || previewZoom <= minimum;
   $("#zoomIn").disabled = printLayoutPreview || previewZoom >= 1.35;
   if (persist && !printLayoutPreview) localStorage.setItem("chordSheetZoom", String(previewZoom));
   requestAnimationFrame(updateViewportOverflow);
}
function fitPreview() {
   if (printLayoutPreview) {
      const viewport = $("#previewViewport");
      if (viewport) viewport.scrollLeft = 0;
      requestAnimationFrame(updateViewportOverflow);
      return;
   }
   const viewport = $("#previewViewport"),
      card = $("#previewCard");
   if (!viewport || !card) return;
   card.style.zoom = 1;
   const available = Math.max(320, viewport.clientWidth - 48),
      ratio = Math.min(1, available / card.offsetWidth);
   setPreviewZoom(ratio);
   viewport.scrollLeft = 0;
}
function setPrintLayoutPreview(enabled, { announce = true } = {}) {
   printLayoutPreview = Boolean(enabled);
   document.documentElement.classList.toggle("is-print-layout", printLayoutPreview);
   const toggle = $("#printPreviewToggle");
   if (toggle) {
      toggle.setAttribute("aria-pressed", String(printLayoutPreview));
      toggle.textContent = printLayoutPreview ? "Exit PDF layout" : "PDF layout";
      toggle.title = printLayoutPreview ? "Return to the editable live preview" : "Preview the printable PDF layout";
   }
   const fit = $("#fitPreview");
   if (fit) fit.disabled = printLayoutPreview;
   setPreviewZoom(previewZoom, { persist: false });
   if (announce)
      toast(printLayoutPreview ? "PDF layout preview on · export will use this geometry" : "Back to live preview");
   requestAnimationFrame(() => {
      $("#previewViewport")?.scrollTo(0, 0);
      updateViewportOverflow();
   });
}

// ---- Transpose ----
function transposeSheet(semitones) {
   const state = getState();
   let changed = 0;
   state.sections.forEach((section) =>
      Object.entries(section.beats).forEach(([slot, value]) => {
         const current = typeof value === "string" ? value : value?.chord;
         if (!current) return;
         const next = transposeChord(current, semitones);
         if (next === current) return;
         if (typeof value === "string") section.beats[slot] = next;
         else value.chord = next;
         changed++;
      }),
   );
   state.key = transposeNote(state.key, semitones);
   $("#keySelect").value = state.key;
   clearPaletteSelection();
   renderControls();
   renderPreview();
   save();
   toast(
      changed
         ? `${changed} chord${changed === 1 ? "" : "s"} transposed ${semitones > 0 ? "up" : "down"} one semitone`
         : "No absolute chords to transpose",
   );
}

// ---- Import / export ----
function projectData() {
   const state = getState();
   return {
      format: "chord-sheet",
      version: 2,
      title: $("#songTitle").value,
      artist: $("#artist").value,
      key: state.key,
      chordRoot: state.chordRoot,
      customChord: state.customChord,
      meter: state.meter,
      lyricsEnabled: state.lyricsEnabled,
      sections: state.sections,
      slashChords: state.slashChords,
      nashvilleNumber: state.nashvilleNumber,
      nashvilleAccidental: state.nashvilleAccidental,
   };
}
function downloadProject() {
   const defaultName = safeFileName($("#songTitle").value),
      requestedName = window.prompt("File name:", defaultName);
   if (requestedName === null) return;
   const content = JSON.stringify(projectData(), null, 2),
      file = new Blob([content], { type: "application/json" }),
      url = URL.createObjectURL(file),
      link = document.createElement("a");
   link.href = url;
   link.download = `${safeFileName(requestedName || defaultName)}.chordsheet.json`;
   document.body.append(link);
   link.click();
   link.remove();
   URL.revokeObjectURL(url);
   toast("WorshipNotationScore file exported");
}
function applyProject(project) {
   if (!project || project.format !== "chord-sheet" || !Array.isArray(project.sections))
      throw new Error("Unrecognized file format");
   const meter = meters.includes(project.meter) ? project.meter : "4/4";
   const sections = project.sections
      .filter((section) => section && typeof section === "object")
      .slice(0, MAX_SECTIONS) // bug fix: cap section count from untrusted files
      .map((section) => normalizeSection(section, meter));
   if (!sections.length) throw new Error("The file does not contain any sections");
   const lyricsEnabled =
      typeof project.lyricsEnabled === "boolean"
         ? project.lyricsEnabled
         : sections.some((section) => Object.keys(section.lyricBeats).length > 0);
   setState({
      key: keys.includes(project.key) ? project.key : "C",
      chordRoot: keys.includes(project.chordRoot) ? project.chordRoot : "C",
      customChord: typeof project.customChord === "string" ? project.customChord : "",
      meter,
      lyricsEnabled,
      sections,
      slashChords: Array.isArray(project.slashChords)
         ? project.slashChords.filter((chord) => typeof chord === "string")
         : [],
      nashvilleNumber: nashvilleChoices.includes(project.nashvilleNumber) ? project.nashvilleNumber : "1",
      nashvilleAccidental: nashvilleAccidentals.includes(project.nashvilleAccidental)
         ? project.nashvilleAccidental
         : "",
      activeId: sections[0].id,
      editingId: null,
   });
   clearPaletteSelection();
   $("#songTitle").value = String(project.title || "Song Title");
   $("#artist").value = String(project.artist || "Artist / Composer");
   $("#timeSignature").value = getState().meter;
   syncEditor();
   renderControls();
   renderPreview();
   save();
}

// ---- Inline meta editing (title/artist/key/meter) ----
function beginMetaEdit(kind) {
   const state = getState();
   const config = {
      title: { target: "#previewTitle", source: "#songTitle", type: "text" },
      artist: { target: "#previewArtist", source: "#artist", type: "text" },
      key: { target: "#previewKey", source: "#keySelect", type: "select", options: keys },
      meter: { target: "#previewMeter", source: "#timeSignature", type: "select", options: meters },
   }[kind];
   const target = $(config.target),
      source = $(config.source);
   if (target.querySelector("input,select")) return;
   const editor = document.createElement(config.type === "select" ? "select" : "input");
   editor.className = "preview-inline-input";
   if (config.type === "select") {
      editor.innerHTML = config.options.map((option) => `<option value="${option}">${option}</option>`).join("");
      editor.value = source.value;
   } else {
      editor.type = "text";
      editor.value = source.value;
   }
   let committed = false;
   const commit = () => {
      if (committed) return;
      committed = true;
      source.value = editor.value;
      target.classList.remove("is-editing");
      if (kind === "key") state.key = editor.value;
      if (kind === "meter") state.meter = editor.value;
      renderControls();
      renderPreview();
      save();
   };
   target.textContent = "";
   target.classList.add("is-editing");
   target.append(editor);
   editor.focus();
   editor.select?.();
   editor.addEventListener("blur", commit, { once: true });
   editor.addEventListener("change", () => (config.type === "select" ? commit() : editor.blur()));
   editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter") editor.blur();
      if (event.key === "Escape") {
         target.classList.remove("is-editing");
         renderPreview();
      }
   });
}

// ---- Ribbon / theme ----
const ribbonLabels = {
   chord: "Chord palette",
   slash: "Slash chord builder",
   nashville: "Nashville Number System",
   rhythm: "Rhythm values",
   lyrics: "Lyrics settings",
};
function activateRibbon(tab, { focus = false, expand = true } = {}) {
   const selected = tab.dataset.ribbonTab;
   document.querySelectorAll(".ribbon-tab").forEach((item) => {
      const active = item === tab;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
   });
   document.querySelectorAll(".ribbon-panel").forEach((panel) => {
      const active = panel.dataset.ribbonPanel === selected;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
   });
   $("#activeToolLabel").textContent = ribbonLabels[selected] || "Arrangement tools";
   if (prefersTap()) tab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
   if (expand && $("#ribbonToggle").getAttribute("aria-expanded") === "false") toggleRibbon(true);
   if (focus) tab.focus();
}
function toggleRibbon(forceExpanded) {
   const editor = document.querySelector(".editor-card"),
      currentlyExpanded = !editor.classList.contains("is-collapsed"),
      expanded = typeof forceExpanded === "boolean" ? forceExpanded : !currentlyExpanded;
   editor.classList.toggle("is-collapsed", !expanded);
   $("#ribbonToggle").setAttribute("aria-expanded", String(expanded));
   $("#ribbonToggle").title = expanded ? "Collapse toolbar" : "Expand toolbar";
   $("#ribbonToggle").querySelector(".sr-only").textContent = expanded ? "Collapse toolbar" : "Expand toolbar";
   requestAnimationFrame(updateViewportOverflow);
}
function applyTheme(theme, { persist = true, announce = false } = {}) {
   activeTheme = theme === "dark" ? "dark" : "light";
   document.documentElement.dataset.theme = activeTheme;
   document.documentElement.style.colorScheme = activeTheme;
   const toggle = $("#themeToggle"),
      dark = activeTheme === "dark";
   toggle.setAttribute("aria-pressed", String(dark));
   toggle.title = `Switch to ${dark ? "light" : "dark"} mode`;
   toggle.querySelector(".theme-toggle-icon").textContent = dark ? "☀" : "☾";
   toggle.querySelector(".theme-toggle-label").textContent = dark ? "Light mode" : "Dark mode";
   document.querySelector('meta[name="theme-color"]').content = dark ? "#101110" : "#1f704a";
   if (persist) localStorage.setItem("chordSheetTheme", activeTheme);
   if (announce) toast(`${dark ? "Dark" : "Light"} mode enabled`);
}

// ---- Wire up all listeners (called once at bootstrap) ----
function bindControlListeners() {
   const state = getState();
   $("#keySelect").addEventListener("change", (event) => {
      state.key = event.target.value;
      renderPreview();
      save();
   });
   $("#chordRootPicker").addEventListener("click", (event) => {
      if (!event.target.dataset.root) return;
      clearPaletteSelection();
      getState().chordRoot = event.target.dataset.root;
      renderControls();
      save();
   });
   $("#customChordInput").addEventListener("input", (event) => {
      clearPaletteSelection();
      getState().customChord = event.target.value;
      renderCustomChord();
      save();
   });
   $("#addSlashBtn").addEventListener("click", () => {
      const chord = `${$("#slashRoot").value}${$("#slashQuality").value}/${$("#slashBass").value}`;
      const slashChords = getState().slashChords;
      if (!slashChords.includes(chord)) slashChords.push(chord);
      renderControls();
      save();
      toast(`${chord} is ready to drag`);
   });
   $("#nashvilleRootPicker").addEventListener("click", (event) => {
      const button = event.target.closest(".nashville-key");
      if (!button) return;
      clearPaletteSelection();
      getState().nashvilleNumber = button.dataset.number;
      renderControls();
      save();
   });
   $("#nashvilleAccidentalPicker").addEventListener("click", (event) => {
      if (event.target.dataset.accidental === undefined) return;
      clearPaletteSelection();
      getState().nashvilleAccidental = event.target.dataset.accidental;
      renderControls();
      save();
   });
   $("#transposeDown").addEventListener("click", () => transposeSheet(-1));
   $("#transposeUp").addEventListener("click", () => transposeSheet(1));
   $("#lyricsEnabled").addEventListener("change", (event) => {
      getState().lyricsEnabled = event.target.checked;
      renderControls();
      renderPreview();
      save();
      toast(getState().lyricsEnabled ? "Lyrics mode enabled" : "Lyrics hidden from score");
   });
   bindAutoSyllable();
   document.querySelectorAll(".ribbon-tab").forEach((tab) => {
      tab.addEventListener("click", () => activateRibbon(tab));
      tab.addEventListener("keydown", (event) => {
         if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
         event.preventDefault();
         const tabs = [...document.querySelectorAll(".ribbon-tab:not([hidden])")],
            index = tabs.indexOf(tab);
         const next =
            event.key === "Home"
               ? tabs[0]
               : event.key === "End"
                 ? tabs.at(-1)
                 : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
         activateRibbon(next, { focus: true });
      });
   });
   $("#ribbonToggle").addEventListener("click", () => toggleRibbon());
   $("#themeToggle").addEventListener("click", () =>
      applyTheme(activeTheme === "dark" ? "light" : "dark", { announce: true }),
   );
   $("#zoomOut").addEventListener("click", () => setPreviewZoom(previewZoom - 0.1));
   $("#zoomIn").addEventListener("click", () => setPreviewZoom(previewZoom + 0.1));
   $("#fitPreview").addEventListener("click", fitPreview);
   $("#printPreviewToggle")?.addEventListener("click", () => setPrintLayoutPreview(!printLayoutPreview));
   $("#previewViewport").addEventListener("scroll", updateViewportOverflow, { passive: true });
   $("#previewTitle").addEventListener("click", (event) => {
      if (!event.target.matches("input")) beginMetaEdit("title");
   });
   $("#previewArtist").addEventListener("click", (event) => {
      if (!event.target.matches("input")) beginMetaEdit("artist");
   });
   $("#previewKey").addEventListener("click", (event) => {
      if (!event.target.matches("select")) beginMetaEdit("key");
   });
   $("#previewMeter").addEventListener("click", (event) => {
      if (!event.target.matches("select")) beginMetaEdit("meter");
   });
   $("#timeSignature").addEventListener("change", (event) => {
      getState().meter = event.target.value;
      renderPreview();
      save();
      toast(`Preview updated to ${getState().meter}`);
   });
   $("#songTitle").addEventListener("input", () => {
      renderPreview();
      save();
   });
   $("#artist").addEventListener("input", () => {
      renderPreview();
      save();
   });
   $("#placingCancel")?.addEventListener("click", () => {
      clearPaletteSelection();
      toast("Selection cleared");
   });
   $("#addSectionBtn").addEventListener("click", () => {
      const currentState = getState();
      if (currentState.sections.length >= MAX_SECTIONS) {
         toast(`Maximum of ${MAX_SECTIONS} sections reached`);
         return;
      }
      const section = newSection(`Section ${currentState.sections.length + 1}`);
      currentState.sections.push(section);
      currentState.activeId = section.id;
      syncEditor();
      renderPreview();
      save();
      toast("New section added");
   });
   $("#resetSheetBtn").addEventListener("click", () => {
      if (!window.confirm("Reset the entire score to its default state?")) return;
      resetState();
      clearPaletteSelection();
      $("#songTitle").value = "Song Title";
      $("#artist").value = "Artist / Composer";
      $("#timeSignature").value = "4/4";
      syncEditor();
      renderControls();
      renderPreview();
      save();
      toast("Score reset to default");
   });
   $("#saveBtn")?.addEventListener("click", downloadProject);
   $("#projectFileInput")?.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
         applyProject(JSON.parse(await file.text()));
         toast("Score loaded and ready to edit");
      } catch (error) {
         toast("Invalid file or not a WorshipNotationScore project");
      } finally {
         event.target.value = "";
      }
   });
   $("#exportBtn").addEventListener("click", () => {
      renderPreview();
      // The Export .pdf button now opens the PDF options dialog (initPdfOptions
      // wires the actual click→open). renderPreview() first so the adopted
      // #previewCard shows the current score. The real export runs from the
      // dialog's own "Export PDF" button via the onExport callback below.
   });
   // PDF options dialog: tweaks --print-* tokens live (mirrors into the on-screen
   // PDF layout preview) without touching the live editor. Opened by #exportBtn.
   pdfOptionsControl = initPdfOptions({
      setPreview: (on, opts) => setPrintLayoutPreview(on, opts),
      isPreviewOn: () => printLayoutPreview,
      onExport: () => {
         renderPreview();
         exportToPdf({ printLayoutPreview, onAfterFrame: updateViewportOverflow });
      },
   });
   window.addEventListener(
      "scroll",
      () => {
         const editor = document.querySelector(".editor-card");
         editor.classList.toggle("is-scrolled", editor.getBoundingClientRect().top <= 80);
      },
      { passive: true },
   );
   window.addEventListener("resize", updateViewportOverflow, { passive: true });

   // Register beforeprint/afterprint so the `is-print-layout` geometry is the
   // single source of truth for printed output (see src/pdf.js).
   initPrintListeners();

   document.addEventListener("keydown", (event) => {
      const editing = event.target?.matches?.('input,textarea,select,[contenteditable="true"]') ?? false;
      if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "0"].includes(event.key)) {
         event.preventDefault();
         if (event.key === "-") setPreviewZoom(previewZoom - 0.1);
         else if (event.key === "0") fitPreview();
         else setPreviewZoom(previewZoom + 0.1);
         return;
      }
      if (event.altKey && !editing && /^[1-5]$/.test(event.key)) {
         event.preventDefault();
         const tab = document.querySelectorAll(".ribbon-tab:not([hidden])")[Number(event.key) - 1];
         if (tab) activateRibbon(tab, { focus: true });
         return;
      }
      if (event.key === "Escape" && !editing && printLayoutPreview) {
         event.preventDefault();
         setPrintLayoutPreview(false);
         return;
      }
      if (event.key === "Escape" && !editing && getSelectedPaletteItem()) {
         event.preventDefault();
         clearPaletteSelection();
         toast("Selection cleared · tap a placed chord to remove it");
         return;
      }
      if (event.key === "Escape" && !editing && $("#ribbonToggle").getAttribute("aria-expanded") === "true")
         toggleRibbon(false);
   });
}

// ---- Auto-syllable: split a pasted line into singable syllables across beats ----
// The lyric inputs are already laid out in visual (beat) order in the DOM, so we
// reuse that ordering — the same approach the per-input paste handler uses.
function bindAutoSyllable() {
   const input = $("#autoSyllableInput");
   const apply = $("#autoSyllableApply");
   const hint = $("#autoSyllableHint");
   if (!input || !apply) return;

   const setHint = (text) => {
      if (hint) hint.textContent = text || "";
   };

   const run = () => {
      const state = getState();
      const text = input.value.trim();
      if (!text) {
         setHint("Type or paste a lyric line first.");
         input.focus();
         return;
      }
      // Ensure lyrics mode is on for the active section so the beat inputs exist.
      const section = findSection(state.activeId) || state.sections[0];
      if (!section) return;
      if (!state.lyricsEnabled) {
         state.lyricsEnabled = true;
         $("#lyricsEnabled").checked = true;
      }
      section.lyricsEnabled = true;
      state.activeId = section.id;
      renderControls();
      renderPreview();

      // Collect this section's lyric inputs in visual order.
      const inputs = [...document.querySelectorAll(`.lyric-input[data-section="${section.id}"]`)];
      if (!inputs.length) {
         setHint("This section has no beats to fill.");
         return;
      }
      const tokens = syllabifyLyrics(text);
      if (!tokens.length) {
         setHint("Nothing to split.");
         return;
      }
      // Write syllables into consecutive beats; if we run out of beats, pack the
      // remaining syllables into the last available slot so nothing is lost.
      inputs.forEach((field, index) => {
         if (index >= tokens.length) {
            // Clear leftover beats beyond the lyric so old text doesn't linger.
            field.value = "";
            setLyric(section, field.dataset.slot, "");
            return;
         }
         const value =
            index === inputs.length - 1 && tokens.length > inputs.length
               ? tokens.slice(index).join(" ")
               : tokens[index];
         field.value = value;
         setLyric(section, field.dataset.slot, value);
      });
      save();

      const placed = Math.min(tokens.length, inputs.length);
      const overflow = tokens.length > inputs.length;
      setHint(
         overflow
            ? `${tokens.length} syllables placed; extras packed into the last beat.`
            : `${tokens.length} syllable${tokens.length === 1 ? "" : "s"} → ${placed} beat${placed === 1 ? "" : "s"} in “${section.name}”.`,
      );
      toast(`Filled ${placed} beat${placed === 1 ? "" : "s"} with syllables`);
   };

   apply.addEventListener("click", run);
   input.addEventListener("keydown", (event) => {
      // Ctrl/Cmd+Enter runs the split without leaving the textarea.
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
         event.preventDefault();
         run();
      }
   });
}

// ---- Public bootstrap entry point ----
// Desktop-recommendation hint: on PHONES only, gently suggest a larger screen
// for a roomier arranging + preview experience. Shown on EVERY load/refresh (no
// persistence) as a centered modal over a blurred backdrop. NOT shown on
// tablets/iPads or desktop — those are all considered recommended devices
// (desktop / laptop / tablet). Dismissing it just closes it for the current visit.
function initDeviceHint() {
   const hint = $("#deviceHint");
   if (!hint) return;
   // Only phones (<= 680px) get the hint. Tablets & desktop are recommended.
   if (!isPhone()) return;

   const dismiss = () => {
      hint.classList.remove("is-open");
      // Wait for the fade-out transition before hiding from the a11y tree.
      setTimeout(() => {
         hint.hidden = true;
      }, 300);
   };

   hint.hidden = false;
   // Force a reflow so the browser commits the hidden→visible start state
   // (opacity:0) before we add the class that fades it in. A tiny timeout is a
   // robust fallback to nested rAF, which can be throttled in background tabs.
   void hint.offsetHeight;
   setTimeout(() => hint.classList.add("is-open"), 60);
   $("#deviceHintClose")?.addEventListener("click", dismiss);
}

export function initEvents() {
   // Inject rendering hooks so render.js never needs to import this module (keeps graph acyclic).
   initRender({ bindDraggableChords, bindPaletteItem, bindPreview, updateViewportOverflow });
   bindControlListeners();
   localStorage.removeItem("chordSheetPreview");
   applyTheme(activeTheme, { persist: false });
   syncEditor();
   renderControls();
   renderPreview();
   activateRibbon(document.querySelector(".ribbon-tab.active"), { expand: false });
   setPreviewZoom(previewZoom, { persist: false });
   if ("ResizeObserver" in window) new ResizeObserver(updateViewportOverflow).observe($("#previewViewport"));
   // Distribute beat widths right away (don't wait only on rAF, which is
   // throttled in hidden tabs) and again once web fonts finish loading, since
   // font metrics can change the grid's usable width.
   updateViewportOverflow();
   if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateViewportOverflow);
   window.addEventListener("load", updateViewportOverflow, { once: true });
   initDeviceHint();
   // Cloud sync (login + My Songs). Bridged via callbacks so cloudUI never
   // imports this module — keeps the dependency graph acyclic.
   initCloudUI({
      getProject: () => projectData(),
      applyProject: (project) => applyProject(project),
      getCloudId: () => currentCloudId,
      setCloudId: (id) => {
         currentCloudId = id || null;
      },
      // Used by the per-card "Export .pdf" action: the song is applied to the
      // editor first, so the dialog's live preview shows that song's score.
      openPdfOptions: () => {
         renderPreview();
         pdfOptionsControl?.open();
      },
   });
}
