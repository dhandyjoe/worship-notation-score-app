// store.js — single source of truth for app state + palette selection.
// State is reassigned wholesale on import/reset, so consumers must read via getState().
import { newSection } from "./notation.js?v=20260904-marginnarrow0";

function defaultState() {
   const first = newSection("Intro");
   return {
      key: "C",
      chordRoot: "C",
      customChord: "",
      meter: "4/4",
      bpm: 120,
      lyricsEnabled: false,
      chordAboveEnabled: false, // Chord Chart mode: letter chords above numbers; OFF by default
      sections: [first],
      slashChords: [],
      nashvilleNumber: "1",
      nashvilleAccidental: "",
      activeId: first.id,
      editingId: null,
      editorMode: "chords", // "chords" or "numbers" - defaults to chords for backward compat
   };
}

let state = defaultState();
let selectedPaletteItem = null;

export const getState = () => state;
export function setState(next) {
   state = next;
}
export function resetState() {
   state = defaultState();
   return state;
}
export const activeSection = () => state.sections.find((section) => section.id === state.activeId) || state.sections[0];
export const findSection = (id) => state.sections.find((section) => section.id === id);

export const getSelectedPaletteItem = () => selectedPaletteItem;
export function setSelectedPaletteItem(item) {
   selectedPaletteItem = item;
}
