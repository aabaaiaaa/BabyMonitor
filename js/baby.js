/**
 * baby.js — Baby monitor mode entry point (baby.html)
 *
 * Responsibilities (stubs for future tasks):
 *   TASK-003  — Wake Lock API (prevent sleep)
 *   TASK-006  — Pairing flow UI
 *   TASK-007  — Peer connection management
 *   TASK-009  — Data channel / message handling
 *   TASK-010  — getUserMedia (video + audio capture)
 *   TASK-015  — Soothing mode UI
 *   TASK-016  — Candle effect
 *   TASK-017  — Water effect
 *   TASK-018  — Stars effect
 *   TASK-019  — Music playback
 *   TASK-020  — Battery level monitoring
 *   TASK-037  — Autoplay policy (tap-to-begin)
 *   TASK-038  — Audio ducking
 *   TASK-039  — Touch lock / kiosk mode
 *   TASK-040  — Screen orientation lock
 *   TASK-041  — Camera selection
 *   TASK-048  — State sync to parent
 *
 * This file wires everything together; each concern will move into its own
 * module as the corresponding task is implemented.
 */

import {
  lsGet, lsSet, getSettings, saveSetting, SETTING_KEYS,
  getOrCreateDeviceId,
  saveAudioFile, getAudioFile, listAudioFiles, deleteAudioFile, updateAudioFileName,
  getStorageUsage,
} from './storage.js';
import {
  initPeer, destroyPeer,
  babyCallParent, getPeer,
  offlineBabyCreateOffer, offlineBabyReceiveAnswer,
  sendMessage, MSG,
  onPeerStatus, PEER_ERROR,
} from './webrtc.js';
import {
  renderQR, renderQRGrid,
  scanAuto, scanSingle, scanMulti, stopScanner,
} from './qr.js';
import { showCompatWarnings } from './browser-compat.js';
import {
  attachMusicPlayer,
  playTrack as _mpPlayTrack,
  stopTrack as _mpStopTrack,
  switchTrack as _mpSwitchTrack,
  fadeOutAndStop as _mpFadeOutAndStop,
  scheduleFadeOut as _mpScheduleFadeOut,
  cancelScheduledFade as _mpCancelScheduledFade,
  isMusicPlaying as _mpIsPlaying,
  BUILTIN_TRACKS,
} from './music-player.js';

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

/** @type {object} Merged settings from localStorage */
let settings = getSettings();

/** @type {string} This device's unique ID */
const deviceId = getOrCreateDeviceId();

/**
 * @typedef {object} BabyState
 * @property {string}      soothingMode   — 'candle'|'water'|'stars'|'music'|'off'
 * @property {number}      musicVolume    — 0–100
 * @property {string|null} currentTrack
 * @property {number}      fadeRemaining  — seconds remaining on fade timer, 0 = off
 * @property {number}      fadeDuration   — total duration the timer was set to (TASK-014)
 * @property {string}      cameraFacing   — 'user'|'environment'
 * @property {boolean}     audioOnly
 * @property {string}      quality        — 'low'|'medium'|'high'
 * @property {boolean}     locked         — touch lock engaged
 * @property {boolean}     screenDim      — TASK-028: screen dimmed to save battery
 * @property {boolean}     videoPaused    — TASK-028: video track paused (parent-commanded)
 */

/** @type {BabyState} */
const state = {
  soothingMode:  settings.defaultMode ?? 'off',
  musicVolume:   70,
  currentTrack:  settings.defaultTrack ?? null,
  fadeRemaining: 0,
  fadeDuration:  0,   // TASK-014: original timer duration (seconds)
  cameraFacing:  settings.cameraFacing ?? 'environment',
  audioOnly:     settings.audioOnly ?? false,
  quality:       settings.videoQuality ?? 'medium',
  locked:        false,
  screenDim:     false,  // TASK-028: dimmed display mode
  videoPaused:   false,  // TASK-028: video track paused by parent command
};

/** @type {MediaStream|null} Local camera/mic stream */
let localStream = null;

/** @type {object|null} Active normalised connection */
let activeConnection = null;

/** @type {Function|null} Unsubscribe function for the current peer status listener */
let _peerStatusUnsub = null;

// ---------------------------------------------------------------------------
// Auto-reconnect state (TASK-030)
// ---------------------------------------------------------------------------

/** PeerJS peer ID of the connected parent device — stored for auto-reconnect (TASK-030) */
let _parentPeerId = null;

/** Connection method used for the last successful connection: 'peerjs'|'offline'|null (TASK-030) */
let _lastConnectionMethod = null;

/** True while automatic reconnection is in progress (TASK-030) */
let _isReconnecting = false;

/** Current auto-reconnect attempt number, 1-based (TASK-030) */
let _reconnectAttempt = 0;

/** setTimeout handle for the next scheduled reconnect attempt (TASK-030) */
let _reconnectTimer = null;

/** Maximum number of auto-reconnect attempts before showing the re-pair prompt (TASK-030) */
const AUTO_RECONNECT_MAX_ATTEMPTS = 3;

/** Delays in ms between reconnect attempts — attempt 1, 2, 3 (TASK-030) */
const AUTO_RECONNECT_DELAYS_MS = [3000, 6000, 12000];

/** @type {WakeLockSentinel|null} Screen wake lock (TASK-003) */
let wakeLock = null;

/**
 * True once a low-battery ALERT_BATTERY_LOW message has been sent to the
 * parent during this connection session. Reset when the battery recovers
 * above 20%, so a future drop triggers a fresh alert.
 * @type {boolean}
 */
let _batteryAlertSent = false;

/**
 * Last known battery level (0–100), or null before the Battery API has been
 * read.  Updated by startBatteryMonitoring() → broadcast() and included in
 * every STATE_SNAPSHOT so the parent always has fresh battery info (TASK-048).
 * @type {number|null}
 */
let _batteryLevel = null;

/**
 * Last known battery charging state, or null before the Battery API has been
 * read.  Updated alongside _batteryLevel (TASK-048).
 * @type {boolean|null}
 */
let _batteryCharging = null;

// ---------------------------------------------------------------------------
// File transfer state (TASK-013)
// ---------------------------------------------------------------------------

/**
 * In-progress incoming file transfer.
 * Chunks arrive as base64 strings and are held in memory until FILE_COMPLETE.
 * @type {{ id: string, name: string, mimeType: string, totalChunks: number, received: number, chunks: string[] } | null}
 */
let _incomingTransfer = null;

/**
 * IndexedDB ID of the most recently received and stored audio file.
 * Used when a FILE_PLAY command arrives.
 * @type {string|null}
 */
let _receivedFileDbId = null;

// ---------------------------------------------------------------------------
// Audio playback state (TASK-013)
// ---------------------------------------------------------------------------

/** @type {AudioContext|null} Dedicated AudioContext for transferred file playback. */
let _audioCtx   = null;

/** @type {GainNode|null} Master gain node — volume + ducking hookup point for TASK-038. */
let _audioGain  = null;

/** @type {AudioBuffer|null} Decoded buffer for the current received audio file. */
let _audioBuffer = null;

/** @type {AudioBufferSourceNode|null} The active playback source node (null if stopped). */
let _audioSource = null;

/** @type {boolean} True while audio is actively playing (not paused or stopped). */
let _audioPlaying = false;

/** @type {number} audioCtx.currentTime at which the last play/resume started. */
let _audioStart   = 0;

/** @type {number} Playback offset (seconds) saved when the audio is paused. */
let _audioOffset  = 0;

// ---------------------------------------------------------------------------
// Music player state (TASK-019)
// ---------------------------------------------------------------------------

/**
 * True once the music-player module has been attached to _audioCtx.
 * Prevents re-attachment on every call to _startMusicMode().
 * @type {boolean}
 */
let _musicPlayerAttached = false;

/**
 * setInterval ID for the fade-out countdown ticker (TASK-014).
 * Drives state.fadeRemaining decrements and STATE_SNAPSHOT broadcasts.
 * The audio fade itself is pre-scheduled via the Web Audio API clock.
 * @type {number|null}
 */
let _fadeTimerIntervalId = null;

/**
 * setTimeout ID for stopping playback when the fade timer expires (TASK-014).
 * Null when no timer is running.
 * @type {number|null}
 */
let _fadeTimerStopId = null;

/**
 * True once the initial soothing mode has been started for the first time.
 * On every subsequent call to startMonitor() (i.e. after reconnection) soothing
 * is already running and must NOT be restarted — restarting would interrupt
 * music, reset the pre-scheduled Web Audio API fade ramp, and cause a canvas
 * flicker (TASK-051).
 * @type {boolean}
 */
let _soothingInitialized = false;

/**
 * True if music mode automatically applied the screen-dim overlay.
 * Used to restore the previous dim state when leaving music mode.
 * @type {boolean}
 */
let _musicModeDimApplied = false;

// ---------------------------------------------------------------------------
// Audio ducking state (TASK-038)
// ---------------------------------------------------------------------------

/**
 * Dedicated gain node that sits between _audioGain and _audioCtx.destination.
 * Normal value: 1.0 (no attenuation).  Ramped to DUCK_GAIN when the parent
 * is speaking, then back to 1.0 when silence returns.
 * @type {GainNode|null}
 */
let _duckingGain = null;

/**
 * AnalyserNode connected to the incoming speak-through MediaStream.
 * Used to detect parent speech activity without relying on data-channel messages.
 * @type {AnalyserNode|null}
 */
let _speakAnalyser = null;

/**
 * MediaStreamAudioSourceNode feeding _speakAnalyser.
 * Disconnected and replaced each time a new speak-through track arrives.
 * @type {MediaStreamAudioSourceNode|null}
 */
let _speakAnalyserSource = null;

/**
 * requestAnimationFrame handle for the ducking detector poll loop.
 * @type {number|null}
 */
let _duckingRafId = null;

/**
 * True while the music is currently ducked (gain is below 1.0).
 * @type {boolean}
 */
let _isDucked = false;

/**
 * performance.now() timestamp of the most recent detected parent speech frame.
 * Used to determine when silence has persisted long enough to end ducking.
 * @type {number}
 */
let _lastSpeakMs = 0;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const tapOverlay          = document.getElementById('tap-overlay');
const pairingSection      = document.getElementById('pairing-section');
const babyMonitor         = document.getElementById('baby-monitor');
const disconnectedScreen  = document.getElementById('disconnected-screen');

// Pairing step elements
const pairingMethodStep   = document.getElementById('pairing-method-step');
const pairingPeerjsStep   = document.getElementById('pairing-peerjs-step');
const pairingOfflineStep  = document.getElementById('pairing-offline-step');
const peerjsQrContainer   = document.getElementById('peerjs-qr-container');
const peerIdText          = document.getElementById('peerjs-peer-id');
const pairingStatusPeerjs = document.getElementById('pairing-status-peerjs');
const offlineQrContainer  = document.getElementById('offline-qr-container');
const offlineScanVideo    = document.getElementById('offline-scan-video');
const offlineScanProgress = document.getElementById('offline-scan-progress');
const pairingInstruction  = document.getElementById('offline-pairing-instruction');
const pairingStatusOffline = document.getElementById('pairing-status-offline');
const offlineScannerContainer = document.getElementById('offline-scanner-container');

// Active monitor elements
const soothingCanvas      = document.getElementById('soothing-canvas');
const babyConnStatus      = document.getElementById('baby-conn-status');
const babyBattery         = document.getElementById('baby-battery');
const touchLockHint       = document.getElementById('touch-lock-hint');
const babySettingsOverlay = document.getElementById('baby-settings-overlay');
const soothingSettingsBtn = document.getElementById('soothing-settings-btn');

// Settings overlay elements
const modeBtns            = babySettingsOverlay?.querySelectorAll('.mode-btn') ?? [];
const flipCameraBtn       = document.getElementById('btn-flip-camera');
const setupFlipCameraBtn  = document.getElementById('btn-setup-flip-camera');   // TASK-041
const setupCameraFacingText = document.getElementById('setup-camera-facing-text'); // TASK-041
const audioOnlyToggle     = document.getElementById('audio-only-toggle');
const screenDimToggle     = document.getElementById('screen-dim-toggle');   // TASK-028
const orientationSelect   = document.getElementById('orientation-select');
const orientationApiNote  = document.getElementById('orientation-api-note');  // TASK-040
const disconnectBtn       = document.getElementById('btn-disconnect');
const settingsCloseBtn    = document.getElementById('baby-settings-close');
const babyDefaultTrack    = document.getElementById('baby-default-track');  // TASK-032

// Audio library (TASK-049)
const babyLibraryList     = document.getElementById('baby-library-list');
const babyLibraryEmpty    = document.getElementById('baby-library-empty');
const babyLibraryStorage  = document.getElementById('baby-library-storage');
const babyLibraryQuotaWarn = document.getElementById('baby-library-quota-warning');

// Disconnected screen
const reconnectStatus      = document.getElementById('reconnect-status');
const disconnectedHeading  = document.getElementById('disconnected-heading');
const rePairBtn            = document.getElementById('btn-re-pair');
const goHomeBtn            = document.getElementById('btn-go-home');

// Reconnecting overlay (TASK-030)
const reconnectOverlay     = document.getElementById('reconnect-overlay');
const reconnectOverlayText = document.getElementById('reconnect-overlay-text');

// File transfer progress overlay (TASK-013)
const babyTransferStatus  = document.getElementById('baby-transfer-status');
const babyTransferText    = document.getElementById('baby-transfer-text');
const babyTransferBar     = document.getElementById('baby-transfer-bar');

// Background persistence banner (TASK-029)
const bgBanner            = document.getElementById('bg-banner');
const bgBannerPwa         = document.getElementById('bg-banner-pwa');
const bgBannerInstall     = document.getElementById('bg-banner-install');
const bgBannerDismiss     = document.getElementById('bg-banner-dismiss');

// ---------------------------------------------------------------------------
// Backup PeerJS ID pool (TASK-061)
//
// To support automatic reconnection (TASK-030) and second-parent access
// (TASK-058) without re-pairing, the baby device pre-generates a pool of
// backup PeerJS peer IDs.  On first connection the full pool is sent to the
// parent via the data channel.  On reconnect, the baby registers the next
// pool ID with PeerJS; the parent (who holds the pool) can try them in order.
// When the pool is running low (< ID_POOL_REPLENISH_THRESHOLD unused IDs),
// a fresh batch is appended and broadcast to ALL connected parents.
// ---------------------------------------------------------------------------

/** Number of UUIDs to generate per pool batch. */
const ID_POOL_BATCH_SIZE = 20;

/** Trigger replenishment when fewer than this many unused IDs remain. */
const ID_POOL_REPLENISH_THRESHOLD = 5;

/**
 * Return the persisted ID pool and current index, creating a fresh pool of
 * ID_POOL_BATCH_SIZE UUIDs if none exists yet.  Called on every connection
 * and whenever the pool needs to be read or modified.
 *
 * @returns {{ pool: string[], index: number }}
 */
function _getOrCreateIdPool() {
  let pool = lsGet(SETTING_KEYS.BACKUP_ID_POOL, null);
  if (!Array.isArray(pool) || pool.length === 0) {
    pool = Array.from({ length: ID_POOL_BATCH_SIZE }, () => crypto.randomUUID());
    lsSet(SETTING_KEYS.BACKUP_ID_POOL, pool);
    lsSet(SETTING_KEYS.BACKUP_POOL_INDEX, 0);
    console.log('[baby] Created backup ID pool with', pool.length, 'IDs (TASK-061)');
  }
  const index = lsGet(SETTING_KEYS.BACKUP_POOL_INDEX, 0);
  return { pool, index };
}

/**
 * Send the full backup ID pool and current index to a connected parent device
 * via the data channel (MSG.ID_POOL).  Called immediately after a data
 * connection is established (TASK-009) so the parent can use the pool for
 * auto-reconnection (TASK-030) and second-parent access (TASK-058).
 *
 * @param {{ dataChannel: object }} conn — normalised connection object
 */
function _sendIdPool(conn) {
  if (!conn?.dataChannel) return;
  const { pool, index } = _getOrCreateIdPool();
  sendMessage(conn.dataChannel, MSG.ID_POOL, { pool, index });
  console.log('[baby] Sent backup ID pool to parent — pool length', pool.length, ', index', index, '(TASK-061)');
}

/**
 * Broadcast the full backup ID pool and current index to ALL currently
 * connected parent devices.  For single-parent sessions this is identical
 * to _sendIdPool(); when TASK-058 adds a second parent, both connections
 * are updated so neither works from a stale pool.
 *
 * @param {string[]} pool  — current pool array
 * @param {number}   index — current pool index
 */
function _broadcastIdPoolToAllParents(pool, index) {
  // activeConnection covers the primary parent (and the only parent before TASK-058).
  if (activeConnection?.dataChannel) {
    sendMessage(activeConnection.dataChannel, MSG.ID_POOL, { pool, index });
  }
  // TASK-058: when additional parent connections are tracked, send to each here.
}

/**
 * Check whether the pool is running low and generate additional IDs if needed.
 * When fewer than ID_POOL_REPLENISH_THRESHOLD unused IDs remain, a fresh batch
 * of ID_POOL_BATCH_SIZE UUIDs is appended, persisted, and broadcast to all
 * currently connected parent devices (TASK-061).
 *
 * Safe to call at any time — is a no-op when the pool has plenty of IDs left.
 */
function _checkAndReplenishPool() {
  const { pool, index } = _getOrCreateIdPool();
  const unused = pool.length - index;
  if (unused >= ID_POOL_REPLENISH_THRESHOLD) return; // plenty left — nothing to do

  const newIds = Array.from({ length: ID_POOL_BATCH_SIZE }, () => crypto.randomUUID());
  const updatedPool = [...pool, ...newIds];
  lsSet(SETTING_KEYS.BACKUP_ID_POOL, updatedPool);
  console.log(
    '[baby] Replenishing ID pool: was', pool.length, '(', unused, 'unused),',
    'now', updatedPool.length, '(TASK-061)',
  );
  // Broadcast the updated pool so ALL parents stay in sync (TASK-058 requirement).
  _broadcastIdPoolToAllParents(updatedPool, index);
}

/**
 * Advance the pool index to the next backup ID for reconnection.
 *
 * Called by TASK-030's auto-reconnect flow when the primary peer ID is no
 * longer reachable.  Returns the next pool ID to register with PeerJS via
 * `initPeer(null, null, nextId)`, or null if the pool is exhausted (this
 * should not happen if _checkAndReplenishPool() is working correctly).
 *
 * After advancing, triggers a replenishment check so parents receive fresh
 * IDs before the pool runs dry.
 *
 * @returns {string|null} the next peer ID to register, or null if exhausted
 */
function _advanceIdPoolForReconnect() {
  const { pool, index } = _getOrCreateIdPool();
  const nextIndex = index + 1;
  if (nextIndex >= pool.length) {
    console.warn('[baby] Backup ID pool exhausted — cannot advance for reconnect (TASK-061)');
    return null;
  }
  lsSet(SETTING_KEYS.BACKUP_POOL_INDEX, nextIndex);
  const nextId = pool[nextIndex];
  console.log('[baby] Advanced pool index to', nextIndex, '— next peer ID:', nextId, '(TASK-061)');
  // Check replenishment now so parents receive new IDs over the reconnected channel.
  _checkAndReplenishPool();
  return nextId;
}

// ---------------------------------------------------------------------------
// Connection health monitoring and auto-reconnect (TASK-030)
// ---------------------------------------------------------------------------

/**
 * Show the reconnecting overlay inside the baby monitor view.
 * Keeps the soothing canvas visible while indicating reconnection is in progress.
 * @param {string} [text] — status text to display
 */
function _showReconnectOverlay(text = 'Reconnecting…') {
  if (reconnectOverlayText) reconnectOverlayText.textContent = text;
  reconnectOverlay?.classList.remove('hidden');
  updateConnectionStatus('reconnecting');
}

/** Hide the reconnecting overlay (TASK-030). */
function _hideReconnectOverlay() {
  reconnectOverlay?.classList.add('hidden');
}

/**
 * Cancel any pending auto-reconnect timer and reset reconnect state.
 * Safe to call even when no reconnect is in progress.
 */
function _cancelAutoReconnect() {
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  _isReconnecting = false;
  _reconnectAttempt = 0;
  _hideReconnectOverlay();
}

/**
 * Handle a connection state change from the WebRTC layer (TASK-030).
 *
 * Decides whether to attempt automatic reconnection or fall through to the
 * disconnected screen, based on the current connection method and state.
 *
 * @param {string} connState — 'connected'|'reconnecting'|'disconnected'|'failed'
 */
function _handleConnectionStateChange(connState) {
  if (connState === 'connected') {
    // Connection (re)established — update status badge
    updateConnectionStatus('connected');
    if (activeConnection?.dataChannel) {
      sendMessage(activeConnection.dataChannel, MSG.CONN_STATUS, connState);
    }
    return;
  }

  if (connState === 'reconnecting') {
    // Transient ICE disconnect — show reconnecting status and wait for recovery
    _showReconnectOverlay('Reconnecting…');
    if (activeConnection?.dataChannel) {
      sendMessage(activeConnection.dataChannel, MSG.CONN_STATUS, connState);
    }
    return;
  }

  if (connState === 'disconnected' || connState === 'failed') {
    if (_isReconnecting) {
      // Already mid-reconnect — the active reconnect attempt handles the next step
      return;
    }

    if (_lastConnectionMethod === 'peerjs' && _parentPeerId && localStream) {
      // PeerJS path: start pool-based auto-reconnect
      _isReconnecting = true;
      _reconnectAttempt = 0;
      _showReconnectOverlay(`Reconnecting… (1/${AUTO_RECONNECT_MAX_ATTEMPTS})`);
      // Close the broken connection object before re-registering
      try { activeConnection?.close?.(); } catch (_) { /* ignore */ }
      activeConnection = null;
      _schedulePeerJsReconnect(1);
    } else if (_lastConnectionMethod === 'offline' && activeConnection?.peerConnection) {
      // Offline path: attempt ICE restart
      _isReconnecting = true;
      _showReconnectOverlay('Reconnecting…');
      _attemptOfflineIceRestart();
    } else {
      // Cannot auto-reconnect — fall through to disconnected screen
      handleDisconnect(connState);
    }
  }
}

/**
 * Schedule the next PeerJS reconnect attempt after a delay.
 * @param {number} attempt — 1-based attempt counter
 */
function _schedulePeerJsReconnect(attempt) {
  const delay = AUTO_RECONNECT_DELAYS_MS[attempt - 1] ?? AUTO_RECONNECT_DELAYS_MS.at(-1);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _attemptPeerJsReconnect(attempt);
  }, delay);
}

/**
 * Attempt to reconnect to the parent via PeerJS using the next backup pool ID.
 *
 * Advances the backup ID pool by one position, re-registers with PeerJS under
 * the new ID, then calls the parent back.  On success, resumes normal monitoring.
 * On failure, schedules the next attempt or falls back to the re-pair prompt.
 *
 * @param {number} attempt — 1-based attempt counter
 */
async function _attemptPeerJsReconnect(attempt) {
  if (!_isReconnecting) return; // Aborted by user

  _reconnectAttempt = attempt;
  _showReconnectOverlay(`Reconnecting… (${attempt}/${AUTO_RECONNECT_MAX_ATTEMPTS})`);
  console.log(`[baby] PeerJS reconnect attempt ${attempt}/${AUTO_RECONNECT_MAX_ATTEMPTS} (TASK-030)`);

  // Step 1: advance to the next backup peer ID
  const nextId = _advanceIdPoolForReconnect();
  if (!nextId) {
    console.warn('[baby] PeerJS reconnect: backup ID pool exhausted (TASK-030)');
    _onAutoReconnectFailed('Backup ID pool exhausted — please re-pair.');
    return;
  }

  console.log(`[baby] Reconnect attempt ${attempt} using peer ID: ${nextId} (TASK-030)`);

  try {
    // Step 2: re-register with PeerJS under the new backup ID
    await initPeer(null, null, nextId);

    // Step 3: call the parent back using the stored parent peer ID
    await babyCallParent(_parentPeerId, localStream, {
      onReady(conn) {
        if (!_isReconnecting) return; // User aborted during handshake
        _cancelAutoReconnect();
        activeConnection = conn;
        updateConnectionStatus('connected');
        // Resume monitoring (shows baby-monitor, starts battery, sends state)
        startMonitor(conn);
        console.log('[baby] PeerJS reconnect succeeded (TASK-030)');
      },
      onState(s) {
        if (s === 'reconnecting') {
          _showReconnectOverlay(`Reconnecting… (${attempt}/${AUTO_RECONNECT_MAX_ATTEMPTS})`);
        } else if ((s === 'disconnected' || s === 'failed') && _isReconnecting) {
          // This connection attempt failed — schedule next retry
          if (attempt < AUTO_RECONNECT_MAX_ATTEMPTS) {
            _schedulePeerJsReconnect(attempt + 1);
          } else {
            _onAutoReconnectFailed('Could not reconnect automatically. Please re-pair.');
          }
        }
      },
      onMessage(msg) {
        handleDataMessage(msg);
      },
    });
  } catch (err) {
    console.warn(`[baby] PeerJS reconnect attempt ${attempt} threw:`, err);
    if (_isReconnecting) {
      if (attempt < AUTO_RECONNECT_MAX_ATTEMPTS) {
        _schedulePeerJsReconnect(attempt + 1);
      } else {
        _onAutoReconnectFailed('Could not reconnect automatically. Please re-pair.');
      }
    }
  }
}

/**
 * Attempt an ICE restart on the offline QR path connection (TASK-030).
 * Falls back to the re-pair prompt if ICE restart is not supported or times out.
 */
function _attemptOfflineIceRestart() {
  const pc = activeConnection?.peerConnection;
  if (!pc || typeof pc.restartIce !== 'function') {
    console.log('[baby] ICE restart not supported — falling back to re-pair (TASK-030)');
    _onAutoReconnectFailed('ICE restart not supported on this device.');
    return;
  }

  console.log('[baby] Attempting ICE restart (TASK-030)');

  const ICE_RESTART_TIMEOUT_MS = 15_000;
  let resolved = false;

  const cleanup = () => {
    resolved = true;
    clearTimeout(timeoutId);
    pc.removeEventListener('iceconnectionstatechange', onIceChange);
    pc.removeEventListener('connectionstatechange', onConnChange);
  };

  const onIceChange = () => {
    if (resolved) return;
    const ice = pc.iceConnectionState;
    if (ice === 'connected' || ice === 'completed') {
      cleanup();
      _isReconnecting = false;
      _hideReconnectOverlay();
      updateConnectionStatus('connected');
      console.log('[baby] ICE restart succeeded (TASK-030)');
    } else if (ice === 'failed') {
      cleanup();
      _onAutoReconnectFailed('ICE restart failed — please re-pair.');
    }
  };

  const onConnChange = () => {
    if (resolved) return;
    const cs = pc.connectionState;
    if (cs === 'connected') {
      cleanup();
      _isReconnecting = false;
      _hideReconnectOverlay();
      updateConnectionStatus('connected');
      console.log('[baby] ICE restart succeeded (TASK-030)');
    } else if (cs === 'failed') {
      cleanup();
      _onAutoReconnectFailed('ICE restart failed — please re-pair.');
    }
  };

  const timeoutId = setTimeout(() => {
    if (resolved) return;
    cleanup();
    _onAutoReconnectFailed('ICE restart timed out — please re-pair.');
  }, ICE_RESTART_TIMEOUT_MS);

  pc.addEventListener('iceconnectionstatechange', onIceChange);
  pc.addEventListener('connectionstatechange', onConnChange);
  pc.restartIce();
}

/**
 * Called when all auto-reconnect attempts have failed (TASK-030).
 * Cancels pending timers, resets reconnect state, and falls back to the
 * disconnected screen with the re-pair prompt.
 *
 * @param {string} reason — user-facing status message
 */
function _onAutoReconnectFailed(reason) {
  console.log('[baby] Auto-reconnect failed:', reason, '(TASK-030)');
  const wasReconnecting = _isReconnecting;
  _cancelAutoReconnect();

  if (wasReconnecting) {
    // Clean up broken connection resources before showing disconnected screen
    try { activeConnection?.close?.(); } catch (_) { /* ignore */ }
    activeConnection = null;
  }

  // Show disconnected screen with failure reason
  if (disconnectedHeading) disconnectedHeading.textContent = 'Disconnected';
  showDisconnected('');
  if (reconnectStatus) reconnectStatus.textContent = reason;
}

// ---------------------------------------------------------------------------
// Browser compatibility check (TASK-045)
// Run immediately at module load — before any user interaction or init().
// ---------------------------------------------------------------------------

const _compatResult = showCompatWarnings();

// ---------------------------------------------------------------------------
// iOS Wake Lock / soothing warning (TASK-051)
// The Screen Wake Lock API is unavailable on all iOS browsers (Apple's WebKit
// restriction).  When the screen sleeps, canvas animation pauses — audio is
// unaffected.  Show an advisory note in the settings overlay so the user
// knows to prefer Music mode on iOS devices.
// ---------------------------------------------------------------------------

if (!('wakeLock' in navigator)) {
  const iosSoothingWarning = document.getElementById('ios-soothing-warning');
  if (iosSoothingWarning) iosSoothingWarning.hidden = false;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/** Entry point: called after the user taps the tap-overlay. */
async function init() {
  setupTheme();
  _updateCameraFacingUI(); // TASK-041: reflect saved camera preference in the setup UI
  await requestWakeLock(); // TASK-003
  _initOnboardingHint();   // TASK-031
  showPairing();
}

// ---------------------------------------------------------------------------
// Theme (TASK-046)
// ---------------------------------------------------------------------------

function setupTheme() {
  const theme = lsGet(SETTING_KEYS.THEME, 'light');
  const isDark = theme === 'dark';
  document.body.classList.toggle('dark-mode', isDark);
  _updateThemeUI(isDark);
}

/** Update theme icon and label text in the baby settings overlay. */
function _updateThemeUI(isDark) {
  const icon      = document.getElementById('theme-icon');
  const labelText = document.getElementById('baby-theme-label-text');
  if (icon)      icon.textContent      = isDark ? '☀️' : '🌙';
  if (labelText) labelText.textContent = isDark ? 'Dark mode' : 'Light mode';
}

// Wire up the dark mode toggle in the baby settings overlay (TASK-046).
document.getElementById('dark-mode-toggle')?.addEventListener('click', () => {
  const isDark = document.body.classList.toggle('dark-mode');
  saveSetting(SETTING_KEYS.THEME, isDark ? 'dark' : 'light');
  _updateThemeUI(isDark);
});

// ---------------------------------------------------------------------------
// Onboarding hint (TASK-031)
// ---------------------------------------------------------------------------
//
// When baby.html is opened with ?onboarding=1 (from the first-run setup wizard
// in index.html), show a dismissible context banner at the top of the pairing
// wizard so the user knows what to do next.

/**
 * Show the onboarding context hint banner if baby.html was launched from the
 * first-run setup wizard (detected via the ?onboarding=1 URL parameter).
 */
function _initOnboardingHint() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('onboarding') !== '1') return;

  const hintEl = document.getElementById('onboarding-hint');
  if (!hintEl) return;

  hintEl.classList.remove('hidden');

  document.getElementById('onboarding-hint-dismiss')?.addEventListener('click', () => {
    hintEl.classList.add('hidden');
  }, { once: true });
}

// ---------------------------------------------------------------------------
// Wake Lock (TASK-003)
// ---------------------------------------------------------------------------

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return; // Graceful fallback
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    console.log('[baby] Wake lock acquired');

    wakeLock.addEventListener('release', () => {
      console.log('[baby] Wake lock released by system');
      wakeLock = null;
    });
  } catch (err) {
    console.warn('[baby] Wake lock request failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Page Visibility API — background tab persistence (TASK-029)
// ---------------------------------------------------------------------------
//
// When the baby monitor tab is hidden (user switches app, phone locks, etc.):
//   • The Wake Lock is released by the OS — this is expected and unavoidable.
//   • WebRTC connections and media streams MUST stay alive. We deliberately
//     do NOT stop any tracks here; stopping them would tear down the stream
//     and require the parent to re-pair when the tab becomes visible again.
//   • Animation frames are paused automatically by the browser — no action
//     needed; they resume when the tab becomes visible again.
//
// When the tab becomes visible again:
//   • Re-acquire the Wake Lock so the screen stays on during monitoring.
//   • The media stream and WebRTC connection are already alive and need no
//     additional action.

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    // Tab went to background — log and keep everything alive.
    // Explicitly: do NOT call localStream.getTracks().forEach(t => t.stop()).
    // The Wake Lock is released automatically by the browser; we will
    // re-request it when the tab becomes visible again.
    console.log('[baby] Tab hidden — WebRTC connection and media stream kept alive (TASK-029)');
  } else if (document.visibilityState === 'visible') {
    // Tab came back to foreground — re-acquire the Wake Lock (TASK-003).
    if (!wakeLock) {
      await requestWakeLock();
    }
    console.log('[baby] Tab visible — Wake Lock re-acquired if possible (TASK-029)');
  }
});

// ---------------------------------------------------------------------------
// Background persistence banner (TASK-029)
// ---------------------------------------------------------------------------

/**
 * Deferred PWA install prompt captured from the `beforeinstallprompt` event.
 * Stored here so we can trigger it from the banner's "Install as app" button.
 * @type {Event|null}
 */
let _deferredInstallPrompt = null;

// Capture the install prompt before the browser shows its own mini-infobar.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // If the banner is already visible, reveal the install button now.
  bgBannerPwa?.classList.remove('hidden');
});

// If the user installs the PWA, clear the deferred prompt and hide the button.
window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  bgBannerPwa?.classList.add('hidden');
  console.log('[baby] PWA installed (TASK-029)');
});

/**
 * True once the user has tapped ✕ on the banner during this session.
 * Prevents the banner from re-appearing if showMonitor() is called again.
 * @type {boolean}
 */
let _bgBannerDismissed = false;

/**
 * Show the "keep this tab open" / install-as-app banner (TASK-029).
 * Called when the baby monitor becomes active (i.e. after pairing succeeds).
 * The banner is persistent but dismissible for the session.
 */
function showBgBanner() {
  if (!bgBanner || _bgBannerDismissed) return;
  bgBanner.classList.remove('hidden');

  // Show install button if the install prompt is already available.
  if (_deferredInstallPrompt) {
    bgBannerPwa?.classList.remove('hidden');
  }
}

// Dismiss button — hides the banner for this session (not persisted).
bgBannerDismiss?.addEventListener('click', () => {
  bgBanner?.classList.add('hidden');
  _bgBannerDismissed = true;
});

// "Install as app" button — trigger the deferred install prompt.
bgBannerInstall?.addEventListener('click', async () => {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  console.log('[baby] PWA install prompt outcome:', outcome, '(TASK-029)');
  _deferredInstallPrompt = null;
  bgBannerPwa?.classList.add('hidden');
});

// ---------------------------------------------------------------------------
// Screen helpers
// ---------------------------------------------------------------------------

function showTapOverlay() {
  tapOverlay?.classList.remove('hidden');
  pairingSection?.classList.add('hidden');
  babyMonitor?.classList.add('hidden');
  disconnectedScreen?.classList.add('hidden');
}

function showPairing() {
  tapOverlay?.classList.add('hidden');
  pairingSection?.classList.remove('hidden');
  babyMonitor?.classList.add('hidden');
  disconnectedScreen?.classList.add('hidden');
  showPairingMethodStep();
}

function showMonitor() {
  tapOverlay?.classList.add('hidden');
  pairingSection?.classList.add('hidden');
  babyMonitor?.classList.remove('hidden');
  disconnectedScreen?.classList.add('hidden');
  enterTouchLock();
  // Show background persistence banner once monitoring is active (TASK-029).
  showBgBanner();
}

function showDisconnected(reason = '') {
  tapOverlay?.classList.add('hidden');
  pairingSection?.classList.add('hidden');
  // TASK-051: Do NOT hide the baby monitor — it remains visible beneath the
  // disconnected overlay so soothing canvas effects (candle, water, stars)
  // continue to be displayed for the baby.  Audio also continues uninterrupted.
  disconnectedScreen?.classList.remove('hidden');
  if (disconnectedHeading) disconnectedHeading.textContent = 'Disconnected';
  if (reconnectStatus) reconnectStatus.textContent = reason;
}

// ---------------------------------------------------------------------------
// Pairing flow (TASK-006)
// ---------------------------------------------------------------------------

function showPairingMethodStep() {
  pairingMethodStep?.classList.remove('hidden');
  pairingPeerjsStep?.classList.add('hidden');
  pairingOfflineStep?.classList.add('hidden');
}

/** Start pairing via PeerJS. */
async function startPeerJsPairing() {
  pairingMethodStep?.classList.add('hidden');
  pairingPeerjsStep?.classList.remove('hidden');

  // Remove any "Try Offline QR" fallback button from a previous attempt
  pairingPeerjsStep?.querySelector('.peerjs-fallback-btn')?.remove();

  if (pairingStatusPeerjs) pairingStatusPeerjs.textContent = 'Connecting to pairing server…';

  // Unsubscribe any previous status listener to prevent duplicates
  _peerStatusUnsub?.();

  // Register a status listener that drives the pairing UI in real time.
  // This fires for the full lifecycle: registering → ready → disconnected → error.
  _peerStatusUnsub = onPeerStatus((status, detail) => {
    // Only update UI while the PeerJS pairing step is visible
    if (pairingPeerjsStep?.classList.contains('hidden')) return;

    if (status === 'disconnected') {
      if (pairingStatusPeerjs) pairingStatusPeerjs.textContent = 'Reconnecting to pairing server…';
    } else if (status === 'error') {
      const msg = detail?.message ?? 'PeerJS connection error. Try Offline QR pairing.';
      if (pairingStatusPeerjs) pairingStatusPeerjs.textContent = msg;

      // When the server is unreachable, offer a one-tap fallback to Offline QR
      if (detail?.serverUnavailable || detail?.type === PEER_ERROR.LIBRARY_UNAVAILABLE) {
        _showPeerjsOfflineFallback();
      }
    }
  });

  try {
    const peerjsServerConfig = lsGet(SETTING_KEYS.PEERJS_SERVER, null);
    const peerId = await initPeer(peerjsServerConfig);

    // Show QR code of our peer ID for the parent to scan
    if (peerjsQrContainer) renderQR(peerjsQrContainer, peerId, { size: 240 });
    if (peerIdText) peerIdText.textContent = peerId;
    if (pairingStatusPeerjs) pairingStatusPeerjs.textContent = 'Waiting for parent to connect…';

    // PeerJS pairing flow:
    // 1. Parent scans our QR code and opens a data connection to this device.
    // 2. We receive the connection, read the parent's peer ID from conn.peer.
    // 3. We acquire the media stream and call the parent back with our stream.
    // 4. Parent listens for our call and receives our video/audio via parentListenPeerJs().
    const peer = getPeer();

    const onParentConnection = async (dataConn) => {
      // Ignore if we already navigated away from the pairing step
      if (pairingPeerjsStep?.classList.contains('hidden')) return;

      // Only handle the first valid connection; remove listener to prevent duplicates
      peer.off('connection', onParentConnection);

      const parentPeerId = dataConn.peer;
      if (pairingStatusPeerjs) pairingStatusPeerjs.textContent = 'Parent connected — starting camera…';

      try {
        localStream = await getUserMediaStream();
        if (pairingStatusPeerjs) pairingStatusPeerjs.textContent = 'Establishing connection…';

        // TASK-030: store parent ID and method for auto-reconnect
        _parentPeerId = parentPeerId;
        _lastConnectionMethod = 'peerjs';

        await babyCallParent(parentPeerId, localStream, {
          onReady(conn) {
            _peerStatusUnsub?.();
            _peerStatusUnsub = null;
            activeConnection = conn;
            stopScanner();
            startMonitor(conn);
          },
          onState(connState) {
            _handleConnectionStateChange(connState);
          },
          onMessage(msg) {
            handleDataMessage(msg);
          },
        });
      } catch (err) {
        console.error('[baby] Error getting stream or calling parent:', err);
        if (pairingStatusPeerjs) {
          pairingStatusPeerjs.textContent =
            err.message || 'Could not access camera or microphone. Please check your permissions and try again.';
        }
        // Re-attach listener so the user can retry from the parent side
        peer.on('connection', onParentConnection);
      }
    };

    peer.on('connection', onParentConnection);
  } catch (err) {
    // Fatal error: the status listener already updated pairingStatusPeerjs text
    // and may have shown the offline fallback button. Just log for debugging.
    console.error('[baby] PeerJS pairing fatal error:', err);
  }
}

/**
 * Show a "Use Offline QR instead" button in the PeerJS pairing step.
 * Called when the PeerJS server is unreachable so the user has a clear
 * one-tap path to the offline connection method.
 */
function _showPeerjsOfflineFallback() {
  if (!pairingPeerjsStep) return;
  // Avoid duplicates
  if (pairingPeerjsStep.querySelector('.peerjs-fallback-btn')) return;

  const btn = document.createElement('button');
  btn.className   = 'action-btn peerjs-fallback-btn';
  btn.textContent = 'Use Offline QR instead';
  btn.setAttribute('aria-label', 'Switch to Offline QR pairing');

  btn.addEventListener('click', () => {
    _peerStatusUnsub?.();
    _peerStatusUnsub = null;
    destroyPeer();
    // Return to method selection so the user can pick Offline QR
    pairingPeerjsStep?.classList.add('hidden');
    pairingMethodStep?.classList.remove('hidden');
  });

  // Insert the button just before the status line so it's prominent
  if (pairingStatusPeerjs) {
    pairingPeerjsStep.insertBefore(btn, pairingStatusPeerjs);
  } else {
    pairingPeerjsStep.appendChild(btn);
  }
}

/** Start pairing via offline QR exchange. */
async function startOfflinePairing() {
  pairingMethodStep?.classList.add('hidden');
  pairingOfflineStep?.classList.remove('hidden');

  if (offlineQrContainer) offlineQrContainer.innerHTML = '<div class="qr-placeholder">Generating offer…</div>';

  try {
    // Step 1: get media stream for inclusion in the offer
    localStream = await getUserMediaStream();

    // TASK-030: record connection method for auto-reconnect
    _lastConnectionMethod = 'offline';

    // Step 2: generate SDP offer + ICE candidates
    const offerJson = await offlineBabyCreateOffer(localStream, {
      onReady(conn) {
        activeConnection = conn;
        startMonitor(conn);
      },
      onState(s) {
        _handleConnectionStateChange(s);
      },
      onMessage(msg) {
        handleDataMessage(msg);
      },
    });

    // Step 3: encode offer as QR grid for parent to scan.
    // No explicit qrSize: renderQRGrid will size cells to fit the container.
    if (offlineQrContainer) {
      renderQRGrid(offlineQrContainer, offerJson);
    }
    if (pairingInstruction) {
      pairingInstruction.textContent = 'Show this grid to the parent device camera, then scan the parent\'s answer.';
    }

    // Step 4: show scanner to receive parent answer
    if (offlineScannerContainer) offlineScannerContainer.classList.remove('hidden');

    const answerJson = await scanMulti(offlineScanVideo, {
      onProgress(scanned, total) {
        if (offlineScanProgress) {
          offlineScanProgress.textContent = total
            ? `Scanned ${scanned} of ${total} codes`
            : `Scanned ${scanned} code(s)…`;
        }
      },
    });

    // Step 5: receive the answer
    await offlineBabyReceiveAnswer(answerJson, {
      onReady(conn) {
        activeConnection = conn;
        startMonitor(conn);
      },
      onState(s) {
        _handleConnectionStateChange(s);
      },
    });
  } catch (err) {
    console.error('[baby] Offline pairing error:', err);
    if (pairingStatusOffline) {
      pairingStatusOffline.textContent =
        err.message || 'Pairing failed. Please try again.';
    }
  }
}

// ---------------------------------------------------------------------------
// Media capture (TASK-010)
// ---------------------------------------------------------------------------

/** Quality presets for getUserMedia constraints. */
const QUALITY_PRESETS = {
  low:    { width: 320,  height: 240, frameRate: 10 },
  medium: { width: 640,  height: 480, frameRate: 15 },
  high:   { width: 1280, height: 720, frameRate: 24 },
};

/**
 * Request camera and microphone access.
 *
 * Falls back to audio-only automatically if camera access is denied or
 * unavailable, updating `state.audioOnly` accordingly.  If even microphone
 * access is denied the function throws an Error with a user-facing message
 * that explains how to restore access.
 *
 * Camera facing direction is read from `state.cameraFacing` (never hard-coded)
 * so that TASK-041's camera selection UI can drive it via state.
 *
 * @returns {Promise<MediaStream>}
 * @throws {Error} if no media access can be obtained
 */
async function getUserMediaStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Camera and microphone are not supported in this browser. Try Chrome or Firefox.',
    );
  }

  const q = QUALITY_PRESETS[state.quality] ?? QUALITY_PRESETS.medium;
  const constraints = {
    video: state.audioOnly ? false : {
      facingMode: { ideal: state.cameraFacing },
      width:      { ideal: q.width },
      height:     { ideal: q.height },
      frameRate:  { ideal: q.frameRate },
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStream = stream;
    return stream;
  } catch (err) {
    console.error('[baby] getUserMedia failed:', err.name, err.message);
    const name = err.name ?? '';

    // A microphone-only request failing means access was denied entirely.
    if (state.audioOnly) {
      throw _mediaErrorMessage(name, /* audioOnly */ true);
    }

    // Camera unavailable or permission denied — fall back to audio-only.
    console.warn('[baby] Camera unavailable; falling back to audio-only');
    state.audioOnly = true;
    if (audioOnlyToggle) audioOnlyToggle.checked = true;

    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream = audioStream;
      return audioStream;
    } catch (audioErr) {
      console.error('[baby] Audio-only fallback also failed:', audioErr.name);
      throw _mediaErrorMessage(audioErr.name ?? '', /* audioOnly */ true);
    }
  }
}

/**
 * Build a user-facing Error for media permission or availability failures.
 * @param {string}  errorName — DOMException name from getUserMedia
 * @param {boolean} audioOnly — true if the failing request was for audio only
 * @returns {Error}
 */
function _mediaErrorMessage(errorName, audioOnly) {
  const denied   = errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError';
  const notFound = errorName === 'NotFoundError'   || errorName === 'DevicesNotFoundError';
  if (denied) {
    return new Error(audioOnly
      ? 'Microphone access was denied. Please allow microphone access in your browser settings and refresh the page.'
      : 'Camera and microphone access was denied. Please allow access in your browser settings and refresh the page.',
    );
  }
  if (notFound) {
    return new Error(audioOnly
      ? 'No microphone was found. Please connect a microphone and try again.'
      : 'No camera or microphone was found. Please connect a camera and try again.',
    );
  }
  return new Error(
    `Could not access ${audioOnly ? 'microphone' : 'camera and microphone'} (${errorName || 'unknown error'}).`,
  );
}

/**
 * Enable or disable video capture (audio-only mode).
 *
 * When a live peer connection is active, the video RTCRtpSender's track is
 * replaced with null (audio-only on) or a fresh video track (audio-only off)
 * so the change takes effect immediately without renegotiation.
 *
 * @param {boolean} audioOnly — true = disable video track, false = re-enable
 */
async function applyAudioOnlyMode(audioOnly) {
  state.audioOnly = audioOnly;
  saveSetting(SETTING_KEYS.AUDIO_ONLY, audioOnly);

  // Keep the UI checkbox in sync.
  if (audioOnlyToggle) audioOnlyToggle.checked = audioOnly;

  if (!localStream) {
    // No active stream yet — state will be applied when getUserMediaStream() is called.
    return;
  }

  if (audioOnly) {
    // Stop all video tracks on the local stream and blank the video sender.
    for (const track of localStream.getVideoTracks()) {
      track.stop();
      localStream.removeTrack(track);
    }
    if (activeConnection?.peerConnection) {
      const videoSender = activeConnection.peerConnection.getSenders()
        .find(s => s.track?.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(null).catch(e => {
          console.warn('[baby] replaceTrack(null) for audio-only failed:', e);
        });
      }
    }
  } else {
    // Re-acquire a video track and push it to the peer connection.
    try {
      const q = QUALITY_PRESETS[state.quality] ?? QUALITY_PRESETS.medium;
      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: state.cameraFacing },
          width:      { ideal: q.width },
          height:     { ideal: q.height },
          frameRate:  { ideal: q.frameRate },
        },
        audio: false,
      });
      const videoTrack = newVideoStream.getVideoTracks()[0];
      if (videoTrack) {
        localStream.addTrack(videoTrack);
        if (activeConnection?.peerConnection) {
          // Replace the nulled-out video sender (no renegotiation needed).
          const senders = activeConnection.peerConnection.getSenders();
          const videoSender = senders.find(s => s.track === null || s.track?.kind === 'video');
          if (videoSender) {
            await videoSender.replaceTrack(videoTrack).catch(e => {
              console.warn('[baby] replaceTrack(videoTrack) for video re-enable failed:', e);
            });
          }
        }
      }
    } catch (err) {
      console.error('[baby] Could not re-enable video:', err);
      // Revert: stay in audio-only mode if the camera is now unavailable.
      state.audioOnly = true;
      if (audioOnlyToggle) audioOnlyToggle.checked = true;
      saveSetting(SETTING_KEYS.AUDIO_ONLY, true);
    }
  }

  sendStateSnapshot();
}

// ---------------------------------------------------------------------------
// Screen dim mode (TASK-028)
// ---------------------------------------------------------------------------

/**
 * Activate or deactivate the screen-dim mode on the baby device.
 *
 * When dimmed the display fades to near-black so the screen light does not
 * disturb the baby.  The WebRTC connection (audio, video, data channel)
 * remains fully active.  Battery impact: significant — backlight is the
 * primary power drain on mobile devices.
 *
 * @param {boolean} dimmed — true = near-black display, false = normal brightness
 */
function applyScreenDimMode(dimmed) {
  state.screenDim = dimmed;

  // Toggle the CSS class that applies the dim overlay
  babyMonitor?.classList.toggle('baby-monitor--screen-dim', dimmed);

  // Keep the local settings toggle in sync
  if (screenDimToggle) screenDimToggle.checked = dimmed;

  sendStateSnapshot();
}

// ---------------------------------------------------------------------------
// Quality constraint reapplication (TASK-028)
// ---------------------------------------------------------------------------

/**
 * Apply the currently selected quality preset to the live stream.
 *
 * When a quality change is received (locally or from the parent via
 * SET_QUALITY), this function re-acquires a video track at the new
 * resolution/frame-rate and replaces the outgoing RTP track without full
 * renegotiation.
 *
 * Preset mapping:
 *   low    — 320 × 240 @ 10 fps  (~saves ~60 % battery vs high)
 *   medium — 640 × 480 @ 15 fps  (default)
 *   high   — 1280 × 720 @ 24 fps
 *
 * @param {string} quality — 'low' | 'medium' | 'high'
 */
async function applyQualityConstraints(quality) {
  state.quality = quality;
  saveSetting(SETTING_KEYS.VIDEO_QUALITY, quality);

  if (state.audioOnly || !localStream) {
    // No active video track — the new preset will be applied next time
    // getUserMediaStream() is called.
    sendStateSnapshot();
    return;
  }

  try {
    const q = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.medium;
    // Re-acquire a video track at the new constraints
    const newVideoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: state.cameraFacing },
        width:      { ideal: q.width },
        height:     { ideal: q.height },
        frameRate:  { ideal: q.frameRate },
      },
      audio: false,
    });

    const newVideoTrack = newVideoStream.getVideoTracks()[0];
    if (!newVideoTrack) return;

    // Stop old video tracks on localStream and swap in the new one
    for (const track of localStream.getVideoTracks()) {
      track.stop();
      localStream.removeTrack(track);
    }
    localStream.addTrack(newVideoTrack);

    // Replace the outgoing RTP sender track (no renegotiation required)
    if (activeConnection?.peerConnection) {
      const senders = activeConnection.peerConnection.getSenders();
      const videoSender = senders.find(s => s.track?.kind === 'video' || s.track === null);
      if (videoSender) {
        await videoSender.replaceTrack(newVideoTrack).catch(e => {
          console.warn('[baby] replaceTrack for quality change failed:', e);
        });
      }
    }

    console.log(`[baby] Quality changed to ${quality}: ${q.width}×${q.height} @ ${q.frameRate}fps`);
  } catch (err) {
    console.error('[baby] Could not apply quality constraints:', err);
  }

  sendStateSnapshot();
}

// ---------------------------------------------------------------------------
// Video-paused mode (TASK-028) — parent-commanded video pause
// ---------------------------------------------------------------------------

/**
 * Pause or resume the outgoing video track on parent's command.
 *
 * This is distinct from audio-only mode: video-paused is a temporary,
 * parent-initiated state that disables video while keeping both audio and
 * the data channel live.  The local `state.audioOnly` setting is unchanged
 * so that toggling this off restores video automatically.
 *
 * @param {boolean} paused — true = stop sending video, false = resume
 */
async function applyVideoPaused(paused) {
  state.videoPaused = paused;

  if (!localStream || state.audioOnly) {
    // Audio-only mode already covers this; nothing extra needed.
    sendStateSnapshot();
    return;
  }

  if (paused) {
    // Disable video tracks without stopping them permanently (enabled = false
    // keeps the track alive so it can be re-enabled without getUserMedia)
    for (const track of localStream.getVideoTracks()) {
      track.enabled = false;
    }
  } else {
    // Re-enable all video tracks
    for (const track of localStream.getVideoTracks()) {
      track.enabled = true;
    }
  }

  sendStateSnapshot();
}

// ---------------------------------------------------------------------------
// Monitor mode
// ---------------------------------------------------------------------------

/**
 * Enter the active baby monitor view once connected.
 * @param {object} conn
 */
function startMonitor(conn) {
  showMonitor();
  updateConnectionStatus('connected');
  // Ensure canvas is pixel-perfect before rendering the first soothing frame.
  _resizeCanvas();
  // Sync settings UI to current state so toggles reflect reality when overlay opens.
  if (audioOnlyToggle) audioOnlyToggle.checked = state.audioOnly;
  if (screenDimToggle) screenDimToggle.checked = state.screenDim;
  _updateCameraFacingUI(); // TASK-041: sync camera direction indicator in settings overlay
  // TASK-032: sync orientation select and default track from saved settings.
  if (orientationSelect) orientationSelect.value = settings.orientation ?? 'auto';
  _applyOrientationLock(settings.orientation ?? 'auto');  // TASK-040: lock on entry
  if (babyDefaultTrack) babyDefaultTrack.value = settings.defaultTrack ?? '';
  startBatteryMonitoring(); // TASK-020
  sendStateSnapshot();     // TASK-048
  // TASK-051: Only start soothing on the first connection.  On reconnection the
  // soothing mode is already running (music player / canvas loop / fade timer)
  // and must not be interrupted.  Calling startSoothingMode() again would stop
  // and restart audio (clearing the pre-scheduled Web Audio API fade ramp) and
  // cause a brief canvas flicker.
  if (!_soothingInitialized) {
    _soothingInitialized = true;
    startSoothingMode(state.soothingMode);
  }
  setupStatusFade();
  _setupSpeakThrough(conn); // TASK-012
  // TASK-061: Send backup ID pool immediately after data channel is ready so
  // the parent can use it for auto-reconnection (TASK-030) and second-parent
  // access (TASK-058).  Also check replenishment in case the pool has shrunk
  // from a previous session's reconnects.
  _sendIdPool(conn);
  _checkAndReplenishPool();
}

/** Update the connection status indicator. */
function updateConnectionStatus(connState) {
  // E2E test hook (TASK-063): expose connection state for Playwright assertions.
  window.__peerState = connState;
  if (!babyConnStatus) return;
  babyConnStatus.className = 'status-badge';
  if (connState === 'connected')    babyConnStatus.classList.add('connected');
  if (connState === 'reconnecting') babyConnStatus.classList.add('reconnecting');
}

// ---------------------------------------------------------------------------
// Speak-through receiver (TASK-012)
// ---------------------------------------------------------------------------

/**
 * Set up the speak-through audio receiver on the baby device.
 *
 * Listens for incoming audio tracks on the peer connection — these are added
 * dynamically by the parent when the parent activates speak-through.  When a
 * track arrives it is attached to the hidden <audio> element so the baby
 * device's speakers play the parent's voice.
 *
 * Echo cancellation is applied on the parent side; no special handling is
 * needed here beyond playing the stream.
 *
 * @param {object} conn — normalised connection object with .peerConnection
 */
function _setupSpeakThrough(conn) {
  const pc = conn.peerConnection;
  if (!pc) {
    console.warn('[baby] No peerConnection for speak-through — skipping (TASK-012)');
    return;
  }

  const speakAudio = /** @type {HTMLAudioElement|null} */ (
    document.getElementById('speak-through-audio')
  );
  if (!speakAudio) return;

  pc.addEventListener('track', async (event) => {
    // Only handle incoming audio tracks; ignore video tracks from the baby's
    // own stream (which are outgoing and do not trigger this event anyway).
    if (event.track.kind !== 'audio') return;

    // Attach the incoming track to the audio element so it plays immediately.
    // Each new speak session (after addTrack/removeTrack renegotiation) delivers
    // a fresh track, so we replace srcObject each time.
    const speakStream = new MediaStream([event.track]);
    speakAudio.srcObject = speakStream;
    speakAudio.play().catch(err => {
      // Autoplay may be blocked before user interaction; the tap-to-begin
      // overlay should have already satisfied the browser's interaction requirement.
      console.warn('[baby] speak-through audio play() failed (TASK-012):', err);
    });

    // TASK-038: start the ducking detector on the incoming speak-through stream.
    // Ensure the shared AudioContext exists first (it may not have been created
    // yet if the user has not started music playback).
    try {
      await _ensureAudioCtx();
      _startDuckingDetector(speakStream);
    } catch (err) {
      console.warn('[baby] Could not start ducking detector (TASK-038):', err);
    }

    console.log('[baby] Speak-through audio track received (TASK-012)');
  });
}

/**
 * Show or hide the "parent is speaking" visual indicator on the baby monitor.
 * @param {boolean} visible
 */
function _showSpeakThroughIndicator(visible) {
  const indicator = document.getElementById('speak-through-indicator');
  if (!indicator) return;
  indicator.classList.toggle('hidden', !visible);
}

// ---------------------------------------------------------------------------
// Soothing modes (TASK-015, TASK-016, TASK-017, TASK-018)
// ---------------------------------------------------------------------------

/** @type {number|null} Canvas animation frame ID */
let _animFrame = null;

/**
 * Resize the soothing canvas to match the current window dimensions.
 * Called on init and on every window resize so all canvas-based effects
 * (candle, water, stars) always render at the correct pixel dimensions.
 */
function _resizeCanvas() {
  if (!soothingCanvas) return;
  soothingCanvas.width  = window.innerWidth;
  soothingCanvas.height = window.innerHeight;
}

// Keep the canvas pixel-perfect whenever the window resizes (orientation
// change, split-screen, browser chrome appearing/disappearing).
window.addEventListener('resize', _resizeCanvas, { passive: true });

/**
 * Start the selected soothing mode.
 * Full implementations provided in TASK-016, TASK-017, TASK-018.
 * @param {string} mode
 */
function startSoothingMode(mode) {
  if (_animFrame !== null) {
    cancelAnimationFrame(_animFrame);
    _animFrame = null;
  }

  // Stop music if we are leaving music mode (TASK-019).
  if (state.soothingMode === 'music' && mode !== 'music') {
    _stopMusicMode();
  }

  state.soothingMode = mode;

  // Expose current mode on the monitor element for CSS targeting (e.g. music
  // mode dimming via .baby-monitor[data-soothing-mode="music"]).
  babyMonitor?.setAttribute('data-soothing-mode', mode);

  // Update aria-pressed on mode buttons
  for (const btn of modeBtns) {
    btn.setAttribute('aria-pressed', btn.dataset.mode === mode ? 'true' : 'false');
  }

  // Ensure canvas dimensions are correct before any rendering.
  _resizeCanvas();

  switch (mode) {
    case 'candle': _startCandleEffect();   break; // TASK-016
    case 'water':  _startWaterEffect();    break; // TASK-017
    case 'stars':  _startStarsEffect();    break; // TASK-018
    case 'music':  _startMusicMode();      break; // TASK-019
    case 'off':    _clearCanvas();         break;
    default:       _clearCanvas();
  }
}

function _clearCanvas() {
  if (!soothingCanvas) return;
  const ctx = soothingCanvas.getContext('2d');
  ctx.clearRect(0, 0, soothingCanvas.width, soothingCanvas.height);
  soothingCanvas.style.background = '#000';
}

/**
 * Candle light soothing effect (TASK-016).
 *
 * Renders a fullscreen animated candle scene: a wax pillar in the lower-centre
 * of the screen with an organic flickering flame drawn using bezier curves and
 * warm orange/yellow/red gradients. A very dim radial ambient glow simulates
 * the candlelight softly illuminating a dark room.
 *
 * Design goals:
 *  - Lightweight: 24 fps via requestAnimationFrame + timestamp throttle
 *  - Organic feel: flame height, sway, and room brightness are driven by
 *    overlapping sine waves at incommensurable frequencies (no true Perlin
 *    noise needed at this scale)
 *  - Battery-friendly: simple 2-D canvas geometry, no per-pixel operations
 *  - Suitable for a dark nursery: background stays very dark (#090402)
 */
function _startCandleEffect() {
  if (!soothingCanvas) return;
  const ctx = soothingCanvas.getContext('2d');

  const TARGET_FPS = 24;
  const FRAME_MS   = 1000 / TARGET_FPS;
  let   lastMs     = 0;

  // Time accumulator advanced each rendered frame.
  let t = 0;

  /**
   * Organic "noise" via summed sines at incommensurable frequencies.
   * Returns a value in approximately [−1, 1].
   * @param {number} base  Primary time value.
   * @param {number} phase Per-oscillator phase offset so height/sway/brightness
   *                       vary independently.
   */
  function organicNoise(base, phase) {
    return (
      Math.sin(base * 2.1 + phase        ) * 0.35 +
      Math.sin(base * 3.7 + phase * 1.31 ) * 0.25 +
      Math.sin(base * 7.3 + phase * 2.07 ) * 0.20 +
      Math.sin(base * 0.5 + phase * 0.71 ) * 0.20
    );
  }

  function drawFrame(timestamp) {
    // Always update _animFrame first so startSoothingMode can cancel us.
    _animFrame = requestAnimationFrame(drawFrame);

    // FPS throttle — skip rendering but keep the loop alive.
    if (timestamp - lastMs < FRAME_MS) return;
    lastMs = timestamp;

    const W = soothingCanvas.width;
    const H = soothingCanvas.height;

    // Advance time for oscillator input (controls animation speed).
    t += 0.055;

    // ---- Organic variation parameters --------------------------------------

    // Flame height: ±12 % of nominal.
    const heightN    = organicNoise(t, 0.0);
    const heightMult = 0.90 + heightN * 0.12;

    // Lateral sway: small fraction of body half-width.
    const swayN  = organicNoise(t, 1.53);

    // Room brightness: slow, separate oscillation.
    const brightN = (organicNoise(t * 0.38, 2.91) + 1) * 0.5; // 0..1

    // ---- Layout ------------------------------------------------------------

    const cx      = W * 0.5;                          // candle centreline
    const bodyW   = Math.max(8, Math.min(W * 0.035, 18)); // wax half-width (px)
    const bodyH   = H * 0.12;                         // wax pillar height
    const baseY   = H * 0.80;                         // bottom of wax body
    const wickY   = baseY - bodyH;                    // top of wax / wick root

    const nomFlameH = H * 0.20;                       // nominal flame height
    const flameH    = nomFlameH * heightMult;
    const flameW    = bodyW * 1.80;                   // half-width at flame base
    const sway      = swayN * bodyW * 0.85;           // tip lateral offset (px)
    const tipX      = cx + sway;
    const tipY      = wickY - flameH;

    // ---- 1. Background — near-black with very faint warm tint --------------
    ctx.fillStyle = '#090402';
    ctx.fillRect(0, 0, W, H);

    // ---- 2. Room ambient glow — large, very dim radial gradient ------------
    const glowCY  = wickY - flameH * 0.50;
    const glowR   = Math.min(W, H) * (0.55 + brightN * 0.10);
    const glowA   = 0.044 + brightN * 0.028;
    const roomGrd = ctx.createRadialGradient(cx, glowCY, 0, cx, glowCY, glowR);
    roomGrd.addColorStop(0,    `rgba(255, 150, 40, ${glowA})`);
    roomGrd.addColorStop(0.40, `rgba(220,  90, 10, ${glowA * 0.50})`);
    roomGrd.addColorStop(0.75, `rgba(160,  50,  0, ${glowA * 0.15})`);
    roomGrd.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.fillStyle = roomGrd;
    ctx.fillRect(0, 0, W, H);

    // ---- 3. Candle body — gradient gives a subtle cylindrical feel ---------
    const waxGrd = ctx.createLinearGradient(cx - bodyW, 0, cx + bodyW, 0);
    waxGrd.addColorStop(0,    '#2a1508');
    waxGrd.addColorStop(0.25, '#5a3015');
    waxGrd.addColorStop(0.60, '#7a4820');
    waxGrd.addColorStop(1,    '#3a1c0a');
    ctx.fillStyle = waxGrd;
    ctx.fillRect(cx - bodyW, wickY, bodyW * 2, bodyH);

    // Top rim of wax (ellipse to suggest a 3-D top surface).
    ctx.beginPath();
    ctx.ellipse(cx, wickY, bodyW, bodyW * 0.35, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#9a6835';
    ctx.fill();

    // ---- 4. Wick -----------------------------------------------------------
    ctx.save();
    ctx.strokeStyle = '#150800';
    ctx.lineWidth   = 1.5;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, wickY);
    ctx.lineTo(cx + sway * 0.10, wickY - bodyW * 0.55);
    ctx.stroke();
    ctx.restore();

    // ---- 5. Outer flame glow — soft elliptical blob around the flame -------
    const blobCY  = wickY - flameH * 0.45;
    const blobR   = flameW * 3.5;
    const blobA   = 0.22 + brightN * 0.08;
    const blobGrd = ctx.createRadialGradient(cx, blobCY, 0, cx, blobCY, blobR);
    blobGrd.addColorStop(0,   `rgba(255, 140,  0, ${blobA})`);
    blobGrd.addColorStop(0.3, `rgba(255,  80,  0, ${blobA * 0.45})`);
    blobGrd.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = blobGrd;
    ctx.beginPath();
    ctx.ellipse(cx, blobCY, blobR, blobR * 1.30, 0, 0, Math.PI * 2);
    ctx.fill();

    // ---- 6. Flame outer shape — orange→red bezier tear-drop ----------------
    const outerGrd = ctx.createLinearGradient(cx, tipY, cx, wickY);
    outerGrd.addColorStop(0,    'rgba(255, 220, 100, 0.92)');
    outerGrd.addColorStop(0.30, 'rgba(255, 120,  20, 0.95)');
    outerGrd.addColorStop(0.65, 'rgba(200,  40,   0, 0.97)');
    outerGrd.addColorStop(1,    'rgba(120,  20,   0, 0.85)');

    const midY = wickY - flameH * 0.50;
    const lX   = cx - flameW;
    const rX   = cx + flameW;

    ctx.beginPath();
    ctx.moveTo(cx - bodyW * 0.50, wickY);
    // Left arc from base to tip.
    ctx.bezierCurveTo(
      lX - flameW * 0.25,   midY + flameH * 0.25,
      tipX - flameW * 0.55, midY - flameH * 0.05,
      tipX, tipY,
    );
    // Right arc from tip back to base (slight asymmetry via heightN).
    ctx.bezierCurveTo(
      tipX + flameW * 0.55 * (1 + heightN * 0.12), midY - flameH * 0.05,
      rX   + flameW * 0.25 * (1 + heightN * 0.08), midY + flameH * 0.25,
      cx + bodyW * 0.50, wickY,
    );
    ctx.closePath();
    ctx.fillStyle = outerGrd;
    ctx.fill();

    // ---- 7. Flame inner core — bright yellow-white hotspot -----------------
    const coreH   = flameH * 0.50;
    const coreW   = flameW * 0.42;
    const coreTY  = wickY - coreH;
    const coreGrd = ctx.createLinearGradient(cx, coreTY, cx, wickY);
    coreGrd.addColorStop(0,    'rgba(255, 255, 230, 0.88)');
    coreGrd.addColorStop(0.45, 'rgba(255, 235,  80, 0.82)');
    coreGrd.addColorStop(1,    'rgba(255, 160,  20, 0.40)');

    ctx.beginPath();
    ctx.moveTo(cx + sway * 0.35, coreTY);
    ctx.bezierCurveTo(
      cx - coreW,        wickY - coreH * 0.45,
      cx - coreW * 0.50, wickY - coreH * 0.05,
      cx, wickY,
    );
    ctx.bezierCurveTo(
      cx + coreW * 0.50, wickY - coreH * 0.05,
      cx + coreW,        wickY - coreH * 0.45,
      cx + sway * 0.35, coreTY,
    );
    ctx.fillStyle = coreGrd;
    ctx.fill();
  }

  _animFrame = requestAnimationFrame(drawFrame);
}

/**
 * Water light soothing effect (TASK-017).
 *
 * Renders a fullscreen animated water scene using layered 2-D canvas shapes —
 * no per-pixel operations so it stays lightweight on mobile.
 *
 * Visual layers (back → front):
 *   1. Deep-water background gradient (dark navy → mid teal)
 *   2. Three wide sine-wave bands that undulate slowly
 *   3. Caustic-light blobs — radial-gradient ellipses that orbit lazily
 *   4. Fine surface-shimmer arcs for a light-on-water glint
 *
 * All animation is driven by a single time accumulator `t`.  24 fps cap keeps
 * battery usage low.
 */
function _startWaterEffect() {
  if (!soothingCanvas) return;
  // Canvas already sized by _resizeCanvas() called in startSoothingMode().
  const ctx = soothingCanvas.getContext('2d');

  // ── Timing ───────────────────────────────────────────────────────────────
  const TARGET_FPS = 24;
  const FRAME_MS   = 1000 / TARGET_FPS;
  let lastMs = 0;
  let t = 0;

  // ── Caustic blob parameters (pre-seeded, not regenerated per frame) ───────
  const BLOB_COUNT = 6;
  const blobs = Array.from({ length: BLOB_COUNT }, (_, i) => ({
    baseX:  (i + 0.5) / BLOB_COUNT,           // horizontal anchor (0–1)
    baseY:  0.18 + (i % 3) * 0.28,            // vertical anchor rows
    rx:     0.09 + (i * 0.037 % 0.09),        // orbit X radius (fraction of W)
    ry:     0.04 + (i * 0.031 % 0.06),        // orbit Y radius (fraction of H)
    phaseX: i * 1.3,
    phaseY: i * 2.1 + 0.7,
    speed:  0.30 + (i * 0.13 % 0.25),
    size:   0.11 + (i * 0.041 % 0.10),        // blob radius (fraction of min(W,H))
    alpha:  0.07 + (i * 0.023 % 0.06),        // base opacity
  }));

  // ── Surface shimmer line parameters ──────────────────────────────────────
  const SHIMMER_COUNT = 8;
  const shimmers = Array.from({ length: SHIMMER_COUNT }, (_, i) => ({
    yFrac:  0.05 + i / SHIMMER_COUNT * 0.88,  // vertical position (fraction of H)
    phase:  i * 0.97,
    speed:  0.9 + (i * 0.17 % 0.80),
    amp:    0.05 + (i * 0.029 % 0.04),        // wave amplitude (fraction of H)
    length: 0.14 + (i * 0.037 % 0.20),        // arc half-length (fraction of W)
    alpha:  0.04 + (i * 0.011 % 0.04),
  }));

  // ── Wave band definitions ─────────────────────────────────────────────────
  const waveDefs = [
    { yBase: 0.33, amp: 0.055, freq: 1.7, phase: 0.0, speed: 0.70, color: 'rgba(29,120,180,0.18)' },
    { yBase: 0.52, amp: 0.045, freq: 2.3, phase: 1.2, speed: 0.50, color: 'rgba(40,155,185,0.15)' },
    { yBase: 0.70, amp: 0.035, freq: 3.1, phase: 2.4, speed: 0.90, color: 'rgba(75,185,205,0.12)' },
  ];

  // ── Per-frame render ──────────────────────────────────────────────────────
  function drawFrame(timestamp) {
    _animFrame = requestAnimationFrame(drawFrame);
    if (timestamp - lastMs < FRAME_MS) return;
    lastMs = timestamp;

    const W = soothingCanvas.width;
    const H = soothingCanvas.height;
    t += 0.018; // slow, calm increment

    // Layer 1 — deep-water background gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0,    '#06203a'); // deep navy
    bg.addColorStop(0.45, '#0a3d6b'); // mid blue
    bg.addColorStop(0.75, '#1a6b8a'); // teal
    bg.addColorStop(1,    '#25899e'); // lighter teal
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Layer 2 — sine-wave bands
    for (const w of waveDefs) {
      const yBase = w.yBase * H;
      const amp   = w.amp   * H;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 4) {
        const xFrac = x / W;
        const y = yBase
          + amp * Math.sin(xFrac * Math.PI * 2 * w.freq + t * w.speed + w.phase)
          + amp * 0.4 * Math.sin(xFrac * Math.PI * 2 * w.freq * 0.63 + t * w.speed * 1.31 + w.phase * 1.7);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = w.color;
      ctx.fill();
    }

    // Layer 3 — caustic-light blobs
    for (const b of blobs) {
      const cx    = (b.baseX + b.rx * Math.sin(t * b.speed         + b.phaseX)) * W;
      const cy    = (b.baseY + b.ry * Math.cos(t * b.speed * 0.71  + b.phaseY)) * H;
      const r     = b.size * Math.min(W, H);
      const alpha = b.alpha * (0.8 + 0.2 * Math.sin(t * 0.8 + b.phaseX));

      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0,   `rgba(160,230,245,${alpha.toFixed(3)})`);
      grad.addColorStop(0.4, `rgba(80,185,220,${(alpha * 0.6).toFixed(3)})`);
      grad.addColorStop(1,   'rgba(20,80,140,0)');

      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.55, Math.sin(t * 0.3 + b.phaseX) * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Layer 4 — surface shimmer highlights
    ctx.save();
    for (const s of shimmers) {
      const y     = s.yFrac * H + s.amp * H * Math.sin(t * s.speed + s.phase);
      const xMid  = (0.15 + 0.70 * ((Math.sin(t * s.speed * 0.53 + s.phase) + 1) * 0.5)) * W;
      const hLen  = s.length * W * 0.5;
      const alpha = s.alpha * (0.6 + 0.4 * Math.abs(Math.sin(t * s.speed * 1.3 + s.phase)));
      const dip   = s.amp * H * 0.5 * Math.sin(t * s.speed * 2 + s.phase);

      ctx.beginPath();
      ctx.moveTo(xMid - hLen, y);
      ctx.quadraticCurveTo(xMid, y + dip, xMid + hLen, y);
      ctx.strokeStyle = `rgba(190,240,250,${alpha.toFixed(3)})`;
      ctx.lineWidth   = 1.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  _animFrame = requestAnimationFrame(drawFrame);
}

/**
 * Stars / night-sky soothing effect (TASK-018).
 *
 * Renders a fullscreen animated starfield with the aesthetic of a projected
 * star night-light.  Visual layers (back → front):
 *   1. Deep-space radial background gradient (indigo/purple centre → near-black)
 *   2. Faint nebula blobs — two large radial-gradient discs that pulse slowly
 *   3. Stars — 160 small circles with individual opacity twinkling.
 *      Brighter/larger stars also receive a soft radial-glow halo.
 *
 * All star positions are pre-seeded once from a deterministic PRNG so the
 * layout is stable across redraws.  The whole starfield drifts with a very
 * slow rotation around the canvas centre (one full revolution ≈ 90 minutes).
 * 24 fps cap keeps battery usage low.
 *
 * Colour palette: deep indigo/purple backgrounds; white, cool-blue, and
 * pale-lavender star tints.
 */
function _startStarsEffect() {
  if (!soothingCanvas) return;
  // Canvas already sized by _resizeCanvas() called in startSoothingMode().
  const ctx = soothingCanvas.getContext('2d');

  // ── Timing ────────────────────────────────────────────────────────────────
  const TARGET_FPS = 24;
  const FRAME_MS   = 1000 / TARGET_FPS;
  let lastMs = 0;
  let t = 0;

  // ── Deterministic PRNG (mulberry32) — stable star layout ─────────────────
  let _seed = 0x9f2d3b1c;
  function rand() {
    _seed |= 0; _seed += 0x6d2b79f5 | 0;
    let z = _seed;
    z = Math.imul(z ^ (z >>> 15), 1 | z);
    z ^= z + Math.imul(z ^ (z >>> 7), 61 | z);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  // ── Star definitions ──────────────────────────────────────────────────────
  // Positions extend slightly beyond [0,1] so the canvas edges stay covered
  // even after the slow rotation has been applied.
  const STAR_COUNT = 160;
  const stars = Array.from({ length: STAR_COUNT }, () => {
    const xFrac        = -0.15 + rand() * 1.30;
    const yFrac        = -0.15 + rand() * 1.30;
    const radius       = 0.5  + rand() * 2.0;
    const baseAlpha    = 0.30 + rand() * 0.70;
    const twinkleAmp   = 0.12 + rand() * 0.30;
    const twinkleSpeed = 0.25 + rand() * 1.20;
    const twinklePhase = rand() * Math.PI * 2;
    // 0 = white/silver,  1 = cool blue,  2 = pale lavender
    const colorTint    = rand() < 0.65 ? 0 : (rand() < 0.55 ? 1 : 2);
    return { xFrac, yFrac, radius, baseAlpha, twinkleAmp, twinkleSpeed, twinklePhase, colorTint };
  });

  // ── Nebula blobs (background ambience, not rotating) ──────────────────────
  const nebulae = [
    { xFrac: 0.28, yFrac: 0.38, rFrac: 0.40, r: 70, g: 55, b: 160, baseAlpha: 0.065, speed: 0.11, phase: 0.0 },
    { xFrac: 0.68, yFrac: 0.65, rFrac: 0.32, r: 40, g: 25, b: 130, baseAlpha: 0.050, speed: 0.08, phase: 1.9 },
  ];

  // ── Per-frame render ──────────────────────────────────────────────────────
  function drawFrame(timestamp) {
    // Always store RAF handle first so startSoothingMode can cancel this loop.
    _animFrame = requestAnimationFrame(drawFrame);

    // FPS throttle — skip rendering but keep the loop alive.
    if (timestamp - lastMs < FRAME_MS) return;
    lastMs = timestamp;

    const W = soothingCanvas.width;
    const H = soothingCanvas.height;
    t += 0.015; // slow tick

    // Very slow rotation: full revolution ≈ 90 min at 24 fps
    // t accumulates 0.015 * 24 = 0.36 per second
    // rotation rate = 0.003 * 0.36 ≈ 0.00108 rad/s → 2π / 0.00108 ≈ 5820 s
    const rotation = t * 0.003;

    // ── 1. Background ────────────────────────────────────────────────────────
    const bg = ctx.createRadialGradient(
      W * 0.50, H * 0.42, 0,
      W * 0.50, H * 0.42, Math.max(W, H) * 0.80,
    );
    bg.addColorStop(0,    '#1c1045'); // deep indigo-purple
    bg.addColorStop(0.40, '#0c0828'); // dark indigo
    bg.addColorStop(0.75, '#06041a'); // near-black blue
    bg.addColorStop(1,    '#020209'); // almost black
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── 2. Nebula blobs ───────────────────────────────────────────────────────
    for (const n of nebulae) {
      const cx    = n.xFrac * W;
      const cy    = n.yFrac * H;
      const r     = n.rFrac * Math.min(W, H);
      const alpha = n.baseAlpha * (0.70 + 0.30 * Math.sin(t * n.speed + n.phase));
      const grad  = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0,   `rgba(${n.r},${n.g},${n.b},${alpha.toFixed(3)})`);
      grad.addColorStop(0.5, `rgba(${n.r},${n.g},${n.b},${(alpha * 0.4).toFixed(3)})`);
      grad.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── 3. Stars ──────────────────────────────────────────────────────────────
    ctx.save();
    // Rotate slowly around the canvas centre to simulate a night-light projector.
    ctx.translate(W * 0.5, H * 0.5);
    ctx.rotate(rotation);
    ctx.translate(-W * 0.5, -H * 0.5);

    for (const s of stars) {
      const x = s.xFrac * W;
      const y = s.yFrac * H;

      // Twinkling opacity.
      const alpha = Math.max(0.02, Math.min(1,
        s.baseAlpha + s.twinkleAmp * Math.sin(t * s.twinkleSpeed + s.twinklePhase),
      ));

      // Colour channels — brighter at peak opacity.
      const lum = 195 + Math.round(alpha * 60); // 195–255
      let cr, cg, cb;
      if (s.colorTint === 1) {        // cool blue
        cr = Math.round(lum * 0.72); cg = Math.round(lum * 0.87); cb = lum;
      } else if (s.colorTint === 2) { // pale lavender
        cr = Math.round(lum * 0.88); cg = Math.round(lum * 0.75); cb = lum;
      } else {                        // white / silver
        cr = lum; cg = lum; cb = lum;
      }

      // Soft glow halo for the brightest, largest stars.
      if (s.baseAlpha > 0.78 && s.radius > 1.3) {
        const glowR = s.radius * 4.0;
        const halo  = ctx.createRadialGradient(x, y, 0, x, y, glowR);
        halo.addColorStop(0,   `rgba(${cr},${cg},${cb},${(alpha * 0.35).toFixed(3)})`);
        halo.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Star dot.
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, s.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  _animFrame = requestAnimationFrame(drawFrame);
}

/**
 * Music mode (TASK-019).
 *
 * Dims the canvas to near-black and starts looped playback of the selected
 * (or default) bundled soothing track via the Web Audio API.
 *
 * The screen dims automatically through CSS targeting
 * .baby-monitor[data-soothing-mode="music"] — no class toggle required here.
 * Additionally, the screen-dim overlay is applied programmatically so that
 * the display reaches near-black even on bright/HDR panels.
 *
 * Audio is routed through _audioGain (the shared master volume node) so
 * MSG.SET_VOLUME changes apply to bundled tracks just as they do to received
 * file audio.
 */
async function _startMusicMode() {
  _clearCanvas();

  // Apply the screen-dim overlay (TASK-019 requirement: dim to near-black
  // while audio plays).  We save any pre-existing dim preference so that
  // leaving music mode restores the original state.
  if (!state.screenDim) {
    babyMonitor?.classList.add('baby-monitor--screen-dim');
    // _musicModeDimApplied tracks that WE toggled it; used by _stopMusicMode().
    _musicModeDimApplied = true;
  }

  try {
    await _ensureAudioCtx();

    // Attach the music player to the shared AudioContext on first use.
    if (!_musicPlayerAttached && _audioCtx && _audioGain) {
      attachMusicPlayer(_audioCtx, _audioGain);
      _musicPlayerAttached = true;
    }

    // Use the saved track or fall back to white noise.
    const track = state.currentTrack ?? BUILTIN_TRACKS[0];
    state.currentTrack = track;
    _mpPlayTrack(track);

    console.log('[baby] Music mode started — track:', track, '(TASK-019)');
  } catch (err) {
    console.error('[baby] Failed to start music mode:', err);
  }
}

/**
 * Stop music playback and remove the auto-applied screen-dim overlay.
 * Called by startSoothingMode() when switching away from music mode.
 */
function _stopMusicMode() {
  _mpStopTrack();

  // Only remove the dim overlay if music mode was the one that applied it.
  if (_musicModeDimApplied) {
    babyMonitor?.classList.remove('baby-monitor--screen-dim');
    _musicModeDimApplied = false;
  }
}

// ---------------------------------------------------------------------------
// Fade-out timer (TASK-014 / TASK-019)
// ---------------------------------------------------------------------------

/**
 * Start the fade-out countdown timer (TASK-014).
 *
 * The audio fade uses a pre-scheduled exponential GainNode ramp (no polling):
 *   fade window = 10% of `seconds`, clamped between 30 s and 300 s (5 min).
 * The countdown ticker (setInterval, 1 s) is used only to broadcast
 * STATE_SNAPSHOT updates so the parent dashboard shows a live countdown.
 * A one-shot setTimeout stops the source node when the timer expires.
 *
 * Cancels any previously running timer before starting.
 *
 * @param {number} seconds — countdown duration in seconds (0 = cancel)
 */
function startFadeTimer(seconds) {
  cancelFadeTimer();
  if (seconds <= 0) return;

  state.fadeRemaining = seconds;
  state.fadeDuration  = seconds;
  sendStateSnapshot();

  // Pre-schedule the exponential GainNode ramp via the Web Audio API clock.
  // This ensures frame-accurate fading without polling.
  if (state.soothingMode === 'music' && _mpIsPlaying()) {
    _mpScheduleFadeOut(seconds);
  }

  // One-shot timeout: stops playback and turns off soothing when timer expires.
  _fadeTimerStopId = setTimeout(() => {
    _fadeTimerStopId = null;
    clearInterval(_fadeTimerIntervalId);
    _fadeTimerIntervalId = null;
    state.fadeRemaining = 0;

    console.log('[baby] Fade timer expired — stopping soothing mode (TASK-014)');

    if (state.soothingMode === 'music') {
      // The GainNode ramp has already silenced the audio; just stop the source.
      _mpStopTrack();
      if (_musicModeDimApplied) {
        babyMonitor?.classList.remove('baby-monitor--screen-dim');
        _musicModeDimApplied = false;
      }
      state.soothingMode = 'off';
      babyMonitor?.setAttribute('data-soothing-mode', 'off');
      _clearCanvas();
    } else {
      // Non-music soothing mode — stop canvas effects.
      startSoothingMode('off');
    }
    sendStateSnapshot();
  }, seconds * 1000);

  // Countdown ticker: decrements state.fadeRemaining every second and
  // broadcasts STATE_SNAPSHOT so the parent can show a live countdown.
  _fadeTimerIntervalId = setInterval(() => {
    if (state.fadeRemaining > 0) {
      state.fadeRemaining--;
      sendStateSnapshot();
    }
  }, 1000);
}

/**
 * Cancel the active fade-out timer (if any) and restore audio to full volume.
 *
 * Clears:
 *   - the countdown interval
 *   - the expiry setTimeout
 *   - any pre-scheduled GainNode ramp (restores gain to 1.0 immediately)
 */
function cancelFadeTimer() {
  if (_fadeTimerIntervalId !== null) {
    clearInterval(_fadeTimerIntervalId);
    _fadeTimerIntervalId = null;
  }
  if (_fadeTimerStopId !== null) {
    clearTimeout(_fadeTimerStopId);
    _fadeTimerStopId = null;
  }
  // Cancel any pre-scheduled GainNode ramp and restore volume to 1.0.
  _mpCancelScheduledFade();
  state.fadeRemaining = 0;
  state.fadeDuration  = 0;
}

// ---------------------------------------------------------------------------
// Status indicator fade (TASK-015)
// ---------------------------------------------------------------------------

/** @type {number|null} Timeout ID for fading the status bar */
let _statusFadeTimeout = null;

/**
 * Set up the status indicator (and settings button) fade behaviour (TASK-015).
 *
 * Both elements are shown immediately when the monitor starts, then fade out
 * after 4 seconds of inactivity. Any touch or click on the monitor surface
 * brings them back for another 4 seconds so the user can see connection/battery
 * state without requiring the settings overlay to open.
 */
function setupStatusFade() {
  const statusEl = document.getElementById('baby-status');
  if (!statusEl) return;

  /** Show both status and settings button, then schedule a fade. */
  function showStatus() {
    statusEl.classList.remove('faded');
    soothingSettingsBtn?.classList.remove('faded');
    clearTimeout(_statusFadeTimeout);
    _statusFadeTimeout = setTimeout(() => {
      statusEl.classList.add('faded');
      soothingSettingsBtn?.classList.add('faded');
    }, 4000);
  }

  // Show immediately when the monitor goes live.
  showStatus();

  // Re-show on any interaction with the monitor area.
  // Use both touchstart (mobile) and pointerdown (mouse/stylus) so desktop
  // testing also works; passive:true avoids scroll jank.
  babyMonitor?.addEventListener('touchstart', showStatus, { passive: true });
  babyMonitor?.addEventListener('pointerdown', showStatus, { passive: true });
}

// ---------------------------------------------------------------------------
// Battery monitoring (TASK-020)
// ---------------------------------------------------------------------------

async function startBatteryMonitoring() {
  if (!('getBattery' in navigator)) {
    // Battery Status API not supported — tell the parent so it shows "unknown"
    if (activeConnection?.dataChannel) {
      sendMessage(activeConnection.dataChannel, MSG.BATTERY_LEVEL, { level: null, charging: null });
    }
    if (babyBattery) {
      babyBattery.textContent = '?';
      babyBattery.setAttribute('aria-label', 'Battery level unknown');
    }
    return;
  }

  try {
    const battery = await navigator.getBattery();

    function broadcast() {
      const level   = Math.round(battery.level * 100);
      const charging = battery.charging;

      // TASK-048: cache battery state so sendStateSnapshot() can include it.
      _batteryLevel   = level;
      _batteryCharging = charging;

      if (babyBattery) {
        babyBattery.textContent = `${level}%${charging ? ' ⚡' : ''}`;
        babyBattery.setAttribute('aria-label', `Battery ${level}%${charging ? ', charging' : ''}`);
      }
      // Send to parent if connected
      if (activeConnection?.dataChannel) {
        sendMessage(activeConnection.dataChannel, MSG.BATTERY_LEVEL, { level, charging });
        // TASK-048: also push a full state snapshot so the parent control panel
        // reflects the latest battery state (e.g. on initial read after connect,
        // or when charging state changes).
        sendStateSnapshot();
      }
      // Local low-battery warning
      if (level < 20 && !charging) {
        babyBattery?.classList.add('battery-low');
        // Send a dedicated alert to the parent once per low-battery episode
        // (distinct from the regular periodic BATTERY_LEVEL broadcast)
        if (activeConnection?.dataChannel && !_batteryAlertSent) {
          _batteryAlertSent = true;
          sendMessage(activeConnection.dataChannel, MSG.ALERT_BATTERY_LOW, { level });
        }
      } else {
        babyBattery?.classList.remove('battery-low');
        _batteryAlertSent = false; // Reset so a future drop triggers a new alert
      }
    }

    broadcast();
    battery.addEventListener('levelchange',  broadcast);
    battery.addEventListener('chargingchange', broadcast);
    setInterval(broadcast, 60_000); // Periodic broadcast every 60s
  } catch (err) {
    console.warn('[baby] Battery API not available:', err);
    // Notify parent that battery level cannot be determined
    if (activeConnection?.dataChannel) {
      sendMessage(activeConnection.dataChannel, MSG.BATTERY_LEVEL, { level: null, charging: null });
    }
    if (babyBattery) {
      babyBattery.textContent = '?';
      babyBattery.setAttribute('aria-label', 'Battery level unknown');
    }
  }
}

// ---------------------------------------------------------------------------
// State snapshot (TASK-048)
// ---------------------------------------------------------------------------

function sendStateSnapshot() {
  if (!activeConnection?.dataChannel) return;
  sendMessage(activeConnection.dataChannel, MSG.STATE_SNAPSHOT, {
    deviceId,
    soothingMode:    state.soothingMode,
    currentTrack:    state.currentTrack,
    musicVolume:     state.musicVolume,
    fadeRemaining:   state.fadeRemaining,
    fadeDuration:    state.fadeDuration,  // TASK-014: original timer duration
    cameraFacing:    state.cameraFacing,
    audioOnly:       state.audioOnly,
    quality:         state.quality,
    screenDim:       state.screenDim,     // TASK-028
    videoPaused:     state.videoPaused,   // TASK-028
    batteryLevel:    _batteryLevel,       // TASK-048: null until Battery API resolves
    batteryCharging: _batteryCharging,    // TASK-048
  });
}

// ---------------------------------------------------------------------------
// File transfer helpers (TASK-013)
// ---------------------------------------------------------------------------

/**
 * Update the baby-side transfer progress overlay.
 * @param {number} received  — chunks received so far
 * @param {number} total     — expected total chunks
 */
function _updateTransferProgress(received, total) {
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
  if (babyTransferBar) babyTransferBar.value = pct;
  if (babyTransferText) {
    babyTransferText.textContent = total > 0
      ? `Receiving audio… ${pct}%`
      : 'Receiving audio…';
  }
}

/**
 * Assemble all received chunks into a Blob, save to IndexedDB, and send a
 * FILE_ACK to the parent.  Called when FILE_COMPLETE is received.
 */
async function _finaliseTransfer() {
  const transfer = _incomingTransfer;
  _incomingTransfer = null;

  if (!transfer) return;

  // Verify all chunks were received
  for (let i = 0; i < transfer.totalChunks; i++) {
    if (!transfer.chunks[i]) {
      console.warn('[baby] Missing chunk', i, '— discarding incomplete transfer');
      if (babyTransferStatus) babyTransferStatus.classList.add('hidden');
      _notifyTransferFailed(transfer.id, `Missing chunk ${i}`);
      return;
    }
  }

  try {
    // Decode all base64 chunks and concatenate into a single Uint8Array
    const byteArrays = transfer.chunks.map(b64 => {
      const binary = atob(b64);
      const arr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      return arr;
    });

    let totalBytes = 0;
    for (const a of byteArrays) totalBytes += a.byteLength;
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const a of byteArrays) { combined.set(a, offset); offset += a.byteLength; }

    const blob = new Blob([combined], { type: transfer.mimeType });

    // Persist to IndexedDB
    const dbId = await saveAudioFile({
      name:      transfer.name,
      blob,
      size:      combined.byteLength,
      duration:  0, // decoded lazily during playback
      type:      'received',
      dateAdded: Date.now(),
    });

    _receivedFileDbId = dbId;
    _audioBuffer = null; // Will be decoded on first FILE_PLAY

    console.log('[baby] File transfer complete, saved to IndexedDB:', transfer.name, `(${combined.byteLength} bytes)`);

    // Acknowledge receipt to the parent
    if (activeConnection?.dataChannel) {
      sendMessage(activeConnection.dataChannel, MSG.FILE_ACK, { id: transfer.id });
    }
  } catch (err) {
    console.error('[baby] Failed to assemble/save received file:', err);
    _notifyTransferFailed(transfer.id, err.message);
  } finally {
    if (babyTransferStatus) babyTransferStatus.classList.add('hidden');
  }
}

/**
 * Notify the parent that the transfer failed.
 * @param {string} id
 * @param {string} reason
 */
function _notifyTransferFailed(id, reason) {
  if (activeConnection?.dataChannel) {
    try {
      sendMessage(activeConnection.dataChannel, MSG.FILE_TRANSFER_FAILED, { id, reason });
    } catch (_) { /* ignore if channel closed */ }
  }
}

// ---------------------------------------------------------------------------
// Audio file library (TASK-049)
// ---------------------------------------------------------------------------

/** Bytes threshold above which the quota-full warning is shown (90 % of quota). */
const BABY_LIBRARY_QUOTA_WARN_RATIO = 0.9;

/**
 * Format a byte count as a human-readable string (B / KB / MB).
 * @param {number} bytes
 * @returns {string}
 */
function _formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Escape a string for safe insertion into HTML attributes and text content.
 * @param {string} str
 * @returns {string}
 */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Update the storage-usage line and quota warning in the baby library panel.
 */
async function _updateBabyLibraryStorageDisplay() {
  const est = await getStorageUsage();
  if (!est) {
    if (babyLibraryStorage) babyLibraryStorage.textContent = '';
    return;
  }
  const { usageBytes, quotaBytes } = est;
  if (babyLibraryStorage) {
    babyLibraryStorage.textContent = quotaBytes > 0
      ? `Storage used: ${_formatBytes(usageBytes)} of ${_formatBytes(quotaBytes)}`
      : `Storage used: ${_formatBytes(usageBytes)}`;
  }
  const nearFull = quotaBytes > 0 && (usageBytes / quotaBytes) >= BABY_LIBRARY_QUOTA_WARN_RATIO;
  babyLibraryQuotaWarn?.classList.toggle('hidden', !nearFull);
}

/**
 * Build a single library list-item element for one audio file record on the baby device.
 * @param {import('./storage.js').AudioFileRecord} record — metadata (no blob)
 * @returns {HTMLElement}
 */
function _buildBabyLibraryItem(record) {
  const item = document.createElement('div');
  item.className = 'audio-library__item';
  item.dataset.id = record.id;

  const date = new Date(record.dateAdded).toLocaleDateString();
  const size = _formatBytes(record.size);
  const isCurrent = record.id === _receivedFileDbId;

  item.innerHTML = `
    <div class="audio-library__item-info">
      <span class="audio-library__item-name" title="${_escapeHtml(record.name)}">${_escapeHtml(record.name)}</span>
      <span class="audio-library__item-meta">${_escapeHtml(size)} · ${_escapeHtml(date)}${isCurrent ? ' · <strong>active</strong>' : ''}</span>
    </div>
    <div class="audio-library__item-actions" role="group" aria-label="Actions for ${_escapeHtml(record.name)}">
      <button class="audio-library__btn audio-library__btn--play"    title="Play"            aria-label="Play ${_escapeHtml(record.name)}">▶</button>
      <button class="audio-library__btn audio-library__btn--set"     title="Set as current"  aria-label="Set ${_escapeHtml(record.name)} as current track"${isCurrent ? ' aria-pressed="true"' : ''}>★</button>
      <button class="audio-library__btn audio-library__btn--delete"  title="Delete"          aria-label="Delete ${_escapeHtml(record.name)}">🗑</button>
    </div>
  `;

  // Play
  item.querySelector('.audio-library__btn--play')?.addEventListener('click', async () => {
    await _playBabyLibraryFile(record.id);
  });

  // Set as current track
  item.querySelector('.audio-library__btn--set')?.addEventListener('click', () => {
    _setLibraryFileAsCurrent(record.id);
    // Refresh the list so the "active" marker updates
    _loadBabyLibraryPanel().catch(() => {});
  });

  // Delete
  item.querySelector('.audio-library__btn--delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${record.name}"?`)) return;
    try {
      // If this is the current active file, clear it
      if (_receivedFileDbId === record.id) {
        _stopPlayback();
        _receivedFileDbId = null;
        _audioBuffer = null;
      }
      await deleteAudioFile(record.id);
      item.remove();
      if (babyLibraryList && babyLibraryList.children.length === 0) {
        babyLibraryEmpty?.classList.remove('hidden');
      }
      await _updateBabyLibraryStorageDisplay();
    } catch (err) {
      console.error('[baby] Library delete error:', err);
    }
  });

  return item;
}

/**
 * Load and render the audio library in the baby settings overlay.
 * Called each time the settings overlay opens.
 */
async function _loadBabyLibraryPanel() {
  if (!babyLibraryList) return;
  babyLibraryList.innerHTML = '';
  babyLibraryEmpty?.classList.add('hidden');

  try {
    const files = await listAudioFiles();
    // Sort by date added, newest first
    files.sort((a, b) => b.dateAdded - a.dateAdded);

    if (files.length === 0) {
      babyLibraryEmpty?.classList.remove('hidden');
    } else {
      for (const f of files) {
        babyLibraryList.appendChild(_buildBabyLibraryItem(f));
      }
    }
  } catch (err) {
    console.error('[baby] Failed to load library:', err);
  }

  await _updateBabyLibraryStorageDisplay();
}

/**
 * Play a file from the library locally on the baby device.
 * Sets it as the active received file and begins playback.
 * @param {string} id
 */
async function _playBabyLibraryFile(id) {
  // Stop any currently playing audio first
  if (_audioPlaying) _stopPlayback();

  // Set as the active file
  _receivedFileDbId = id;
  _audioBuffer = null;  // Force re-decode from the new file
  _audioOffset  = 0;

  await _playReceivedFile();
}

/**
 * Set a library file as the "current track" that will play when FILE_PLAY
 * commands arrive from the parent, without immediately starting playback.
 * @param {string} id
 */
function _setLibraryFileAsCurrent(id) {
  if (_audioPlaying) _stopPlayback();
  _receivedFileDbId = id;
  _audioBuffer = null;
  _audioOffset  = 0;
  console.log('[baby] Library file set as current track:', id);
}

// ---------------------------------------------------------------------------
// Audio playback (TASK-013)
// ---------------------------------------------------------------------------

/**
 * Ensure the shared AudioContext exists and is resumed.
 * Creates it on first call (after the user gesture from tap-to-begin).
 */
async function _ensureAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
    _audioGain = _audioCtx.createGain();
    // Apply current music volume (0–100 → 0–1).
    _audioGain.gain.value = state.musicVolume / 100;

    // TASK-038: insert a dedicated ducking gain node between the master volume
    // node and the audio destination so ducking can operate independently of
    // the user-set volume level.
    //   _audioGain → _duckingGain → destination
    _duckingGain = _audioCtx.createGain();
    _duckingGain.gain.value = 1.0;
    _audioGain.connect(_duckingGain);
    _duckingGain.connect(_audioCtx.destination);
  }
  if (_audioCtx.state === 'suspended') {
    await _audioCtx.resume();
  }
}

// ---------------------------------------------------------------------------
// Audio ducking (TASK-038)
// ---------------------------------------------------------------------------

/** Gain level applied to _duckingGain while the parent is speaking (~15%). */
const DUCK_GAIN       = 0.15;
/** Seconds to ramp the gain down when ducking begins. */
const DUCK_RAMP_DOWN_S = 0.5;
/** Seconds to ramp the gain back up when silence is detected. */
const DUCK_RAMP_UP_S   = 1.5;
/** RMS amplitude threshold above which a frame is considered to contain speech. */
const DUCK_THRESHOLD   = 0.008;
/** Milliseconds of continuous silence required before releasing the duck. */
const DUCK_SILENCE_MS  = 800;

/**
 * Smoothly apply or release ducking on the shared _duckingGain node.
 *
 * Duck-on  : ramp to DUCK_GAIN over DUCK_RAMP_DOWN_S seconds.
 * Duck-off : ramp back to 1.0  over DUCK_RAMP_UP_S  seconds.
 *
 * @param {boolean} duck — true to duck, false to restore.
 */
function _applyDucking(duck) {
  if (!_duckingGain || !_audioCtx) return;
  _isDucked = duck;
  const now = _audioCtx.currentTime;
  _duckingGain.gain.cancelScheduledValues(now);
  _duckingGain.gain.setValueAtTime(_duckingGain.gain.value, now);
  if (duck) {
    _duckingGain.gain.linearRampToValueAtTime(DUCK_GAIN, now + DUCK_RAMP_DOWN_S);
    console.log('[baby] Audio ducking ON — ramping to', DUCK_GAIN, '(TASK-038)');
  } else {
    _duckingGain.gain.linearRampToValueAtTime(1.0, now + DUCK_RAMP_UP_S);
    console.log('[baby] Audio ducking OFF — ramping back to 1.0 (TASK-038)');
  }
}

/**
 * Attach an AnalyserNode to the given speak-through MediaStream and begin
 * polling for speech activity on every animation frame.
 *
 * When the RMS of the incoming audio exceeds DUCK_THRESHOLD the music gain
 * is ducked; when silence persists for DUCK_SILENCE_MS it is restored.
 *
 * The analyser is intentionally NOT connected to any audio output — it is
 * used only for level monitoring.
 *
 * Any previously running detector is stopped first so renegotiated speak
 * sessions (where the parent removes and re-adds the track) work correctly.
 *
 * @param {MediaStream} stream — the incoming speak-through MediaStream
 */
function _startDuckingDetector(stream) {
  _stopDuckingDetector(); // clean up any previous instance

  if (!_audioCtx) return;

  _speakAnalyserSource = _audioCtx.createMediaStreamSource(stream);
  _speakAnalyser = _audioCtx.createAnalyser();
  _speakAnalyser.fftSize = 256;
  _speakAnalyserSource.connect(_speakAnalyser);
  // Intentionally not connected to any destination — analysis only.

  const frameData = new Float32Array(_speakAnalyser.fftSize);

  function tick() {
    if (!_speakAnalyser) return;

    _speakAnalyser.getFloatTimeDomainData(frameData);

    // Compute RMS of the current audio frame.
    let sumSq = 0;
    for (let i = 0; i < frameData.length; i++) {
      sumSq += frameData[i] * frameData[i];
    }
    const rms = Math.sqrt(sumSq / frameData.length);

    const nowMs = performance.now();
    if (rms > DUCK_THRESHOLD) {
      _lastSpeakMs = nowMs;
      if (!_isDucked) _applyDucking(true);
    } else if (_isDucked && (nowMs - _lastSpeakMs) > DUCK_SILENCE_MS) {
      _applyDucking(false);
    }

    _duckingRafId = requestAnimationFrame(tick);
  }

  _duckingRafId = requestAnimationFrame(tick);
  console.log('[baby] Ducking detector started (TASK-038)');
}

/**
 * Stop the ducking detector, disconnect its nodes, and immediately restore
 * the ducking gain to 1.0 if it is currently lowered.
 *
 * Safe to call when no detector is running (no-op).
 */
function _stopDuckingDetector() {
  if (_duckingRafId !== null) {
    cancelAnimationFrame(_duckingRafId);
    _duckingRafId = null;
  }
  if (_speakAnalyserSource) {
    try { _speakAnalyserSource.disconnect(); } catch (_) { /* ignore */ }
    _speakAnalyserSource = null;
  }
  _speakAnalyser = null;

  // Release any active ducking so music does not stay muted indefinitely.
  if (_isDucked) {
    _isDucked = false;
    if (_duckingGain && _audioCtx) {
      const now = _audioCtx.currentTime;
      _duckingGain.gain.cancelScheduledValues(now);
      _duckingGain.gain.setValueAtTime(_duckingGain.gain.value, now);
      _duckingGain.gain.linearRampToValueAtTime(1.0, now + DUCK_RAMP_UP_S);
    }
  }
  console.log('[baby] Ducking detector stopped (TASK-038)');
}

/**
 * Load, decode, and start playing the most recently received audio file.
 * If playback was paused, resumes from the saved offset instead.
 */
async function _playReceivedFile() {
  if (!_receivedFileDbId) {
    console.warn('[baby] No received file available to play');
    return;
  }

  // If we have a paused position, resume rather than restarting
  if (!_audioPlaying && _audioBuffer && _audioOffset > 0) {
    _resumePlayback();
    return;
  }

  _stopPlayback();

  try {
    await _ensureAudioCtx();

    if (!_audioBuffer) {
      const record = await getAudioFile(_receivedFileDbId);
      if (!record?.blob) {
        console.warn('[baby] Received file not found in IndexedDB');
        return;
      }
      const arrayBuffer = await record.blob.arrayBuffer();
      _audioBuffer = await _audioCtx.decodeAudioData(arrayBuffer);
    }

    _createAndStartSource(0);
  } catch (err) {
    console.error('[baby] Failed to play received file:', err);
  }
}

/**
 * Create an AudioBufferSourceNode and begin playback from `offset` seconds.
 * @param {number} offset — seconds into the buffer to start from
 */
function _createAndStartSource(offset) {
  if (!_audioCtx || !_audioBuffer || !_audioGain) return;

  _audioSource = _audioCtx.createBufferSource();
  _audioSource.buffer = _audioBuffer;
  _audioSource.connect(_audioGain);
  _audioSource.start(0, offset);
  _audioStart   = _audioCtx.currentTime - offset;
  _audioPlaying = true;
  _audioOffset  = 0;

  _audioSource.addEventListener('ended', () => {
    // Natural end of audio (not a manual stop)
    if (_audioPlaying) {
      _audioSource  = null;
      _audioPlaying = false;
      _audioOffset  = 0;
    }
  });
}

/**
 * Pause playback, saving the current position so `_resumePlayback` can
 * continue from the same point.
 */
function _pausePlayback() {
  if (!_audioPlaying || !_audioSource || !_audioCtx) return;
  // Record how far through the buffer we were
  _audioOffset  = _audioCtx.currentTime - _audioStart;
  _audioPlaying = false;
  try { _audioSource.stop(); } catch (_) { /* ignore */ }
  _audioSource = null;
}

/**
 * Resume playback from the position saved by `_pausePlayback`.
 */
function _resumePlayback() {
  if (_audioPlaying || !_audioBuffer) return;
  _ensureAudioCtx().then(() => _createAndStartSource(_audioOffset)).catch(err => {
    console.error('[baby] Failed to resume audio:', err);
  });
}

/**
 * Stop playback and reset the playback position to the beginning.
 */
function _stopPlayback() {
  if (_audioSource) {
    _audioPlaying = false;
    try { _audioSource.stop(); } catch (_) { /* ignore */ }
    _audioSource = null;
  }
  _audioPlaying = false;
  _audioOffset  = 0;
}

// ---------------------------------------------------------------------------
// Incoming data channel messages (TASK-009)
// ---------------------------------------------------------------------------

/**
 * Handle a message received from the parent device.
 * @param {object} msg
 */
function handleDataMessage(msg) {
  // E2E test hook (TASK-063): record the last received message for assertions.
  window.__lastBabyMessage = msg;
  switch (msg.type) {
    case MSG.SET_MODE:
      startSoothingMode(msg.value);
      sendStateSnapshot();
      break;

    case MSG.SET_VOLUME:
      state.musicVolume = msg.value;
      // Apply to the master GainNode — covers both file-transfer audio (TASK-013)
      // and bundled soothing tracks (TASK-019) which share the same gain node.
      if (_audioGain && _audioCtx) {
        _audioGain.gain.setTargetAtTime(
          state.musicVolume / 100,
          _audioCtx.currentTime,
          0.05, // 50 ms smoothing
        );
      }
      sendStateSnapshot();
      break;

    case MSG.SET_TRACK:
      // Update track state and switch playback if music mode is active (TASK-019).
      state.currentTrack = msg.value;
      if (state.soothingMode === 'music' && msg.value) {
        if (_musicPlayerAttached) {
          _mpSwitchTrack(msg.value);
        } else {
          // Music player not yet attached — start the mode fresh.
          _startMusicMode();
        }
      }
      sendStateSnapshot();
      break;

    case MSG.SET_FADE_TIMER:
      // Start the fade-out countdown timer (TASK-019 / TASK-014).
      startFadeTimer(Number(msg.value));
      sendStateSnapshot();
      break;

    case MSG.CANCEL_FADE:
      // Cancel the active fade timer (TASK-019 / TASK-014).
      cancelFadeTimer();
      sendStateSnapshot();
      break;

    case MSG.FLIP_CAMERA:
      flipCamera();
      break;

    case MSG.SET_AUDIO_ONLY:
      applyAudioOnlyMode(msg.value);
      break;

    case MSG.DISCONNECT:
      handleDisconnect('disconnected');
      break;

    case MSG.SET_QUALITY:
      // TASK-028: actually re-apply the new quality constraints to the live stream
      applyQualityConstraints(msg.value);
      break;

    case MSG.SET_SCREEN_DIM: // TASK-028
      applyScreenDimMode(Boolean(msg.value));
      break;

    case MSG.SET_VIDEO_PAUSED: // TASK-028
      applyVideoPaused(Boolean(msg.value));
      break;

    case MSG.SPEAK_START:
      // Show the "parent is speaking" indicator (TASK-012).
      // The audio plays automatically via the track event set up in _setupSpeakThrough.
      _showSpeakThroughIndicator(true);
      break;

    case MSG.SPEAK_STOP:
      // Hide the "parent is speaking" indicator (TASK-012).
      _showSpeakThroughIndicator(false);
      break;

    case MSG.FILE_META: {
      // Parent is starting a file transfer — prepare receive buffer (TASK-013)
      const { id, name, mimeType, totalChunks } = msg.value ?? {};
      if (!id || !totalChunks) break;

      // Discard any previous in-progress transfer
      _incomingTransfer = null;

      // Delete old received file from IndexedDB to reclaim storage space
      if (_receivedFileDbId) {
        deleteAudioFile(_receivedFileDbId).catch(e =>
          console.warn('[baby] Failed to delete old audio file:', e));
        _receivedFileDbId = null;
        _audioBuffer = null; // Decoded buffer is now stale
      }

      _incomingTransfer = {
        id,
        name:        name ?? 'audio',
        mimeType:    mimeType ?? 'audio/mpeg',
        totalChunks,
        received:    0,
        chunks:      new Array(totalChunks),
      };

      // Show the transfer progress overlay
      _updateTransferProgress(0, totalChunks);
      if (babyTransferStatus) babyTransferStatus.classList.remove('hidden');
      console.log('[baby] File transfer started:', name, `(${totalChunks} chunks)`);
      break;
    }

    case MSG.FILE_CHUNK: {
      // Accumulate an incoming chunk (TASK-013)
      const { id, seq, data } = msg.value ?? {};
      if (!_incomingTransfer || _incomingTransfer.id !== id) break;
      if (seq == null || typeof data !== 'string') break;

      if (!_incomingTransfer.chunks[seq]) {
        _incomingTransfer.chunks[seq] = data;
        _incomingTransfer.received++;
      }
      _updateTransferProgress(_incomingTransfer.received, _incomingTransfer.totalChunks);
      break;
    }

    case MSG.FILE_COMPLETE: {
      // All chunks received — assemble blob and store in IndexedDB (TASK-013)
      const { id } = msg.value ?? {};
      if (!_incomingTransfer || _incomingTransfer.id !== id) break;
      _finaliseTransfer(); // async; errors are logged internally
      break;
    }

    case MSG.FILE_ABORT: {
      // Parent aborted the transfer — discard partial data (TASK-013)
      if (_incomingTransfer) {
        console.log('[baby] File transfer aborted by parent:', _incomingTransfer.id);
        _incomingTransfer = null;
        if (babyTransferStatus) babyTransferStatus.classList.add('hidden');
      }
      break;
    }

    case MSG.FILE_PLAY:
      // Parent commands the baby to play the received file (TASK-013)
      _playReceivedFile();
      break;

    case MSG.FILE_PAUSE:
      // Parent commands pause/resume toggle (TASK-013)
      if (_audioPlaying) _pausePlayback();
      else _resumePlayback();
      break;

    case MSG.FILE_STOP:
      // Parent commands stop + reset (TASK-013)
      _stopPlayback();
      break;

    case MSG.ID_POOL:
      // TASK-061 — MSG.ID_POOL is sent baby→parent, never parent→baby.
      // The baby generates the pool; the parent stores it for reconnection.
      // No action needed here; log unexpected receipt and ignore.
      console.warn('[baby] Unexpected MSG.ID_POOL received from parent (TASK-061)');
      break;

    default:
      console.log('[baby] Unhandled message:', msg.type);
  }
}

// ---------------------------------------------------------------------------
// Camera flip (TASK-041)
// ---------------------------------------------------------------------------

/**
 * Update the camera-facing indicator labels in both the setup screen and the
 * settings overlay to match the current value of `state.cameraFacing`.
 * Called on page init and after every flip so users always know which camera
 * is selected.
 */
function _updateCameraFacingUI() {
  const label = state.cameraFacing === 'user' ? 'Front' : 'Rear';
  if (setupCameraFacingText) setupCameraFacingText.textContent = label;
}

/**
 * Toggle between front-facing ('user') and rear-facing ('environment') camera.
 *
 * If no stream is active yet (pre-connection or audio-only mode) only the
 * state preference is updated and saved to localStorage; the new value will
 * be used automatically when getUserMediaStream() is called next.
 *
 * When a live stream is active, only the video track is replaced — the audio
 * track is left untouched to avoid redundantly re-capturing the microphone.
 * If the new camera cannot be opened (e.g. the device has only one camera),
 * the state is reverted to the previous value.
 */
async function flipCamera() {
  // Toggle and persist the preference.
  state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
  saveSetting(SETTING_KEYS.CAMERA_FACING, state.cameraFacing);
  _updateCameraFacingUI();

  // Pre-connection or audio-only: preference saved; applied when camera starts.
  if (!localStream || state.audioOnly) return;

  // Stop the existing video track(s) before requesting the new camera.
  for (const track of localStream.getVideoTracks()) {
    track.stop();
    localStream.removeTrack(track);
  }

  // Request only video for the new camera direction — do not re-capture audio.
  const q = QUALITY_PRESETS[state.quality] ?? QUALITY_PRESETS.medium;
  let newVideoTrack = null;
  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: state.cameraFacing },
        width:      { ideal: q.width },
        height:     { ideal: q.height },
        frameRate:  { ideal: q.frameRate },
      },
      audio: false,
    });
    newVideoTrack = videoStream.getVideoTracks()[0];
  } catch (err) {
    console.warn('[baby] Camera flip failed — reverting to previous camera:', err.name, err.message);
    // Revert state so future getUserMedia calls use the working camera.
    state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
    saveSetting(SETTING_KEYS.CAMERA_FACING, state.cameraFacing);
    _updateCameraFacingUI();
    return;
  }

  if (newVideoTrack) {
    localStream.addTrack(newVideoTrack);

    // Replace the video sender on the active peer connection so the parent
    // immediately sees the new camera feed without renegotiation.
    if (activeConnection?.peerConnection) {
      const senders = activeConnection.peerConnection.getSenders();
      const videoSender = senders.find(s => s.track?.kind === 'video');
      if (videoSender) await videoSender.replaceTrack(newVideoTrack);
    }
  }

  sendStateSnapshot();
}

// ---------------------------------------------------------------------------
// Touch lock / kiosk mode (TASK-039)
// ---------------------------------------------------------------------------

/** @type {number} Tap counter for triple-tap unlock */
let _tapCount = 0;
/** @type {number|null} setTimeout ID for resetting the tap counter after inactivity */
let _tapTimeout = null;
/** @type {number|null} setTimeout ID for the auto-relock-after-30s timer */
let _relockTimerId = null;
/** @type {number|null} setTimeout ID for hiding the touch-lock hint */
let _hintHideTimerId = null;

/**
 * Enter touch-lock / kiosk mode.
 *
 * - Sets state.locked = true so the babyMonitor click handler intercepts taps.
 * - Requests fullscreen to suppress browser chrome.
 * - Cancels any pending auto-relock timer (avoids duplicate lock calls when the
 *   user manually re-locks via the settings close button).
 */
function enterTouchLock() {
  clearTimeout(_relockTimerId);
  _relockTimerId = null;
  state.locked = true;
  document.documentElement.requestFullscreen?.().catch(() => {});
}

/**
 * Exit touch-lock and reveal the settings overlay.
 *
 * Automatically re-engages the lock after 30 seconds of inactivity so the
 * user does not have to manually re-lock every time.
 */
function exitTouchLock() {
  clearTimeout(_relockTimerId);
  state.locked = false;
  babySettingsOverlay?.classList.remove('hidden');
  // Load audio library whenever the settings overlay opens (TASK-049)
  _loadBabyLibraryPanel().catch(err => console.warn('[baby] Library load error:', err));
  // Auto re-lock after 30 seconds of inactivity (TASK-039)
  _relockTimerId = setTimeout(() => {
    _relockTimerId = null;
    babySettingsOverlay?.classList.add('hidden');
    enterTouchLock();
  }, 30_000);
}

/**
 * Show the "Triple-tap to unlock" hint, restarting the CSS fade animation so
 * repeated taps each produce a fresh animation run.
 */
function _showTouchLockHint() {
  if (!touchLockHint) return;
  clearTimeout(_hintHideTimerId);
  // Restart the CSS animation by briefly forcing the browser to re-compute style.
  touchLockHint.classList.remove('hidden');
  touchLockHint.style.animation = 'none';
  // eslint-disable-next-line no-unused-expressions
  touchLockHint.offsetHeight; // trigger reflow
  touchLockHint.style.animation = '';
  _hintHideTimerId = setTimeout(() => {
    touchLockHint.classList.add('hidden');
    _hintHideTimerId = null;
  }, 2000);
}

babyMonitor?.addEventListener('click', () => {
  if (!state.locked) return;

  _tapCount++;
  clearTimeout(_tapTimeout);

  if (_tapCount >= 3) {
    _tapCount = 0;
    exitTouchLock();
    return;
  }

  // Show "Triple-tap to unlock" hint on single/double tap while locked.
  _showTouchLockHint();

  // Reset the tap counter if a third tap does not arrive within 1.5 s.
  _tapTimeout = setTimeout(() => {
    _tapCount = 0;
    clearTimeout(_hintHideTimerId);
    touchLockHint?.classList.add('hidden');
  }, 1500);
});

// ---------------------------------------------------------------------------
// Disconnection handling
// ---------------------------------------------------------------------------

function handleDisconnect(reason) {
  // Cancel any in-progress auto-reconnect (TASK-030)
  _cancelAutoReconnect();

  // Clean up peer status listener if still active
  _peerStatusUnsub?.();
  _peerStatusUnsub = null;

  stopScanner();

  // Discard any partially received file transfer (TASK-013).
  // The connection is gone so we cannot notify the parent — the parent handles
  // this on its own side by detecting the disconnect state.
  if (_incomingTransfer) {
    console.log('[baby] Discarding partial file transfer due to disconnect:', _incomingTransfer.id);
    _incomingTransfer = null;
    if (babyTransferStatus) babyTransferStatus.classList.add('hidden');
  }

  // TASK-051: Do NOT stop audio playback on disconnect.
  // All soothing activity (music, file-transfer audio, canvas effects, fade
  // timer) must continue uninterrupted regardless of connection state.
  // Only an explicit user action (local settings) or a MSG received after a
  // successful reconnection should change the soothing state.

  // Stop the speak-through ducking detector and restore gain (TASK-038).
  _stopDuckingDetector();

  // TASK-040: release orientation lock when leaving monitor mode so the OS
  // can control rotation freely on the disconnected / pairing screens.
  screen.orientation?.unlock?.();

  // Close the connection cleanly (closes data channel / peer connection)
  try { activeConnection?.close?.(); } catch (_) { /* ignore */ }
  activeConnection = null;

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  showDisconnected(reason === 'failed' ? 'Connection failed.' : 'Connection lost.');
}

// ---------------------------------------------------------------------------
// Event listeners — pairing method buttons
// ---------------------------------------------------------------------------

document.getElementById('method-peerjs')?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.PREFERRED_METHOD, 'peerjs');
  startPeerJsPairing();
});

document.getElementById('method-offline')?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.PREFERRED_METHOD, 'offline');
  startOfflinePairing();
});

// ---------------------------------------------------------------------------
// Event listeners — settings overlay
// ---------------------------------------------------------------------------

for (const btn of modeBtns) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    startSoothingMode(mode);
    // TASK-032: persist mode selection as default for future sessions.
    saveSetting(SETTING_KEYS.DEFAULT_MODE, mode);
    settings.defaultMode = mode;
    if (activeConnection?.dataChannel) {
      sendMessage(activeConnection.dataChannel, MSG.SET_MODE, mode);
    }
  });
}

flipCameraBtn?.addEventListener('click', flipCamera);
setupFlipCameraBtn?.addEventListener('click', flipCamera); // TASK-041: setup screen flip

audioOnlyToggle?.addEventListener('change', () => {
  const enabled = audioOnlyToggle.checked;
  applyAudioOnlyMode(enabled);
  if (activeConnection?.dataChannel) {
    sendMessage(activeConnection.dataChannel, MSG.SET_AUDIO_ONLY, enabled);
  }
});

// Screen dim toggle (TASK-028): dims the display to near-black to save battery.
screenDimToggle?.addEventListener('change', () => {
  applyScreenDimMode(screenDimToggle.checked);
});

// ---------------------------------------------------------------------------
// Screen orientation lock (TASK-040)
// ---------------------------------------------------------------------------

/**
 * Apply (or release) the Screen Orientation API lock for the given setting.
 *
 * - 'auto'             → unlock so the OS controls orientation
 * - any other value    → lock to that orientation type
 *
 * If the Screen Orientation API is not available, the settings note is
 * revealed so the user understands why no lock will be applied.
 *
 * @param {string} value — 'auto'|'portrait'|'landscape-primary'|'landscape-secondary'
 */
function _applyOrientationLock(value) {
  if (!screen.orientation?.lock) {
    // API not supported — reveal the note and leave orientation unlocked.
    if (orientationApiNote) orientationApiNote.hidden = false;
    return;
  }
  // API is supported — hide the note (it is only for the unsupported case).
  if (orientationApiNote) orientationApiNote.hidden = true;

  if (value === 'auto') {
    screen.orientation.unlock();
  } else {
    screen.orientation.lock(value).catch(() => {
      // Lock may be rejected (e.g. desktop browsers, non-fullscreen context).
      // Silently ignore — the user will see the display rotate naturally.
    });
  }
}

orientationSelect?.addEventListener('change', () => {
  const value = orientationSelect.value;
  saveSetting(SETTING_KEYS.ORIENTATION, value);
  _applyOrientationLock(value);  // TASK-040
});

// TASK-032: Default music track selector — persists to DEFAULT_TRACK in localStorage.
// Pre-populate from stored setting so the selector reflects the current default.
if (babyDefaultTrack) {
  babyDefaultTrack.value = settings.defaultTrack ?? '';
  babyDefaultTrack.addEventListener('change', () => {
    const track = babyDefaultTrack.value;
    settings.defaultTrack = track || null;
    saveSetting(SETTING_KEYS.DEFAULT_TRACK, track || null);
    // Update live state so that if music mode is active, the next play uses this track.
    state.currentTrack = track || null;
  });
}

// Small settings icon button — opens the settings overlay directly (TASK-015).
// Provides a visible (but minimal) access point in addition to triple-tap.
soothingSettingsBtn?.addEventListener('click', (e) => {
  // Prevent the click from bubbling to the monitor-level triple-tap handler.
  e.stopPropagation();
  exitTouchLock();
});

settingsCloseBtn?.addEventListener('click', () => {
  babySettingsOverlay?.classList.add('hidden');
  enterTouchLock();
});

disconnectBtn?.addEventListener('click', () => {
  if (activeConnection?.dataChannel) {
    sendMessage(activeConnection.dataChannel, MSG.DISCONNECT, null);
  }
  handleDisconnect('disconnected');
});

// ---------------------------------------------------------------------------
// Event listeners — disconnected screen
// ---------------------------------------------------------------------------

rePairBtn?.addEventListener('click', () => {
  _cancelAutoReconnect(); // Abort any in-progress reconnect (TASK-030)
  showPairing();
});
goHomeBtn?.addEventListener('click', () => { window.location.href = 'index.html'; });

// ---------------------------------------------------------------------------
// Tap-to-begin overlay (TASK-037)
// ---------------------------------------------------------------------------

// If the browser is blocked (iOS Safari), the compat modal is already visible
// and the tap overlay has been hidden — do not wire up the tap-to-begin handler.
if (_compatResult !== 'blocked') {
  tapOverlay?.addEventListener('click', () => {
    tapOverlay.classList.add('hidden');
    init().catch(err => {
      console.error('[baby] init error:', err);
    });
  }, { once: true });
}

// ---------------------------------------------------------------------------
// E2E test hooks (TASK-067)
// ---------------------------------------------------------------------------
// These helpers are set at module scope so their closures capture the live
// module-level bindings (activeConnection, lsGet, SETTING_KEYS).  They are
// intentional no-ops until the app reaches the appropriate state.

/**
 * Simulate a WebRTC connection drop by closing the active connection from the
 * baby side.  Both the data channel and the media call are torn down, which
 * triggers close events on both sides and causes both the baby and parent to
 * enter their respective auto-reconnect flows — exactly as if the network had
 * been interrupted while the app was running.
 */
window.__testDropConnection = () => {
  if (activeConnection) {
    try { activeConnection.close(); } catch (_) { /* ignore */ }
  }
};

/**
 * Return the current backup pool index from localStorage.
 * After the first reconnect this should be 1 (advanced from 0 → 1).
 * @returns {number}
 */
window.__testGetPoolIndex = () => lsGet(SETTING_KEYS.BACKUP_POOL_INDEX, 0);

/**
 * Return the full backup peer ID pool array from localStorage, or null if
 * the pool has not been created yet.
 * @returns {string[]|null}
 */
window.__testGetPool = () => lsGet(SETTING_KEYS.BACKUP_ID_POOL, null);
