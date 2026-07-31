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
