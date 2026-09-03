// synth.js — multi-sample piano engine with lazy-load, progress UI & IndexedDB cache.
//
// Design rules (2026-08-26):
//  • Lazy load on first play: don't download until user clicks "Play"
//  • Multi-sample (Salamander set, sampled in minor thirds) so each note uses a
//    nearby sample with a small playbackRate shift → realistic sound.
//  • Confirm dialog before download: show total size + how many files.
//  • Progress bar during download: real-time % and MB across all files.
//  • Cache in IndexedDB: after first download, samples persist across refreshes.
//  • Source: Salamander Grand Piano V3 (Yamaha C5, Alexander Holm),
//    hosted on tonejs.github.io/audio (CORS-enabled), CC BY 3.0.

let audioCtx = null;
let samples = []; // [{ midi, buffer }] — decoded samples
let samplesReady = false;
let isDownloading = false;

// Shared master-chain nodes (persist for the lifetime of audioCtx).
let masterGain = null;   // final volume before speakers
let reverbNode = null;   // ConvolverNode (no external asset — generated IR)
let reverbWetGain = null;

// ---- Central audio tuning knobs ----
// Adjust these instead of hunting through scheduling/envelope code.
const AUDIO_CONFIG = {
   masterVolume: 0.95, // master gain — protect ears & avoid clipping on chords
   notePeak: 0.9,     // per-note peak gain (× velocity)
   compressorThreshold: -18, // dB
   compressorRatio: 6,
   compressorKnee: 10,       // dB (soft knee)
   compressorAttack: 0.003,
   compressorRelease: 0.25,
   attack: 0.015,     // seconds — fast hammer attack
   release: 1.8,      // seconds — longer tail after the decay (sustain feel)
   minDuration: 2.5,  // seconds — floor so notes sound longer at fast tempos
   reverbLevel: 0.12, // wet/dry mix (0 = fully dry)
   reverbDuration: 1.8, // seconds — synthetic IR length
   reverbDecay: 2.6,     // exponent — higher = shorter tail
};

// Base URL for Salamander Grand Piano V3 (CORS-enabled GitHub Pages).
const SOUNDFONT_BASE =
   "https://tonejs.github.io/audio/salamander/";

// Salamander sample set spanning the full piano range (A0–C8), kept in its
// original minor-third grid. File names use sharp suffixes: Ds, Fs (no flats).
const SAMPLE_NOTES = [
   "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7",
   "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8",
   "Ds1", "Ds2", "Ds3", "Ds4", "Ds5", "Ds6", "Ds7",
   "Fs1", "Fs2", "Fs3", "Fs4", "Fs5", "Fs6", "Fs7",
];

// IndexedDB key prefix for the sample set (bump to force re-download).
export const SAMPLE_CACHE_KEY = "salamander-piano-tonejs-v1";

const PITCH_CLASS = {
   C: 0, Cs: 1, Db: 1, D: 2, Ds: 3, Eb: 3, E: 4, F: 5, Fs: 6, Gb: 6,
   G: 7, Gs: 8, Ab: 8, A: 9, As: 10, Bb: 10, B: 11,
};

/**
 * Convert a sample note name ("C4", "Ds3", "Gb4") to a MIDI note number.
 * Supports both sharp suffixes ("Ds") — used by Salamander — and flat names ("Db").
 */
export function noteNameToMidi(name) {
   const m = String(name).match(/^([A-G]s?b?)([0-9])$/);
   if (!m) return null;
   const pc = PITCH_CLASS[m[1]];
   if (pc === undefined) return null;
   return (Number(m[2]) + 1) * 12 + pc;
}

/** MIDI note number → frequency in Hz (A4 = 440 Hz = MIDI 69). */
const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

const SF = (name) => `${SOUNDFONT_BASE}${name}.mp3`;

// Sample metadata sorted by MIDI (for nearest-match + HEAD sizing).
const SAMPLE_META = SAMPLE_NOTES
   .map((name) => ({ name, midi: noteNameToMidi(name), url: SF(name) }))
   .sort((a, b) => a.midi - b.midi);

/**
 * Check file sizes via HEAD requests for every sample, before asking the user.
 * Returns { totalBytes, totalText, totalMB, count, perFile } or null if failed.
 */
export async function checkSoundFontSize() {
   try {
      const sizes = await Promise.all(
         SAMPLE_META.map(async (meta) => {
            try {
               const res = await fetch(meta.url, { method: "HEAD" });
               const len = parseInt(res.headers.get("content-length"), 10);
               return len > 0 ? len : 0;
            } catch {
               return 0;
            }
         }),
      );

      const totalBytes = sizes.reduce((a, b) => a + b, 0);
      if (!(totalBytes > 0)) return null;

      const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
      const totalKB = (totalBytes / 1024).toFixed(0);
      return {
         url: SOUNDFONT_BASE,
         totalBytes,
         totalMB,
         count: SAMPLE_META.length,
         totalText: totalBytes >= 1048576 ? `${totalMB} MB` : `${totalKB} KB`,
      };
   } catch (err) {
      console.error("Failed to get SoundFont file sizes:", err);
      return null;
   }
}

/**
 * Ask user for confirmation before downloading large sample.
 * Shows confirm dialog with file size info.
 * @returns {Promise<boolean>} True if user confirms, false if cancelled
 */
export async function askForDownload() {
   const fileInfo = await checkSoundFontSize();

   if (!fileInfo || !(fileInfo.totalBytes > 0)) {
      throw new Error("Cannot estimate file size. Please try again.");
   }

   return new Promise((resolve) => {
      // Create modal container
      const overlay = document.createElement("div");
      overlay.id = "soundfont-modal-overlay";
      overlay.className = "download-modal-overlay";

      overlay.innerHTML = `
         <div class="download-modal">
            <div class="download-modal-header">
               <div class="download-icon">🎹</div>
               <h2 class="download-modal-title">Load Piano Samples</h2>
            </div>
            
            <div class="download-modal-content">
               <div class="info-row">
                  <span class="info-label">📦 Size:</span>
                  <span class="info-value">${fileInfo.totalText} (${fileInfo.count} files)</span>
               </div>
               <div class="info-row">
                  <span class="info-label">🎹 Source:</span>
                  <span class="info-value">Salamander Grand Piano V3 (Yamaha C5)</span>
               </div>
               <div class="info-row">
                  <span class="info-label">📜 License:</span>
                  <span class="info-value">
                     CC BY 3.0 —
                     <a href="https://github.com/tonejs/audio" target="_blank" rel="noopener">tonejs/audio — Salamander samples</a>
                  </span>
               </div>
               
               <div id="progressSection" style="display:none;">
                  <div class="progress-container">
                     <div class="progress-bar" id="modalProgressBar"></div>
                  </div>
                  <div class="progress-text" id="modalProgressText">0%</div>
               </div>
            </div>
            
            <div class="download-actions">
               <button id="cancelDownloadBtn" class="download-btn btn-cancel">Cancel</button>
               <button id="confirmDownloadBtn" class="download-btn btn-download">Download & Play</button>
            </div>
         </div>
      `;

      document.body.appendChild(overlay);

      // Handle cancel
      document.getElementById("cancelDownloadBtn").addEventListener("click", () => {
         overlay.remove();
         resolve(false);
      });

      // Handle confirm
      document.getElementById("confirmDownloadBtn").addEventListener("click", () => {
         overlay.remove();
         resolve(true);
      });
   });
}

/**
 * Download all piano samples (multi-file, parallel) with cumulative progress.
 * Decodes each file and stores { midi, buffer }; also saves raw bytes to the
 * IndexedDB cache (via sampleCache) for persistence across refreshes.
 * @param {Function} onProgress Callback: (percent: number, loadedMB: string, totalMB: string) => void
 * @param {Function} [onError] Callback: (error: Error) => void
 */
export async function downloadSoundFont(onProgress, onError) {
   if (isDownloading) {
      throw new Error("Download already in progress");
   }
   isDownloading = true;

   try {
      const fileInfo = await checkSoundFontSize();
      const totalBytes = fileInfo ? fileInfo.totalBytes : 0;
      const ctx = initAudioContext();

      // Cumulative progress across ALL files (single smooth 0→100% bar).
      // Because downloads run in parallel, we accumulate bytes for every chunk
      // from any file into one shared counter, then derive a global percent.
      let accumulatedBytes = 0;
      const reportProgress = (bytesSinceLast) => {
         if (typeof onProgress !== "function") return;
         accumulatedBytes += bytesSinceLast;
         const denom = totalBytes || 1;
         const percent = Math.min(Math.round((accumulatedBytes / denom) * 100), 100);
         const loadedMB = (accumulatedBytes / 1024 / 1024).toFixed(2);
         const totalMB = ((denom) / 1024 / 1024).toFixed(1);
         onProgress(percent, loadedMB, totalMB);
      };

      // Download every file in parallel.
      const tasks = SAMPLE_META.map(async (meta) => {
         try {
            const res = await fetch(meta.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const chunks = [];
            let loaded = 0;
            const reader = res.body.getReader();

            while (true) {
               const { done, value } = await reader.read();
               if (done) break;
               chunks.push(value);
               loaded += value.length;
               reportProgress(value.length);
            }

            return { meta, bytes: new Uint8Array(loaded), chunks };
         } catch (err) {
            return { meta, error: err };
         }
      });

      const results = await Promise.all(tasks);
      const downloaded = [];

      await Promise.all(
         results.map(async ({ meta, bytes, chunks, error }) => {
            if (error || !chunks) return; // skip failed file (tolerant)
            try {
               // Concatenate stream chunks into one contiguous buffer.
               const raw = new Uint8Array(bytes.length);
               let offset = 0;
               for (const chunk of chunks) {
                  raw.set(chunk, offset);
                  offset += chunk.length;
               }
               const buffer = await ctx.decodeAudioData(raw.buffer);
               downloaded.push({ midi: meta.midi, name: meta.name, buffer, raw: raw.buffer });
            } catch (err) {
               console.warn("decode failed for", meta.name, err);
            }
         }),
      );

      if (downloaded.length === 0) {
         throw new Error("Failed to download any sample file.");
      }

      // Keep decoded samples in memory; map by MIDI.
      samples = downloaded.map(({ midi, buffer }) => ({ midi, buffer }));
      samplesReady = true;

      // Persist raw bytes in IndexedDB (best-effort) for future sessions.
      try {
         const { saveSamples } = await import("./sampleCache.js?v=20260826-chordAbove");
         await saveSamples(SAMPLE_CACHE_KEY, downloaded.map(({ name, raw }) => ({ name, raw })));
      } catch (err) {
         console.warn("Sample cache save skipped:", err);
      }

      isDownloading = false;
      return samples;
   } catch (err) {
      isDownloading = false;
      if (typeof onError === "function") onError(err);
      throw err;
   }
}

/**
 * Restore decoded samples from the IndexedDB cache (if present). No-op when the
 * cache is empty/unavailable. Returns true if samples are ready afterwards.
 */
export async function loadSamplesFromCache() {
   if (samplesReady) return true;
   try {
      const { loadSamples } = await import("./sampleCache.js?v=20260826-chordAbove");
      const cached = await loadSamples(SAMPLE_CACHE_KEY);
      if (!cached || !cached.length) return false;

      const ctx = initAudioContext();
      const decoded = [];
      for (const { name, raw } of cached) {
         const midi = noteNameToMidi(name);
         if (midi === null || !raw) continue;
         try {
            const buffer = await ctx.decodeAudioData(raw);
            decoded.push({ midi, buffer });
         } catch (err) {
            console.warn("cache decode failed for", name, err);
         }
      }
      if (decoded.length) {
         samples = decoded;
         samplesReady = true;
         return true;
      }
      return false;
   } catch (err) {
      console.warn("Sample cache load failed:", err);
      return false;
   }
}

/**
 * Initialize AudioContext if not exists and (re)build the shared master chain
 * (compressor → master gain → speakers, plus a synthetic reverb). Must be
 * called after a user gesture (browser policy).
 */
export function initAudioContext() {
   if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
   }

   if (audioCtx.state === "suspended") {
      audioCtx.resume();
   }

   ensureMasterChain();
   return audioCtx;
}

/**
 * Build (once per context) the master output chain that every piano sample
 * feeds into:
 *   note → compressor → masterGain → destination
 *   note → reverb(Convolver) → wetGain → masterGain
 * The compressor keeps polyphonic chords from clipping; the reverb adds space.
 */
function ensureMasterChain() {
   if (masterGain && masterGain.context === audioCtx) return;

   const compressor = audioCtx.createDynamicsCompressor();
   compressor.threshold.value = AUDIO_CONFIG.compressorThreshold;
   compressor.ratio.value = AUDIO_CONFIG.compressorRatio;
   compressor.knee.value = AUDIO_CONFIG.compressorKnee;
   compressor.attack.value = AUDIO_CONFIG.compressorAttack;
   compressor.release.value = AUDIO_CONFIG.compressorRelease;

   masterGain = audioCtx.createGain();
   masterGain.gain.value = AUDIO_CONFIG.masterVolume;

   compressor.connect(masterGain);
   masterGain.connect(audioCtx.destination);

   // Reverb is a point of taste: keep it subtle so chords stay clear.
   if (AUDIO_CONFIG.reverbLevel > 0) {
      reverbNode = audioCtx.createConvolver();
      reverbNode.buffer = generateImpulseResponse(
         AUDIO_CONFIG.reverbDuration,
         AUDIO_CONFIG.reverbDecay,
      );
      reverbWetGain = audioCtx.createGain();
      reverbWetGain.gain.value = AUDIO_CONFIG.reverbLevel;
      reverbNode.connect(reverbWetGain);
      reverbWetGain.connect(masterGain);
   } else {
      reverbNode = null;
      reverbWetGain = null;
   }
}

/**
 * Create a short stereo impulse response from exponentially-decaying noise.
 * This is a lightweight, dependency-free reverb — no .wav asset required.
 */
function generateImpulseResponse(duration, decay) {
   const rate = audioCtx.sampleRate;
   const length = Math.max(1, Math.floor(rate * duration));
   const impulse = audioCtx.createBuffer(2, length, rate);
   for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
         const t = i / length;
         data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
   }
   return impulse;
}

/**
 * Close and release the shared AudioContext (e.g. on playback stop) so a fresh
 * context is created on the next play. Nested use of a closed context throws,
 * so we also null out the reference.
 */
export function closeAudioContext() {
   if (!audioCtx) return;
   const ctx = audioCtx;
   audioCtx = null;
   // Drop master-chain refs so the next play builds a fresh graph.
   masterGain = null;
   reverbNode = null;
   reverbWetGain = null;
   // Give any scheduled notes time to finish before tearing the context down.
   setTimeout(() => {
      try {
         ctx.close();
      } catch (err) {
         console.warn("AudioContext close:", err);
      }
   }, 300);
}

/**
 * Play a chord using piano samples, picking the nearest sample per note and
 * shifting its pitch by a small playbackRate for a realistic result.
 * Handles polyphonic playback of multiple notes simultaneously and feeds every
 * note through the shared master chain (compressor + gain + reverb).
 *
 * @param {number[]} frequencies Array of frequencies in Hz.
 * @param {object}   [opts]
 * @param {number}   [opts.time]     Absolute AudioContext time to start (default: now).
 * @param {number}   [opts.duration] Note sustain in seconds; clamped to a min so
 *                                   notes aren't truncated at fast tempos.
 * @param {number}   [opts.velocity] 0..1 loudness multiplier (default 1).
 */
export function playSoundFontChord(frequencies, opts = {}) {
   if (!audioCtx) {
      throw new Error("AudioContext not initialized. Call initAudioContext() first.");
   }

   if (!samplesReady || !samples.length) {
      throw new Error("SoundFont samples not loaded. Download first.");
   }

   ensureMasterChain();

   const now = audioCtx.currentTime;
   const start = Math.max(opts.time ?? now, now); // never schedule in the past
   const duration = Math.max(opts.duration ?? 0, AUDIO_CONFIG.minDuration);
   const velocity = typeof opts.velocity === "number" ? opts.velocity : 1;

   frequencies.forEach((freq) => {
      const targetMidi = Math.round(69 + 12 * Math.log2(freq / 440));
      const nearest = findNearestSample(targetMidi);
      if (!nearest) return;

      const ratio = freq / midiToFreq(nearest.midi);
      const source = audioCtx.createBufferSource();
      source.buffer = nearest.buffer;
      source.playbackRate.value = Math.min(2, Math.max(0.5, ratio));

      // Natural piano envelope: fast hammer attack → long gentle sustain → soft tail.
      const gain = audioCtx.createGain();
      const peak = AUDIO_CONFIG.notePeak * velocity;

      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + AUDIO_CONFIG.attack);
      // Sustain: keep most of the level until nearly the end of the note, then
      // let it decay gently so notes linger longer (melodic, warm feel).
      const sustainEnd = start + duration * 0.95;
      gain.gain.exponentialRampToValueAtTime(peak * 0.05, sustainEnd);
      gain.gain.setTargetAtTime(0, sustainEnd, AUDIO_CONFIG.release / 4);

      source.connect(gain);

      // Dry → master chain; wet → reverb → master chain.
      gain.connect(masterGain);
      if (reverbNode) gain.connect(reverbNode);

      const stopAt = start + duration + AUDIO_CONFIG.release;
      source.start(start);
      source.stop(stopAt);
   });
}

/** Choose the sample whose MIDI is closest to `midi`. */
function findNearestSample(midi) {
   let best = null;
   let bestDist = Infinity;
   for (const s of samples) {
      const d = Math.abs(s.midi - midi);
      if (d < bestDist) {
         bestDist = d;
         best = s;
      }
   }
   return best;
}

/**
 * Get current playback state.
 */
export function getDownloadState() {
   return {
      isReady: samplesReady,
      isDownloading: isDownloading,
      sampleCount: samples.length,
      hasAudioContext: !!audioCtx,
   };
}
