// playback.js — chord/number → frequency resolver + Web Audio playback engine.
//
// Design rules (agreed 2026-08-24):
//  • Letter chords (A–G) → play as CHORD (block harmony, multiple notes).
//  • Nashville numbers (1–7) → play as SINGLE NOTE (melodic, Do-Re-Mi).
//  • Nashville octave markers: 1̇ = +1 octave, 1̣ = -1 octave, plain = middle.
//  • Empty beats (·) → metronome click (toggleable).
//  • One-shot playback (no loop), stop at end.
//  • Supports both Synthesis (instant) and SoundFont (real samples) modes.

import { notePitches, isNashvilleChord, beatValue, durationMeta } from "./notation.js?v=20260904-marginnarrow4";
import { getState } from "./store.js?v=20260904-marginnarrow4";
import { initAudioContext, closeAudioContext, playSoundFontChord, checkSoundFontSize, downloadSoundFont, getDownloadState, askForDownload, loadSamplesFromCache } from "./synth.js?v=20260904-marginnarrow4";

// ---- Chord quality → semitone intervals (from root) ----
const QUALITY_INTERVALS = {
   "": [0, 4, 7], // major triad
   m: [0, 3, 7], // minor triad
   7: [0, 4, 7, 10], // dominant 7th
   maj7: [0, 4, 7, 11], // major 7th
   m7: [0, 3, 7, 10], // minor 7th
   sus2: [0, 2, 7], // sus2
   sus4: [0, 5, 7], // sus4
   "°": [0, 3, 6], // diminished
   "+": [0, 4, 8], // augmented
   ø7: [0, 3, 6, 10], // half-diminished
   add9: [0, 4, 7, 2], // add9
   6: [0, 4, 7, 9], // major 6th
   m6: [0, 3, 7, 9], // minor 6th
   9: [0, 4, 7, 10, 2], // dominant 9th
   m9: [0, 3, 7, 10, 2], // minor 9th
   13: [0, 4, 7, 10, 14], // dominant 13th
   "7b9": [0, 4, 7, 10, 1], // 7 flat 9
};

// Nashville number → scale degree (0-indexed semitone offset from key root).
// Major scale: 1=0, 2=2, 3=4, 4=5, 5=7, 6=9, 7=11
const NASHVILLE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

// MIDI note number → frequency (A4 = 440 Hz = MIDI 69).
const MIDI_TO_FREQ = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// Base octave: Nashville number root sits at octave 4 (C4 = MIDI 60).
const BASE_OCTAVE = 4;
// Letter chord voicing (experiment): a low bass note (C2 = MIDI 36) with the
// triad at the middle octave (C4 = MIDI 60), i.e. C → C2 + C4-E4-G4.
const CHORD_OCTAVE = 4;
const CHORD_BASS_OCTAVE = 2;
const MIDI_C0 = 12; // MIDI note 0 = C-1, so C0 = 12

// ---- Parsing helpers ----

/**
 * Parse a letter chord (e.g. "Am", "F♯m7", "G/B") into root pitch class + quality.
 * Returns { rootPitch: 0-11, quality: string, bassPitch: 0-11|null } or null.
 */
function parseLetterChord(chord) {
   const slashMatch = chord.match(/^(.*)\/([A-G](?:[#♯b♭])?)$/);
   const main = slashMatch ? slashMatch[1] : chord;
   const bass = slashMatch ? slashMatch[2] : null;

   const rootMatch = main.match(/^([A-G])([#♯b♭]?)(.*)$/);
   if (!rootMatch) return null;

   const root = `${rootMatch[1]}${rootMatch[2]}`;
   const rootPitch = notePitches[root];
   if (rootPitch === undefined) return null;

   const quality = rootMatch[3] || "";
   const bassPitch = bass ? notePitches[bass] : null;

   return { rootPitch, quality, bassPitch };
}

/**
 * Parse a Nashville number (e.g. "1", "2m", "1̇", "2̣") into
 * { degree: 0-6, accidental: -1|0|1, octaveShift: -1|0|1 } or null.
 */
function parseNashville(chord) {
   const match = chord.match(/^([♭#]?)([0-7])([̣̇]?)(.*)$/u);
   if (!match) return null;

   const accidental = match[1] === "♭" ? -1 : match[1] === "#" ? 1 : 0;
   const degree = Number(match[2]) - 1;
   if (degree < 0 || degree > 6) return null;

   const dot = match[3];
   const octaveShift = dot === "\u0307" ? 1 : dot === "\u0323" ? -1 : 0;

   return { degree, accidental, octaveShift };
}

/**
 * Resolve a chord string into an array of MIDI note numbers.
 *
 * - Letter chord → low bass + middle-voiced triad (root + quality intervals).
 * - Nashville number → single note (root only, ignore quality).
 *
 * @param {string} chord  The chord/number string from section.beats[slot].chord
 * @param {string} songKey The current song key (e.g. "C", "D♭", "A")
 * @returns {number[]}    Array of MIDI note numbers (may be empty if unresolvable)
 */
export function chordToMidiNotes(chord, songKey) {
   if (!chord) return [];

   // Nashville number → single note (melodic)
   if (isNashvilleChord(chord)) {
      const parsed = parseNashville(chord);
      if (!parsed) return [];

      const keyPitch = notePitches[songKey] ?? 0;
      const semitoneOffset = NASHVILLE_SEMITONES[parsed.degree] + parsed.accidental;
      const pitchClass = (keyPitch + semitoneOffset + 12) % 12;
      const midiNote = MIDI_C0 + pitchClass + (BASE_OCTAVE + parsed.octaveShift) * 12;

      return [midiNote];
   }

   // Letter chord → chord (block harmony), voiced low-mid:
   // a low bass note (root or slash bass) plus the triad one octave above.
   const parsed = parseLetterChord(chord);
   if (!parsed) return [];

   const intervals = QUALITY_INTERVALS[parsed.quality] ?? QUALITY_INTERVALS[""];
   const rootMidi = MIDI_C0 + parsed.rootPitch + CHORD_OCTAVE * 12;
   const notes = intervals.map((interval) => rootMidi + interval);

   // Low bass: use the slash bass when present, otherwise double the root one
   // octave below, so chords sit comfortably in the low-mid register.
   notes.unshift(
      parsed.bassPitch !== null
         ? MIDI_C0 + parsed.bassPitch + CHORD_BASS_OCTAVE * 12
         : MIDI_C0 + parsed.rootPitch + CHORD_BASS_OCTAVE * 12,
   );

   return notes;
}

/**
 * Convenience: resolve chord → array of frequencies in Hz.
 */
export function chordToFrequencies(chord, songKey) {
   return chordToMidiNotes(chord, songKey).map(MIDI_TO_FREQ);
}

// ---- Web Audio playback engine ----

let audioCtx = null;
let isPlaying = false;
let schedulerTimer = null;
let currentBeatIndex = 0;
let playbackQueue = []; // [{ slot, sectionId, chord, beatUnit }]
let nextNoteTime = 0;
let onBeatCallback = null; // called with { slot, sectionId } for visual highlight
let onEndCallback = null; // called when playback stops (incl. natural completion)
let metronomeEnabled = true;
let useSynthesis = true; // Default to synthesis, can override with SoundFont

const lookahead = 25; // ms — scheduler wakeup interval
const scheduleAheadTime = 0.1; // seconds — how far ahead to schedule

/**
 * Flatten the score into a linear timeline of playable beats.
 * Traverses sections → bars → beats → subdivisions (depth-first), collecting
 * every slot that has a chord or is a leaf beat (for metronome click).
 */
function buildPlaybackQueue(sections, beatsPerBar) {
   const queue = [];
   for (const section of sections) {
      for (let bar = 0; bar < section.bars; bar++) {
         for (let beat = 0; beat < beatsPerBar; beat++) {
            const slot = `${bar}-${beat}`;
            collectBeat(section, slot, queue);
         }
      }
   }
   return queue;
}

/**
 * Recursively collect a beat and its subdivisions into the queue.
 * If a beat has a duration (half/triplet/quarter), we MUST split its chord
 * into multiple sub-beat entries with timing info.
 */
function collectBeat(section, slot, queue, level = 0, unit = 1) {
   const value = beatValue(section, slot);

   if (value.duration && durationMeta[value.duration]) {
      // This beat is subdivided — split the parent chord into children
      const count = durationMeta[value.duration].count;
      const childUnit = unit / count; // each child is an even fraction of this slot

      // Slot-key separator for the NEXT level. Matches render.js/events.js:
      //   level 0→1 uses ":" (e.g. "0-0:0"), level 1→2 uses "." (e.g. "0-0:0.0").
      const sep = level === 0 ? ":" : ".";

      for (let i = 0; i < count; i++) {
         const subSlot = `${slot}${sep}${i}`;
         const subValue = beatValue(section, subSlot);

         // Nested subdivision (only "half" can nest per editor rules) → recurse,
         // passing the reduced time-unit so deep nesting keeps correct duration.
         if (subValue.duration && durationMeta[subValue.duration]) {
            collectBeat(section, subSlot, queue, level + 1, childUnit);
         } else {
            // Use sub-slot chord if exists, otherwise use parent chord
            const chordToPlay = subValue.chord || value.chord || null;
            queue.push({
               slot: subSlot,
               sectionId: section.id,
               chord: chordToPlay,
               beatUnit: childUnit, // fraction of ONE whole beat this entry occupies
            });
         }
      }
   } else {
      // No rhythm marker on this beat - play as one full beat
      queue.push({
         slot,
         sectionId: section.id,
         chord: value.chord,
         beatUnit: unit, // fraction of ONE whole beat (1 for a plain beat)
      });
   }
}

/**
 * Schedule a single note (or chord) at an absolute audio time.
 * Uses triangle wave for soft organ-like tone with a short envelope.
 */
function scheduleNote(frequencies, time, duration) {
   if (!audioCtx || !frequencies.length) return;
   const gain = audioCtx.createGain();
   gain.connect(audioCtx.destination);

   // Envelope: 20ms attack, hold, 300ms release (longer sustain feel)
   const attack = 0.02;
   const release = 0.3;
   const sustain = Math.max(duration - attack - release, 0.05);

   gain.gain.setValueAtTime(0, time);
   gain.gain.linearRampToValueAtTime(0.15, time + attack);
   gain.gain.setValueAtTime(0.15, time + attack + sustain);
   gain.gain.linearRampToValueAtTime(0, time + attack + sustain + release);

   for (const freq of frequencies) {
      const osc = audioCtx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(time);
      osc.stop(time + attack + sustain + release + 0.01);
   }
}

/**
 * Schedule a metronome click (short blip) for empty beats.
 */
function scheduleClick(time) {
   if (!audioCtx) return;
   const osc = audioCtx.createOscillator();
   const gain = audioCtx.createGain();
   osc.type = "square";
   osc.frequency.value = 1000;
   osc.connect(gain);
   gain.connect(audioCtx.destination);
   gain.gain.setValueAtTime(0, time);
   gain.gain.linearRampToValueAtTime(0.06, time + 0.001);
   gain.gain.linearRampToValueAtTime(0, time + 0.03);
   osc.start(time);
   osc.stop(time + 0.04);
}

/**
 * The scheduler loop: runs every `lookahead` ms, scheduling notes that fall
 * within the next `scheduleAheadTime` window. Calculates correct timing based on beat duration.
 */
function scheduler() {
   while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
      if (currentBeatIndex >= playbackQueue.length) {
         stopPlayback();
         return;
      }
      const beat = playbackQueue[currentBeatIndex];
      const bpm = getState().bpm || 120;
      
      // Duration = fraction of ONE whole beat (beatUnit), regardless of nesting depth.
      const mainBeatDuration = 60 / bpm;
      const subBeatDuration = (beat.beatUnit ?? 1) * mainBeatDuration;

      if (beat.chord) {
         const freqs = chordToFrequencies(beat.chord, getState().key);
         scheduleNote(freqs, nextNoteTime, subBeatDuration * 0.9);
      } else if (metronomeEnabled) {
         scheduleClick(nextNoteTime);
      }

      // Schedule visual highlight callback
      const highlightTime = nextNoteTime - audioCtx.currentTime;
      const beatInfo = { slot: beat.slot, sectionId: beat.sectionId };
      setTimeout(
         () => {
            if (isPlaying && onBeatCallback) onBeatCallback(beatInfo);
         },
         Math.max(highlightTime * 1000, 0),
      );

      // Advance time by ONE sub-beat, not one whole beat
      nextNoteTime += subBeatDuration;
      currentBeatIndex++;
   }
   schedulerTimer = setTimeout(scheduler, lookahead);
}

/**
 * Scheduler loop for SoundFont sample playback (lazy-loaded piano samples).
 * Schedules notes immediately instead of buffering, perfect for real-time playback.
 */
function schedulerWithSamples() {
   while (currentBeatIndex < playbackQueue.length && audioCtx.currentTime + scheduleAheadTime > nextNoteTime) {
      if (currentBeatIndex >= playbackQueue.length) {
         stopPlayback();
         return;
      }
      
      const beat = playbackQueue[currentBeatIndex];
      const bpm = getState().bpm || 120;
      const subBeatDuration = (beat.beatUnit ?? 1) * (60 / bpm);
      
      if (beat.chord) {
         // Play chord using SoundFont samples, scheduled at the SWING time so
         // notes stay in sync with the metronome/BPM (previously ignored time).
         const freqs = chordToFrequencies(beat.chord, getState().key);
         playSoundFontChord(freqs, {
            time: nextNoteTime,
            duration: subBeatDuration,
         });
      } else if (metronomeEnabled) {
         // Still use synthesis click for metronome (too small to load sample for each click)
         scheduleClick(nextNoteTime);
      }
      
      // Schedule visual highlight callback
      const highlightTime = nextNoteTime - audioCtx.currentTime;
      const beatInfo = { slot: beat.slot, sectionId: beat.sectionId };
      setTimeout(
         () => {
            if (isPlaying && onBeatCallback) onBeatCallback(beatInfo);
         },
         Math.max(highlightTime * 1000, 0),
      );
      
      // Advance time by ONE sub-beat (note: subBeatDuration computed above)
      
      nextNoteTime += subBeatDuration;
      currentBeatIndex++;
   }
   
   // Check if we're done
   if (currentBeatIndex >= playbackQueue.length) {
      stopPlayback();
   } else {
      schedulerTimer = setTimeout(schedulerWithSamples, lookahead);
   }
}

/**
 * Start playback from the beginning of the score.
 * @param {object} opts
 * @param {(beat: {slot: string, sectionId: string}) => void} [opts.onBeat]
 *        Called ~when each beat plays, for visual highlighting.
 * @param {boolean} [opts.metronome=true] Whether metronome click is enabled.
 * @param {Function} [opts.onProgress] Optional callback: (percent: number, loaded: string, total: string) => void
 *        Used to update UI download progress bar during SoundFont loading.
 * @param {Function} [opts.onEnd] Optional callback called once playback stops
 *        (including when it finishes naturally or is stopped manually).
 */
export async function startPlayback({ onBeat, metronome = true, onProgress, onEnd } = {}) {
   if (isPlaying) return;
   
   // Initialize AudioContext first. Assign the returned shared context so the
   // scheduler below can use it (a context created here is not otherwise reachable).
   try {
      audioCtx = initAudioContext();
   } catch (err) {
      console.error('Failed to initialize AudioContext:', err);
      return;
   }
   
   const state = getState();
   const [beatsPerBar] = state.meter.split("/").map(Number);
   playbackQueue = buildPlaybackQueue(state.sections, beatsPerBar || 4);
   if (!playbackQueue.length) return;
   
   // Decide how to source the piano samples:
   //  1) Already decoded in memory  → use them (no modal).
   //  2) Cached in IndexedDB        → decode & use them (no modal).
   //  3) Otherwise                  → show download modal.
   const { isReady } = getDownloadState();
   if (isReady) {
      useSynthesis = false;
   } else {
      const restored = await loadSamplesFromCache();
      if (restored) {
         useSynthesis = false;
      } else {
         // Check if we need to load the sample set from the CDN.
         const fileInfo = await checkSoundFontSize();

         // If we can't reach the CDN (or it reports no size), fall back to the
         // built-in synthesizer so playback still works.
         if (!fileInfo || !(fileInfo.totalBytes > 0)) {
            console.warn('Cannot get SoundFont file size, using synthesis fallback');
            useSynthesis = true;
         } else {
            // Ask the user with the custom modal instead of a browser confirm.
            const confirmed = await askForDownload().catch(() => false);

            if (confirmed) {
               try {
                  await downloadSoundFont(
                     (percent, loadedMB, totalMB) => {
                        // Update progress bar in the modal (if present).
                        const progressBar = document.getElementById('modalProgressBar');
                        const progressText = document.getElementById('modalProgressText');
                        const progressSection = document.getElementById('progressSection');

                        if (progressSection) progressSection.style.display = 'block';
                        if (progressBar) progressBar.style.width = `${percent}%`;
                        if (progressText) progressText.textContent = `${percent}% (${loadedMB}MB / ${totalMB}MB)`;

                        // Also forward progress to the caller's callback (optional).
                        if (onProgress) onProgress(percent, loadedMB, totalMB);
                     },
                     (err) => {
                        console.error('Download failed:', err);
                        useSynthesis = true;
                     },
                  );
                  // Sample decoded & cached — use real sample playback.
                  useSynthesis = false;
               } catch (err) {
                  console.error('SoundFont download error:', err);
                  useSynthesis = true;
               }
            } else {
               // User cancelled the download — do NOT start playback.
               console.log('Sample download cancelled; playback not started.');
               return false;
            }
         }
      }
   }
   
   onBeatCallback = onBeat || null;
   onEndCallback = onEnd || null;
   metronomeEnabled = metronome;
   currentBeatIndex = 0;
   nextNoteTime = audioCtx.currentTime + 0.05;
   isPlaying = true;
   
   if (useSynthesis) {
      console.log('Using synthesis fallback');
      scheduler();
   } else {
      console.log('Using SoundFont playback');
      schedulerWithSamples();
   }
   return true;
}

/** Stop playback and clean up audio resources. */
export function stopPlayback() {
   isPlaying = false;
   if (schedulerTimer) {
      clearTimeout(schedulerTimer);
      schedulerTimer = null;
   }
   if (audioCtx) {
      // Close & reset the shared context (owned by synth.js) so the next play
      // creates a fresh context. Our local reference is cleared immediately.
      closeAudioContext();
      audioCtx = null;
   }
   if (onBeatCallback) {
      // Final callback with null to clear highlight
      onBeatCallback(null);
   }
   playbackQueue = [];
   currentBeatIndex = 0;
   // Notify the UI (e.g. reset play/pause button) that playback has stopped,
   // whether that was from natural completion or being stopped manually.
   if (onEndCallback) {
      const cb = onEndCallback;
      onEndCallback = null;
      cb();
   }
}

/** Whether playback is currently active. */
export function getIsPlaying() {
   return isPlaying;
}

// ---- Visual highlight ----

const PLAYING_CLASS = "beat-playing";
let lastHighlighted = null;

/**
 * Highlight the beat element matching { slot, sectionId } in the DOM.
 * Called by the scheduler's onBeat callback. Pass null to clear highlight.
 */
export function highlightBeat(beatInfo) {
   // Clear previous highlight
   if (lastHighlighted) {
      lastHighlighted.classList.remove(PLAYING_CLASS);
      lastHighlighted = null;
   }
   if (!beatInfo) return;

   // Find the beat element: try exact slot match first, then base-slot match.
   // Sub-beats render as .sub-beat with data-slot; top-level beats render as
   // .beat with data-slot.
   const { slot, sectionId } = beatInfo;
   const candidates = document.querySelectorAll(
      `[data-section="${CSS.escape(sectionId)}"][data-slot="${CSS.escape(slot)}"]`,
   );
   for (const el of candidates) {
      if (el.classList.contains("beat") || el.classList.contains("sub-beat")) {
         el.classList.add(PLAYING_CLASS);
         lastHighlighted = el;
         break;
      }
   }
}
