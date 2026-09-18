import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
   transposeNote,
   transposeChord,
   normalizeSection,
   removeBar,
   safeFileName,
   isNashvilleChord,
   beatValue,
   lyricValue,
   setLyric,
   prepareLyricsForDuration,
   chordAboveValue,
   setChordAbove,
   barHasContent,
   slotBarIndex,
   splitSyllables,
   syllabifyLyrics,
   MAX_BARS,
   editorModeMeta,
   normalizeEditorMode,
} from "../src/notation.js";
import { encodeShare, decodeShare, buildShareLink, extractPayloadFromLink, canCompress } from "../src/share.js";
import {
   composeSong,
   isLegacySongDoc,
   generateInviteCode,
   normalizeInviteCode,
   versionCopyPayload,
} from "../src/cloud.js";
import { friendlyName } from "../src/identity.js";
import { parseYoutubeUrl, canonicalUrl, thumbnailUrl } from "../src/youtube.js";
import { chordProSectionHTML } from "../src/render.js";
import {
   MAX_CHORDPRO_CHARS,
   normalizeChordPro,
   normalizeChordProSections,
   carryChordProSections,
   isChordToken,
   parseChordProLine,
   parseChordPro,
   transposeChordToken,
   transposeChordProText,
   chordProPlainText,
   chordProMeta,
   chordProFromFile,
} from "../src/chordPro.js";

test("transposeNote wraps around 12 notes and prefers flat spelling", () => {
   assert.equal(transposeNote("B", 1), "C");
   assert.equal(transposeNote("C", -1), "B");
   assert.equal(transposeNote("C", 1), "D♭");
   assert.equal(transposeNote("X", 1), "X"); // unknown note is left untouched
});

test("transposeChord keeps quality and slash bass", () => {
   assert.equal(transposeChord("Cmaj7", 2), "Dmaj7");
   assert.equal(transposeChord("G/B", 1), "A♭/C");
   assert.equal(transposeChord("F#m7", -1), "Fm7");
});

test("Nashville notation is never transposed", () => {
   assert.equal(transposeChord("1maj7", 3), "1maj7");
   assert.equal(transposeChord("♭7", 1), "♭7");
   assert.ok(isNashvilleChord("♭3m"));
});

test("non-chord text is passed through untouched", () => {
   assert.equal(transposeChord("N.C.", 1), "N.C.");
   assert.equal(transposeChord("Hello", 5), "Hello");
});

test("slotBarIndex parses the leading bar number", () => {
   assert.equal(slotBarIndex("2-1"), 2);
   assert.equal(slotBarIndex("0-3:1"), 0);
   assert.equal(slotBarIndex("nope"), -1);
});

test("removeBar shifts slots after the removed bar", () => {
   const section = { bars: 3, beats: { "0-0": "C", "1-0": "G", "2-1": "F" }, lyricBeats: { "1-0": "lord" } };
   removeBar(section, 1);
   assert.equal(section.bars, 2);
   assert.deepEqual(section.beats, { "0-0": "C", "1-1": "F" });
   assert.deepEqual(section.lyricBeats, {});
});

test("normalizeSection distributes legacy lyrics per beat", () => {
   const section = normalizeSection({ id: "s1", name: "Verse", bars: 1, lyrics: "amazing grace how sweet" }, "4/4");
   assert.equal(section.lyricBeats["0-0"], "amazing");
   assert.equal(section.lyricBeats["0-3"], "sweet");
});

test("normalizeSection caps bars and strips invalid beat data", () => {
   const section = normalizeSection({
      id: "s2",
      bars: 9999,
      beats: { "0-0": { chord: "C", duration: "evil" }, "0-1": 42 },
   });
   assert.equal(section.bars, MAX_BARS);
   assert.equal(section.beats["0-0"].duration, null);
   assert.equal(section.beats["0-0"].chord, "C");
   assert.equal(section.beats["0-1"], undefined);
});

test("beatValue normalizes string and object beats", () => {
   const section = { beats: { "0-0": "C", "0-1": { chord: "G", duration: "half" } } };
   assert.deepEqual(beatValue(section, "0-0"), { chord: "C", duration: null });
   assert.deepEqual(beatValue(section, "0-1"), { chord: "G", duration: "half" });
   assert.deepEqual(beatValue(section, "9-9"), { chord: null, duration: null });
});

test("setLyric writes and clears entries", () => {
   const section = { lyricBeats: {} };
   setLyric(section, "0-0", "grace");
   assert.equal(section.lyricBeats["0-0"], "grace");
   setLyric(section, "0-0", "   ");
   assert.equal(section.lyricBeats["0-0"], undefined);
});

test("prepareLyricsForDuration moves a whole-beat lyric onto the first subdivision", () => {
   const section = { beats: {}, lyricBeats: { "0-0": "hallelujah" } };
   prepareLyricsForDuration(section, "0-0", "half");
   assert.equal(lyricValue(section, "0-0:0"), "hallelujah");
   assert.equal(lyricValue(section, "0-0"), "");
});

test("barHasContent detects chords and lyrics in a bar", () => {
   const section = { beats: { "1-0": "C" }, lyricBeats: { "2-0": "word" } };
   assert.ok(barHasContent(section, 1));
   assert.ok(barHasContent(section, 2));
   assert.equal(barHasContent(section, 0), false);
});

test("setChordAbove writes and clears entries", () => {
   const section = { chordAboveBeats: {} };
   setChordAbove(section, "0-0", "Am7");
   assert.equal(section.chordAboveBeats["0-0"], "Am7");
   setChordAbove(section, "0-0", "   ");
   assert.equal(section.chordAboveBeats["0-0"], undefined);
});

test("chordAboveValue returns empty string for unset slots", () => {
   const section = { chordAboveBeats: { "0-0": "G" } };
   assert.equal(chordAboveValue(section, "0-0"), "G");
   assert.equal(chordAboveValue(section, "0-1"), "");
   assert.equal(chordAboveValue({}, "0-0"), "");
});

test("barHasContent detects chord-above entries in a bar", () => {
   const section = { beats: {}, lyricBeats: {}, chordAboveBeats: { "1-0": "Dm" } };
   assert.ok(barHasContent(section, 1));
   assert.equal(barHasContent(section, 0), false);
});

test("normalizeSection preserves and sanitizes chordAboveBeats", () => {
   const section = { name: "Verse", bars: 2, chordAboveBeats: { "0-0": "C", "0-1": "  " } };
   const out = normalizeSection(section, "4/4");
   assert.equal(out.chordAboveBeats["0-0"], "C");
   assert.equal(out.chordAboveBeats["0-1"], undefined);
   assert.equal(out.chordAboveEnabled, true);
   assert.equal(normalizeSection({ name: "X", bars: 1 }).chordAboveEnabled, true);
   assert.equal(normalizeSection({ name: "X", bars: 1, chordAboveEnabled: false }).chordAboveEnabled, false);
});

test("extractBar/replaceBarContent preserve chordAboveBeats", () => {
   const source = {
      beats: { "1-0": { chord: "C", duration: null } },
      lyricBeats: { "1-0": "sing" },
      chordAboveBeats: { "1-0": "G/B" },
   };
   const payload = extractBar(source, 1);
   assert.equal(payload.chordAboveBeats["0-0"], "G/B");
   const target = { beats: {}, lyricBeats: {}, chordAboveBeats: { "2-0": "old" } };
   replaceBarContent(target, 2, payload);
   assert.equal(target.chordAboveBeats["2-0"], "G/B");
   assert.equal(target.chordAboveBeats["2-1"], undefined);
});

test("extractBars/overwriteBars preserve chordAboveBeats for multi-bar ranges", () => {
   const source = {
      bars: 4,
      beats: {},
      lyricBeats: {},
      chordAboveBeats: { "0-0": "C", "1-0": "F", "2-0": "G", "3-0": "Am" },
   };
   const payload = extractBars(source, 0, 1);
   assert.equal(payload.chordAboveBeats["0-0"], "C");
   assert.equal(payload.chordAboveBeats["1-0"], "F");
   const target = { bars: 4, beats: {}, lyricBeats: {}, chordAboveBeats: {} };
   overwriteBars(target, 2, payload);
   assert.equal(target.chordAboveBeats["2-0"], "C");
   assert.equal(target.chordAboveBeats["3-0"], "F");
});

test("safeFileName produces a filesystem-safe slug", () => {
   assert.equal(safeFileName("My Song! (v2)"), "My-Song-v2");
   assert.equal(safeFileName(""), "worship-notation-score");
   assert.equal(safeFileName("///"), "worship-notation-score");
});

test("splitSyllables keeps short words and single-nucleus words intact", () => {
   assert.deepEqual(splitSyllables("God"), ["God"]);
   assert.deepEqual(splitSyllables("the"), ["the"]);
   assert.deepEqual(splitSyllables("grace"), ["grace"]); // silent trailing e
   assert.deepEqual(splitSyllables("saved"), ["saved"]); // silent -ed
});

test("splitSyllables breaks multi-syllable words naturally", () => {
   assert.deepEqual(splitSyllables("wonderful"), ["won", "der", "ful"]);
   assert.deepEqual(splitSyllables("mercy"), ["mer", "cy"]);
   assert.deepEqual(splitSyllables("salvation"), ["sal", "va", "tion"]);
});

test("splitSyllables respects user-supplied hyphenation", () => {
   assert.deepEqual(splitSyllables("a-maz-ing"), ["a", "maz", "ing"]);
});

test("splitSyllables preserves attached punctuation", () => {
   const pieces = splitSyllables("gone,");
   assert.equal(pieces[pieces.length - 1].endsWith(","), true);
});

test("syllabifyLyrics returns hymnal-style tokens with trailing hyphens", () => {
   assert.deepEqual(syllabifyLyrics("amazing grace"), ["a-", "ma-", "zing", "grace"]);
   assert.deepEqual(syllabifyLyrics("  God   is  "), ["God", "is"]);
   assert.deepEqual(syllabifyLyrics(""), []);
});

// ---- chordBank suggestion engine ----------------------------------------
import {
   suggestChords,
   hasSuggestions,
   detectMode,
   foldChordKey,
   foldNashvilleKey,
   BANK_QUALITIES,
} from "../src/chordBank.js";

test("detectMode distinguishes letter chords from Nashville degrees", () => {
   assert.equal(detectMode("Cmaj7"), "chord");
   assert.equal(detectMode("g/b"), "chord");
   assert.equal(detectMode("1"), "nashville");
   assert.equal(detectMode("♭3"), "nashville");
   assert.equal(detectMode("#4m"), "nashville");
   assert.equal(detectMode(""), "chord");
});

test("foldChordKey normalizes unicode accidentals and casing", () => {
   assert.equal(foldChordKey("C♯m7"), "c#m7");
   assert.equal(foldChordKey("E♭maj7"), "ebmaj7");
   assert.equal(foldChordKey("  g / b "), "g/b");
});

test("suggestChords returns normalized letter chords, exact-first", () => {
   const out = suggestChords("cm7");
   assert.equal(out[0], "Cm7"); // exact match wins even from lowercase input
   assert.ok(out.every((value) => value.startsWith("C")));
});

test("suggestChords normalizes ascii accidentals to unicode", () => {
   const out = suggestChords("bb");
   assert.ok(out.includes("B♭")); // 'bb' → B♭ root
});

test("suggestChords generates slash chords on demand after '/'", () => {
   const out = suggestChords("g/b");
   assert.ok(out.includes("G/B"));
   assert.ok(out.every((value) => value.startsWith("G/")));
});

test("suggestChords offers Nashville octave variants for a bare degree", () => {
   const out = suggestChords("1");
   assert.equal(out[0], "1"); // base degree first
   assert.ok(out.includes("1\u0307")); // octave-high 1̇
   assert.ok(out.includes("1\u0323")); // octave-low 1̣
   assert.ok(out.some((value) => value === "1°" || value === "1m")); // quality colours present
});

test("suggestChords keeps Nashville accidental in results", () => {
   const out = suggestChords("♭3");
   assert.ok(out.every((value) => value.startsWith("♭3")));
});

test("foldNashvilleKey drops combining octave dots for matching", () => {
   assert.equal(foldNashvilleKey("1\u0307"), "1");
   assert.equal(foldNashvilleKey("1\u0323"), "1");
});

test("suggestChords returns empty for blank input and unknown text", () => {
   assert.deepEqual(suggestChords(""), []);
   assert.deepEqual(suggestChords("   "), []);
   assert.equal(hasSuggestions("Xyz123"), false);
});

test("suggestChords respects the limit option", () => {
   assert.ok(suggestChords("C", { limit: 3 }).length <= 3);
});

test("BANK_QUALITIES is the agreed Option-1 practical set", () => {
   assert.equal(BANK_QUALITIES[0], ""); // major first
   assert.ok(BANK_QUALITIES.includes("maj7"));
   assert.ok(BANK_QUALITIES.includes("ø7")); // half-diminished (music symbol)
   assert.ok(BANK_QUALITIES.includes("°")); // diminished (music symbol)
   assert.ok(BANK_QUALITIES.includes("+")); // augmented (music symbol)
   assert.ok(!BANK_QUALITIES.includes("aug")); // spelled words are aliases, not stored values
   assert.ok(!BANK_QUALITIES.includes("dim"));
   assert.ok(!BANK_QUALITIES.includes("alt")); // jazz-only qualities excluded
});

test("suggestChords maps augmented/diminished/half-diminished words to music symbols", () => {
   // Augmented → "+"
   assert.equal(suggestChords("Gaug")[0], "G+");
   assert.equal(suggestChords("Gau")[0], "G+"); // partial word
   assert.equal(suggestChords("G+")[0], "G+"); // symbol itself still matches
   // Diminished → "°"
   assert.equal(suggestChords("Gdim")[0], "G°");
   assert.equal(suggestChords("Gdiminished")[0], "G°");
   // Half-diminished → "ø7"
   assert.equal(suggestChords("Gm7b5")[0], "Gø7");
   assert.equal(suggestChords("Ghalfdim")[0], "Gø7");
});

test("suggestChords maps quality aliases in Nashville mode too", () => {
   assert.equal(suggestChords("1aug")[0], "1+");
   assert.equal(suggestChords("1dim")[0], "1°");
   assert.equal(suggestChords("1m7b5")[0], "1ø7");
});

// Chord Chart mode: a numeric query surfaces Nashville degrees (incl. octave
// variants) so users can add numbers with high/low octaves without switching
// out of Chord Chart mode. Letters and slash queries keep letter-chord results.
test("suggestChords in chords mode surfaces Nashville octave variants for numeric queries", () => {
   const out = suggestChords("1", { mode: "chords", limit: 6 });
   assert.equal(out[0], "1"); // base degree first
   assert.ok(out.includes("1\u0307")); // octave-high 1̇
   assert.ok(out.includes("1\u0323")); // octave-low 1̣
});

test("suggestChords in chords mode keeps letter chords for letter queries", () => {
   const out = suggestChords("C", { mode: "chords", limit: 4 });
   assert.ok(out.every((value) => /^[A-G]/.test(value))); // no Nashville leaked in
   assert.equal(out[0], "C");
});

test("suggestChords in chords mode still resolves slash chords first", () => {
   const out = suggestChords("G/", { mode: "chords", limit: 3 });
   assert.ok(out.every((value) => value.startsWith("G/")));
});

test("suggestChords in chords mode honours Nashville accidentals", () => {
   const out = suggestChords("♭3", { mode: "chords", limit: 5 });
   assert.ok(out.length > 0);
   assert.ok(out.every((value) => value.startsWith("♭3")));
});

// ---- Copy / paste helpers (extractBar, replaceBarContent, cloneSection) ----
import {
   extractBar,
   replaceBarContent,
   cloneSection,
   extractBars,
   insertBars,
   overwriteBars,
} from "../src/notation.js?v=20260808-hide-dot-active";

test("extractBar pulls out a single bar's beats and lyrics normalized to bar 0", () => {
   const section = {
      id: "sec-test",
      name: "Test",
      bars: 3,
      beats: { "0-0": "C", "0-1:0": "G", "1-0": "F", "1-1": "Am" },
      lyricBeats: {},
   };
   const payload = extractBar(section, 0);
   assert.deepStrictEqual(payload, { beats: { "0-0": "C", "0-1:0": "G" }, lyricBeats: {}, chordAboveBeats: {} });
});

test("extractBar includes lyrics", () => {
   const section = {
      id: "sec-test",
      name: "Test",
      bars: 2,
      beats: {},
      lyricBeats: { "1-0": "hallelujah" },
   };
   const payload = extractBar(section, 1);
   assert.deepStrictEqual(payload, { beats: {}, lyricBeats: { "0-0": "hallelujah" }, chordAboveBeats: {} });
});

test("replaceBarContent overwrites target bar with copied payload", () => {
   const section = {
      id: "sec-test",
      name: "Test",
      bars: 2,
      beats: { "0-0": "C", "0-1": "Dm" },
      lyricBeats: {},
   };
   const payload = { beats: { "0-0": "G", "0-1:0": "Em" }, lyricBeats: {} };
   replaceBarContent(section, 1, payload);
   assert.strictEqual(section.bars, 2);
   assert.strictEqual(section.beats["1-0"], "G");
   assert.strictEqual(section.beats["1-1:0"], "Em");
   // Bar 0 is untouched
   assert.strictEqual(section.beats["0-0"], "C");
   assert.strictEqual(section.beats["0-1"], "Dm");
});

test("cloneSection creates a fresh id and allows renaming", () => {
   const original = {
      id: "original-id",
      name: "Verse",
      bars: 4,
      beats: {},
      lyricBeats: {},
   };
   const clone = cloneSection(original, "Verse Copy");
   assert.ok(clone.id !== original.id);
   assert.match(clone.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
   assert.equal(clone.name, "Verse Copy");
   // Original untouched
   assert.equal(original.id, "original-id");
   assert.equal(original.name, "Verse");
});

test("replaceBarContent clears existing content before writing payload", () => {
   const section = {
      id: "sec-test",
      name: "Test",
      bars: 2,
      beats: { "1-0": "X", "1-1": "Y" },
      lyricBeats: {},
   };
   const payload = { beats: { "0-0": "Z" }, lyricBeats: {} };
   replaceBarContent(section, 1, payload);
   assert.equal(section.beats["1-0"], "Z");
   assert.equal(section.beats["1-1"], undefined); // cleared
});

test("extractBars pulls a contiguous range normalized to bar 0", () => {
   const section = {
      id: "s",
      name: "T",
      bars: 5,
      beats: { "0-0": "C", "1-0": "F", "2-0": "G", "2-1:0": "Am", "3-0": "Dm" },
      lyricBeats: { "2-0": "hymn" },
   };
   const payload = extractBars(section, 1, 2);
   assert.equal(payload.count, 2);
   // bar 1 -> 0, bar 2 -> 1
   assert.deepStrictEqual(payload.beats, { "0-0": "F", "1-0": "G", "1-1:0": "Am" });
   assert.deepStrictEqual(payload.lyricBeats, { "1-0": "hymn" });
});

test("extractBars is order-agnostic (start/end swapped)", () => {
   const section = { id: "s", name: "T", bars: 4, beats: { "1-0": "F", "2-0": "G" }, lyricBeats: {} };
   const a = extractBars(section, 1, 2);
   const b = extractBars(section, 2, 1);
   assert.deepStrictEqual(a, b);
});

test("insertBars shifts existing bars right and writes payload before target", () => {
   const section = {
      id: "s",
      name: "T",
      bars: 3,
      beats: { "0-0": "C", "1-0": "F", "2-0": "G" },
      lyricBeats: {},
   };
   const payload = { count: 2, beats: { "0-0": "X", "1-0": "Y" }, lyricBeats: {} };
   const ok = insertBars(section, 1, payload); // insert BEFORE bar 1
   assert.equal(ok, true);
   assert.equal(section.bars, 5);
   // bar 0 stays
   assert.equal(section.beats["0-0"], "C");
   // payload lands at bars 1 and 2
   assert.equal(section.beats["1-0"], "X");
   assert.equal(section.beats["2-0"], "Y");
   // old bar 1 (F) shifted to bar 3, old bar 2 (G) shifted to bar 4
   assert.equal(section.beats["3-0"], "F");
   assert.equal(section.beats["4-0"], "G");
});

test("insertBars respects MAX_BARS and refuses to overflow", () => {
   const section = { id: "s", name: "T", bars: 95, beats: {}, lyricBeats: {} };
   const payload = { count: 2, beats: { "0-0": "X" }, lyricBeats: {} };
   const ok = insertBars(section, 0, payload); // 95 + 2 = 97 > 96
   assert.equal(ok, false);
   assert.equal(section.bars, 95); // unchanged
});

// --- share.js: encode/decode roundtrip -------------------------------------

const SAMPLE_PROJECT = {
   format: "chord-sheet",
   version: 2,
   title: "Amazing Grace ♭",
   artist: "Traditional",
   key: "G",
   meter: "3/4",
   sections: [
      {
         id: "a",
         name: "Verse 1",
         bars: 4,
         beats: { "0-0": { chord: "G" }, "1-0": { chord: "C" } },
         lyricBeats: { "0-0": "A-ma-zing" },
      },
   ],
};

test("encodeShare/decodeShare roundtrip preserves the project (gzip when available)", async () => {
   const payload = await encodeShare(SAMPLE_PROJECT);
   assert.equal(typeof payload, "string");
   assert.equal(payload[0], "w"); // magic marker
   assert.ok(payload[1] === "g" || payload[1] === "p"); // scheme
   const decoded = await decodeShare(payload);
   assert.deepEqual(decoded, SAMPLE_PROJECT);
});

test("gzip payload is smaller than plain for a realistic project", async () => {
   if (!canCompress()) return; // environment without CompressionStream
   const payload = await encodeShare(SAMPLE_PROJECT);
   assert.equal(payload[1], "g"); // should pick gzip
});

test("decodeShare rejects non-share strings", async () => {
   await assert.rejects(() => decodeShare("not-a-payload"));
   await assert.rejects(() => decodeShare(""));
   await assert.rejects(() => decodeShare("wz123")); // unknown scheme 'z'
});

test("buildShareLink puts payload in the fragment after #/import?d=", async () => {
   const link = await buildShareLink(SAMPLE_PROJECT, "https://host/app/index.html#/editor");
   assert.ok(link.startsWith("https://host/app/index.html#/import?d="));
   // and it must decode back to the same project
   const payload = extractPayloadFromLink(link);
   assert.deepEqual(await decodeShare(payload), SAMPLE_PROJECT);
});

test("extractPayloadFromLink handles full links, bare fragments, and raw payloads", async () => {
   const payload = await encodeShare(SAMPLE_PROJECT);
   assert.equal(extractPayloadFromLink(`https://host/app/#/import?d=${payload}`), payload);
   assert.equal(extractPayloadFromLink(`#/import?d=${payload}`), payload);
   assert.equal(extractPayloadFromLink(`  ${payload}  `), payload); // raw payload with whitespace
   assert.equal(extractPayloadFromLink("https://host/app/"), null); // no payload
   assert.equal(extractPayloadFromLink(""), null);
});

// ---- Multi-bar clipboard: extract / insert / overwrite ----
// These back the "Copy bars" selection feature (copy a bar range, paste it
// over another range). They are pure data transforms on section.beats.

test("extractBars pulls a bar range and rebases slot indices to 0", () => {
   const section = {
      bars: 4,
      beats: {
         "0-0": { chord: "C", duration: null },
         "1-0": { chord: "G", duration: null },
         "2-0": { chord: "Am", duration: null },
         "3-0": { chord: "F", duration: null },
      },
      lyricBeats: { "1-0": "hello", "2-0": "world" },
   };
   const payload = extractBars(section, 1, 2);
   assert.equal(payload.count, 2);
   // bar 1 -> 0, bar 2 -> 1 (rebased)
   assert.equal(payload.beats["0-0"].chord, "G");
   assert.equal(payload.beats["1-0"].chord, "Am");
   assert.equal(payload.lyricBeats["0-0"], "hello");
   assert.equal(payload.lyricBeats["1-0"], "world");
   // bars outside the range are excluded
   assert.equal(payload.beats["2-0"], undefined);
});

test("extractBars normalizes a reversed range (endBar < startBar)", () => {
   const section = {
      bars: 3,
      beats: { "0-0": { chord: "C", duration: null }, "2-0": { chord: "F", duration: null } },
      lyricBeats: {},
   };
   const payload = extractBars(section, 2, 0);
   assert.equal(payload.count, 3);
   assert.equal(payload.beats["0-0"].chord, "C");
   assert.equal(payload.beats["2-0"].chord, "F");
});

test("overwriteBars replaces the target range in place without shifting other bars", () => {
   const section = {
      bars: 4,
      beats: {
         "0-0": { chord: "C", duration: null },
         "1-0": { chord: "G", duration: null },
         "2-0": { chord: "Am", duration: null },
         "3-0": { chord: "F", duration: null },
      },
      lyricBeats: { "3-0": "keep-me" },
   };
   const payload = extractBars(section, 0, 1); // copy C, G
   const ok = overwriteBars(section, 2, payload); // paste over bars 2..3
   assert.equal(ok, true);
   assert.equal(section.beats["2-0"].chord, "C");
   assert.equal(section.beats["3-0"].chord, "G");
   // Overwritten bar 3's old lyric is cleared (range was replaced).
   assert.equal(section.lyricBeats["3-0"], undefined);
   // Bars before the paste target are untouched.
   assert.equal(section.beats["0-0"].chord, "C");
   assert.equal(section.beats["1-0"].chord, "G");
   // No extra bars were inserted.
   assert.equal(section.bars, 4);
});

test("overwriteBars grows section.bars when the pasted range extends past the end", () => {
   const section = {
      bars: 2,
      beats: { "0-0": { chord: "C", duration: null }, "1-0": { chord: "G", duration: null } },
      lyricBeats: {},
   };
   const payload = extractBars(section, 0, 1); // 2 bars
   const ok = overwriteBars(section, 1, payload); // paste at bar 1 -> covers bars 1,2
   assert.equal(ok, true);
   assert.equal(section.bars, 3); // grew from 2 to 3
   assert.equal(section.beats["1-0"].chord, "C");
   assert.equal(section.beats["2-0"].chord, "G");
});

test("overwriteBars refuses to exceed MAX_BARS", () => {
   const section = { bars: MAX_BARS, beats: {}, lyricBeats: {} };
   const payload = { count: 2, beats: { "0-0": { chord: "C", duration: null } }, lyricBeats: {} };
   // Pasting 2 bars at the last index would need MAX_BARS+1 bars.
   const ok = overwriteBars(section, MAX_BARS - 1, payload);
   assert.equal(ok, false);
   assert.equal(section.bars, MAX_BARS); // unchanged
});

test("insertBars shifts existing bars right and respects MAX_BARS", () => {
   const section = {
      bars: 2,
      beats: { "0-0": { chord: "C", duration: null }, "1-0": { chord: "G", duration: null } },
      lyricBeats: { "1-0": "world" },
   };
   const payload = { count: 1, beats: { "0-0": { chord: "Am", duration: null } }, lyricBeats: {} };
   const ok = insertBars(section, 1, payload); // insert 1 bar before bar 1
   assert.equal(ok, true);
   assert.equal(section.bars, 3);
   assert.equal(section.beats["0-0"].chord, "C"); // unchanged
   assert.equal(section.beats["1-0"].chord, "Am"); // inserted
   assert.equal(section.beats["2-0"].chord, "G"); // shifted right
   assert.equal(section.lyricBeats["2-0"], "world"); // lyric followed its bar
});

// ---- song + version composition (pure helpers from cloud.js) ----

test("composeSong produces a clean editor project without version meta fields", () => {
   const meta = { title: "O Holy Night", artist: "Adolphe Adam" };
   const version = {
      versionId: "version-x",
      label: "Pop",
      number: 2,
      createdAt: 1,
      updatedAt: 2,
      cloudId: "song-c",
      songId: "song-s",
      format: "chord-sheet",
      version: 2,
      title: "O Holy Night",
      artist: "Adolphe Adam",
      key: "C",
      meter: "4/4",
      sections: [{ name: "Intro", bars: [] }],
      pdfOptions: { paper: "A4" },
   };
   const out = composeSong(meta, version);
   assert.equal(out.title, "O Holy Night");
   assert.equal(out.artist, "Adolphe Adam");
   assert.equal(out.key, "C");
   assert.deepEqual(out.sections, [{ name: "Intro", bars: [] }]);
   assert.equal(out.pdfOptions.paper, "A4");
   for (const key of ["label", "number", "createdAt", "updatedAt", "cloudId", "songId", "versionId"]) {
      assert.ok(!(key in out), `version meta field "${key}" must not leak into the project`);
   }
});

test("composeSong prefers the song metadata for title/artist", () => {
   const meta = { title: "From Meta", artist: "Arranger" };
   const version = { format: "chord-sheet", title: "From Version", artist: "Old", sections: [] };
   const out = composeSong(meta, version);
   assert.equal(out.title, "From Meta");
   assert.equal(out.artist, "Arranger");
});

test("composeSong falls back to the version's own title when metadata is missing", () => {
   const out = composeSong({}, { format: "chord-sheet", title: "Fallback", artist: "A", sections: [] });
   assert.equal(out.title, "Fallback");
});

test("composeSong fills generic placeholders when nothing provides a title", () => {
   const out = composeSong(null, { format: "chord-sheet", sections: [] });
   assert.equal(out.title, "Song Title");
   assert.equal(out.artist, "Artist / Composer");
});

test("isLegacySongDoc flags flat documents that still hold sections inline", () => {
   assert.equal(isLegacySongDoc({ sections: [] }), true);
   assert.equal(isLegacySongDoc({ title: "new", versionCount: 1 }), false);
   assert.equal(isLegacySongDoc({}), false);
   assert.equal(isLegacySongDoc(null), false);
});

test("composeSong preserves the full project shape for PDF/export compatibility", () => {
   const meta = { title: "T", artist: "A" };
   const version = {
      format: "chord-sheet",
      version: 2,
      title: "T",
      artist: "A",
      key: "G",
      meter: "3/4",
      bpm: 90,
      lyricsEnabled: true,
      chordAboveEnabled: false,
      nashvilleNumber: "1",
      nashvilleAccidental: "#",
      slashChords: ["G/B"],
      sections: [{ name: "Verse", bars: 2, beats: { "0-0": "C" } }],
      pdfOptions: { fontSize: 14 },
   };
   const out = composeSong(meta, version);
   assert.deepEqual(out, {
      format: "chord-sheet",
      version: 2,
      title: "T",
      artist: "A",
      key: "G",
      meter: "3/4",
      bpm: 90,
      lyricsEnabled: true,
      chordAboveEnabled: false,
      nashvilleNumber: "1",
      nashvilleAccidental: "#",
      slashChords: ["G/B"],
      sections: [{ name: "Verse", bars: 2, beats: { "0-0": "C" } }],
      pdfOptions: { fontSize: 14 },
   });
});

// ---- YouTube link parsing (pure helpers from youtube.js) ----

test("parseYoutubeUrl extracts the id from common URL forms", () => {
   const id = "dQw4w9WgXcQ";
   const forms = [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/watch?v=${id}&list=PL1234`,
      id, // bare 11-char id
   ];
   for (const form of forms) {
      const out = parseYoutubeUrl(form);
      assert.equal(out?.videoId, id, `expected id for ${form}`);
      assert.equal(out?.url, `https://www.youtube.com/watch?v=${id}`);
   }
});

test("parseYoutubeUrl rejects invalid or non-YouTube input", () => {
   const bad = ["", "   ", "not a video", "https://vimeo.com/12345", "https://example.com/dQw4w9WgXcQ", "abc"];
   for (const value of bad) {
      assert.equal(parseYoutubeUrl(value), null, `expected null for ${JSON.stringify(value)}`);
   }
});

test("canonicalUrl and thumbnailUrl helpers", () => {
   assert.equal(canonicalUrl("abc123XYZ-q"), "https://www.youtube.com/watch?v=abc123XYZ-q");
   assert.equal(thumbnailUrl("abc"), "https://i.ytimg.com/vi/abc/mqdefault.jpg");
   assert.equal(thumbnailUrl("abc", "hqdefault"), "https://i.ytimg.com/vi/abc/hqdefault.jpg");
   assert.equal(thumbnailUrl("abc", "bogus"), "https://i.ytimg.com/vi/abc/mqdefault.jpg");
});

// ---- Member identity (pure helper from identity.js) ----
// Google sign-in fills Auth.displayName, but email/password sign-up does NOT —
// so the member list derives a readable name from the email's local part instead
// of showing a generic "Musician" for everyone.

test("friendlyName prefers the explicit displayName / member name", () => {
   assert.equal(friendlyName({ displayName: "Dhandy J", email: "x7k2p9@gmail.com" }), "Dhandy J");
   assert.equal(friendlyName({ name: "Pak Budi", email: "bud@gmail.com" }), "Pak Budi");
   assert.equal(friendlyName({ displayName: "  Sarah  ", email: "x@y.com" }), "Sarah");
});

test("friendlyName derives a readable name from the email local part", () => {
   assert.equal(friendlyName({ email: "dhandy.joe@gmail.com" }), "Dhandy Joe");
   assert.equal(friendlyName({ email: "sarah_w@example.com" }), "Sarah W");
   assert.equal(friendlyName({ email: "joe2@gmail.com" }), "Joe");
   assert.equal(friendlyName({ email: "d.handy-joenathan+team@gmail.com" }), "D Handy Joenathan");
});

test("friendlyName returns empty for id-like or missing addresses (caller keeps its fallback)", () => {
   const rejected = ["x7k2p9@gmail.com", "a@b.com", "", "   ", "user_12345678@mail.com", "12345678@mail.com"];
   for (const email of rejected) {
      assert.equal(friendlyName({ email }), "", `expected no derived name for ${JSON.stringify(email)}`);
   }
   assert.equal(friendlyName(), "");
   assert.equal(friendlyName({}), "");
   assert.equal(friendlyName({ email: undefined, name: "" }), "");
});

test("friendlyName caps the derived name to three words and 28 characters", () => {
   assert.equal(friendlyName({ email: "one.two.three.four.five@example.com" }), "One Two Three");
   assert.ok(friendlyName({ email: "abcdefghijklmnopqrstuvwxyz1234@example.com" }).length <= 28);
});

// ---- Album invite codes (pure helpers from cloud.js) ----

test("generateInviteCode produces XXXX-XXXX from an unambiguous alphabet", () => {
   for (let i = 0; i < 25; i++) {
      const code = generateInviteCode();
      assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
      // I / O / 0 / 1 are excluded so a code read from a photo is never ambiguous.
      assert.ok(!/[IO01]/.test(code), `code must avoid I/O/0/1: ${code}`);
   }
});

test("normalizeInviteCode canonicalises typed codes and rejects the rest", () => {
   assert.equal(normalizeInviteCode("7fq3-xk2n"), "7FQ3-XK2N");
   assert.equal(normalizeInviteCode("7fq3xk2n"), "7FQ3-XK2N");
   assert.equal(normalizeInviteCode("  7FQ3 XK2N "), "7FQ3-XK2N");
   for (const bad of ["", "ABC", "7FQ3-XK2N9", "abcdefghij", null, undefined]) {
      assert.equal(normalizeInviteCode(bad), null, `expected null for ${JSON.stringify(bad)}`);
   }
});

// ---- Version payload copy (album "Add from My Songs", from cloud.js) ----
// Every copied version is re-created through saveAlbumVersion, which assigns its
// own label/number/timestamps — so those transport fields must be stripped while
// the whole arrangement content is carried over.

test("versionCopyPayload strips transport + version-meta fields", () => {
   const source = {
      cloudId: "c1",
      songId: "s1",
      versionId: "v1",
      label: "Version 3",
      number: 3,
      createdAt: 1,
      updatedAt: 2,
      legacy: true,
      hasNoVersions: true,
      title: "Amazing Grace",
      sections: [{ name: "Verse" }],
   };
   const payload = versionCopyPayload(source);
   const stripped = ["cloudId", "songId", "versionId", "label", "number", "createdAt", "updatedAt", "legacy", "hasNoVersions"];
   for (const key of stripped) {
      assert.equal(key in payload, false, `${key} should be stripped from the copy`);
   }
   assert.equal(payload.title, "Amazing Grace");
});

test("versionCopyPayload keeps every content field and never mutates the source", () => {
   const source = {
      title: "Amazing Grace",
      artist: "John Newton",
      key: "G",
      meter: "4/4",
      bpm: 84,
      editorMode: "numbers",
      lyricsEnabled: true,
      chordAboveEnabled: true,
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      youtubeId: "dQw4w9WgXcQ",
      sections: [{ id: "sec1", name: "Verse", bars: 4, beats: { "0:0": "G" } }],
      label: "Version 3",
      number: 3,
      cloudId: "c1",
   };
   const snapshot = structuredClone(source);
   const payload = versionCopyPayload(source);
   assert.equal(payload.title, "Amazing Grace");
   assert.equal(payload.artist, "John Newton");
   assert.equal(payload.key, "G");
   assert.equal(payload.meter, "4/4");
   assert.equal(payload.bpm, 84);
   assert.equal(payload.editorMode, "numbers");
   assert.equal(payload.lyricsEnabled, true);
   assert.equal(payload.chordAboveEnabled, true);
   assert.equal(payload.youtubeId, "dQw4w9WgXcQ");
   assert.deepEqual(payload.sections, source.sections);
   // A fresh object (the caller may add its own label/number on top)...
   assert.notEqual(payload, source);
   // ...and the source document is untouched.
   assert.deepEqual(source, snapshot);
});

test("versionCopyPayload is safe with missing input", () => {
   assert.deepEqual(versionCopyPayload(), {});
   assert.deepEqual(versionCopyPayload({}), {});
});

// ============================================================================
// Editor modes (from notation.js)
// ----------------------------------------------------------------------------
// Regression guard for the ChordPro release: the two ORIGINAL modes must keep the
// exact badge label and glyph they had before the third mode existed, so the
// topbar pill and the library cards look identical for existing songs.
// ============================================================================

test("editorModeMeta keeps the original Chord Chart / Nashville labels and glyphs", () => {
   assert.deepEqual(editorModeMeta.chords, { id: "chords", badge: "Chord Chart", cardMark: "♪" });
   assert.deepEqual(editorModeMeta.numbers, { id: "numbers", badge: "Nashville Numbers", cardMark: "#" });
   assert.equal(editorModeMeta.chordpro.id, "chordpro");
   assert.equal(editorModeMeta.chordpro.badge, "ChordPro");
});

test("normalizeEditorMode accepts the three modes and falls back to chords", () => {
   assert.equal(normalizeEditorMode("chordpro"), "chordpro");
   assert.equal(normalizeEditorMode("numbers"), "numbers");
   assert.equal(normalizeEditorMode("chords"), "chords");
   // Legacy projects have no editorMode at all — they must stay Chord Chart.
   for (const bad of [undefined, null, "", "Chords", "CHORDPRO", "nashville", 0, {}, []]) {
      assert.equal(normalizeEditorMode(bad), "chords", `expected chords for ${JSON.stringify(bad)}`);
   }
});

// ============================================================================
// ChordPro mode (from chordPro.js)
// ============================================================================

test("isChordToken recognises letter, slash, Nashville and N.C. tokens", () => {
   for (const value of ["C", "Am7", "Cmaj7", "G/B", "F#m7", "A♭", "am", "N.C.", "nc", "1", "♭7", "5̇"]) {
      assert.ok(isChordToken(value), `expected a chord token: ${value}`);
   }
});

test("isChordToken rejects section labels, plain words and empty input", () => {
   for (const value of ["", "  ", "Verse 1", "Chorus", "hello", "Amazing grace", null, undefined]) {
      assert.ok(!isChordToken(value), `expected a non-chord token: ${JSON.stringify(value)}`);
   }
});

test("parseChordProLine attaches each chord to the word it precedes", () => {
   assert.deepEqual(parseChordProLine("[C]Amazing [G]grace"), [
      { chord: "C", text: "Amazing " },
      { chord: "G", text: "grace" },
   ]);
});

test("parseChordProLine keeps text before the first chord unchorded", () => {
   assert.deepEqual(parseChordProLine("Oh [C]happy day"), [
      { chord: null, text: "Oh " },
      { chord: "C", text: "happy " },
      { chord: null, text: "day" },
   ]);
});

test("parseChordProLine splits a multi-word run into one chunk per word", () => {
   // Only the first word of a run carries the chord, so the printed sheet can wrap
   // between words without dragging the chord along.
   assert.deepEqual(parseChordProLine("[C]how sweet the sound"), [
      { chord: "C", text: "how " },
      { chord: null, text: "sweet " },
      { chord: null, text: "the " },
      { chord: null, text: "sound" },
   ]);
});

test("parseChordProLine emits a chord-only chunk for a trailing chord", () => {
   assert.deepEqual(parseChordProLine("Amazing [C]"), [
      { chord: null, text: "Amazing " },
      { chord: "C", text: "" },
   ]);
   assert.deepEqual(parseChordProLine("[C]"), [{ chord: "C", text: "" }]);
});

test("parseChordProLine keeps non-chord brackets as literal text", () => {
   assert.deepEqual(parseChordProLine("Hello [world]"), [
      { chord: null, text: "Hello " },
      { chord: null, text: "[world]" },
   ]);
});

test("parseChordProLine tolerates an unclosed bracket", () => {
   assert.deepEqual(parseChordProLine("[C]Amazing [G"), [
      { chord: "C", text: "Amazing " },
      { chord: null, text: "[G" },
   ]);
});

test("parseChordPro classifies sections, comments, metadata, ends and blanks", () => {
   const blocks = parseChordPro("{soc}\n{c: soft}\n[C]Sing\n{eoc}\n{unknown_thing: x}\n\n{sov}\n[G]Again");
   assert.deepEqual(
      blocks.map((block) => block.type),
      ["section", "comment", "line", "end", "directive", "blank", "section", "line"],
   );
   assert.equal(blocks[0].label, "Chorus");
   assert.equal(blocks[1].text, "soft");
   assert.equal(blocks[6].label, "Verse");
});

test("parseChordPro accepts the long section form with a custom label", () => {
   assert.deepEqual(parseChordPro("{start_of_chorus: Chorus 2}")[0], { type: "section", label: "Chorus 2" });
   assert.deepEqual(parseChordPro("{start_of_bridge}")[0], { type: "section", label: "Bridge" });
});

test("parseChordPro treats a bracket-only non-chord line as a section label", () => {
   const blocks = parseChordPro("[Verse 1]\n[C]Amazing");
   assert.deepEqual(blocks[0], { type: "section", label: "Verse 1" });
   assert.equal(blocks[1].type, "line");
});

test("parseChordPro keeps an inline-chord line a lyric line, not a label", () => {
   const blocks = parseChordPro("[C]Amazing [G]grace");
   assert.equal(blocks.length, 1);
   assert.equal(blocks[0].type, "line");
});

test("parseChordPro ignores unknown directives without breaking the score", () => {
   const blocks = parseChordPro("{define: C base-fret 1}\n[C]Sing");
   assert.equal(blocks[0].type, "directive");
   assert.equal(blocks[0].name, "define");
   assert.equal(blocks[1].type, "line");
   assert.equal(blocks[1].chunks[0].chord, "C");
});

test("parseChordPro returns an empty block list for empty input", () => {
   assert.deepEqual(parseChordPro(""), []);
   assert.deepEqual(parseChordPro(null), []);
   assert.deepEqual(parseChordPro("   \n\n  "), []);
});

test("transposeChordProText transposes letter and slash chords only", () => {
   assert.equal(transposeChordProText("[C]Amazing [G/B]grace", 1), "[D♭]Amazing [A♭/C]grace");
   assert.equal(transposeChordProText("[F#m7]how [Cmaj7]sweet", 2), "[A♭m7]how [Dmaj7]sweet");
});

test("transposeChordProText never transposes Nashville degrees or N.C.", () => {
   assert.equal(transposeChordProText("[1]Sing [♭7]soft [N.C.]rest", 2), "[1]Sing [♭7]soft [N.C.]rest");
});

test("transposeChordProText canonicalises a lowercase root", () => {
   // The root is upper-cased so the shared chord grammar accepts it, which means a
   // lowercase `[am]` transposes instead of being silently skipped.
   assert.equal(transposeChordProText("[am]Sing", 2), "[Bm]Sing");
});

test("transposeChordProText leaves comments, unknown directives and lyrics untouched", () => {
   const source = "{c: play [C] twice}\n{x_custom: [G]}\nAmazing [C]grace";
   assert.equal(transposeChordProText(source, 2), "{c: play [C] twice}\n{x_custom: [G]}\nAmazing [D]grace");
});

test("transposeChordProText rewrites the {key:} directive and keeps its spacing", () => {
   assert.equal(transposeChordProText("{key: G}", 1), "{key: A♭}");
   assert.equal(transposeChordProText("{ key : G }", 1), "{ key : A♭ }");
   assert.equal(transposeChordProText("{k: C}", -1), "{k: B}");
});

test("transposeChordProText returns identical text for 0 semitones", () => {
   const source = "[C]Amazing [G/B]grace";
   assert.equal(transposeChordProText(source, 0), source);
   assert.equal(transposeChordProText(source, null), source);
});

test("transposeChordProText is reversible", () => {
   // Spellings the app already prefers (flats) survive a round trip; F#/G♭ style
   // enharmonic swaps are the same behaviour as the existing beat-grid transpose.
   const source = "[C]Amazing [G/B]grace [Am7]how [N.C.]sweet";
   assert.equal(transposeChordProText(transposeChordProText(source, 3), -3), source);
});

test("transposeChordToken keeps an unknown token as-is", () => {
   assert.equal(transposeChordToken("N.C.", 1), "N.C.");
   assert.equal(transposeChordToken("1", 1), "1");
   assert.equal(transposeChordToken("C", 1), "D♭");
});

test("normalizeChordPro normalises line endings, control chars and blank runs", () => {
   assert.equal(normalizeChordPro("  [C]Amazing  \r\n\r\n\r\n\r\n[G]grace\r"), "  [C]Amazing\n\n[G]grace");
   assert.equal(normalizeChordPro("A\u0000B"), "AB");
   assert.equal(normalizeChordPro(""), "");
   assert.equal(normalizeChordPro(null), "");
   assert.equal(normalizeChordPro(42), "");
});

test("normalizeChordPro clamps oversized input", () => {
   const long = "x".repeat(MAX_CHORDPRO_CHARS + 500);
   assert.equal(normalizeChordPro(long).length, MAX_CHORDPRO_CHARS);
});

test("normalizeChordProSections guarantees name + chordPro and keeps other fields", () => {
   const out = normalizeChordProSections([
      { id: "a", name: "Verse", chordPro: "  [C]x  \r\n" },
      { id: "b" },
   ]);
   assert.equal(out[0].id, "a");
   assert.equal(out[0].name, "Verse");
   assert.equal(out[0].chordPro, "  [C]x");
   assert.equal(out[1].id, "b");
   assert.equal(out[1].name, "Section");
   assert.equal(out[1].chordPro, "");
   assert.deepEqual(normalizeChordProSections(null), []);
});

test("carryChordProSections restores lyrics that normalizeSection() drops", () => {
   // Regression guard for the import path: normalizeSection() only knows the beat
   // grid, so it silently loses `section.chordPro` — which is exactly the field a
   // ChordPro song stores its lyrics in. This proves the carry-over works.
   const raw = [
      { id: "s1", name: "Verse", chordPro: "  [C]Amazing  \r\n[G]grace" },
      { id: "s2", name: "Chorus" },
   ];
   const normalized = raw.map((section) => normalizeSection(section, "4/4"));
   assert.equal("chordPro" in normalized[0], false, "normalizeSection is expected to drop chordPro");
   const carried = carryChordProSections(raw, normalized);
   assert.equal(carried[0].chordPro, "  [C]Amazing\n[G]grace");
   assert.equal(carried[1].chordPro, "");
   assert.equal(carried[0].id, "s1");
   assert.equal(carried[0].name, "Verse");
   assert.equal(carried[1].name, "Chorus");
   assert.deepEqual(carryChordProSections(null, null), []);
});

test("a ChordPro project survives a save/load round trip through normalizeSection", () => {
   const saved = {
      format: "chord-sheet",
      version: 2,
      editorMode: "chordpro",
      sections: [
         { id: "a", name: "Verse 1", chordPro: "[C]Amazing [G]grace" },
         { id: "b", name: "Chorus", chordPro: "{soc}\n[F]How sweet [C]the sound" },
      ],
   };
   const normalized = saved.sections.map((section) => normalizeSection(section, "4/4"));
   const reloaded = carryChordProSections(saved.sections, normalized);
   assert.equal(reloaded.length, 2);
   assert.deepEqual(
      reloaded.map((section) => section.chordPro),
      ["[C]Amazing [G]grace", "{soc}\n[F]How sweet [C]the sound"],
   );
   assert.deepEqual(
      reloaded.map((section) => section.name),
      ["Verse 1", "Chorus"],
   );
});

test("chordProPlainText strips chords and directives", () => {
   const text = "{soc}\n{c: soft}\n[C]Amazing [G]grace\n{eoc}";
   assert.equal(chordProPlainText(text), "Chorus\nsoft\nAmazing grace");
});

test("chordProMeta reads the metadata directive aliases", () => {
   const meta = chordProMeta("{t: Amazing Grace}\n{artist: John Newton}\n{key: G}\n{tempo: 84}");
   assert.equal(meta.title, "Amazing Grace");
   assert.equal(meta.artist, "John Newton");
   assert.equal(meta.key, "G");
   assert.equal(meta.tempo, "84");
   assert.equal(chordProMeta("no metadata here").title, "");
});

test("chordProFromFile splits sections on headers and numbers duplicates", () => {
   const file = "{title: Test}\n{sov}\n[C]Verse line\n{soc}\n[G]Chorus line\n{soc}\n[C]Chorus again";
   const { meta, sections } = chordProFromFile(file);
   assert.equal(meta.title, "Test");
   assert.deepEqual(
      sections.map((section) => section.name),
      ["Verse", "Chorus", "Chorus 2"],
   );
   assert.equal(sections[0].chordPro, "[C]Verse line");
   assert.equal(sections[2].chordPro, "[C]Chorus again");
});

test("chordProFromFile keeps text before the first header as a leading section", () => {
   const { sections } = chordProFromFile("[C]Instrumental intro\n{soc}\n[G]Sing");
   assert.deepEqual(
      sections.map((section) => section.name),
      ["Intro", "Chorus"],
   );
});

test("chordProFromFile returns no sections for metadata-only or empty input", () => {
   assert.deepEqual(chordProFromFile("{title: Only meta}").sections, []);
   assert.deepEqual(chordProFromFile("").sections, []);
   assert.deepEqual(chordProFromFile(null).sections, []);
});

// ============================================================================
// ChordPro workspace wiring (static checks — no browser needed)
// ----------------------------------------------------------------------------
// These guard the failure modes that unit-testing the pure modules cannot catch:
// a typo'd element id, a stylesheet that was never linked, and cache-version drift
// between index.html / the ES modules / the service worker.
// ============================================================================

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (relative) => readFileSync(join(projectRoot, relative), "utf8");

test("ChordPro workspace: every id used by chordProEditor.js exists in index.html", () => {
   const ids = new Set([...readProjectFile("index.html").matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
   const used = [...readProjectFile("src/chordProEditor.js").matchAll(/\$\("#([A-Za-z0-9_-]+)"/g)].map((match) => match[1]);
   assert.ok(used.length >= 8, `expected several lookups, found ${used.length}`);
   for (const id of used) assert.ok(ids.has(id), `#${id} is used by chordProEditor.js but missing from index.html`);
});

test("ChordPro workspace: render.js and events.js look up ids that exist too", () => {
   const ids = new Set([...readProjectFile("index.html").matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
   // Documented pre-existing lookups that are intentionally absent from index.html:
   //   previewHint      legacy guard (replaced by the how-to dialog)
   //   placingLabel     optional, written only when present
   //   projectFileInput / saveBtn  created dynamically by the cloud UI
   const legacyOptional = new Set(["previewHint", "placingLabel", "projectFileInput", "saveBtn"]);
   for (const file of ["src/render.js", "src/events.js", "src/pdfOptions.js"]) {
      const used = [...readProjectFile(file).matchAll(/\$\("#([A-Za-z0-9_-]+)"/g)].map((match) => match[1]);
      for (const id of used) {
         if (legacyOptional.has(id)) continue;
         assert.ok(ids.has(id), `#${id} is used by ${file} but missing from index.html`);
      }
   }
});

test("index.html ships the ChordPro workspace, its stylesheet and the third mode card", () => {
   const html = readProjectFile("index.html");
   assert.match(html, /styles\/chordpro\.css\?v=/);
   assert.match(html, /id="cpWorkspace"/);
   assert.match(html, /id="cpSectionsPreview"/);
   assert.match(html, /id="cpPreviewCard"/);
   assert.match(html, /id="cpPreviewScroll"/);
   assert.match(html, /data-mode="chordpro"/);
   // The grid workspace must still be there — ChordPro is additive, never a replace.
   assert.match(html, /id="sectionsPreview"/);
   assert.match(html, /id="previewCard"/);
   assert.match(html, /id="previewViewport"/);
});

test("service worker precaches every new ChordPro asset", () => {
   const sw = readProjectFile("sw.js");
   for (const asset of ["./styles/chordpro.css", "./src/chordPro.js", "./src/chordProEditor.js"]) {
      assert.ok(sw.includes(asset), `${asset} is missing from CORE_ASSETS`);
   }
});

test("every relative ES module import resolves to a file on disk", () => {
   const files = readdirSync(join(projectRoot, "src")).filter((name) => name.endsWith(".js"));
   for (const file of files) {
      for (const match of readProjectFile(`src/${file}`).matchAll(/from "(\.\/[^"?]+\.js)/g)) {
         const target = match[1].replace("./", "");
         assert.ok(files.includes(target), `src/${file} imports ${match[1]}, which does not exist`);
      }
   }
});

test("every asset version query matches the service worker's ASSET_VERSION", () => {
   const version = readProjectFile("sw.js").match(/const ASSET_VERSION = "([^"]+)"/)?.[1];
   assert.ok(version, "ASSET_VERSION not found in sw.js");
   const files = ["index.html", ...readdirSync(join(projectRoot, "src")).map((name) => `src/${name}`)];
   const mismatches = [];
   for (const file of files) {
      for (const match of readProjectFile(file).matchAll(/\?v=([A-Za-z0-9._-]+)/g)) {
         if (match[1] !== version) mismatches.push(`${file} → ${match[1]}`);
      }
   }
   assert.deepEqual(mismatches, [], `cache-buster drift vs ASSET_VERSION ${version}`);
});

test("chordpro.css keeps the two original modes untouched (no grid selectors, all cp- or gated)", () => {
   // Comments are stripped first: the file *documents* the names it must avoid.
   const css = readProjectFile("styles/chordpro.css").replace(/\/\*[\s\S]*?\*\//g, "");
   // Nothing may restyle the grid score: those class names belong to ui.css/preview.css.
   for (const forbidden of [".preview-card", ".preview-section", ".bar-grid", ".placed-chord", ".lyric-input", ".section-tools"]) {
      assert.ok(!css.includes(forbidden), `chordpro.css must not style ${forbidden}`);
   }
   // Every selector line must be cp-prefixed, gated to ChordPro mode, or one of the
   // documented shared selectors below:
   //   • .mode-picker-card / .mode-picker-grid — the New Song dialog now shows three
   //     cards, which needs a wider dialog + a 3-column grid (layout only; the two
   //     original cards keep their own styling in ui.css);
   //   • .song-card.is-chordpro — the gold library card;
   //   • :root — declares ONLY the --chordpro-css-version marker variable.
   const allowedShared = [".mode-picker-card", ".mode-picker-grid", ".song-card.is-chordpro", ":root"];
   const offenders = css
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith("{") && !line.startsWith("@") && !line.startsWith("/*"))
      .filter((line) => !/^[\d.]+%\s*\{$/.test(line))
      .filter(
         (line) =>
            !line.includes("cp-") &&
            !line.includes("cpPreviewCard") &&
            !line.includes("is-print-layout") &&
            !line.includes("chordpro") &&
            !line.includes("prefers-reduced-motion") &&
            !allowedShared.some((selector) => line.includes(selector)),
      );
   assert.deepEqual(offenders, [], "ungated selectors found in chordpro.css");
});

test("the ChordPro mode card is a normal card (no full-width span)", () => {
   const css = readProjectFile("styles/chordpro.css");
   assert.ok(!css.includes("grid-column: 1 / -1"), "the mode card must not span the whole grid");
   assert.ok(!css.includes("grid-column: 1/-1"));
   // Three equal cards in one row on wide screens.
   assert.match(css, /\.mode-picker-grid\s*\{[^}]*repeat\(3, 1fr\)/);
});

test("the ChordPro library card uses the dark-gold accent", () => {
   const css = readProjectFile("styles/chordpro.css");
   assert.match(css, /\.song-card\.is-chordpro\s*\{[^}]*background:\s*#fbf3df/);
   assert.match(css, /\.song-card\.is-chordpro \.song-card-mode-mark\s*\{[^}]*color:\s*#8a6a10/);
   assert.match(css, /html\[data-theme="dark"\] \.song-card\.is-chordpro\s*\{[^}]*background:\s*#2a2415/);
});

test("the ChordPro editor has no chord palette / drag-and-drop UI", () => {
   const html = readProjectFile("index.html");
   const source = readProjectFile("src/chordProEditor.js");
   for (const gone of ["cp-palette", "cpRootPicker", "cpChordBank", "cp-snippet"]) {
      assert.ok(!html.includes(gone), `index.html still contains ${gone}`);
      assert.ok(!source.includes(gone), `chordProEditor.js still references ${gone}`);
   }
   // The palette CSS must be gone too.
   const css = readProjectFile("styles/chordpro.css");
   for (const gone of [".cp-palette", ".cp-root", ".cp-chord-btn", ".cp-snippet"]) {
      assert.ok(!css.includes(gone), `chordpro.css still styles ${gone}`);
   }
});

test("ChordPro mode takes the beat-grid workspace out of the page", () => {
   // The structural swap lives INLINE in index.html (not in chordpro.css alone):
   // preview.css sets `.ribbon-workspace { display: block }` and styles.css
   // re-declares `.workspace { display: block }` for print, so a stylesheet that
   // 404s or is served stale would otherwise leave BOTH workspaces on screen.
   const html = readProjectFile("index.html");
   const gate = html.match(/body\[data-editor-mode="chordpro"\] \.ribbon-workspace[^{]*\{([^}]*)\}/);
   assert.ok(gate, "the beat-grid workspace must be gated to ChordPro mode inline in index.html");
   assert.match(gate[1], /display:\s*none\s*!important/, "the grid workspace gate needs !important");
   // The chord-chart LIVE PREVIEW is a SIBLING of .ribbon-workspace inside <main>, so
   // gating only .ribbon-workspace leaves the grid score visible in ChordPro mode.
   assert.match(html, /body\[data-editor-mode="chordpro"\] \.preview-stage/);
   assert.match(html, /body\[data-editor-mode="chordpro"\] main > \.preview-stage/);
   // The side-by-side split must be inline too, so the layout survives a missing CSS.
   assert.match(html, /body\[data-editor-mode="chordpro"\] \.cp-workspace\s*\{[^}]*display:\s*grid/);
   assert.match(html, /\.cp-workspace\s*\{\s*display:\s*none/);
   // JS half: the swap is ALSO applied with inline styles, so it can never depend on
   // the stylesheet being present/fresh, plus hidden/aria-hidden (restored for the
   // other two modes).
   const render = readProjectFile("src/render.js");
   assert.match(render, /const chordproMode = mode === "chordpro"/);
   assert.match(render, /gridParts = \[document\.querySelector\("main > \.ribbon-workspace"\), document\.querySelector\("main > \.preview-stage"\)\]/);
   assert.match(render, /part\.style\.display = chordproMode \? "none" : ""/);
   assert.match(render, /cpWorkspace\.style\.display = chordproMode \? "grid" : "none"/);
   assert.match(render, /part\.hidden = chordproMode/);
   assert.match(render, /part\.setAttribute\("aria-hidden", "true"\)/);
   assert.match(render, /part\.removeAttribute\("aria-hidden"\)/);
   // A missing/stale stylesheet is surfaced instead of silently rendering unstyled.
   assert.match(render, /warnIfChordProCssMissing/);
});

test("the stylesheet version marker matches render.js and sw.js ASSET_VERSION", () => {
   // The marker is how a STALE stylesheet (service worker / HTTP cache) becomes
   // visible instead of silently rendering the page with old rules — so all three
   // copies must be bumped together.
   const cssVersion = readProjectFile("styles/chordpro.css").match(/--chordpro-css-version:\s*([^\s;]+)/)?.[1];
   const jsVersion = readProjectFile("src/render.js").match(/CHORDPRO_CSS_VERSION = "([^"]+)"/)?.[1];
   const swVersion = readProjectFile("sw.js").match(/const ASSET_VERSION = "([^"]+)"/)?.[1];
   assert.ok(cssVersion, "--chordpro-css-version is missing from chordpro.css");
   assert.ok(jsVersion, "CHORDPRO_CSS_VERSION is missing from render.js");
   assert.equal(cssVersion, jsVersion, "chordpro.css and render.js version markers must match");
   assert.equal(cssVersion, swVersion, "chordpro.css and sw.js ASSET_VERSION must match");
});

// ---- Deploy hygiene: a new deploy must never be masked by a cache ----

test("the build stamp matches the service worker's ASSET_VERSION", () => {
   // index.html uses the stamp to decide "this deploy is newer than what I
   // cached". If the two ever drift, returning visitors keep the previous
   // deploy's CSS/JS — exactly the "weird PDF after deploy" class of bug.
   const stamp = readProjectFile("index.html").match(/window\.__WNS_BUILD__ = "([^"]+)"/)?.[1];
   const version = readProjectFile("sw.js").match(/const ASSET_VERSION = "([^"]+)"/)?.[1];
   assert.ok(stamp, "window.__WNS_BUILD__ is missing from index.html");
   assert.equal(stamp, version, "index.html build stamp and sw.js ASSET_VERSION must match");
   // One token drives BOTH version strings in sw.js: CACHE_VERSION embeds
   // ASSET_VERSION, so the workflow's single replacement renames the cache
   // (activate then deletes the previous deploy's cache) AND busts every ?v= URL.
   const cache = readProjectFile("sw.js").match(/const CACHE_VERSION = "([^"]+)"/)?.[1];
   assert.ok(cache, "CACHE_VERSION is missing from sw.js");
   assert.ok(cache.includes(version), `CACHE_VERSION (${cache}) must embed ASSET_VERSION (${version})`);
});

test(
   "the deploy workflow injects ONE build version into the staged site",
   // Skipped when this suite runs against the staged artifact, which has no CI
   // metadata (the workflow itself runs the suite there to verify the injection).
   { skip: !existsSync(join(projectRoot, ".github/workflows/deploy.yml")) },
   () => {
      const workflow = readProjectFile(".github/workflows/deploy.yml");
      assert.match(workflow, /branches: \[master\]/, "deploys on push to master");
      assert.match(workflow, /run: node --test tests\/unit\.test\.mjs/, "unit tests are a deploy gate");
      assert.match(
         workflow,
         /VERSION="r\$\{GITHUB_RUN_NUMBER\}-\$\{GITHUB_SHA:0:7\}"/,
         "the build id is r<run_number>-<short sha>",
      );
      assert.match(workflow, /sed -i "s\|__BUILD__\|\$\{VERSION\}\|g"/, "the placeholder is replaced in one pass");
      assert.match(workflow, /grep -rq '__BUILD__' _site/, "a leftover placeholder fails the deploy");
      assert.match(workflow, /path: _site/, "only the stamped copy is deployed");
   },
);

test("a new deploy purges every cache and reloads the page once", () => {
   const html = readProjectFile("index.html");
   // Purge + worker-update wiring.
   assert.match(html, /const keys = await caches\.keys\(\);/);
   assert.match(html, /caches\.delete\(key\)/);
   assert.match(html, /getRegistrations\(\)/);
   assert.match(html, /register\("sw\.js", \{ updateViaCache: "none" \}\)/);
   assert.match(html, /addEventListener\("controllerchange"/);
   // The stamp comparison is what triggers the purge on a returning visit.
   assert.match(html, /const lastBuild = read\(localStorage, STAMP_KEY\);/);
   assert.match(html, /if \(lastBuild !== BUILD\) \{/);
   // Manual escape hatch + the harness opt-out that keeps ?test= cache-free.
   assert.match(html, /params\.has\("reset"\) \|\| params\.has\("fresh"\)/);
   assert.match(html, /if \(params\.has\("test"\)\) return;/);
   // Cache Storage is origin-wide (all GitHub Pages projects share one origin),
   // so the page purge AND the worker's activate purge must be prefix-scoped.
   assert.match(html, /const CACHE_PREFIX = "wns-shell-";/);
   assert.match(readProjectFile("sw.js"), /const CACHE_PREFIX = "wns-shell-";/);
   assert.match(readProjectFile("sw.js"), /k\.startsWith\(CACHE_PREFIX\) && k !== CACHE_VERSION/);
});

test("the service worker revalidates the shell instead of serving a stale copy", () => {
   const sw = readProjectFile("sw.js");
   // Un-versioned entry points (no ?v=) are network-first, by pathname so the
   // GitHub Pages subpath and a local server behave the same.
   assert.match(
      sw,
      /const NETWORK_FIRST_PATHS = \["\/", "\/index\.html", "\/styles\/styles\.css", "\/manifest\.webmanifest"\];/,
   );
   assert.match(
      sw,
      /const networkFirst =[\s\S]{0,30}?request\.mode === "navigate" \|\| NETWORK_FIRST_PATHS\.some\(\(path\) => url\.pathname\.endsWith\(path\)\);/,
   );
   // Every network read revalidates the browser's HTTP cache (GitHub Pages sends
   // max-age=600, so a plain fetch() could return a pre-deploy file).
   assert.match(sw, /new Request\(request, \{ cache: "no-cache" \}\)/);
   // Online reads of a versioned asset must be EXACT matches: the old
   // `cache.match(request) || cache.match(request, { ignoreSearch: true })` made
   // a new ?v= resolve to the previous deploy's file for one extra load.
   assert.match(sw, /const cached = await cache\.match\(request\);/);
   assert.ok(
      !/const cached = \(await cache\.match\(request\)\) \|\|/.test(sw),
      "the online asset lookup must not fall back to ignoreSearch",
   );
   const ignoreUses = sw.match(/ignoreSearch: true/g) || [];
   assert.equal(ignoreUses.length, 2, "ignoreSearch must survive ONLY as the two offline fallbacks");
   assert.match(sw, /if \(fresh\) return fresh;[\s\S]{0,200}?ignoreSearch: true/);
});

test("bar-selection chrome can never print as a green box in the PDF", () => {
   const css = readProjectFile("styles/ui.css");
   // The multi-bar selection ring/tint (#1f9d55) and its ✓ badge are editor-only
   // affordances; both the real print job and the on-screen PDF-layout preview
   // must neutralise them.
   assert.match(css, /\.bar\.is-selected,[\s\S]{0,300}?outline: 0 !important/);
   assert.match(css, /html\.is-print-layout \.bar\.is-selected,[\s\S]{0,400}?outline: 0 !important/);
   assert.match(
      css,
      /\.preview-section\.is-selecting \.bar\.is-selected::after \{[\s\S]{0,60}?content: none !important/,
   );
   // ...and the export flow clears the selection as well (belt and braces).
   const events = readProjectFile("src/events.js");
   assert.match(events, /beforeprint[\s\S]{0,200}?cancelBarSelection\(\)/);
   assert.match(
      events,
      /onExport: \(\) => \{[\s\S]{0,500}?cancelBarSelection\(\);[\s\S]{0,200}?exportToPdf\(/,
   );
});

// ---- ChordPro polish (defaults, footer, print parity with Chord Chart) ----

test("ChordPro starts with Intro + Verse sample sections", () => {
   const source = readProjectFile("src/cloudUI.js");
   assert.match(source, /const CHORDPRO_INTRO_STARTER = "\[C\] \[Am7\] \[Dm7\] \[G7\] \[Cmaj7\]"/);
   assert.match(source, /const CHORDPRO_VERSE_STARTER = "\[C\]Type your lyric here/);
   assert.match(source, /\{ name: "Intro", chordPro: CHORDPRO_INTRO_STARTER \}/);
   assert.match(source, /\{ name: "Verse", chordPro: CHORDPRO_VERSE_STARTER \}/);
   assert.ok(!source.includes('name: "Verse 1"'), "the starter sections must be Intro + Verse");
});

test("a chord-only run keeps the typed gap instead of collapsing", () => {
   // "[C] [Am7] [Dm7]" used to render as "CAm7Dm7" because the spaces between the
   // brackets were dropped by the parser.
   assert.deepEqual(parseChordProLine("[C] [Am7] [Dm7]"), [
      { chord: "C", text: " " },
      { chord: "Am7", text: " " },
      { chord: "Dm7", text: "" },
   ]);
   const html = chordProSectionHTML({ id: "s1", name: "Intro", chordPro: "[C] [Am7] [Dm7]" });
   assert.equal((html.match(/is-chord-only/g) || []).length, 3, "every chord-only word must be flagged");
   assert.match(readProjectFile("styles/chordpro.css"), /\.cp-word\.is-chord-only \{[^}]*padding-right: 0\.5em/);
});

test("ChordPro PDF fonts scale up from the shared print tokens", () => {
   const css = readProjectFile("styles/chordpro.css");
   // Bigger defaults, still driven by the PDF-options tokens so the sliders work.
   assert.match(css, /--cp-chord-size: calc\(var\(--print-chord-size, 4\.3mm\) \* 1\.25\)/);
   assert.match(css, /--cp-lyric-size: calc\(var\(--print-lyric-size, 3\.2mm\) \* 1\.35\)/);
   assert.match(css, /\.cp-chord \{[^}]*font-size: var\(--cp-chord-size/);
   assert.match(css, /\.cp-lyric \{[^}]*font-size: var\(--cp-lyric-size/);
});

test("ChordPro print geometry matches the Chord Chart export", () => {
   const css = readProjectFile("styles/chordpro.css");
   // Same content box as the grid card (see the measurement comment in the file).
   assert.match(css, /html\.is-print-layout \.cp-card \{[^}]*padding: 18px 16px 28px/);
   assert.match(css, /html\.is-print-layout \.cp-card-title \{[^}]*margin: 5px 0 4px/);
   assert.match(css, /html\.is-print-layout \.cp-card-rule \{[^}]*margin: 5px 0 22px/);
   // KEY + TIME SIGNATURE side by side, 10mm in from the right edge, like .song-meta.
   assert.match(css, /html\.is-print-layout \.cp-card-meta[^{]*\{[^}]*flex-direction: row/);
   assert.match(css, /html\.is-print-layout \.cp-card-meta[^{]*\{[^}]*gap: 16px/);
   assert.match(css, /html\.is-print-layout \.cp-card-meta[^{]*\{[^}]*margin-right: 10mm/);
   assert.match(css, /html\.is-print-layout \.cp-card-meta b[^{]*\{[^}]*font-size: 17px/);
   // Section name uses the grid's boxed label look.
   assert.match(css, /html\.is-print-layout \.cp-section-name \{[^}]*border: 1px solid #000/);
   assert.match(readProjectFile("index.html"), /TIME SIGNATURE/);
});

test("the ChordPro editor footer stays a compact single row", () => {
   const css = readProjectFile("styles/chordpro.css");
   assert.match(css, /\.cp-editor-foot \{[^}]*flex-direction: row/);
   assert.match(css, /\.cp-editor-foot \.cp-text-btn\.is-strong \{[^}]*flex: none/);
});

// ---- New Song dialog head, bigger mode-card visual, LIVE PREVIEW label ----

test("the New Song dialog uses the shared icon-left / text-right head", () => {
   const html = readProjectFile("index.html");
   // Anchored right after this dialog's close button so the match can't drift to
   // one of the version dialogs (which share the same .vd-dialog-head classes).
   const head = html.match(/id="newSongClose"[\s\S]*?<div class="vd-dialog-head">([\s\S]*?)<\/div>\s*<\/div>/);
   assert.ok(head, "the mode picker must use the .vd-dialog-head layout");
   assert.match(head[1], /class="confirm-dialog-icon"/);
   assert.match(head[1], /class="vd-dialog-head-text"/);
   assert.match(head[1], /id="newSongTitle"/);
   assert.match(head[1], /id="newSongDesc"/);
   // Icon first (left), text column second (right).
   assert.ok(head[1].indexOf('class="confirm-dialog-icon"') < head[1].indexOf('class="vd-dialog-head-text"'));
   // The flat (icon above title) variant must be gone.
   assert.ok(!/id="newSongClose"[\s\S]{0,200}<h2/.test(html), "title must sit inside the head text column");
});

test("the ChordPro mode-card visual is large enough to read", () => {
   const css = readProjectFile("styles/chordpro.css");
   assert.match(css, /\.cp-mca-chord \{[^}]*font-size: 22px/);
   assert.match(css, /\.cp-mca-word \{[^}]*font-size: 16px/);
   assert.match(css, /\.cp-mode-anim \{[^}]*gap: 0 12px/);
});

test("the in-app help dialog documents the ChordPro mode", () => {
   const html = readProjectFile("index.html");
   const dialog = html.match(/id="howToDialog"[\s\S]*?<\/ul>/);
   assert.ok(dialog, "the help dialog must exist");
   assert.match(dialog[0], /ChordPro, step by step/);
   // The two starter sections are quoted verbatim so the help matches the code.
   assert.match(dialog[0], /\[C\] \[Am7\] \[Dm7\] \[G7\] \[Cmaj7\]/);
   assert.match(dialog[0], /Type your lyric here/);
   assert.match(dialog[0], /\{sov\}/);
   assert.match(dialog[0], /\{c: play softly\}/);
});

test("the README documents the ChordPro mode and its starters", () => {
   const readme = readProjectFile("README.md");
   assert.match(readme, /### ChordPro mode/);
   assert.match(readme, /Starting a ChordPro song/);
   assert.match(readme, /\[C\] \[Am7\] \[Dm7\] \[G7\] \[Cmaj7\]/);
   assert.match(readme, /Adjacent chords stay readable/);
   assert.match(readme, /Print parity/);
});

test("the LIVE PREVIEW bar is bold, larger and aligned with the preview card", () => {
   const css = readProjectFile("styles/chordpro.css");
   assert.match(css, /\.cp-stage-title \{[^}]*font-size: 13px[^}]*font-weight: 800/);
   assert.match(css, /\.cp-stage-hint \{[^}]*font-size: 12\.5px[^}]*font-weight: 700/);
   // The bar lives in the card's column and lines up with the card's content edge.
   assert.match(css, /\.cp-stage-bar \{[^}]*max-width: 210mm[^}]*margin: 0 auto[^}]*padding: 0 2px 0 var\(--cp-card-pad-x/);
   assert.match(css, /\.cp-stage \{[^}]*--cp-card-pad-x: 10mm/);
   assert.match(css, /\.cp-card \{[\s\S]*?padding: var\(--cp-card-pad-y, 12mm\) var\(--cp-card-pad-x, 10mm\)/);
});

