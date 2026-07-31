// notation.js — pure music/notation + section-data logic. No DOM access; safe to unit test in Node.

export const keys = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
export const notePitches = {
   C: 0,
   "B#": 0,
   "D♭": 1,
   Db: 1,
   "C#": 1,
   "C♯": 1,
   D: 2,
   "E♭": 3,
   Eb: 3,
   "D#": 3,
   "D♯": 3,
   E: 4,
   "F♭": 4,
   Fb: 4,
   F: 5,
   "E#": 5,
   "E♯": 5,
   "G♭": 6,
   Gb: 6,
   "F#": 6,
   "F♯": 6,
   G: 7,
   "A♭": 8,
   Ab: 8,
   "G#": 8,
   "G♯": 8,
   A: 9,
   "B♭": 10,
   Bb: 10,
   "A#": 10,
   "A♯": 10,
   B: 11,
   "C♭": 11,
   Cb: 11,
};
export const chordQualities = [
   { value: "", label: "major" },
   { value: "m", label: "m" },
   { value: "7", label: "7" },
   { value: "maj7", label: "maj7" },
   { value: "sus2", label: "sus2" },
   { value: "sus4", label: "sus4" },
   { value: "add9", label: "add9" },
   { value: "+", label: "+" },
   { value: "°", label: "°" },
   { value: "ø7", label: "ø7" },
];
export const bassNotes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const nashvilleNumbers = ["1", "2", "3", "4", "5", "6", "7"];
export const nashvilleZeroNumbers = ["0"];
export const nashvilleLowerNumbers = ["1̣", "2̣", "3̣", "4̣", "5̣", "6̣", "7̣"];
export const nashvilleUpperNumbers = ["1̇", "2̇", "3̇", "4̇", "5̇", "6̇", "7̇"];
export const nashvilleChoices = [
   ...nashvilleNumbers,
   ...nashvilleLowerNumbers,
   ...nashvilleUpperNumbers,
   ...nashvilleZeroNumbers,
];
export const lyricsFeatureAvailable = true;
export const durationMeta = {
   half: { count: 2, symbol: "½", label: "Half beat" },
   triplet: { count: 3, symbol: "⅓", label: "Beat triplet" },
   quarter: { count: 4, symbol: "¼", label: "Quarter beat" },
};
export const meters = ["2/4", "3/4", "4/4", "6/8"];
export const nashvilleAccidentals = ["", "♭", "#"];

// Import hardening limits (guard against oversized/hostile project files).
export const MAX_BARS = 96;
export const MAX_SECTIONS = 40;

export const escapeHTML = (value) =>
   String(value ?? "").replace(
      /[&<>"]/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
   );

export const newSection = (name = "Intro") => ({
   id: crypto.randomUUID(),
   name,
   lyricsEnabled: true,
   lyricBeats: {},
   bars: 4,
   beats: {},
});

// ---- Transpose ----
export function transposeNote(note, semitones) {
   const pitch = notePitches[note];
   return pitch === undefined ? note : keys[(pitch + semitones + 12) % 12];
}
export function isNashvilleChord(value) {
   return /^[♭#]?[0-7][̣̇]?/u.test(String(value));
}
export function validChordSuffix(suffix) {
   return /^(?:(?:maj|min|sus|add|dim|aug|omit|no)|[mM0-9#♯b♭/()+\-°ø])*$/i.test(suffix);
}
export function transposeChordRoot(value, semitones) {
   const match = String(value).match(/^([A-G])([#♯b♭]?)(.*)$/);
   if (!match || !validChordSuffix(match[3])) return null;
   return `${transposeNote(`${match[1]}${match[2]}`, semitones)}${match[3]}`;
}
export function transposeChord(value, semitones) {
   const chord = String(value);
   if (isNashvilleChord(chord)) return chord;
   const slash = chord.match(/^(.*)\/([A-G](?:[#♯b♭])?)$/),
      main = slash ? slash[1] : chord,
      transposedMain = transposeChordRoot(main, semitones);
   if (!transposedMain) return chord;
   return slash ? `${transposedMain}/${transposeNote(slash[2], semitones)}` : transposedMain;
}

// ---- Slot helpers ----
export function slotBarIndex(slot) {
   const match = String(slot).match(/^(\d+)-/);
   return match ? Number(match[1]) : -1;
}

// ---- Section-data helpers (mutate plain data; no DOM) ----
export function beatValue(section, slot) {
   const value = section.beats[slot];
   return typeof value === "string" ? { chord: value, duration: null } : value || { chord: null, duration: null };
}
export function lyricValue(section, slot) {
   return typeof section.lyricBeats?.[slot] === "string" ? section.lyricBeats[slot] : "";
}
export function setLyric(section, slot, text) {
   section.lyricBeats ??= {};
   if (text.trim()) section.lyricBeats[slot] = text;
   else delete section.lyricBeats[slot];
}
export function prepareLyricsForDuration(section, baseSlot, nextDuration) {
   section.lyricBeats ??= {};
   const currentDuration = beatValue(section, baseSlot).duration,
      baseText = lyricValue(section, baseSlot);
   if (!currentDuration && baseText) {
      setLyric(section, `${baseSlot}:0`, baseText);
      delete section.lyricBeats[baseSlot];
   }
   if (currentDuration === "quarter" && nextDuration === "half") {
      const trailing = [1, 2, 3]
         .map((index) => lyricValue(section, `${baseSlot}:${index}`))
         .filter(Boolean)
         .join(" ");
      setLyric(section, `${baseSlot}:1`, trailing);
      delete section.lyricBeats[`${baseSlot}:2`];
      delete section.lyricBeats[`${baseSlot}:3`];
   }
}
export function barHasContent(section, bar) {
   return (
      Object.keys(section.beats || {}).some((slot) => slotBarIndex(slot) === bar) ||
      Object.entries(section.lyricBeats || {}).some(([slot, text]) => slotBarIndex(slot) === bar && String(text).trim())
   );
}
export function removeBar(section, bar) {
   const shiftSlots = (source) =>
      Object.fromEntries(
         Object.entries(source || {}).flatMap(([slot, value]) => {
            const match = slot.match(/^(\d+)(-.+)$/);
            if (!match) return [[slot, value]];
            const index = Number(match[1]);
            if (index === bar) return [];
            return [[`${index > bar ? index - 1 : index}${match[2]}`, value]];
         }),
      );
   section.beats = shiftSlots(section.beats);
   section.lyricBeats = shiftSlots(section.lyricBeats);
   section.bars = Math.max(1, section.bars - 1);
}

// ---- Import normalization / hardening ----
export function normalizeSection(section, meter = "4/4") {
   const bars = Math.min(MAX_BARS, Math.max(1, Number(section.bars) || 4));
   const beats = {};
   if (section.beats && typeof section.beats === "object")
      Object.entries(section.beats).forEach(([slot, value]) => {
         if (typeof value === "string") beats[slot] = value;
         else if (value && typeof value === "object")
            beats[slot] = {
               chord: typeof value.chord === "string" ? value.chord : null,
               duration: ["half", "triplet", "quarter"].includes(value.duration) ? value.duration : null,
            };
      });
   const lyricBeats = {};
   if (section.lyricBeats && typeof section.lyricBeats === "object")
      Object.entries(section.lyricBeats).forEach(([slot, text]) => {
         if (typeof text === "string" && text.trim()) lyricBeats[slot] = text;
      });
   if (!Object.keys(lyricBeats).length && typeof section.lyrics === "string" && section.lyrics.trim()) {
      const words = section.lyrics.trim().split(/\s+/),
         beatCount = Math.max(1, Number(String(meter).split("/")[0]) || 4);
      words.forEach((word, index) => {
         if (index < bars * beatCount) lyricBeats[`${Math.floor(index / beatCount)}-${index % beatCount}`] = word;
      });
   }
   return {
      id: section.id || crypto.randomUUID(),
      name: String(section.name || "Section"),
      lyricsEnabled: section.lyricsEnabled !== false,
      lyricBeats,
      bars,
      beats,
   };
}

export function safeFileName(value) {
   return (
      (value || "worship-notation-score")
         .trim()
         .replace(/[^a-z0-9-_]+/gi, "-")
         .replace(/^-|-$/g, "") || "worship-notation-score"
   );
}
