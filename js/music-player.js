/**
 * music-player.js — Soothing audio player for baby monitor (TASK-019)
 *
 * Synthesises three royalty-free ambient sounds programmatically using the
 * Web Audio API — no audio files are required:
 *
 *   white-noise  Broadband noise; effective for sleep masking
 *   lullaby      Gentle 8-note pentatonic melody (C major, ~30 bpm)
 *   rain         Lowpass-filtered noise with soft amplitude modulation
 *
 * All buffers are generated once (on first play) and cached in memory.
 * Each track loops seamlessly via AudioBufferSourceNode.loop = true.
 *
 * The player attaches to the caller's AudioContext and routes its output
 * through a provided destination GainNode (baby.js's master volume node),
 * so MSG.SET_VOLUME changes apply equally to bundled tracks and received
 * audio files.  An internal GainNode (_musicGain) provides independent
 * fade-in / fade-out control without disturbing the master volume.
 *
 * Public API
 * ----------
 *   attachMusicPlayer(ctx, destNode)   — bind to existing AudioContext
 *   playTrack(trackId)                 — start looped playback
 *   stopTrack()                        — stop immediately
 *   switchTrack(trackId)               — cross-fade to a new track (500 ms)
 *   fadeOutAndStop(durationSeconds)    — smooth fade then stop; returns Promise
 *   scheduleFadeOut(totalSeconds)      — pre-schedule exponential ramp (TASK-014)
 *   cancelScheduledFade()              — cancel pre-scheduled ramp (TASK-014)
 *   isMusicPlaying()                   — boolean
 *   getCurrentTrackId()                — string | null
 */

// ---------------------------------------------------------------------------
// Track registry
// ---------------------------------------------------------------------------

/** Ordered list of built-in track IDs. */
export const BUILTIN_TRACKS = ['white-noise', 'lullaby', 'rain'];

/** Human-readable display names for each built-in track. */
export const TRACK_NAMES = {
  'white-noise': 'White Noise',
  'lullaby':     'Lullaby',
  'rain':        'Rain',
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {AudioContext|null} Shared AudioContext from baby.js. */
let _ctx = null;

/**
 * Master destination node provided by baby.js.
 * The player's internal gain connects here, so baby.js volume changes
 * (MSG.SET_VOLUME → _audioGain.gain) flow through to bundled tracks.
 * @type {GainNode|null}
 */
let _destNode = null;

/**
 * Internal gain node for fade-in / fade-out.
 * Sits between track source nodes and _destNode.
 * @type {GainNode|null}
 */
let _musicGain = null;

/** @type {AudioBufferSourceNode|null} Currently active source node. */
let _activeSource = null;

/** @type {string|null} ID of the currently playing (or last played) track. */
let _activeTrackId = null;

/**
 * Cache of generated AudioBuffers — each track is synthesised once and
 * reused for every subsequent play() call.
 * @type {Record<string, AudioBuffer>}
 */
const _bufferCache = {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attach the music player to an existing AudioContext and destination node.
 * Must be called once before playTrack() is usable.
 * Safe to call multiple times with the same ctx — idempotent.
 *
 * @param {AudioContext} audioCtx      — the shared AudioContext from baby.js
 * @param {GainNode}     destinationNode — master volume GainNode from baby.js
 */
// Public API additions documented in the module header:
//   scheduleFadeOut(totalSeconds)    — schedule exponential ramp in advance (TASK-014)
//   cancelScheduledFade()            — cancel the pre-scheduled ramp (TASK-014)
export function attachMusicPlayer(audioCtx, destinationNode) {
  if (_ctx === audioCtx && _musicGain) return; // already attached to this context
  _ctx      = audioCtx;
  _destNode = destinationNode;

  // Create the internal gain node that allows independent fade control.
  _musicGain = _ctx.createGain();
  _musicGain.gain.value = 1.0;
  _musicGain.connect(_destNode);
  console.log('[music-player] Attached to AudioContext (TASK-019)');
}

/**
 * Start looped playback of the specified track.
 * Any current playback is stopped cleanly before the new track begins.
 *
 * @param {string} trackId — one of BUILTIN_TRACKS
 */
export function playTrack(trackId) {
  if (!_ctx || !_musicGain) {
    console.warn('[music-player] Not attached — call attachMusicPlayer() first');
    return;
  }

  stopTrack(); // stop any in-progress playback

  const buffer = _getOrGenerateBuffer(trackId);
  if (!buffer) {
    console.warn('[music-player] Unknown or ungenerated track:', trackId);
    return;
  }

  _activeTrackId = trackId;
  _activeSource  = _ctx.createBufferSource();
  _activeSource.buffer = buffer;
  _activeSource.loop   = true;
  _activeSource.connect(_musicGain);
  _activeSource.start(0);
  console.log('[music-player] Playing:', trackId);
}

/**
 * Stop playback immediately and reset the internal gain to 1.0.
 */
export function stopTrack() {
  if (_activeSource) {
    try { _activeSource.stop(0); } catch (_e) { /* already stopped — ignore */ }
    try { _activeSource.disconnect(); } catch (_e) { /* ignore */ }
    _activeSource = null;
  }
  _activeTrackId = null;

  // Reset internal gain so the next play() starts at full volume.
  if (_musicGain && _ctx) {
    _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
    _musicGain.gain.setValueAtTime(1.0, _ctx.currentTime);
  }
}

/**
 * Cross-fade from the current track to a new one over ~500 ms.
 * If nothing is currently playing, starts the new track immediately.
 *
 * @param {string} newTrackId — target track ID
 */
export function switchTrack(newTrackId) {
  if (!_ctx || !_musicGain) return;
  if (newTrackId === _activeTrackId) return; // already playing this track

  if (!_activeSource) {
    // Nothing playing — just start the new track.
    playTrack(newTrackId);
    return;
  }

  // Fade out current track over 500 ms.
  const FADE_S    = 0.5;
  const now       = _ctx.currentTime;
  _musicGain.gain.cancelScheduledValues(now);
  _musicGain.gain.setValueAtTime(1.0, now);
  _musicGain.gain.linearRampToValueAtTime(0, now + FADE_S);

  // After the fade completes, start the new track and restore gain.
  setTimeout(() => {
    stopTrack();
    if (_musicGain && _ctx) {
      _musicGain.gain.setValueAtTime(1.0, _ctx.currentTime);
    }
    playTrack(newTrackId);
  }, FADE_S * 1000 + 50); // small safety margin
}

/**
 * Fade the music out over `duration` seconds, then stop playback.
 * Resolves when the fade is complete and audio has been stopped.
 *
 * @param {number} [duration=3] — fade duration in seconds
 * @returns {Promise<void>}
 */
export function fadeOutAndStop(duration = 3) {
  return new Promise((resolve) => {
    if (!_activeSource || !_musicGain || !_ctx) {
      stopTrack();
      resolve();
      return;
    }

    const now = _ctx.currentTime;
    _musicGain.gain.cancelScheduledValues(now);
    _musicGain.gain.setValueAtTime(_musicGain.gain.value, now);
    _musicGain.gain.linearRampToValueAtTime(0, now + duration);

    setTimeout(() => {
      stopTrack();
      resolve();
    }, duration * 1000 + 150); // +150 ms safety margin
  });
}

/**
 * @returns {boolean} True if a track is currently playing.
 */
export function isMusicPlaying() {
  return _activeSource !== null;
}

/**
 * @returns {string|null} ID of the current track, or null if idle.
 */
export function getCurrentTrackId() {
  return _activeTrackId;
}

/**
 * Schedule an exponential GainNode fade-out, timed from now.
 *
 * The fade window is 10% of `totalSeconds`, clamped between 30 s (minimum)
 * and 300 s / 5 min (maximum).  Examples:
 *   30 min (1800 s) → 180 s fade window (10%)
 *   60 min (3600 s) → 300 s fade window (capped at 5 min)
 *    5 min  (300 s) →  30 s fade window (floor)
 *
 * The ramp is fully pre-scheduled via the Web Audio API clock so it runs
 * frame-accurately without any polling or setInterval.
 *
 * The source node is NOT stopped here — the caller is responsible for
 * stopping it via stopTrack() once the total duration has elapsed.
 *
 * @param {number} totalSeconds — timer duration from now, in seconds
 * @returns {{ fadeWindow: number }} — the computed fade window in seconds
 */
export function scheduleFadeOut(totalSeconds) {
  if (!_ctx || !_musicGain || !_activeSource) {
    return { fadeWindow: 0 };
  }

  const fadeWindow     = Math.max(30, Math.min(300, totalSeconds * 0.1));
  const fadeStartDelay = Math.max(0, totalSeconds - fadeWindow);
  const now            = _ctx.currentTime;

  _musicGain.gain.cancelScheduledValues(now);
  _musicGain.gain.setValueAtTime(_musicGain.gain.value, now);

  if (fadeStartDelay > 0) {
    // Hold at current level until the fade window begins.
    _musicGain.gain.setValueAtTime(1.0, now + fadeStartDelay);
  }

  // Exponential ramp to near-silence.
  // exponentialRampToValueAtTime requires a positive target value (> 0).
  _musicGain.gain.exponentialRampToValueAtTime(0.0001, now + totalSeconds);

  console.log(
    `[music-player] Scheduled fade-out — total: ${totalSeconds}s,`,
    `hold until: +${fadeStartDelay.toFixed(1)}s,`,
    `fade window: ${fadeWindow.toFixed(1)}s (TASK-014)`,
  );

  return { fadeWindow };
}

/**
 * Cancel any pre-scheduled GainNode fade-out ramp and restore gain to 1.0.
 * Call this when the timer is cancelled mid-countdown.
 * Safe to call even if no fade was scheduled.
 */
export function cancelScheduledFade() {
  if (!_ctx || !_musicGain) return;
  _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
  _musicGain.gain.setValueAtTime(1.0, _ctx.currentTime);
  console.log('[music-player] Pre-scheduled fade cancelled (TASK-014)');
}

/**
 * Return the current intrinsic value of the internal music GainNode.
 * Exposed for E2E test assertions (TASK-065).
 *
 * Note: during an exponential ramp the Web Audio API's .value getter reflects
 * the automation-computed value at AudioContext.currentTime in Chrome, so this
 * can be polled to observe the fade-out progressing toward 0.0001.
 *
 * @returns {number|null}
 */
export function getMusicGainValue() {
  return _musicGain?.gain?.value ?? null;
}

/**
 * Return true if the internal source node is non-null (i.e. a track is active
 * and connected through _musicGain to the destination).
 * Mirrors isMusicPlaying() but explicitly documents the connectivity check.
 * Exposed for E2E test assertions (TASK-065).
 *
 * @returns {boolean}
 */
export function isSourceActive() {
  return _activeSource !== null;
}

// ---------------------------------------------------------------------------
// Buffer synthesis (each track generated once, then cached)
// ---------------------------------------------------------------------------

/**
 * Return the cached AudioBuffer for `trackId`, synthesising it on first call.
 *
 * @param {string} trackId
 * @returns {AudioBuffer|null}
 */
function _getOrGenerateBuffer(trackId) {
  if (_bufferCache[trackId]) return _bufferCache[trackId];
  if (!_ctx) return null;

  let buffer;
  switch (trackId) {
    case 'white-noise': buffer = _generateWhiteNoise(); break;
    case 'lullaby':     buffer = _generateLullaby();    break;
    case 'rain':        buffer = _generateRain();       break;
    default:
      console.warn('[music-player] No generator for track:', trackId);
      return null;
  }

  _bufferCache[trackId] = buffer;
  return buffer;
}

/**
 * White Noise
 * -----------
 * Fills an 8-second mono AudioBuffer with uniformly distributed random
 * samples in [-0.45, 0.45].  The loop is imperceptible because noise is
 * statistically homogeneous — there is no pitch or rhythmic content at the
 * loop boundary.
 *
 * White noise is highly effective for infant sleep: it masks sudden ambient
 * sounds (traffic, doors) and resembles the sound environment in the womb.
 *
 * @returns {AudioBuffer}
 */
function _generateWhiteNoise() {
  const SR     = _ctx.sampleRate;
  const length = SR * 8; // 8-second loop
  const buffer = _ctx.createBuffer(1, length, SR);
  const data   = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.45;
  }

  return buffer;
}

/**
 * Lullaby
 * -------
 * A gentle 8-note pentatonic phrase (C major: C4, E4, G4, A4, C5 and back),
 * synthesised as sine waves with soft ADSR envelopes.
 *
 * Design choices:
 *  - 2 seconds per note (≈ 30 bpm whole-notes) — slow, restful tempo
 *  - 120 ms attack, 550 ms release — avoids clicking at note boundaries
 *  - Peak amplitude 0.26 — quiet and sleep-friendly
 *  - ±0.4% vibrato at 5.2 Hz — gives a sung, organic quality
 *  - Faint second harmonic (12 dB below) — adds warmth without brightness
 *  - Total loop: ~16 s (8 notes × 2 s) — long enough to avoid repetition
 *
 * @returns {AudioBuffer}
 */
function _generateLullaby() {
  const SR = _ctx.sampleRate;

  // C major pentatonic ascending then descending — a complete musical phrase.
  const freqs   = [261.63, 329.63, 392.00, 440.00, 523.25, 440.00, 392.00, 329.63];
  const noteLen = 2.0; // seconds per note

  const totalDur = freqs.length * noteLen;
  const buffer   = _ctx.createBuffer(1, Math.ceil(SR * totalDur), SR);
  const data     = buffer.getChannelData(0);

  freqs.forEach((freq, noteIdx) => {
    const startSample  = Math.floor(noteIdx * noteLen * SR);
    const totalSamples = Math.floor(noteLen * SR);
    const attackLen    = Math.floor(0.12 * SR); // 120 ms
    const releaseLen   = Math.floor(0.55 * SR); // 550 ms
    const peakAmp      = 0.26;

    for (let s = 0; s < totalSamples; s++) {
      const idx = startSample + s;
      if (idx >= data.length) break;

      // ADSR envelope (no sustain decay — flat top between attack and release).
      let env;
      if (s < attackLen) {
        env = (s / attackLen) * peakAmp;
      } else if (s > totalSamples - releaseLen) {
        env = ((totalSamples - s) / releaseLen) * peakAmp;
      } else {
        env = peakAmp;
      }

      // Sine fundamental + vibrato + faint second harmonic.
      const t       = s / SR;
      const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * t);
      data[idx] +=
        Math.sin(2 * Math.PI * freq * vibrato * t) * env * 0.85 +
        Math.sin(2 * Math.PI * freq * 2 * t)       * env * 0.12;
    }
  });

  return buffer;
}

/**
 * Rain
 * ----
 * Soft, continuous rain sound created from white noise shaped through:
 *   1. A first-order IIR lowpass filter (α = 0.10, ~600 Hz virtual cutoff
 *      at 44 100 Hz) — removes harsh high-frequency content.
 *   2. Layered slow sinusoidal amplitude modulation (0.15 Hz, 0.37 Hz,
 *      1.1 Hz) — gives a naturalistic, slightly-dynamic texture without
 *      distinct rhythmic beats.
 *
 * The 10-second loop is long enough that the modulation phase at the loop
 * boundary is barely perceptible.
 *
 * @returns {AudioBuffer}
 */
function _generateRain() {
  const SR     = _ctx.sampleRate;
  const length = Math.ceil(SR * 10); // 10-second loop
  const buffer = _ctx.createBuffer(1, length, SR);
  const data   = buffer.getChannelData(0);

  // Step 1: uniform white noise.
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  // Step 2: first-order IIR lowpass (y[n] = y[n-1] + α*(x[n] - y[n-1])).
  const alpha = 0.10;
  let   prev  = 0;
  for (let i = 0; i < length; i++) {
    data[i] = prev + alpha * (data[i] - prev);
    prev    = data[i];
  }

  // Step 3: scale and apply layered amplitude modulation.
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const mod =
      1.0 +
      0.22 * Math.sin(2 * Math.PI * 0.15 * t) +
      0.14 * Math.sin(2 * Math.PI * 0.37 * t + 1.2) +
      0.07 * Math.sin(2 * Math.PI * 1.10 * t + 0.7);
    data[i] *= mod * 0.28; // scale to comfortable amplitude
  }

  return buffer;
}
