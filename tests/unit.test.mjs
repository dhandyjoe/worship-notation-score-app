import test from "node:test";
import assert from "node:assert/strict";
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
} from "../src/notation.js";
import { encodeShare, decodeShare, buildShareLink, extractPayloadFromLink, canCompress } from "../src/share.js";

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
