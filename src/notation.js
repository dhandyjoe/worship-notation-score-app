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

// ---- Lyric syllable splitting (pure, DOM-free) ----
// Lightweight English-oriented syllabifier. It is heuristic (no dictionary), so
// it won't be perfect for every word, but it produces natural, singable breaks
// for typical worship lyrics (e.g. "amazing" -> a·maz·ing). Users can always
// hand-tune the result afterwards in the per-beat inputs.
const VOWELS = "aeiouy";
const isVowel = (character) => VOWELS.includes(String(character).toLowerCase());

/**
 * Split a single word into syllable chunks. Returns an array of 1+ pieces.
 * Punctuation attached to the word (commas, apostrophes) is preserved on the
 * chunk it belongs to. Very short words and single-nucleus words are not split.
 *
 * Strategy (classic vowel-group heuristic):
 *  1. Find vowel groups (maximal runs of vowels) — each is one syllable nucleus.
 *  2. Drop a silent trailing "e" nucleus ("grace", "saved" stay one syllable).
 *  3. Between two nuclei, assign the consonant cluster: a single consonant goes
 *     to the following syllable (V|CV → "a·maz"); two or more consonants split
 *     (VC|CV → "won·der"), leaving the last consonant with the next syllable.
 */
export function splitSyllables(word) {
   const raw = String(word ?? "");
   if (!raw) return [];
   const match = raw.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'’-]*)?([^A-Za-z]*)$/);
   if (!match || !match[2]) return [raw];
   const [, lead, core, trail] = match;
   // Already hyphenated by the user (e.g. "a-maz-ing")? Respect their breaks.
   if (core.includes("-")) {
      return applyAffix(core.split("-").filter(Boolean), lead, trail);
   }
   const chars = core.split("");
   const letters = core.replace(/['’]/g, "");
   if (letters.length <= 3) return applyAffix([core], lead, trail);

   // 1) Vowel groups → nuclei (store start index of each group).
   const groups = [];
   let inVowel = false;
   for (let i = 0; i < chars.length; i += 1) {
      const v = /[A-Za-z]/.test(chars[i]) && isVowel(chars[i]);
      if (v && !inVowel) groups.push({ start: i, end: i });
      else if (v) groups[groups.length - 1].end = i;
      inVowel = v;
   }
   // 2) Drop silent trailing "e" (e.g. grace, saved, more) — but not "the"/"be"
   //    handled by the length<=3 guard above.
   if (groups.length >= 2) {
      const last = groups[groups.length - 1];
      const isFinalE =
         last.start === last.end && chars[last.start].toLowerCase() === "e" && last.end === chars.length - 1;
      if (isFinalE) groups.pop();
   }
   // 2b) Drop a silent "e" in a "-ed"/"-es" ending (saved, praised, ransomed,
   //     raises) so the ending clings to the previous syllable rather than
   //     forming its own beat. The "e" is voiced after t/d ("wanted"), so skip
   //     those.
   if (groups.length >= 2) {
      const last = groups[groups.length - 1];
      const tail = core.slice(last.start).toLowerCase();
      const beforeE = last.start > 0 ? chars[last.start - 1].toLowerCase() : "";
      if (last.start === last.end && (tail === "ed" || tail === "es") && beforeE && !"td".includes(beforeE)) {
         groups.pop();
      }
   }
   if (groups.length <= 1) return applyAffix([core], lead, trail);

   // 3) Choose a cut index between each pair of adjacent nuclei.
   const cuts = [];
   for (let g = 0; g < groups.length - 1; g += 1) {
      const vowelEnd = groups[g].end; // last vowel of this nucleus
      const nextVowelStart = groups[g + 1].start; // first vowel of next nucleus
      const consonants = nextVowelStart - vowelEnd - 1;
      // 1 (or 0) consonant → cut right after the vowel (V|CV).
      // 2+ consonants → keep the first consonant with this syllable (VC|CV).
      const cut = consonants <= 1 ? vowelEnd + 1 : vowelEnd + 2;
      if (cut > 0 && cut < chars.length) cuts.push(cut);
   }
   if (!cuts.length) return applyAffix([core], lead, trail);

   const pieces = [];
   let start = 0;
   for (const cut of cuts) {
      pieces.push(core.slice(start, cut));
      start = cut;
   }
   pieces.push(core.slice(start));
   return applyAffix(mergeVowelless(pieces.filter(Boolean)), lead, trail);
}

// Merge any chunk that has no vowel (unsingable, e.g. a lone "g"/"ch") into an
// adjacent chunk so every syllable carries a nucleus.
function mergeVowelless(pieces) {
   const out = [];
   for (const piece of pieces) {
      if (!/[aeiouy]/i.test(piece) && out.length) out[out.length - 1] += piece;
      else out.push(piece);
   }
   return out.length ? out : pieces;
}

// Re-attach leading/trailing punctuation to the first/last syllable chunk.
function applyAffix(pieces, lead, trail) {
   if (!pieces.length) return [`${lead}${trail}`];
   const out = pieces.slice();
   out[0] = `${lead}${out[0]}`;
   out[out.length - 1] = `${out[out.length - 1]}${trail}`;
   return out;
}

/**
 * Turn a free-form lyric line/paragraph into an ordered list of syllable
 * tokens ready to drop into consecutive beats. Multi-syllable words get a
 * trailing hyphen on every chunk except the last, matching hymnal style
 * (e.g. "amazing grace" -> ["a-", "maz-", "ing", "grace"]).
 */
export function syllabifyLyrics(text) {
   const words = String(text ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
   const tokens = [];
   for (const word of words) {
      const pieces = splitSyllables(word);
      pieces.forEach((piece, index) => {
         const isLast = index === pieces.length - 1;
         const needsHyphen = !isLast && !/[-.,;:!?]$/.test(piece);
         tokens.push(needsHyphen ? `${piece}-` : piece);
      });
   }
   return tokens;
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

// ---- Copy / paste helpers (pure, unit-testable) ----
// Extract a single bar's beats + lyrics, normalized so the bar index becomes 0.
// Returns { beats, lyricBeats } — deep-cloned, safe to store in a clipboard.
export function extractBar(section, bar) {
   const pick = (source) =>
      Object.fromEntries(
         Object.entries(source || {}).flatMap(([slot, value]) => {
            const match = slot.match(/^(\d+)(-.+)$/);
            if (!match) return [];
            if (Number(match[1]) !== bar) return [];
            // Re-base the bar index to 0 and deep-clone the value.
            const cloned = value && typeof value === "object" ? { ...value } : value;
            return [[`0${match[2]}`, cloned]];
         }),
      );
   return { beats: pick(section.beats), lyricBeats: pick(section.lyricBeats) };
}

// Overwrite a target bar's content with a previously-extracted bar payload.
// Existing slots for that bar are cleared first, then the payload (which is
// normalized to bar 0) is written at the target bar index. Mutates section.
export function replaceBarContent(section, bar, payload) {
   const clearBar = (source) =>
      Object.fromEntries(Object.entries(source || {}).filter(([slot]) => slotBarIndex(slot) !== bar));
   const rebase = (source, target) => {
      Object.entries(source || {}).forEach(([slot, value]) => {
         const match = slot.match(/^0(-.+)$/);
         if (!match) return;
         const cloned = value && typeof value === "object" ? { ...value } : value;
         target[`${bar}${match[1]}`] = cloned;
      });
   };
   const beats = clearBar(section.beats);
   const lyricBeats = clearBar(section.lyricBeats);
   rebase(payload?.beats, beats);
   rebase(payload?.lyricBeats, lyricBeats);
   section.beats = beats;
   section.lyricBeats = lyricBeats;
}

// Deep-clone a section and assign a fresh id (for copy/paste + duplicate).
export function cloneSection(section, newName) {
   const clone = JSON.parse(JSON.stringify(section));
   clone.id = crypto.randomUUID();
   if (newName) clone.name = newName;
   return clone;
}

// Extract a contiguous RANGE of bars [startBar..endBar] (inclusive), normalized
// so the first bar in the range becomes bar 0. Returns { count, beats, lyricBeats }
// — deep-cloned, safe to store in a clipboard. Order-agnostic (start/end can be
// passed either way round).
export function extractBars(section, startBar, endBar) {
   const lo = Math.min(startBar, endBar);
   const hi = Math.max(startBar, endBar);
   const pick = (source) =>
      Object.fromEntries(
         Object.entries(source || {}).flatMap(([slot, value]) => {
            const match = slot.match(/^(\d+)(-.+)$/);
            if (!match) return [];
            const index = Number(match[1]);
            if (index < lo || index > hi) return [];
            const cloned = value && typeof value === "object" ? { ...value } : value;
            return [[`${index - lo}${match[2]}`, cloned]];
         }),
      );
   return { count: hi - lo + 1, beats: pick(section.beats), lyricBeats: pick(section.lyricBeats) };
}

// Insert a previously-extracted multi-bar payload into a section BEFORE the
// given target bar. Existing bars at/after the target shift right by
// payload.count; the payload (normalized to bar 0) is written at the target
// index. Mutates section. Respects MAX_BARS (returns false if it would overflow).
export function insertBars(section, targetBar, payload) {
   const count = payload?.count || 0;
   if (!count) return false;
   if (section.bars + count > MAX_BARS) return false;
   // Shift every existing slot at index >= targetBar right by `count`.
   const shiftSlots = (source) =>
      Object.fromEntries(
         Object.entries(source || {}).map(([slot, value]) => {
            const match = slot.match(/^(\d+)(-.+)$/);
            if (!match) return [slot, value];
            const index = Number(match[1]);
            const shifted = index >= targetBar ? index + count : index;
            return [`${shifted}${match[2]}`, value];
         }),
      );
   const beats = shiftSlots(section.beats);
   const lyricBeats = shiftSlots(section.lyricBeats);
   // Write the payload (bar-0-based) at the target index.
   const rebase = (source, target) => {
      Object.entries(source || {}).forEach(([slot, value]) => {
         const match = slot.match(/^(\d+)(-.+)$/);
         if (!match) return;
         const cloned = value && typeof value === "object" ? { ...value } : value;
         target[`${Number(match[1]) + targetBar}${match[2]}`] = cloned;
      });
   };
   rebase(payload.beats, beats);
   rebase(payload.lyricBeats, lyricBeats);
   section.beats = beats;
   section.lyricBeats = lyricBeats;
   section.bars = section.bars + count;
   return true;
}

// Paste a previously-extracted multi-bar payload by OVERWRITING the bars at the
// target index and the ones after it (target, target+1, …). Bars are NOT shifted
// right; existing content in the overwritten range is replaced. The section grows
// only if the payload extends past the current last bar. Mutates section.
// Respects MAX_BARS (returns false if the paste would overflow the limit).
export function overwriteBars(section, targetBar, payload) {
   const count = payload?.count || 0;
   if (!count) return false;
   const endBar = targetBar + count - 1; // inclusive last bar the paste writes to
   if (endBar + 1 > MAX_BARS) return false;
   // Clear every slot inside the target range [targetBar..endBar]; slots outside
   // that range are kept exactly where they are (no shifting).
   const clearRange = (source) =>
      Object.fromEntries(
         Object.entries(source || {}).filter(([slot]) => {
            const index = slotBarIndex(slot);
            return index < targetBar || index > endBar;
         }),
      );
   const beats = clearRange(section.beats);
   const lyricBeats = clearRange(section.lyricBeats);
   // Write the payload (bar-0-based) at the target index.
   const rebase = (source, target) => {
      Object.entries(source || {}).forEach(([slot, value]) => {
         const match = slot.match(/^(\d+)(-.+)$/);
         if (!match) return;
         const cloned = value && typeof value === "object" ? { ...value } : value;
         target[`${Number(match[1]) + targetBar}${match[2]}`] = cloned;
      });
   };
   rebase(payload.beats, beats);
   rebase(payload.lyricBeats, lyricBeats);
   section.beats = beats;
   section.lyricBeats = lyricBeats;
   // Grow the bar count only when the paste extends beyond the current end.
   section.bars = Math.max(section.bars, endBar + 1);
   return true;
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
