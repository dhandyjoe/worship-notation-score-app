// chordPro.js — ChordPro ("lyrics + chords") parsing, transposing and normalizing.
// Pure module: no DOM access, no app state — safe to unit test in Node.
//
// Why a hand-written parser instead of an npm package (e.g. chordsheetjs):
// this app is a no-build-step static site (native ES modules + a service-worker
// offline shell), so a runtime dependency would break both the "serve over HTTP"
// workflow and the offline PWA. We implement a MINIMAL, well-defined subset of the
// ChordPro spec instead, and every unknown directive is parsed and then IGNORED
// by the renderer — text pasted from another ChordPro app can never break a score.
//
// Supported syntax
//   [C] [Am7] [G/B] [N.C.]      inline chords (Nashville tokens like [♭7] pass through)
//   {start_of_chorus} / {soc}   section header — {end_of_*} / {eoc} closes it
//   {c: text} / {comment: text} comment line
//   {title:} {t:} {artist:} {key:} {tempo:} {time:}   song metadata (import only)
//   [Verse 1]                   bracket-only line that is NOT a chord = section label
//   anything else               ignored on render, preserved verbatim in the source
//
// Data model: a section keeps its source text verbatim in `section.chordPro`, so
// the editor textarea is always a faithful round-trip. Rendering and transposing
// are pure transforms over that text.

import {
   isNashvilleChord,
   transposeChord,
   transposeChordRoot,
   transposeNote,
} from "./notation.js?v=20260925-chordpro6";

// Import hardening limit (mirrors MAX_BARS / MAX_SECTIONS in notation.js).
export const MAX_CHORDPRO_CHARS = 20000;

// Directive → printed section label. Both the long and the short spec forms work.
export const CP_SECTION_LABELS = {
   start_of_verse: "Verse",
   sov: "Verse",
   start_of_chorus: "Chorus",
   soc: "Chorus",
   start_of_bridge: "Bridge",
   sob: "Bridge",
   start_of_prechorus: "Pre-Chorus",
   sopc: "Pre-Chorus",
   start_of_intro: "Intro",
   start_of_outro: "Outro",
   start_of_tab: "Tab",
   sot: "Tab",
};

// Directives that close a section (parsed, then ignored by the renderer).
const CP_SECTION_ENDS = new Set([
   "end_of_verse",
   "eov",
   "end_of_chorus",
   "eoc",
   "end_of_bridge",
   "eob",
   "end_of_prechorus",
   "eopc",
   "end_of_intro",
   "end_of_outro",
   "end_of_tab",
   "eot",
]);

// Directives that render as a comment line.
const CP_COMMENT_KEYS = new Set(["c", "comment"]);

// Directives that carry song metadata (consumed by the .cho/.pro importer).
const CP_META_ALIASES = {
   title: "title",
   t: "title",
   subtitle: "subtitle",
   st: "subtitle",
   artist: "artist",
   key: "key",
   k: "key",
   tempo: "tempo",
   time: "time",
};

// "[N.C.]" means "no chord" — a real, printable chord token that is never transposed.
const CP_NO_CHORD = /^(n\.?c\.?|nc)$/i;

// ---- Normalization (import hardening) ----

/**
 * Normalise ChordPro source text: LF line endings, no control characters, no
 * trailing spaces, at most one blank line in a row, clamped to MAX_CHORDPRO_CHARS.
 */
export function normalizeChordPro(text) {
   if (typeof text !== "string" || !text) return "";
   const clean = text
      .replace(/\r\n?/g, "\n")
      // Drop control characters that would corrupt the rendered line flow, but keep
      // tabs and newlines (hand-written sheets use tabs to indent comments).
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n")
      // Collapse runs of blank lines down to a single separator line.
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+|\n+$/g, "");
   return clean.length > MAX_CHORDPRO_CHARS ? clean.slice(0, MAX_CHORDPRO_CHARS) : clean;
}

/**
 * Normalise a section list for ChordPro mode: guarantees a string `name` and a
 * sanitized `chordPro` text on every section while leaving all other fields (id,
 * and any legacy beat/lyric data) untouched.
 */
export function normalizeChordProSections(sections) {
   if (!Array.isArray(sections)) return [];
   return sections.map((section) => ({
      ...section,
      name: String(section?.name || "Section"),
      chordPro: normalizeChordPro(section?.chordPro),
   }));
}

/**
 * Merge the ChordPro source text from a RAW document into its normalized sections.
 *
 * `normalizeSection()` (notation.js) only knows the beat-grid fields, so it drops
 * `section.chordPro` — this helper carries it across by index (both arrays are
 * produced from the same filtered source list) and sanitizes it in the same pass.
 */
export function carryChordProSections(sourceSections, normalizedSections) {
   const sources = Array.isArray(sourceSections) ? sourceSections : [];
   const normalized = Array.isArray(normalizedSections) ? normalizedSections : [];
   return normalizeChordProSections(
      normalized.map((section, index) => ({ ...section, chordPro: sources[index]?.chordPro })),
   );
}

// ---- Chord token detection ----

/**
 * Is this bracket content a chord? Letter chords (including a lowercase root such
 * as `[am]`), slash chords, Nashville degrees and `N.C.` all qualify; section
 * names like `[Verse 1]` do not.
 */
export function isChordToken(value) {
   const raw = String(value ?? "").trim();
   if (!raw) return false;
   if (CP_NO_CHORD.test(raw)) return true;
   if (isNashvilleChord(raw)) return true;
   // Probe the canonical spelling so a lowercase root still validates against the
   // shared chord grammar in notation.js. Slash chords are split first (the bass
   // note is validated by the shared grammar inside transposeChord, not here).
   const canonical = raw[0].toUpperCase() + raw.slice(1);
   const slash = canonical.match(/^(.*)\/([A-G](?:[#♯b♭])?)$/);
   return transposeChordRoot(slash ? slash[1] : canonical, 0) !== null;
}

// ---- Parsing ----

/**
 * Split one lyric line into "word chunks". Each chunk carries the chord that
 * belongs directly above it (or null), and keeps its trailing whitespace so the
 * renderer can wrap lines between words without losing spacing.
 *
 * One chunk per word (not one per chord) is what makes the printed sheet align
 * chords with the syllable they precede while still wrapping naturally.
 */
export function parseChordProLine(line) {
   const source = String(line ?? "");
   const chunks = [];
   let buffer = "";
   let pending = null; // chord waiting for the text that follows it

   const flush = () => {
      if (buffer) {
         const words = buffer.match(/\S+\s*/g) || [];
         words.forEach((word, index) => chunks.push({ chord: index === 0 ? pending : null, text: word }));
         // A chord followed only by whitespace still prints — and the whitespace is
         // KEPT (not dropped), so a progression like "[C] [Am7] [Dm7]" cannot collapse
         // into "CAm7Dm7" on screen or in the PDF.
         if (!words.length && pending) chunks.push({ chord: pending, text: buffer });
         buffer = "";
      } else if (pending) {
         // Chord with no following text at all (e.g. "Amazing [C]").
         chunks.push({ chord: pending, text: "" });
      }
      pending = null;
   };

   let index = 0;
   while (index < source.length) {
      if (source[index] === "[") {
         const close = source.indexOf("]", index);
         if (close === -1) {
            buffer += source.slice(index);
            break;
         }
         const inner = source.slice(index + 1, close);
         if (isChordToken(inner)) {
            flush(); // text so far belongs to the chord seen earlier
            pending = inner.trim();
         } else {
            // Not a chord → literal text, exactly as typed.
            buffer += source.slice(index, close + 1);
         }
         index = close + 1;
         continue;
      }
      buffer += source[index];
      index += 1;
   }
   flush();
   return chunks;
}

/** Parse a `{directive: value}` line. Returns null when the line isn't one. */
function parseDirective(line) {
   const match = line.match(/^\{\s*([a-zA-Z_][\w-]*)\s*(?::\s*([^}]*))?\s*\}$/);
   if (!match) return null;
   return { name: match[1].toLowerCase(), value: (match[2] ?? "").trim() };
}

/**
 * Parse a section's ChordPro text into renderable blocks:
 *   { type:"section", label } | { type:"end" } | { type:"comment", text }
 *   { type:"meta", key, value } | { type:"directive", name, value }
 *   { type:"line", chunks } | { type:"blank" }
 *
 * `meta`, `directive` and `end` blocks are ignored by the renderer — they only
 * exist so imports can read metadata and so pasted text degrades gracefully.
 */
export function parseChordPro(text) {
   const source = normalizeChordPro(text);
   if (!source) return [];
   const blocks = [];
   for (const rawLine of source.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
         blocks.push({ type: "blank" });
         continue;
      }
      const directive = parseDirective(line);
      if (directive) {
         const label = CP_SECTION_LABELS[directive.name];
         if (label) {
            blocks.push({ type: "section", label: directive.value || label });
            continue;
         }
         if (CP_SECTION_ENDS.has(directive.name)) {
            blocks.push({ type: "end" });
            continue;
         }
         if (CP_COMMENT_KEYS.has(directive.name)) {
            blocks.push({ type: "comment", text: directive.value });
            continue;
         }
         if (CP_META_ALIASES[directive.name]) {
            blocks.push({ type: "meta", key: directive.name, value: directive.value });
            continue;
         }
         blocks.push({ type: "directive", name: directive.name, value: directive.value });
         continue;
      }
      // A bracket-only line that is NOT a chord is a section label — hand-written
      // sheets (and most web exports) use "[Verse 1]" / "[Chorus]" headers.
      const labelOnly = line.match(/^\[([^\]]+)\]$/);
      if (labelOnly && !isChordToken(labelOnly[1])) {
         blocks.push({ type: "section", label: labelOnly[1].trim() });
         continue;
      }
      blocks.push({ type: "line", chunks: parseChordProLine(rawLine) });
   }
   return blocks;
}

// ---- Transposing ----

/**
 * Transpose one bracket token. `N.C.` and Nashville degrees are returned as-is
 * (the shared grammar in notation.js never transposes them), and a lowercase root
 * is canonicalised so `[am]` → `[bm]` instead of being left behind.
 */
export function transposeChordToken(value, steps) {
   const raw = String(value ?? "").trim();
   if (!raw) return raw;
   if (CP_NO_CHORD.test(raw) || isNashvilleChord(raw)) return raw;
   const canonical = raw[0].toUpperCase() + raw.slice(1);
   return transposeChord(canonical, steps);
}

/** Transpose the `{key:}` / `{k:}` directive value, keeping the user's spacing. */
function transposeDirective(line, directive, steps) {
   if (directive.name !== "key" && directive.name !== "k") return line;
   const value = directive.value;
   const match = value.match(/^([A-G][#♯b♭]?)(.*)$/);
   if (!match || isNashvilleChord(value)) return line;
   const next = `${transposeNote(match[1], steps)}${match[2]}`;
   if (next === value) return line;
   const inner = line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
   const colon = inner.indexOf(":");
   if (colon === -1) return line;
   const head = inner.slice(0, colon + 1);
   const tail = inner.slice(colon + 1);
   const trimmed = tail.trim();
   return `{${head}${tail.replace(trimmed, next)}}`;
}

/**
 * Transpose every chord in a ChordPro text by `semitones`, leaving lyrics,
 * comments and unknown directives untouched. Returns a NEW string (callers store
 * the result back into `section.chordPro`, mirroring how the beat-grid modes
 * transpose their chords in place).
 */
export function transposeChordProText(text, semitones) {
   const steps = Number(semitones) || 0;
   const source = String(text ?? "");
   if (!steps) return source;
   return source
      .split("\n")
      .map((line) => {
         const directive = parseDirective(line.trim());
         if (directive) return transposeDirective(line, directive, steps);
         return line.replace(/\[([^\]]*)\]/g, (full, inner) =>
            isChordToken(inner) ? `[${transposeChordToken(inner, steps)}]` : full,
         );
      })
      .join("\n");
}

// ---- Convenience readers (import / search) ----

/** Plain lyric text with chords and directives stripped out. */
export function chordProPlainText(text) {
   return parseChordPro(text)
      .map((block) => {
         if (block.type === "comment") return block.text;
         if (block.type === "section") return block.label;
         if (block.type !== "line") return "";
         return block.chunks
            .map((chunk) => chunk.text)
            .join("")
            .trim();
      })
      .filter(Boolean)
      .join("\n");
}

/** Song metadata carried by `{title:}` / `{artist:}` / `{key:}` / `{tempo:}` directives. */
export function chordProMeta(text) {
   const meta = { title: "", artist: "", key: "", tempo: "", time: "", subtitle: "" };
   for (const block of parseChordPro(text)) {
      if (block.type !== "meta") continue;
      const field = CP_META_ALIASES[block.key];
      if (field && field in meta && !meta[field]) meta[field] = block.value;
   }
   return meta;
}

/**
 * Split a whole ChordPro file (.cho / .pro / .txt) into sections: every
 * `{start_of_*}` / `{sov}` header or `[Verse 1]` label line starts a new section,
 * and text before the first header becomes a leading section. Duplicate names are
 * numbered ("Chorus", "Chorus 2") so the printed score stays readable.
 */
export function chordProFromFile(text) {
   const source = normalizeChordPro(text);
   const meta = chordProMeta(source);
   if (!source) return { meta, sections: [] };
   const groups = [];
   let current = null;
   for (const rawLine of source.split("\n")) {
      const line = rawLine.trim();
      const directive = parseDirective(line);
      const label = directive ? CP_SECTION_LABELS[directive.name] : null;
      const labelOnly = directive ? null : line.match(/^\[([^\]]+)\]$/);
      const isHeader = Boolean(label) || Boolean(labelOnly && !isChordToken(labelOnly[1]));
      if (isHeader) {
         const name = label ? directive.value || label : labelOnly[1].trim();
         current = { name, lines: [] };
         groups.push(current);
         continue;
      }
      if (!current) {
         // Song metadata in the file preamble (`{title:}` …) is not a section.
         if (directive && CP_META_ALIASES[directive.name]) continue;
         current = { name: "Intro", lines: [] };
         groups.push(current);
      }
      current.lines.push(rawLine);
   }
   const seen = new Map();
   const sections = groups
      .map((group) => {
         const base = String(group.name || "Section").trim() || "Section";
         const count = (seen.get(base) || 0) + 1;
         seen.set(base, count);
         return { name: count > 1 ? `${base} ${count}` : base, chordPro: normalizeChordPro(group.lines.join("\n")) };
      })
      .filter((section) => section.chordPro);
   return { meta, sections };
}
