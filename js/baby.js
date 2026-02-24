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
} from './storage.js';
import {
  initPeer, destroyPeer, getPeer,
  babyCallParent, parentListenPeerJs,
  offlineBabyCreateOffer, offlineBabyReceiveAnswer,
  sendMessage, MSG,
} from './webrtc.js';
import {
  renderQR, renderQRGrid,
  scanAuto, scanSingle, scanMulti, stopScanner,
} from './qr.js';

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
  audioOnly:     false,
  quality:       settings.videoQuality ?? 'medium',
  locked:        false,
};

/** @type {MediaStream|null} Local camera/mic stream */
let localStream = null;

/** @type {object|null} Active normalised connection */
let activeConnection = null;

/** @type {WakeLockSentinel|null} Screen wake lock (TASK-003) */
let wakeLock = null;

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
const offlineScannerContainer = document.getElementById('offline-scanner-container');

// Active monitor elements
const soothingCanvas      = document.getElementById('soothing-canvas');
const babyConnStatus      = document.getElementById('baby-conn-status');
const babyBattery         = document.getElementById('baby-battery');
const touchLockHint       = document.getElementById('touch-lock-hint');
const babySettingsOverlay = document.getElementById('baby-settings-overlay');

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

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/** Entry point: called after the user taps the tap-overlay. */
async function init() {
  checkBrowserCompatibility();
  setupTheme();
  await requestWakeLock(); // TASK-003
  showPairing();
}

// ---------------------------------------------------------------------------
// Browser compatibility check (TASK-045)
// ---------------------------------------------------------------------------

function checkBrowserCompatibility() {
  const ua = navigator.userAgent;
  const isIosSafari = /iP(hone|ad|od)/.test(ua) && !/CriOS/.test(ua);

  if (isIosSafari) {
    // Block iOS Safari entirely
    const modal = document.getElementById('compat-modal');
    const msg   = document.getElementById('compat-modal-message');
    const url   = document.getElementById('compat-modal-url');
    if (modal && msg) {
      msg.textContent =
        'This app requires Chrome to function. ' +
        'Please open this page in Chrome on your iPhone or iPad.';
      if (url) url.textContent = window.location.href;
      modal.classList.remove('hidden');
    }
    // Halt further execution
    throw new Error('iOS Safari not supported');
  }
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

  if (pairingStatusPeerjs) pairingStatusPeerjs.textContent = 'Connecting to pairing server…';

  try {
    const peerjsServerConfig = lsGet(SETTING_KEYS.PEERJS_SERVER, null);
    const peerId = await initPeer(peerjsServerConfig);

    // Show QR code of our peer ID for the parent to scan
    if (peerjsQrContainer) renderQR(peerjsQrContainer, peerId, { size: 240 });
    if (peerIdText) peerIdText.textContent = peerId;
    if (pairingStatusPeerjs) pairingStatusPeerjs.textContent = 'Waiting for parent to connect…';

    // Listen for the parent to connect back to us
    parentListenPeerJs({
      onReady(conn) {
        activeConnection = conn;
        stopScanner();
        startMonitor(conn);
      },
      onState(connState) {
        if (connState === 'disconnected' || connState === 'failed') {
          handleDisconnect(connState);
        }
      },
      onMessage(msg) {
        handleDataMessage(msg);
      },
    });
  } catch (err) {
    if (pairingStatusPeerjs) {
      pairingStatusPeerjs.textContent = `Connection failed: ${err.message}. Try Offline QR pairing.`;
    }
    console.error('[baby] PeerJS pairing error:', err);
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
        if (s === 'disconnected' || s === 'failed') handleDisconnect(s);
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
        if (s === 'disconnected' || s === 'failed') handleDisconnect(s);
      },
    });
  } catch (err) {
    console.error('[baby] Offline pairing error:', err);
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
 * @returns {Promise<MediaStream>}
 */
async function getUserMediaStream() {
  const q    = QUALITY_PRESETS[state.quality] ?? QUALITY_PRESETS.medium;
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
    console.error('[baby] getUserMedia failed:', err);
    // Fallback to audio-only if camera access denied
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream = audioStream;
    return audioStream;
  }
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

  // Update aria-pressed on mode buttons
  for (const btn of modeBtns) {
    btn.setAttribute('aria-pressed', btn.dataset.mode === mode ? 'true' : 'false');
  }

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

  function resizeCanvas() {
    soothingCanvas.width  = window.innerWidth;
    soothingCanvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

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
  soothingCanvas.style.background = 'linear-gradient(135deg, #0d4f8e, #4db8e8)';
  // Full animated water in TASK-017
}

/** Stars effect stub (TASK-018). */
function _startStarsEffect() {
  if (!soothingCanvas) return;
  soothingCanvas.style.background = 'radial-gradient(ellipse at center, #1a1a4e 0%, #000010 80%)';
  // Full animated stars in TASK-018
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

function setupStatusFade() {
  const statusEl = document.getElementById('baby-status');
  if (!statusEl) return;

  function showStatus() {
    statusEl.classList.remove('faded');
    clearTimeout(_statusFadeTimeout);
    _statusFadeTimeout = setTimeout(() => {
      statusEl.classList.add('faded');
    }, 4000);
  }

  showStatus();
  document.addEventListener('touchstart', showStatus, { passive: true });
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
      } else {
        babyBattery?.classList.remove('battery-low');
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
      // Apply to GainNode in TASK-019
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
      state.audioOnly = msg.value;
      // Toggle video track in TASK-010
      sendStateSnapshot();
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
  stopScanner();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  activeConnection = null;
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
  state.audioOnly = audioOnlyToggle.checked;
  saveSetting(SETTING_KEYS.CAMERA_FACING, state.cameraFacing);
  if (activeConnection?.dataChannel) {
    sendMessage(activeConnection.dataChannel, MSG.SET_AUDIO_ONLY, state.audioOnly);
  }
});

orientationSelect?.addEventListener('change', () => {
  const value = orientationSelect.value;
  saveSetting(SETTING_KEYS.ORIENTATION, value);
  if (value !== 'auto' && screen.orientation?.lock) {
    screen.orientation.lock(value).catch(() => {});
  }
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

tapOverlay?.addEventListener('click', () => {
  tapOverlay.classList.add('hidden');
  init().catch(err => {
    // If init throws (e.g. browser compatibility block), keep overlay
    console.error('[baby] init error:', err);
  });
}, { once: true });
