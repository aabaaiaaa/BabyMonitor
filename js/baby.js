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
  saveAudioFile, getAudioFile, deleteAudioFile,
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
 * @property {string}      cameraFacing   — 'user'|'environment'
 * @property {boolean}     audioOnly
 * @property {string}      quality        — 'low'|'medium'|'high'
 * @property {boolean}     locked         — touch lock engaged
 */

/** @type {BabyState} */
const state = {
  soothingMode:  settings.defaultMode ?? 'off',
  musicVolume:   70,
  currentTrack:  settings.defaultTrack ?? null,
  fadeRemaining: 0,
  cameraFacing:  settings.cameraFacing ?? 'environment',
  audioOnly:     settings.audioOnly ?? false,
  quality:       settings.videoQuality ?? 'medium',
  locked:        false,
};

/** @type {MediaStream|null} Local camera/mic stream */
let localStream = null;

/** @type {object|null} Active normalised connection */
let activeConnection = null;

/** @type {Function|null} Unsubscribe function for the current peer status listener */
let _peerStatusUnsub = null;

/** @type {WakeLockSentinel|null} Screen wake lock (TASK-003) */
let wakeLock = null;

/**
 * True once a low-battery ALERT_BATTERY_LOW message has been sent to the
 * parent during this connection session. Reset when the battery recovers
 * above 20%, so a future drop triggers a fresh alert.
 * @type {boolean}
 */
let _batteryAlertSent = false;

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
const audioOnlyToggle     = document.getElementById('audio-only-toggle');
const orientationSelect   = document.getElementById('orientation-select');
const disconnectBtn       = document.getElementById('btn-disconnect');
const settingsCloseBtn    = document.getElementById('baby-settings-close');

// Disconnected screen
const reconnectStatus     = document.getElementById('reconnect-status');
const rePairBtn           = document.getElementById('btn-re-pair');
const goHomeBtn           = document.getElementById('btn-go-home');

// File transfer progress overlay (TASK-013)
const babyTransferStatus  = document.getElementById('baby-transfer-status');
const babyTransferText    = document.getElementById('baby-transfer-text');
const babyTransferBar     = document.getElementById('baby-transfer-bar');

// ---------------------------------------------------------------------------
// Browser compatibility check (TASK-045)
// Run immediately at module load — before any user interaction or init().
// ---------------------------------------------------------------------------

const _compatResult = showCompatWarnings();

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/** Entry point: called after the user taps the tap-overlay. */
async function init() {
  setupTheme();
  await requestWakeLock(); // TASK-003
  showPairing();
}

// ---------------------------------------------------------------------------
// Theme (TASK-046)
// ---------------------------------------------------------------------------

function setupTheme() {
  const theme = lsGet(SETTING_KEYS.THEME, 'light');
  if (theme === 'dark') {
    document.body.classList.add('dark-mode');
  }
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

/** Re-acquire wake lock when tab becomes visible again (TASK-003). */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && !wakeLock) {
    await requestWakeLock();
  }
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
}

function showDisconnected(reason = '') {
  tapOverlay?.classList.add('hidden');
  pairingSection?.classList.add('hidden');
  babyMonitor?.classList.add('hidden');
  disconnectedScreen?.classList.remove('hidden');
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

        await babyCallParent(parentPeerId, localStream, {
          onReady(conn) {
            _peerStatusUnsub?.();
            _peerStatusUnsub = null;
            activeConnection = conn;
            stopScanner();
            startMonitor(conn);
          },
          onState(connState) {
            if (connState === 'reconnecting') {
              updateConnectionStatus('reconnecting');
              // Notify parent that baby's connection is temporarily degraded
              if (activeConnection?.dataChannel) {
                sendMessage(activeConnection.dataChannel, MSG.CONN_STATUS, connState);
              }
            } else if (connState === 'disconnected' || connState === 'failed') {
              handleDisconnect(connState);
            }
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

    // Step 2: generate SDP offer + ICE candidates
    const offerJson = await offlineBabyCreateOffer(localStream, {
      onReady(conn) {
        activeConnection = conn;
        startMonitor(conn);
      },
      onState(s) {
        if (s === 'reconnecting') {
          updateConnectionStatus('reconnecting');
          if (activeConnection?.dataChannel) {
            sendMessage(activeConnection.dataChannel, MSG.CONN_STATUS, s);
          }
        } else if (s === 'disconnected' || s === 'failed') handleDisconnect(s);
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
        if (s === 'reconnecting') {
          updateConnectionStatus('reconnecting');
          if (activeConnection?.dataChannel) {
            sendMessage(activeConnection.dataChannel, MSG.CONN_STATUS, s);
          }
        } else if (s === 'disconnected' || s === 'failed') handleDisconnect(s);
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
  startBatteryMonitoring(); // TASK-020
  sendStateSnapshot();     // TASK-048
  startSoothingMode(state.soothingMode);
  setupStatusFade();
}

/** Update the connection status indicator. */
function updateConnectionStatus(connState) {
  if (!babyConnStatus) return;
  babyConnStatus.className = 'status-badge';
  if (connState === 'connected')    babyConnStatus.classList.add('connected');
  if (connState === 'reconnecting') babyConnStatus.classList.add('reconnecting');
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

/** Candle effect stub (TASK-016). */
function _startCandleEffect() {
  if (!soothingCanvas) return;
  const ctx = soothingCanvas.getContext('2d');
  // Canvas already sized by _resizeCanvas() called in startSoothingMode().

  function drawFrame() {
    // Placeholder: warm orange fill — full animated candle in TASK-016
    const r = 180 + Math.round(Math.random() * 20);
    const g = 80  + Math.round(Math.random() * 20);
    ctx.fillStyle = `rgb(${r}, ${g}, 10)`;
    ctx.fillRect(0, 0, soothingCanvas.width, soothingCanvas.height);
    _animFrame = requestAnimationFrame(drawFrame);
  }
  drawFrame();
}

/** Water effect stub (TASK-017). */
function _startWaterEffect() {
  if (!soothingCanvas) return;
  // Canvas already sized by _resizeCanvas() called in startSoothingMode().
  const ctx = soothingCanvas.getContext('2d');
  // Placeholder: calm blue gradient fill — full animated water in TASK-017
  const grad = ctx.createLinearGradient(0, 0, soothingCanvas.width, soothingCanvas.height);
  grad.addColorStop(0, '#0d4f8e');
  grad.addColorStop(1, '#4db8e8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, soothingCanvas.width, soothingCanvas.height);
  soothingCanvas.style.background = '';
}

/** Stars effect stub (TASK-018). */
function _startStarsEffect() {
  if (!soothingCanvas) return;
  // Canvas already sized by _resizeCanvas() called in startSoothingMode().
  const ctx = soothingCanvas.getContext('2d');
  // Placeholder: deep space radial gradient — full animated stars in TASK-018
  const grad = ctx.createRadialGradient(
    soothingCanvas.width / 2, soothingCanvas.height / 2, 0,
    soothingCanvas.width / 2, soothingCanvas.height / 2, Math.max(soothingCanvas.width, soothingCanvas.height) / 2,
  );
  grad.addColorStop(0,    '#1a1a4e');
  grad.addColorStop(0.7,  '#0a0a2a');
  grad.addColorStop(1,    '#000010');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, soothingCanvas.width, soothingCanvas.height);
  soothingCanvas.style.background = '';
}

/** Music mode stub (TASK-019). */
function _startMusicMode() {
  _clearCanvas();
  // Dim the screen; start audio playback in TASK-019
  soothingCanvas.style.background = '#050505';
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
  if (!('getBattery' in navigator)) return;

  try {
    const battery = await navigator.getBattery();

    function broadcast() {
      const level   = Math.round(battery.level * 100);
      const charging = battery.charging;
      if (babyBattery) {
        babyBattery.textContent = `${level}%${charging ? ' ⚡' : ''}`;
        babyBattery.setAttribute('aria-label', `Battery ${level}%${charging ? ', charging' : ''}`);
      }
      // Send to parent if connected
      if (activeConnection?.dataChannel) {
        sendMessage(activeConnection.dataChannel, MSG.BATTERY_LEVEL, { level, charging });
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
  }
}

// ---------------------------------------------------------------------------
// State snapshot (TASK-048)
// ---------------------------------------------------------------------------

function sendStateSnapshot() {
  if (!activeConnection?.dataChannel) return;
  sendMessage(activeConnection.dataChannel, MSG.STATE_SNAPSHOT, {
    deviceId,
    soothingMode:  state.soothingMode,
    currentTrack:  state.currentTrack,
    musicVolume:   state.musicVolume,
    fadeRemaining: state.fadeRemaining,
    cameraFacing:  state.cameraFacing,
    audioOnly:     state.audioOnly,
    quality:       state.quality,
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
    // Apply current music volume (0–100 → 0–1); TASK-038 ducking hooks in here.
    _audioGain.gain.value = state.musicVolume / 100;
    _audioGain.connect(_audioCtx.destination);
  }
  if (_audioCtx.state === 'suspended') {
    await _audioCtx.resume();
  }
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
  switch (msg.type) {
    case MSG.SET_MODE:
      startSoothingMode(msg.value);
      sendStateSnapshot();
      break;

    case MSG.SET_VOLUME:
      state.musicVolume = msg.value;
      // Apply to the file-playback GainNode if active (TASK-013)
      if (_audioGain && _audioCtx) {
        _audioGain.gain.setTargetAtTime(
          state.musicVolume / 100,
          _audioCtx.currentTime,
          0.05, // 50 ms smoothing
        );
      }
      // Also applied to bundled tracks GainNode in TASK-019
      sendStateSnapshot();
      break;

    case MSG.SET_TRACK:
      state.currentTrack = msg.value;
      // Switch track in TASK-019
      sendStateSnapshot();
      break;

    case MSG.SET_FADE_TIMER:
      state.fadeRemaining = msg.value;
      // Start timer in TASK-014
      sendStateSnapshot();
      break;

    case MSG.CANCEL_FADE:
      state.fadeRemaining = 0;
      // Cancel timer in TASK-014
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
      state.quality = msg.value;
      sendStateSnapshot();
      break;

    case MSG.SPEAK_START:
      // Play incoming parent audio in TASK-012
      break;

    case MSG.SPEAK_STOP:
      // Stop parent audio in TASK-012
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
      // TASK-061 — parent is sending a pre-agreed pool of backup peer IDs
      // Full implementation in TASK-061: persist pool for reconnection
      break;

    default:
      console.log('[baby] Unhandled message:', msg.type);
  }
}

// ---------------------------------------------------------------------------
// Camera flip (TASK-041)
// ---------------------------------------------------------------------------

async function flipCamera() {
  state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
  saveSetting(SETTING_KEYS.CAMERA_FACING, state.cameraFacing);

  if (!localStream) return;

  // Stop existing video track
  for (const track of localStream.getVideoTracks()) {
    track.stop();
    localStream.removeTrack(track);
  }

  // Request new stream with flipped camera
  const newStream = await getUserMediaStream();

  // Replace track on the peer connection
  const videoTrack = newStream.getVideoTracks()[0];
  if (videoTrack && activeConnection?.peerConnection) {
    const senders = activeConnection.peerConnection.getSenders();
    const videoSender = senders.find(s => s.track?.kind === 'video');
    if (videoSender) await videoSender.replaceTrack(videoTrack);
  }

  sendStateSnapshot();
}

// ---------------------------------------------------------------------------
// Touch lock / kiosk mode (TASK-039)
// ---------------------------------------------------------------------------

/** @type {number} Tap counter for triple-tap unlock */
let _tapCount = 0;
/** @type {number|null} Timeout for resetting tap counter */
let _tapTimeout = null;

function enterTouchLock() {
  state.locked = true;
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function exitTouchLock() {
  state.locked = false;
  babySettingsOverlay?.classList.remove('hidden');
  // Auto re-lock after 30 seconds (TASK-039)
  setTimeout(() => {
    babySettingsOverlay?.classList.add('hidden');
    enterTouchLock();
  }, 30_000);
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

  // Show hint
  touchLockHint?.classList.remove('hidden');
  setTimeout(() => touchLockHint?.classList.add('hidden'), 2000);

  _tapTimeout = setTimeout(() => {
    _tapCount = 0;
    touchLockHint?.classList.add('hidden');
  }, 1500);
});

// ---------------------------------------------------------------------------
// Disconnection handling
// ---------------------------------------------------------------------------

function handleDisconnect(reason) {
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

  // Stop any ongoing audio playback (TASK-013)
  _stopPlayback();

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
    if (activeConnection?.dataChannel) {
      sendMessage(activeConnection.dataChannel, MSG.SET_MODE, mode);
    }
  });
}

flipCameraBtn?.addEventListener('click', flipCamera);

audioOnlyToggle?.addEventListener('change', () => {
  const enabled = audioOnlyToggle.checked;
  applyAudioOnlyMode(enabled);
  if (activeConnection?.dataChannel) {
    sendMessage(activeConnection.dataChannel, MSG.SET_AUDIO_ONLY, enabled);
  }
});

orientationSelect?.addEventListener('change', () => {
  const value = orientationSelect.value;
  saveSetting(SETTING_KEYS.ORIENTATION, value);
  if (value !== 'auto' && screen.orientation?.lock) {
    screen.orientation.lock(value).catch(() => {});
  }
});

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

rePairBtn?.addEventListener('click', () => showPairing());
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
