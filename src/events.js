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
   extractBar,
   replaceBarContent,
   cloneSection,
   extractBars,
   insertBars,
   overwriteBars,
   beatValue,
   lyricValue,
   setLyric,
   prepareLyricsForDuration,
   chordAboveValue,
   setChordAbove,
   barHasContent,
   syllabifyLyrics,
   MAX_SECTIONS,
} from "./notation.js?v=20260824-chordAbove";
import { $, prefersTap, isPhone, toast } from "./dom.js?v=20260824-chordAbove";
import { clearHistory, saveState, undo, redo, canUndo, canRedo } from "./history.js?v=20260824-chordAbove";
import { setClipboard, getClipboard, hasClipboard } from "./clipboard.js?v=20260824-chordAbove";
import {
   getState,
   setState,
   resetState,
   findSection,
   getSelectedPaletteItem,
   setSelectedPaletteItem,
} from "./store.js?v=20260824-chordAbove";
import {
   initRender,
   renderControls,
   renderPreview,
   renderCustomChord,
   chordLabel,
} from "./render.js?v=20260824-chordAbove";
import { initPrintListeners, exportToPdf } from "./pdf.js?v=20260824-chordAbove";
import { initPdfOptions, getPdfOptions, setPdfOptions } from "./pdfOptions.js?v=20260824-chordAbove";
import { initCloudUI } from "./cloudUI.js?v=20260824-chordAbove";
import { openChordEditor, closeChordEditor, isChordEditorOpen } from "./chordEditor.js?v=20260824-chordAbove";
import { openBeatMenu, closeBeatMenu } from "./beatMenu.js?v=20260824-chordAbove";
import { startPlayback, stopPlayback, getIsPlaying, highlightBeat } from "./playback.js?v=20260824-chordAbove";

// ---- UI-only state (not part of the serializable document) ----
// Firestore doc id of the currently-open cloud song (null = unsaved / local only).
let currentCloudId = null;
// Tracks whether the document has been edited since it was last loaded from — or
// saved to — the cloud. Powers the "unsaved changes" guard on Back to My Songs.
// Set true by save() (fired on every edit), cleared on fresh load / cloud save.
let dirtySinceSave = false;
// Single writer for the dirty flag. Also broadcasts the change so the topbar
// "Save to Cloud" button can show/hide its unsaved-changes badge (see cloudUI).
function setDirty(next) {
   const value = !!next;
   if (value === dirtySinceSave) return;
   dirtySinceSave = value;
   window.dispatchEvent(new CustomEvent("chordsheet:dirtychange", { detail: { dirty: value } }));
}
// The live preview is locked to a fixed "fit width" scale (no zoom controls).
// 0.95 keeps the page comfortably inside the canvas with a small breathing gap.
const FIXED_PREVIEW_ZOOM = 0.95;
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
// save() is the single chokepoint fired after every edit, so it's also where we
// flag the document as having unsaved changes (see dirtySinceSave / the Back guard).
function save() {
   // While undo/redo is restoring a snapshot we must NOT record it again,
   // otherwise the future (redo) buffer gets cleared and the stack corrupts.
   if (!isRestoring) {
      const snapshot = projectData();
      saveState(snapshot);
      updateUndoRedoButtons();
   }
   setDirty(true);
}
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

// ---- Inline chord editor (type → pick a suggestion) ----
// Resolve a beat element by section+slot after a re-render (elements are rebuilt
// on every renderPreview, so we can't hold references across commits).
function findBeatEl(sectionId, slot) {
   return [...document.querySelectorAll(".drop-target")].find(
      (el) => el.dataset.section === sectionId && el.dataset.slot === slot,
   );
}
// Ordered list of beat elements for Tab navigation (document order = musical order).
function beatOrder() {
   return [...document.querySelectorAll(".drop-target")];
}
function neighbourBeat(anchor, dir) {
   const beats = beatOrder();
   const index = beats.indexOf(anchor);
   if (index < 0) return null;
   return beats[index + dir] || null;
}
// Write a chosen (already-normalized) chord value into state and re-render.
function commitChordToBeat(sectionId, slot, value) {
   const section = findSection(sectionId);
   if (!section) return;
   const beatEl = findBeatEl(sectionId, slot);
   const current = beatValue(section, slot);
   current.chord = value;
   section.beats[slot] = current;
   getState().activeId = sectionId;
   renderPreview();
   save();
   flashDropTarget(sectionId, slot);
}
// Open the editor on a beat element, wiring commit + Tab navigation callbacks.
function openBeatEditor(beat, { selectQuery = true } = {}) {
   const sectionId = beat.dataset.section;
   const slot = beat.dataset.slot;
   const section = findSection(sectionId);
   const initialValue = selectQuery ? beatValue(section, slot).chord || "" : "";
   openChordEditor({
      anchor: beat,
      initialValue,
      mode: getState().editorMode === "numbers" ? "numbers" : "chords",
      onCommit: (value) => commitChordToBeat(sectionId, slot, value),
      advanceTo: (currentAnchor, dir) => neighbourBeat(currentAnchor, dir),
      reopen: (nextAnchor) => openBeatEditor(nextAnchor),
   });
}

// ---- Rhythm context menu (right-click / long-press) ----
// Apply a subdivision by reusing the existing placePaletteItem duration path, so
// the (well-tested) split/merge + lyric-preservation logic stays single-sourced.
function applyDuration(beat, durationValue) {
   const section = findSection(beat.dataset.section);
   if (!section) return;
   if (!placePaletteItem(section, beat, { type: "duration", value: durationValue })) return;
   renderPreview();
   save();
   flashDropTarget(section.id, beat.dataset.slot);
}
// Remove a subdivision from a base-level beat, keeping the first child chord and
// merging child lyrics (mirrors the duration-line click handler below).
function removeDurationAt(beat) {
   // Block all editing while in bar-selection mode.
   if (isSelectionActiveFor(beat.dataset.section)) return;
   const section = findSection(beat.dataset.section);
   if (!section) return;
   const baseSlot = beat.dataset.baseSlot || beat.dataset.slot;
   if (!beatValue(section, baseSlot).duration) return;
   const descendantSlots = Object.keys(section.beats)
      .filter((slot) => slot === baseSlot || slot.startsWith(`${baseSlot}.`) || slot.startsWith(`${baseSlot}:`))
      .sort();
   const firstChord = descendantSlots.map((slot) => beatValue(section, slot).chord).find(Boolean) || null;
   const lyricSlots = Object.keys(section.lyricBeats || {})
      .filter((slot) => slot.startsWith(`${baseSlot}.`) || slot.startsWith(`${baseSlot}:`))
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
   getState().activeId = section.id;
   renderPreview();
   save();
   toast("Rhythm marker removed");
}
// Open the rhythm menu for a beat at the given viewport point.
function openRhythmMenu(beat, x, y) {
   // Block the rhythm menu entirely while in bar-selection mode.
   if (isSelectionActiveFor(beat.dataset.section)) return;
   closeChordEditor();
   const section = findSection(beat.dataset.section);
   if (!section) return;
   const level = Number(beat.dataset.level || 0);
   const baseSlot = beat.dataset.baseSlot || beat.dataset.slot;
   const hasDuration = !!beatValue(section, baseSlot).duration;
   const nested = level >= 1;
   const items = [
      {
         label: "½ — Half beat",
         hint: "2",
         disabled: level >= 2,
         action: () => applyDuration(beat, "half"),
      },
      {
         label: "⅓ — Triplet",
         hint: "3",
         disabled: nested,
         action: () => applyDuration(beat, "triplet"),
      },
      {
         label: "¼ — Quarter beat",
         hint: "4",
         disabled: nested,
         action: () => applyDuration(beat, "quarter"),
      },
      {
         label: "Remove subdivision",
         danger: true,
         disabled: !hasDuration || nested,
         action: () => removeDurationAt(beat),
      },
   ];
   openBeatMenu({ x, y, items });
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
      // Long-press bookkeeping (declared before the click handler so it can honor
      // the suppression window a just-fired long-press sets up).
      let pressTimer = null;
      let pressPoint = null;
      let suppressClickUntil = 0;
      const cancelPress = () => {
         if (pressTimer) clearTimeout(pressTimer);
         pressTimer = null;
      };
      beat.addEventListener("click", (event) => {
         if (event.target.closest(".placed-chord,.duration-line,.nested-duration-line,.lyric-input")) return;
         // On touch, lifting the finger after a long-press emits a synthetic
         // click on the beat. Without this guard it would open the chord editor
         // right on top of the rhythm menu the long-press just opened.
         if (Date.now() < suppressClickUntil) {
            suppressClickUntil = 0;
            event.stopPropagation();
            return;
         }
         // ---- Multi-bar selection mode intercept ----
         if (isSelectionActiveFor(beat.dataset.section)) {
            const barEl = beat.closest(".bar");
            const bar = Number(barEl?.dataset.bar);
            if (!Number.isNaN(bar)) {
               handleBarSelectionClick(beat.dataset.section, bar, event.shiftKey);
            }
            event.stopPropagation();
            return;
         }
         // ---- Normal beat click flow below ----
         const selectedItem = getSelectedPaletteItem();
         // Legacy palette flow (arrangement tools) still works when an item is
         // selected. Otherwise, clicking an empty beat opens the inline editor.
         if (selectedItem) {
            event.stopPropagation();
            const section = findSection(beat.dataset.section),
               slot = beat.dataset.slot;
            if (!placePaletteItem(section, beat, selectedItem)) return;
            if (prefersTap()) clearPaletteSelection();
            syncEditor();
            renderPreview();
            save();
            flashDropTarget(section.id, slot);
            return;
         }
         event.stopPropagation();
         openBeatEditor(beat, { selectQuery: false });
      });

      // Rhythm context menu: right-click (desktop) + long-press (touch).
      beat.addEventListener("contextmenu", (event) => {
         event.preventDefault();
         event.stopPropagation();
         openRhythmMenu(beat, event.clientX, event.clientY);
      });
      beat.addEventListener(
         "touchstart",
         (event) => {
            if (event.touches.length !== 1) return;
            const touch = event.touches[0];
            pressPoint = { x: touch.clientX, y: touch.clientY };
            cancelPress();
            pressTimer = setTimeout(() => {
               pressTimer = null;
               // Arm the guard so the trailing synthetic click (on finger lift)
               // is swallowed and doesn't open the chord editor over the menu.
               suppressClickUntil = Date.now() + 900;
               openRhythmMenu(beat, pressPoint.x, pressPoint.y);
            }, 500);
         },
         { passive: true },
      );
      beat.addEventListener(
         "touchmove",
         (event) => {
            if (!pressPoint || !event.touches.length) return;
            const touch = event.touches[0];
            if (Math.hypot(touch.clientX - pressPoint.x, touch.clientY - pressPoint.y) > 10) cancelPress();
         },
         { passive: true },
      );
      // If the long-press already fired, keep the click-suppression window alive
      // (touchend arrives right before the synthetic click). A normal short tap
      // clears nothing — its click proceeds and opens the chord editor.
      beat.addEventListener("touchend", cancelPress, { passive: true });
      beat.addEventListener("touchcancel", cancelPress, { passive: true });
   });
   document.querySelectorAll(".placed-chord").forEach((chord) => {
      const removeOrReplace = (event) => {
         event.stopPropagation();
         // Block all editing while in bar-selection mode.
         if (isSelectionActiveFor(chord.closest(".drop-target")?.dataset.section)) return;
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
         // Clicking the chord body (not the × badge) re-opens the editor so the
         // user can change it; the × badge removes the chord.
         if (!viaRemoveBadge) {
            openBeatEditor(beat, { selectQuery: true });
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
         // Block all editing while in bar-selection mode.
         if (isSelectionActiveFor(line.dataset.section)) return;
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
         // Block all editing while in bar-selection mode.
         if (isSelectionActiveFor(group.dataset.section)) return;
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
         // Block lyric edits while in bar-selection mode.
         if (isSelectionActiveFor(input.dataset.section)) {
            renderPreview();
            return;
         }
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
   // Chord-above inputs (Chord Chart mode): a letter chord above each number.
   // Free-text letter chord only (no Nashville) — mirrors lyric-input behaviour.
   document.querySelectorAll(".chord-above-input").forEach((input) => {
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("input", () => {
         const section = findSection(input.dataset.section);
         if (!section) return;
         if (isSelectionActiveFor(input.dataset.section)) {
            renderPreview();
            return;
         }
         setChordAbove(section, input.dataset.slot, input.value);
         state.activeId = section.id;
         save();
      });
      input.addEventListener("blur", () => {
         const section = findSection(input.dataset.section);
         if (!section) return;
         input.value = input.value.trim();
         setChordAbove(section, input.dataset.slot, input.value);
         renderPreview();
         save();
      });
      input.addEventListener("keydown", (event) => {
         if (event.key === "Escape") {
            input.blur();
            return;
         }
         if (event.key !== "Enter") return;
         event.preventDefault();
         const inputs = [...document.querySelectorAll(".chord-above-input")],
            index = inputs.indexOf(input),
            target = inputs[index + (event.shiftKey ? -1 : 1)];
         target?.focus();
         target?.select();
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
   document.querySelectorAll(".section-chord-above-toggle").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         const section = findSection(button.dataset.section);
         if (!section) return;
         section.chordAboveEnabled = section.chordAboveEnabled === false;
         state.activeId = section.id;
         renderPreview();
         save();
         toast(`Chords above ${section.chordAboveEnabled ? "enabled" : "hidden"} for ${section.name}`);
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
      // While bar-selection mode is active, the ENTIRE bar becomes one big clickable target.
      // A capture-phase listener runs before any inner editing handler (chords, rhythm lines,
      // lyric inputs, tool buttons), so it both (a) widens the hit area to the whole bar and
      // (b) blocks all content edits — clicking anywhere inside the bar only (de)selects it.
      bar.addEventListener(
         "click",
         (event) => {
            const sel = getBarSelection();
            const sectionId = bar.closest(".preview-section")?.dataset.section;
            if (!sel || !sel.active || sel.sectionId !== sectionId) return;
            event.stopPropagation();
            event.preventDefault();
            const barIndex = Number(bar.dataset.bar);
            if (Number.isNaN(barIndex)) return;
            handleBarSelectionClick(sel.sectionId, barIndex, event.shiftKey);
         },
         true, // capture phase: intercept before inner beat/chord/lyric handlers
      );
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
   document.querySelectorAll(".copy-section").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         copySection(button.dataset.section);
      }),
   );
   document.querySelectorAll(".paste-section").forEach((button) => {
      button.disabled = !hasClipboard("section");
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         pasteSection(button.dataset.section);
      });
   });
   document.querySelectorAll(".copy-bar").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         copyBar(button.dataset.section, Number(button.dataset.bar));
      }),
   );
   document.querySelectorAll(".paste-bar").forEach((button) => {
      button.disabled = !hasClipboard("bar") && !hasClipboard("bars");
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         pasteBar(button.dataset.section, Number(button.dataset.bar));
      });
   });
   document.querySelectorAll(".select-bars").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         // Close the ••• menu, then enter selection mode for this section.
         button.closest(".section-menu")?.removeAttribute("open");
         beginBarSelection(button.dataset.section);
      }),
   );
   document.querySelectorAll(".bar-selection-copy").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         copySelectedBars();
      }),
   );
   document.querySelectorAll(".bar-selection-cancel").forEach((button) =>
      button.addEventListener("click", (event) => {
         event.stopPropagation();
         cancelBarSelection();
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
// Apply the fixed preview scale. The PDF layout preview always renders at paper
// scale (zoom 1). The live editor is locked to FIXED_PREVIEW_ZOOM on desktop,
// but stays at 1 on touch devices so tap targets keep their accessible size
// (on phones the bars stack vertically, so no shrink-to-fit is needed).
function applyPreviewZoom() {
   const card = $("#previewCard");
   if (!card) return;
   const liveZoom = prefersTap() ? 1 : FIXED_PREVIEW_ZOOM;
   card.style.zoom = printLayoutPreview ? 1 : liveZoom;
   requestAnimationFrame(updateViewportOverflow);
}
function setPrintLayoutPreview(enabled, { announce = true } = {}) {
   printLayoutPreview = Boolean(enabled);
   document.documentElement.classList.toggle("is-print-layout", printLayoutPreview);
   applyPreviewZoom();
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

// ---- Undo/Redo ----
// Guard flag: true while applyProject() is replaying a history snapshot, so the
// save() call inside applyProject doesn't record the restore as a fresh edit.
let isRestoring = false;

function updateUndoRedoButtons() {
   const undoBtn = $("#undoBtn");
   const redoBtn = $("#redoBtn");
   if (undoBtn) undoBtn.disabled = !canUndo();
   if (redoBtn) redoBtn.disabled = !canRedo();
}

function undoSheet() {
   if (!canUndo()) return;
   isRestoring = true;
   undo((snapshot) => {
      applyProject(snapshot);
      toast("Undo");
   });
   isRestoring = false;
   updateUndoRedoButtons();
}

function redoSheet() {
   if (!canRedo()) return;
   isRestoring = true;
   redo((snapshot) => {
      applyProject(snapshot);
      toast("Redo");
   });
   isRestoring = false;
   updateUndoRedoButtons();
}

// ---- Copy / paste (sections & bars) ----
// Copy an entire section (deep-cloned) into the in-memory clipboard.
function copySection(sectionId) {
   const section = findSection(sectionId);
   if (!section) return;
   setClipboard("section", section, { name: section.name });
   updatePasteButtons();
   toast(`Section "${section.name}" copied`);
}
// Paste the clipboard's section content INTO the given section (overwrites all bars/lyrics).
// When pasting to the same section that was copied, it replaces its content with the copy.
// Uses the clipboard's original name to preserve identity (no " (copy)" suffix).
function pasteSection(afterSectionId) {
   const clip = getClipboard();
   if (!clip || clip.kind !== "section") {
      toast("Nothing to paste");
      return;
   }
   const state = getState();
   const targetIndex = state.sections.findIndex((s) => s.id === afterSectionId);
   if (targetIndex === -1) {
      toast("Target section not found");
      return;
   }
   const targetSection = state.sections[targetIndex];
   // Overwrite bars: clear everything in target, then write the copied bars exactly as-is.
   Object.keys(targetSection.beats).forEach((slot) => delete targetSection.beats[slot]);
   Object.keys(targetSection.lyricBeats).forEach((slot) => delete targetSection.lyricBeats[slot]);
   targetSection.bars = clip.payload.bars;
   Object.entries(clip.payload.beats).forEach(([slot, value]) => {
      targetSection.beats[slot] = typeof value === "string" ? value : { ...value };
   });
   Object.entries(clip.payload.lyricBeats).forEach(([slot, text]) => {
      targetSection.lyricBeats[slot] = typeof text === "string" ? text : text;
   });
   targetSection.name = clip.payload.name || "Section";
   state.activeId = targetSection.id;
   renderPreview();
   save();
   toast(`Replaced ${targetSection.name}`);
}

// Copy a single bar's content (chords + lyrics) into the clipboard.
function copyBar(sectionId, bar) {
   const section = findSection(sectionId);
   if (!section) return;
   const payload = extractBar(section, bar);
   setClipboard("bar", payload, { sourceBar: bar });
   updatePasteButtons();
   toast(`Bar ${bar + 1} copied`);
}

// Paste the clipboard's bar content over the target bar (overwrites it).
function pasteBar(sectionId, bar) {
   const clip = getClipboard();
   // A multi-bar range takes precedence: insert it before the target bar.
   if (clip && clip.kind === "bars") {
      pasteBars(sectionId, bar);
      return;
   }
   if (!clip || clip.kind !== "bar") {
      toast("No bar copied");
      return;
   }
   const section = findSection(sectionId);
   if (!section) return;
   replaceBarContent(section, bar, clip.payload);
   getState().activeId = section.id;
   renderPreview();
   save();
   toast(`Pasted into bar ${bar + 1}`);
}

// ---- Multi-bar selection (transient UI state; NOT part of undo history) ----
// { active, sectionId, anchor, focus } — anchor is the first-clicked bar, focus
// the most recent (shift+)clicked bar. The inclusive range [min,max] is copied.
let barSelection = null;

export function getBarSelection() {
   return barSelection;
}

// True when bar-selection mode is active AND targeting the given section.
// Used as a guard by every content-mutation handler so that, while selecting,
// clicks inside a bar only (de)select it — they never edit or remove content.
// (The capture-phase bar click handler is the primary gate; these per-handler
// guards are defense-in-depth in case an event path bypasses it.)
function isSelectionActiveFor(sectionId) {
   return !!(barSelection && barSelection.active && barSelection.sectionId === sectionId);
}

// Enter selection mode for a section. The first bar click sets the anchor.
function beginBarSelection(sectionId) {
   barSelection = { active: true, sectionId, anchor: null, focus: null };
   renderPreview();
   toast("Copy bars: click a bar, Shift+click another to extend");
}

function cancelBarSelection() {
   if (!barSelection) return;
   barSelection = null;
   renderPreview();
}

// Handle a bar click while in selection mode. Plain click = set/reset anchor;
// Shift+click = extend the range to that bar.
function handleBarSelectionClick(sectionId, bar, extend) {
   if (!barSelection || !barSelection.active) return;
   // Selection is confined to the section it was started in.
   if (sectionId !== barSelection.sectionId) return;
   if (extend && barSelection.anchor !== null) {
      barSelection.focus = bar;
   } else {
      barSelection.anchor = bar;
      barSelection.focus = bar;
   }
   renderPreview();
}

// Copy the currently-selected bar range into the clipboard as a "bars" payload.
function copySelectedBars() {
   if (!barSelection || barSelection.anchor === null) {
      toast("Click a bar first");
      return;
   }
   const section = findSection(barSelection.sectionId);
   if (!section) return;
   const payload = extractBars(section, barSelection.anchor, barSelection.focus);
   setClipboard("bars", payload, { count: payload.count });
   cancelBarSelection();
   updatePasteButtons();
   toast(`${payload.count} bar${payload.count === 1 ? "" : "s"} copied`);
}

// Works across sections since the clipboard is global.
// PASTE NOW OVERWRITES instead of inserting: existing bars at target are replaced,
// not shifted. Bars after the paste stay put; only the overwritten range changes.
function pasteBars(sectionId, bar) {
   const clip = getClipboard();
   if (!clip || clip.kind !== "bars") {
      toast("No bars copied");
      return;
   }
   const section = findSection(sectionId);
   if (!section) return;
   const ok = overwriteBars(section, bar, clip.payload);
   if (!ok) {
      toast("Not enough room — bar limit reached");
      return;
   }
   getState().activeId = section.id;
   renderPreview();
   save();
   toast(`${clip.payload.count} bar${clip.payload.count === 1 ? "" : "s"} pasted`);
}

// Enable/disable any paste affordances based on clipboard contents.
function updatePasteButtons() {
   document.querySelectorAll(".paste-section").forEach((btn) => {
      btn.disabled = !hasClipboard("section");
   });
   document.querySelectorAll(".paste-bar").forEach((btn) => {
      // Single-bar paste-bar buttons accept both a single copied bar and a
      // multi-bar range (range = insert; single = overwrite).
      btn.disabled = !hasClipboard("bar") && !hasClipboard("bars");
   });
}
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
      bpm: state.bpm,
      lyricsEnabled: state.lyricsEnabled,
      chordAboveEnabled: state.chordAboveEnabled,
      // Per-song PDF appearance: each song stores its own PDF options so that
      // tweaking layout for one song never bleeds into another.
      pdfOptions: getPdfOptions(),
      sections: state.sections,
      slashChords: state.slashChords,
      nashvilleNumber: state.nashvilleNumber,
      nashvilleAccidental: state.nashvilleAccidental,
      editorMode: state.editorMode,
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
   const chordAboveEnabled =
      typeof project.chordAboveEnabled === "boolean"
         ? project.chordAboveEnabled
         : sections.some((section) => Object.keys(section.chordAboveBeats || {}).length > 0);
   setState({
      key: keys.includes(project.key) ? project.key : "C",
      chordRoot: keys.includes(project.chordRoot) ? project.chordRoot : "C",
      customChord: typeof project.customChord === "string" ? project.customChord : "",
      meter,
      bpm: Number(project.bpm) || 120,
      lyricsEnabled,
      chordAboveEnabled,
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
      editorMode: project.editorMode === "numbers" ? "numbers" : "chords",
   });
   // Restore this song's own PDF options (font sizes, spacing, paper, margins),
   // so opening it again keeps the exact export appearance chosen for it.
   if (project.pdfOptions && typeof project.pdfOptions === "object") {
      setPdfOptions(project.pdfOptions);
   }
   clearPaletteSelection();
   $("#songTitle").value = String(project.title || "Song Title");
   $("#artist").value = String(project.artist || "Artist / Composer");
   $("#timeSignature").value = getState().meter;
   syncEditor();
   renderControls();
   renderPreview();
   // Loading a different project should start at the top-left, not inherit the
   // scroll position from whatever was previously being edited.
   $("#previewViewport")?.scrollTo(0, 0);
   // When loading a fresh document (file/cloud), reset undo history so the user
   // can't undo across songs. During an undo/redo replay (isRestoring) we skip
   // this so the stack stays intact.
   if (!isRestoring) {
      clearHistory();
      saveState(projectData());
      updateUndoRedoButtons();
   }
   save();
   // A freshly-loaded document matches its source (cloud/file) — not dirty yet.
   setDirty(false);
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

   // Playback controls: play/stop button + BPM input + metronome toggle.
   const playBtn = $("#playBtn");
   const bpmInput = $("#bpmInput");

   function updatePlayButton() {
      const playing = getIsPlaying();
      playBtn.textContent = playing ? "⏸" : "▶";
      playBtn.classList.toggle("playing", playing);
      playBtn.setAttribute("aria-label", playing ? "Pause score" : "Play score");
      playBtn.setAttribute("title", playing ? "Pause score" : "Play score");
   }

   playBtn?.addEventListener("click", async () => {
      if (getIsPlaying()) {
         stopPlayback();
         updatePlayButton();
      } else {
         // Optimistic: show the "playing" state immediately so the button reacts
         // while samples are being loaded/downloaded, not only after playback begins.
         playBtn.textContent = "⏸";
         playBtn.classList.add("playing");
         playBtn.setAttribute("aria-label", "Pause score");
         playBtn.setAttribute("title", "Pause score");
         // startPlayback is async (may await a sample download). After it resolves,
         // sync the button to the real playback state (playing / fallback / error).
         await startPlayback({ onBeat: highlightBeat, onEnd: updatePlayButton });
         updatePlayButton();
      }
   });

   bpmInput?.addEventListener("input", (event) => {
      const bpm = Math.min(240, Math.max(40, Number(event.target.value)));
      getState().bpm = bpm || 120;
      // Persist to the song (history + dirty flag) and re-sync the control so
      // it reflects the new tempo (each song keeps its own BPM, not a static 120).
      save();
      renderControls();
   });


   $("#undoBtn")?.addEventListener("click", () => undoSheet());
   $("#redoBtn")?.addEventListener("click", () => redoSheet());
   $("#lyricsEnabled").addEventListener("change", (event) => {
      getState().lyricsEnabled = event.target.checked;
      renderControls();
      renderPreview();
      save();
      toast(getState().lyricsEnabled ? "Lyrics mode enabled" : "Lyrics hidden from score");
   });
   // Global lyrics toggle in the topbar (mirrors the hidden ribbon switch, which
   // remains the source of truth so renderControls keeps both in sync).
   $("#lyricsEnabledTop")?.addEventListener("change", (event) => {
      const ribbonToggle = $("#lyricsEnabled");
      ribbonToggle.checked = event.target.checked;
      ribbonToggle.dispatchEvent(new Event("change"));
   });
   $("#chordAboveEnabledTop")?.addEventListener("change", (event) => {
      const ribbonToggle = $("#chordAboveEnabled");
      if (ribbonToggle) {
         ribbonToggle.checked = event.target.checked;
         ribbonToggle.dispatchEvent(new Event("change"));
      }
   });
   // Chord-above (Chord Chart mode): a letter chord row above each number.
   $("#chordAboveEnabled")?.addEventListener("change", (event) => {
      getState().chordAboveEnabled = event.target.checked;
      renderControls();
      renderPreview();
      save();
      toast(getState().chordAboveEnabled ? "Chords above numbers enabled" : "Chords above hidden");
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
      $("#previewViewport")?.scrollTo(0, 0);
      save();
      toast("Score reset to default");
   });
   // "How to edit this score" help dialog (replaces the old drag-and-drop hint).
   // Explains the click-to-type / right-click-for-rhythm live-editing model.
   {
      const howToDialog = $("#howToDialog");
      const openBtn = $("#howToUseBtn");
      let lastFocused = null;
      const openHowTo = () => {
         if (!howToDialog) return;
         lastFocused = document.activeElement;
         howToDialog.hidden = false;
         void howToDialog.offsetHeight; // commit start state before fade-in
         setTimeout(() => howToDialog.classList.add("is-open"), 20);
         setTimeout(() => $("#howToCloseBtn")?.focus(), 60);
         document.addEventListener("keydown", onKey);
      };
      const closeHowTo = () => {
         if (!howToDialog) return;
         howToDialog.classList.remove("is-open");
         document.removeEventListener("keydown", onKey);
         setTimeout(() => {
            howToDialog.hidden = true;
         }, 260);
         if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
      };
      function onKey(event) {
         if (event.key === "Escape") closeHowTo();
      }
      openBtn?.addEventListener("click", openHowTo);
      // Backdrop and any element flagged data-howto-dismiss (Got it button) close.
      howToDialog?.addEventListener("click", (event) => {
         if (event.target.closest("[data-howto-dismiss]")) closeHowTo();
      });
   }
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
   // PDF options are part of each song's document (per-song PDF options), so
   // tweaking them marks the song as having unsaved changes.
   window.addEventListener("chordsheet:pdfoptionschange", () => setDirty(true));
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

      // Undo/Redo shortcuts: Ctrl+Z / Ctrl+Shift+Z (standard modern shortcut for redo)
      if (!editing && (event.ctrlKey || event.metaKey)) {
         if (event.key.toLowerCase() === "z" && !event.shiftKey) {
            event.preventDefault();
            undoSheet();
            return;
         }
         if (event.key.toLowerCase() === "z" && event.shiftKey) {
            event.preventDefault();
            redoSheet();
            return;
         }
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
   initRender({ bindDraggableChords, bindPaletteItem, bindPreview, updateViewportOverflow, getBarSelection });
   bindControlListeners();
   localStorage.removeItem("chordSheetPreview");
   applyTheme(activeTheme, { persist: false });
   syncEditor();
   renderControls();
   renderPreview();
   // Seed the undo history with the initial (default) document so the first edit
   // has a baseline to undo back to.
   clearHistory();
   saveState(projectData());
   updateUndoRedoButtons();
   activateRibbon(document.querySelector(".ribbon-tab.active"), { expand: false });
   applyPreviewZoom();
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
      // Unsaved-changes guard: cloudUI asks whether the open document has edits
      // that haven't been persisted to the cloud, and clears the flag once a
      // save succeeds (or when leaving without saving is confirmed).
      hasUnsavedChanges: () => dirtySinceSave,
      markSaved: () => {
         setDirty(false);
      },
      // Used by the per-card "Export .pdf" action: the song is applied to the
      // editor first, so the dialog's live preview shows that song's score.
      openPdfOptions: () => {
         renderPreview();
         pdfOptionsControl?.open();
      },
      // Playback awareness for cloudUI: it needs to know whether audio is live
      // so that leaving to My Songs can ask first and stop it, without cloudUI
      // importing the playback module (keeps the module graph acyclic).
      isPlaying: () => getIsPlaying(),
      stopPlayback: () => stopPlayback(),
   });
}
