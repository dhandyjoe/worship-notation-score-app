// render.js — view layer: builds score HTML and writes it to the DOM.
// Depends on notation.js (pure), dom.js (helpers), store.js (state).
// Event-binding hooks (from events.js) are injected via initRender() to keep the graph acyclic.
import {
   keys,
   chordQualities,
   bassNotes,
   nashvilleNumbers,
   nashvilleZeroNumbers,
   nashvilleLowerNumbers,
   nashvilleUpperNumbers,
   durationMeta,
   lyricsFeatureAvailable,
   escapeHTML,
   beatValue,
   lyricValue,
} from "./notation.js";
import { $, prefersTap } from "./dom.js";
import { getState } from "./store.js";

// Injected app hooks (set once at bootstrap by events.js/app.js).
const hooks = {
   bindDraggableChords() {},
   bindPaletteItem() {},
   bindPreview() {},
   updateViewportOverflow() {},
};
export function initRender(overrides = {}) {
   Object.assign(hooks, overrides);
}

function chordName(quality) {
   return `${getState().chordRoot}${quality}`;
}
function nashvilleName(quality) {
   const state = getState();
   return `${state.nashvilleAccidental}${state.nashvilleNumber}${quality}`;
}
export function nashvilleNumberLabel(number) {
   const match = String(number).match(/^([1-7])([̣̇])$/u);
   if (!match) return number;
   const position = match[2] === "̣" ? "low" : "high";
   return `<span class="nashville-octave nashville-octave-${position}"><span class="nashville-degree">${match[1]}</span><span class="nashville-octave-dot" aria-hidden="true">●</span></span>`;
}
export function chordLabel(chord) {
   const match = String(chord).match(/^([♭#]?)([1-7][̣̇])(.*)$/u);
   if (match) {
      const accidental = match[1] === "♭" ? '<span class="chord-accidental chord-flat">♭</span>' : escapeHTML(match[1]);
      return `<span class="chord-token">${accidental}${nashvilleNumberLabel(match[2])}${escapeHTML(match[3])}</span>`;
   }
   const label = escapeHTML(chord)
      .replaceAll("♭", '<span class="chord-accidental chord-flat">♭</span>')
      .replaceAll("♯", '<span class="chord-accidental chord-sharp">♯</span>');
   return `<span class="chord-token">${label}</span>`;
}
function meterInfo() {
   const [top] = getState().meter.split("/").map(Number);
   return { beats: top };
}
export function renderCustomChord() {
   const value = getState().customChord.trim(),
      safe = escapeHTML(value); // bug fix: escape user-supplied custom chord before injecting
   $("#customChordPreview").innerHTML = value
      ? `<span class="chord custom-chord" draggable="true" data-chord="${safe}">${safe}</span>`
      : '<span class="custom-chord-hint">Custom chord preview</span>';
   hooks.bindDraggableChords();
}
export function renderControls() {
   const state = getState();
   $("#keySelect").innerHTML = keys
      .map((key) => `<option ${key === state.key ? "selected" : ""}>${key}</option>`)
      .join("");
   $("#chordRootPicker").innerHTML = keys
      .map((key) => `<button class="key ${key === state.chordRoot ? "active" : ""}" data-root="${key}">${key}</button>`)
      .join("");
   $("#chordBank").innerHTML = chordQualities
      .map(
         ({ value }) =>
            `<span class="chord" draggable="true" data-chord="${chordName(value)}">${chordName(value)}</span>`,
      )
      .join("");
   $("#slashRoot").innerHTML = keys.map((key) => `<option value="${key}">${key}</option>`).join("");
   $("#slashQuality").innerHTML = chordQualities
      .map(({ value, label }) => `<option value="${value}">${label}</option>`)
      .join("");
   $("#slashBass").innerHTML = bassNotes.map((note) => `<option value="${note}">${note}</option>`).join("");
   $("#slashChordBank").innerHTML = state.slashChords
      .map(
         (chord) =>
            `<span class="chord slash-chord" draggable="true" data-chord="${escapeHTML(chord)}">${escapeHTML(chord)}</span>`,
      )
      .join("");
   $("#customChordInput").value = state.customChord;
   const nashvilleRow = (numbers, label, description, rowClass = "") =>
      `<div class="nashville-row-block"><span class="nashville-row-label">${label}</span><div class="nashville-number-row ${rowClass}" aria-label="${description}">${numbers.map((number) => `<button class="nashville-key ${number === state.nashvilleNumber ? "active" : ""}" data-number="${number}" title="${description}">${nashvilleNumberLabel(number)}</button>`).join("")}</div></div>`;
   $("#nashvilleRootPicker").innerHTML = [
      nashvilleRow(nashvilleNumbers, "Normal", "Normal notation"),
      nashvilleRow(nashvilleLowerNumbers, "Lower octave", "One octave lower"),
      nashvilleRow(nashvilleUpperNumbers, "Upper octave", "One octave higher"),
      nashvilleRow(nashvilleZeroNumbers, "Number 0", "Nashville Number 0", "nashville-zero-row"),
   ].join("");
   $("#nashvilleAccidentalPicker").innerHTML = [
      ["", "♮"],
      ["♭", "♭"],
      ["#", "#"],
   ]
      .map(
         ([value, label]) =>
            `<button class="nashville-accidental ${value === state.nashvilleAccidental ? "active" : ""}" data-accidental="${value}">${label}</button>`,
      )
      .join("");
   $("#nashvilleChordBank").innerHTML = chordQualities
      .map(
         ({ value }) =>
            `<span class="chord nashville-chord" draggable="true" data-chord="${nashvilleName(value)}">${chordLabel(nashvilleName(value))}</span>`,
      )
      .join("");
   $("#nashvilleSelectedPreview").innerHTML = chordLabel(nashvilleName(""));
   $("#beatBank").innerHTML = Object.entries(durationMeta)
      .map(
         ([value, { symbol, label, count }]) =>
            `<span class="duration-option duration-option-${value}" draggable="true" data-duration="${value}" title="Divide one beat into ${count} equal parts"><b>${symbol}</b><span>${label}<small>${count} notes per beat</small></span></span>`,
      )
      .join("");
   $("#lyricsEnabled").checked = state.lyricsEnabled;
   $("#lyricsEnabledLabel").textContent = state.lyricsEnabled ? "Lyrics on" : "Lyrics off";
   hooks.bindDraggableChords();
   renderCustomChord();
   document
      .querySelectorAll(".duration-option")
      .forEach((option) => hooks.bindPaletteItem(option, { type: "duration", value: option.dataset.duration }));
}
function chordOrDot(section, slot) {
   const value = beatValue(section, slot);
   return value.chord
      ? `<span class="placed-chord" role="button" tabindex="0" title="Tap to remove" aria-label="Remove ${escapeHTML(value.chord)} chord">${chordLabel(value.chord)}<span class="chord-remove" title="Remove chord" aria-hidden="true">×</span></span>`
      : '<span class="beat-dot">·</span>';
}
function lyricInputHTML(section, slot) {
   const text = lyricValue(section, slot),
      label = `Lyrics for beat ${slot.replace(":", " part ")}`;
   return `<span class="lyric-editor"><input class="lyric-input" type="text" value="${escapeHTML(text)}" placeholder="" data-section="${section.id}" data-slot="${slot}" aria-label="${label}" autocomplete="off" spellcheck="false"><span class="lyric-print">${escapeHTML(text)}</span></span>`;
}
function subdivisionTargetHTML(section, baseSlot, index, parentDuration) {
   const subSlot = `${baseSlot}:${index}`,
      subValue = beatValue(section, subSlot);
   if (parentDuration === "half" && subValue.duration === "half") {
      if (subValue.chord && !section.beats[`${subSlot}.0`]) {
         section.beats[`${subSlot}.0`] = { chord: subValue.chord, duration: null };
         subValue.chord = null;
         section.beats[subSlot] = subValue;
      }
      const children = Array.from({ length: 2 }, (_, childIndex) => {
         const childSlot = `${subSlot}.${childIndex}`,
            childValue = beatValue(section, childSlot);
         return `<span class="sub-beat nested-sub-beat drop-target ${childValue.chord ? "has-chord" : ""}" data-section="${section.id}" data-slot="${childSlot}" data-base-slot="${baseSlot}" data-parent-slot="${subSlot}" data-parent-duration="half" data-level="2">${chordOrDot(section, childSlot)}</span>`;
      }).join("");
      return `<span class="nested-beat-group" data-section="${section.id}" data-base-slot="${baseSlot}" data-split-slot="${subSlot}"><span class="nested-duration-line" data-section="${section.id}" data-split-slots="${subSlot}" title="Click to remove nested half-beat" aria-label="Remove nested half-beat"></span><span class="nested-sub-beats">${children}</span></span>`;
   }
   return `<span class="sub-beat drop-target ${subValue.chord ? "has-chord" : ""}" data-section="${section.id}" data-slot="${subSlot}" data-base-slot="${baseSlot}" data-parent-duration="${parentDuration}" data-level="1">${chordOrDot(section, subSlot)}</span>`;
}
function beatHTML(section, bar, beat) {
   const state = getState();
   const slot = `${bar}-${beat}`,
      value = beatValue(section, slot),
      showLyrics = lyricsFeatureAvailable && state.lyricsEnabled && section.lyricsEnabled !== false;
   if (!value.duration) {
      const notation = `<span class="beat drop-target ${value.chord ? "has-chord" : ""}" data-section="${section.id}" data-slot="${slot}" data-base-slot="${slot}" data-level="0">${chordOrDot(section, slot)}</span>`;
      return `<span class="beat-column ${showLyrics ? "with-lyrics" : ""}"><span class="notation-cell">${notation}</span>${showLyrics ? lyricInputHTML(section, slot) : ""}</span>`;
   }
   if (value.chord && !section.beats[`${slot}:0`]) {
      section.beats[`${slot}:0`] = { chord: value.chord, duration: null };
      value.chord = null;
      section.beats[slot] = value;
   }
   const count = durationMeta[value.duration]?.count || 1;
   const subBeats = Array.from({ length: count }, (_, index) =>
      subdivisionTargetHTML(section, slot, index, value.duration),
   ).join("");
   const nestedSplitSlots =
      value.duration === "half"
         ? Array.from({ length: count }, (_, index) => `${slot}:${index}`).filter(
              (subSlot) => beatValue(section, subSlot).duration === "half",
           )
         : [];
   const quarterPrintLine =
      value.duration === "quarter" ? '<span class="quarter-print-line" aria-hidden="true"></span>' : "";
   const lyricSlots = Array.from({ length: count }, (_, index) => `${slot}:${index}`).flatMap((subSlot) =>
      value.duration === "half" && beatValue(section, subSlot).duration === "half"
         ? [`${subSlot}.0`, `${subSlot}.1`]
         : [subSlot],
   );
   const subLyrics = showLyrics
      ? `<span class="sub-lyrics" style="--lyric-leaves:${lyricSlots.length}">${lyricSlots.map((lyricSlot) => lyricInputHTML(section, lyricSlot)).join("")}</span>`
      : "";
   return `<span class="beat-column duration-column duration-${value.duration} ${showLyrics ? "with-lyrics" : ""}"><span class="notation-cell"><span class="beat-group duration-${value.duration} ${nestedSplitSlots.length ? "has-nested-duration" : ""}" data-section="${section.id}" data-base-slot="${slot}"><span class="duration-line" title="Click to remove rhythm marker"></span>${quarterPrintLine}<span class="sub-beats">${subBeats}</span></span></span>${subLyrics}</span>`;
}
function sectionTypeClass(name) {
   const n = name.toLowerCase().trim();
   if (/^(verse|v\.?|vrs)/.test(n)) return "sec-verse";
   if (/^(chorus|cho\.?|reff?|refrain)/.test(n)) return "sec-chorus";
   if (/^(bridge|brg\.?|bri\.?)/.test(n)) return "sec-bridge";
   if (/^(intro|int\.?|intr\.?)/.test(n)) return "sec-intro";
   if (/^(outro|out\.?|ending|coda|tag)/.test(n)) return "sec-outro";
   if (/^(pre-?chorus|pc)/.test(n)) return "sec-prechorus";
   if (/^(interlude|music|solo|instrumental|instr\.?)/.test(n)) return "sec-interlude";
   return "sec-default";
}
function sectionHTML(section) {
   const state = getState();
   const { beats } = meterInfo();
   const showLyrics = lyricsFeatureAvailable && state.lyricsEnabled && section.lyricsEnabled !== false,
      hasLyricContent = Object.values(section.lyricBeats || {}).some((text) => String(text).trim());
   // Track cumulative bar count across sections
   if (!renderPreview._cumulativeBarCount) renderPreview._cumulativeBarCount = 0;
   const cumulativeBarStart = renderPreview._cumulativeBarCount;
   renderPreview._cumulativeBarCount += section.bars;
   const bars = Array.from({ length: section.bars }, (_, bar) => {
      const globalBarNum = cumulativeBarStart + bar + 1;
      return `<div class="bar ${showLyrics ? "has-lyrics" : ""}" style="--beats:${beats}" data-bar="${bar}"><span class="bar-num" aria-hidden="true">${globalBarNum}</span><button class="delete-bar" type="button" data-section="${section.id}" data-bar="${bar}" title="Delete bar ${globalBarNum}" aria-label="Delete bar ${globalBarNum}">×</button>${Array.from({ length: beats }, (_, beat) => beatHTML(section, bar, beat)).join("")}</div>`;
   });
   const batches = Array.from(
      { length: Math.ceil(bars.length / 4) },
      (_, index) =>
         `<div class="bar-batch ${showLyrics ? "has-lyrics" : ""}">${bars.slice(index * 4, index * 4 + 4).join("")}</div>`,
   ).join("");
   const title =
      section.id === state.editingId
         ? `<input class="section-title-input" data-section="${section.id}" value="${escapeHTML(section.name)}" aria-label="Section name">`
         : `<button class="section-title" data-section="${section.id}" title="Click to edit section name">${escapeHTML(section.name.toUpperCase())}</button>`;
   const lyricsToggle =
      lyricsFeatureAvailable && state.lyricsEnabled
         ? `<button class="section-lyrics-toggle ${section.lyricsEnabled !== false ? "active" : ""}" data-section="${section.id}" aria-pressed="${section.lyricsEnabled !== false}"><span aria-hidden="true">${section.lyricsEnabled !== false ? "✓" : "–"}</span> Lyrics ${section.lyricsEnabled !== false ? "On" : "Off"}</button>`
         : "";
   const deleteDisabled = state.sections.length === 1;
   const sectionMenu = `<details class="section-menu"><summary title="Section options" aria-label="Options for ${escapeHTML(section.name)}">•••</summary><div class="section-menu-popover"><button class="delete-section" type="button" data-section="${section.id}" ${deleteDisabled ? "disabled" : ""}>Delete section</button></div></details>`;
   const typeClass = sectionTypeClass(section.name);
   const chip = `<span class="section-chip" aria-hidden="true"></span>`;
   return `<section class="preview-section ${typeClass} ${section.id === state.activeId ? "is-active" : ""} ${hasLyricContent ? "has-lyric-content" : ""}" data-section="${section.id}"><div class="section-preview-heading"><div>${chip}${title}</div><div class="section-tools">${lyricsToggle}<span class="bar-caption">${section.bars} ${section.bars === 1 ? "bar" : "bars"} · ${beats} beats per bar</span><button class="text-button add-bar" data-section="${section.id}">+ Add 1 bar</button>${sectionMenu}</div></div><div class="bar-grid">${batches}</div></section>`;
}
export function renderPreview() {
   const state = getState();
   renderPreview._cumulativeBarCount = 0;
   const artist = $("#artist").value || "Artist / Composer";
   $("#previewTitle").textContent = $("#songTitle").value || "Song Title";
   $("#previewArtist").innerHTML =
      `<span class="artist-label">Created by:</span> <em class="artist-value">${escapeHTML(artist)}</em>`;
   $("#previewKey").textContent = state.key;
   $("#previewMeter").textContent = state.meter;
   $("#previewHint").textContent =
      lyricsFeatureAvailable && state.lyricsEnabled
         ? `${prefersTap() ? "Select and tap" : "Drag"} chords onto beats, then enter lyrics in the row below.`
         : `${prefersTap() ? "Select an item above, then tap" : "Drag a chord from the toolbar onto"} a beat.`;
   $("#sectionsPreview").innerHTML = state.sections.map(sectionHTML).join("");
   hooks.bindPreview();
   requestAnimationFrame(hooks.updateViewportOverflow);
}
