// chordBank.js — pure, DOM-free chord/Nashville suggestion engine.
// Single source of truth for the "type → pick a suggestion" input flow.
// Everything here is deterministic and unit-testable in Node (no DOM, no state).
//
// Design contract (agreed 2026-08-07):
//  - The user MUST pick a suggestion; the raw text is only a search query. This
//    guarantees every stored chord is normalized/standard (unicode ♭/♯, correct
//    root casing, canonical quality spelling).
//  - One field, auto-detected mode: a leading A–G ⇒ chord mode, a leading
//    1–7 (optionally after ♭/#) ⇒ Nashville mode.
//  - Slash chords are generated on demand once the query contains "/".
//  - Nashville octave variants (high 1̇ / low 1̣) are offered AS SUGGESTIONS
//    (no ^/v typing grammar) so the un-typeable combining dots are reachable.

// ---- Vocabulary ---------------------------------------------------------

// Option-1 quality set: practical worship/pop coverage. Order matters — it is
// the tie-break ordering shown to the user (major first, then common colours).
// Augmented / diminished / half-diminished use their proper MUSIC SYMBOLS as the
// canonical value (matching the palette in notation.js): "+" augmented, "°"
// diminished, "ø7" half-diminished. They stay reachable by typing the spelled
// words ("aug", "dim", "m7b5", …) via QUALITY_ALIASES below.
export const BANK_QUALITIES = [
   "",
   "m",
   "7",
   "maj7",
   "m7",
   "sus2",
   "sus4",
   "°",
   "+",
   "ø7",
   "add9",
   "6",
   "m6",
   "9",
   "m9",
   "13",
   "7b9",
];

// Typeable search aliases for the symbol qualities. Typing any of these (after
// the root) surfaces the symbol chord — e.g. "Gaug" → G+, "Gdim" → G°,
// "Gm7b5" → Gø7. Keys are matched folded (lowercase, ascii accidentals).
const QUALITY_ALIASES = {
   "+": ["aug", "augmented"],
   "°": ["dim", "diminished", "o"],
   ø7: ["m7b5", "min7b5", "halfdim", "halfdiminished", "ø", "o7"],
};

// Canonical roots. Flats mirror the app's key list; sharps are offered too so a
// player in a sharp key can reach F♯m etc. Accidentals are unicode (♭/♯).
const NATURAL_ROOTS = ["C", "D", "E", "F", "G", "A", "B"];
const FLAT_ROOTS = ["D♭", "E♭", "G♭", "A♭", "B♭"];
const SHARP_ROOTS = ["C♯", "D♯", "F♯", "G♯", "A♯"];
export const BANK_ROOTS = [...NATURAL_ROOTS, ...FLAT_ROOTS, ...SHARP_ROOTS];

// Bass notes for slash chords (same spellings as roots).
export const BANK_BASSES = [...BANK_ROOTS];

// Nashville scale degrees and accidentals (nashville uses "#", not "♯").
const NASHVILLE_DEGREES = ["1", "2", "3", "4", "5", "6", "7"];
const NASHVILLE_ACCIDENTALS = ["", "♭", "#"];
const OCTAVE_UP = "\u0307"; // combining dot ABOVE  → 1̇
const OCTAVE_DOWN = "\u0323"; // combining dot BELOW → 1̣

const DEFAULT_LIMIT = 12;

// ---- Normalization ------------------------------------------------------

// Fold a value or query to a comparable key: lowercase, unicode accidentals →
// ascii (♭→b, ♯→#), strip whitespace. Quality spellings that use literal "b"
// (e.g. "7b9") are preserved because we only swap the *accidental* glyphs, and
// "b"/"#" already read the same after folding.
export function foldChordKey(value) {
   return String(value ?? "")
      .toLowerCase()
      .replace(/♭/g, "b")
      .replace(/♯/g, "#")
      .replace(/\s+/g, "");
}

// Fold Nashville values for comparison. We drop the combining octave dots so
// that a base-degree query ("1") still prefix-matches its octave variants.
export function foldNashvilleKey(value) {
   return String(value ?? "")
      .replace(new RegExp(`[${OCTAVE_UP}${OCTAVE_DOWN}]`, "gu"), "")
      .toLowerCase()
      .replace(/♯/g, "#")
      .replace(/\s+/g, "");
}

// ---- Mode detection -----------------------------------------------------

// A query is Nashville when, after an optional leading ♭/# (or b/#), the first
// meaningful character is a digit 1–7. Otherwise, if it starts with A–G it is a
// letter chord. Empty/other → "chord" (default palette).
export function detectMode(rawInput) {
   const trimmed = String(rawInput ?? "").trim();
   if (!trimmed) return "chord";
   const nash = trimmed.replace(/^[♭#b]/i, "");
   if (/^[1-7]/.test(nash)) return "nashville";
   if (/^[a-g]/i.test(trimmed)) return "chord";
   return "chord";
}

// ---- Candidate generation ----------------------------------------------

function chordCandidates() {
   const out = [];
   for (const root of BANK_ROOTS) for (const quality of BANK_QUALITIES) out.push(`${root}${quality}`);
   return out;
}

function nashvilleCandidatesForDegree(accidental, degree) {
   // Order: base, octave-high, octave-low, then quality colours (base octave).
   const base = `${accidental}${degree}`;
   const ordered = [base, `${accidental}${degree}${OCTAVE_UP}`, `${accidental}${degree}${OCTAVE_DOWN}`];
   for (const quality of BANK_QUALITIES) {
      if (quality === "") continue;
      ordered.push(`${accidental}${degree}${quality}`);
   }
   return ordered;
}

function allNashvilleCandidates() {
   const out = [];
   for (const accidental of NASHVILLE_ACCIDENTALS)
      for (const degree of NASHVILLE_DEGREES) out.push(...nashvilleCandidatesForDegree(accidental, degree));
   return out;
}

// ---- Ranking ------------------------------------------------------------

// Rank a folded candidate against a folded query: 0 exact, 1 prefix, 2 contains,
// -1 no match. Lower is better; original array order breaks ties (stable sort).
function rankKey(candidateKey, queryKey) {
   if (!queryKey) return 1; // empty query → everything is a "prefix" match
   if (candidateKey === queryKey) return 0;
   if (candidateKey.startsWith(queryKey)) return 1;
   if (candidateKey.includes(queryKey)) return 2;
   return -1;
}

// A candidate may expose several fold keys (e.g. G+ also answers to "gaug").
// Rank against the best (lowest, non-negative) of them.
function rankKeys(candidateKeys, queryKey) {
   let best = -1;
   for (const key of candidateKeys) {
      const rank = rankKey(key, queryKey);
      if (rank >= 0 && (best === -1 || rank < best)) best = rank;
   }
   return best;
}

// foldFn may return a single key (string) or several (array). Normalise to an
// array so callers can attach search aliases to a candidate.
function rankAndSlice(candidates, queryKey, foldFn, limit) {
   const scored = [];
   candidates.forEach((value, index) => {
      const folded = foldFn(value);
      const keys = Array.isArray(folded) ? folded : [folded];
      const rank = rankKeys(keys, queryKey);
      if (rank >= 0) scored.push({ value, rank, index });
   });
   scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
   return scored.slice(0, limit).map((entry) => entry.value);
}

// Fold keys for a chord candidate: its own folded value plus any spelled-out
// aliases for a trailing symbol quality (so "Gaug" finds G+, "Gm7b5" finds Gø7).
function chordFoldKeys(value) {
   const primary = foldChordKey(value);
   const keys = [primary];
   for (const [symbol, aliases] of Object.entries(QUALITY_ALIASES)) {
      const symKey = foldChordKey(symbol);
      if (symKey && primary.endsWith(symKey)) {
         const base = primary.slice(0, primary.length - symKey.length);
         for (const alias of aliases) keys.push(base + foldChordKey(alias));
      }
   }
   return keys;
}

// Same alias expansion for Nashville candidates (so "1aug" finds 1+, etc.).
function nashvilleFoldKeys(value) {
   const primary = foldNashvilleKey(value);
   const keys = [primary];
   for (const [symbol, aliases] of Object.entries(QUALITY_ALIASES)) {
      const symKey = foldNashvilleKey(symbol);
      if (symKey && primary.endsWith(symKey)) {
         const base = primary.slice(0, primary.length - symKey.length);
         for (const alias of aliases) keys.push(base + foldNashvilleKey(alias));
      }
   }
   return keys;
}

// ---- Slash chords (on demand) -------------------------------------------

// When the query has a "/", suggest "<left>/<bass>" pairs. The left side is
// resolved to its best canonical chord match; the bass side filters BANK_BASSES.
function slashSuggestions(rawInput, limit) {
   const [leftRaw, bassRaw = ""] = String(rawInput).split("/");
   const leftKey = foldChordKey(leftRaw);
   const leftMatch = rankAndSlice(chordCandidates(), leftKey, chordFoldKeys, 1)[0] || leftRaw.trim();
   if (!leftMatch) return [];
   const bassKey = foldChordKey(bassRaw);
   const basses = rankAndSlice(BANK_BASSES, bassKey, foldChordKey, limit);
   return basses.map((bass) => `${leftMatch}/${bass}`);
}

// ---- Public API ---------------------------------------------------------

/**
 * Suggest normalized chord/Nashville values for a raw query string.
 * @param {string} rawInput - what the user has typed so far.
 * @param {{limit?:number, mode?:"chords"|"numbers"}} [options]
 *   - mode "chords": only chord suggestions (never Nashville numbers).
 *   - mode "numbers": only Nashville number suggestions (never chords).
 *   - omitted: auto-detect from the query (legacy behavior).
 * @returns {string[]} ordered suggestion values (already normalized/standard).
 */
export function suggestChords(rawInput, options = {}) {
   const limit = options.limit ?? DEFAULT_LIMIT;
   const mode = options.mode;
   const input = String(rawInput ?? "").trim();
   if (!input) return [];

   // Numbers mode: always Nashville, ignore chord candidates entirely.
   if (mode === "numbers") {
      return rankAndSlice(allNashvilleCandidates(), foldNashvilleKey(input), nashvilleFoldKeys, limit);
   }

   // Chords mode: never fall into Nashville, even if the query looks numeric.
   if (mode === "chords") {
      if (input.includes("/")) return slashSuggestions(input, limit);
      return rankAndSlice(chordCandidates(), foldChordKey(input), chordFoldKeys, limit);
   }

   // Auto-detect (legacy behavior when no mode specified).
   if (detectMode(input) === "nashville") {
      return rankAndSlice(allNashvilleCandidates(), foldNashvilleKey(input), nashvilleFoldKeys, limit);
   }

   if (input.includes("/")) return slashSuggestions(input, limit);

   return rankAndSlice(chordCandidates(), foldChordKey(input), chordFoldKeys, limit);
}

/** True when at least one suggestion exists for the query. */
export function hasSuggestions(rawInput, options = {}) {
   return suggestChords(rawInput, { ...options, limit: 1 }).length > 0;
}
