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
   barHasContent,
   slotBarIndex,
   splitSyllables,
   syllabifyLyrics,
   MAX_BARS,
} from "../src/notation.js";

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
