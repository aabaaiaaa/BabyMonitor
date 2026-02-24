/**
 * parent.js — Parent monitor mode entry point (parent.html)
 *
 * Responsibilities (stubs for future tasks):
 *   TASK-003  — Wake Lock API
 *   TASK-006  — Pairing flow UI (Method 1 + 2 + 3)
 *   TASK-007  — Peer connection management
 *   TASK-009  — Data channel / message handling
 *   TASK-011  — Media stream display + Web Audio graph
 *   TASK-012  — Speak-through
 *   TASK-013  — Audio file transfer
 *   TASK-021  — Dashboard layout
 *   TASK-022  — Multi-monitor support (up to 4)
 *   TASK-023  — Baby device labelling
 *   TASK-024  — Noise level visualiser
 *   TASK-025  — Remote control panel
 *   TASK-026  — Movement detection
 *   TASK-027  — Movement alerts + notifications
 *   TASK-036  — Low battery alert
 *   TASK-037  — Autoplay policy
 *   TASK-044  — Safe sleep guide
 *   TASK-045  — Browser compatibility
 *   TASK-046  — Dark / night mode
 *   TASK-047  — Notification permission
 *   TASK-048  — State sync from baby device
 *   TASK-058  — Share with additional parent
 */

import {
  lsGet, lsSet, getSettings, saveSetting, SETTING_KEYS,
  getDeviceProfile, saveDeviceProfile,
} from './storage.js';
import { renderSafeSleepContent } from './safe-sleep.js';
import {
  initPeer, destroyPeer,
  parentListenPeerJs, getPeer,
  offlineParentReceiveOffer,
  sendMessage, MSG,
  onPeerStatus, PEER_ERROR,
} from './webrtc.js';
import {
  renderQR, renderQRGrid,
  scanSingle, scanMulti, scanAuto, stopScanner,
} from './qr.js';
import { showCompatWarnings } from './browser-compat.js';
import { showNotificationPermissionScreen } from './notifications.js';

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

/** @type {object} */
let settings = getSettings();

/** Maximum simultaneous baby monitors (TASK-022). */
const MAX_MONITORS = 4;

/**
 * @typedef {object} MonitorEntry
 * @property {string}        deviceId
 * @property {string}        label
 * @property {object}        conn          — normalised connection
 * @property {MediaStream|null}   mediaStream
 * @property {HTMLElement}   panelEl
 * @property {AudioContext}  audioCtx
 * @property {MediaStreamAudioSourceNode|null} sourceNode — TASK-011: stored for cleanup
 * @property {GainNode}      gainNode      — TASK-011 / TASK-056 hookup: volume + smooth ramp
 * @property {AnalyserNode}  analyserNode  — TASK-024 hookup: noise visualiser
 * @property {number}        desiredGain   — TASK-011: last user-set gain (0–1); preserved across mute
 * @property {number}        noiseThreshold
 * @property {boolean}       audioMuted
 */

/** @type {Map<string, MonitorEntry>} deviceId → monitor entry */
const monitors = new Map();

/** @type {string|null} Device ID of the currently open control panel */
let controlPanelDeviceId = null;

/** @type {WakeLockSentinel|null} */
let wakeLock = null;

/** @type {Function|null} Unsubscribe function for the current peer status listener */
let _peerStatusUnsub = null;

// ---------------------------------------------------------------------------
// File transfer state (TASK-013)
// ---------------------------------------------------------------------------

/**
 * Active file transfer. Only one at a time across all connected monitors.
 * @type {{ id: string, deviceId: string, totalChunks: number, sentChunks: number } | null}
 */
let _activeTransfer = null;

/**
 * Per-device record of the last successfully transferred file, keyed by deviceId.
 * Used to restore playback controls when the control panel is reopened.
 * @type {Map<string, { name: string }>}
 */
const _lastTransferredFile = new Map();

/** Chunk size for file transfer: 16 KB (safe for all WebRTC implementations). */
const FILE_CHUNK_SIZE = 16 * 1024;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const tapOverlay          = document.getElementById('tap-overlay');
const pairingSection      = document.getElementById('pairing-section');
const addParentSection    = document.getElementById('add-parent-section');
const parentDashboard     = document.getElementById('parent-dashboard');
const monitorGrid         = document.getElementById('monitor-grid');
const monitorGridEmpty    = document.getElementById('monitor-grid-empty');
const alertBanners        = document.getElementById('alert-banners');
const controlPanel        = document.getElementById('control-panel');
const controlPanelTitle   = document.getElementById('control-panel-title');
const controlPanelClose   = document.getElementById('control-panel-close');
const safeSlotScreen      = document.getElementById('safe-sleep-screen');
const settingsScreen      = document.getElementById('settings-screen');
const notifScreen         = document.getElementById('notif-screen');

// Pairing elements
const pairingMethodStep   = document.getElementById('pairing-method-step');
const pairingPeerjsStep   = document.getElementById('pairing-peerjs-step');
const pairingOfflineStep  = document.getElementById('pairing-offline-step');
const peerjsScanVideo     = document.getElementById('peerjs-scan-video');
const peerjsScanStatus    = document.getElementById('peerjs-scan-status');
const offlineScanVideo    = document.getElementById('offline-scan-video');
const offlineScanProgress = document.getElementById('offline-scan-progress');
const offlineAnswerContainer = document.getElementById('offline-answer-container');
const pairingStatusOffline   = document.getElementById('pairing-status-offline');

// Header buttons
const btnAddMonitor       = document.getElementById('btn-add-monitor');
const darkModeToggle      = document.getElementById('dark-mode-toggle');
const themeIcon           = document.getElementById('theme-icon');
const btnDashboardSettings = document.getElementById('btn-dashboard-settings');
const btnSafeSleep        = document.getElementById('btn-safe-sleep');

// Control panel buttons / inputs
const cpSpeakBtn          = document.getElementById('cp-speak-btn');
const cpVolume            = document.getElementById('cp-volume');
const cpMonitorVolume     = document.getElementById('cp-monitor-volume'); // TASK-011
const cpTrackSelect       = document.getElementById('cp-track-select');
const cpTimerBtns         = controlPanel?.querySelectorAll('.timer-btn') ?? [];
const cpTimerCountdown    = document.getElementById('cp-timer-countdown');
const cpFlipCamera        = document.getElementById('cp-flip-camera');
const cpAudioOnly         = document.getElementById('cp-audio-only');
const cpNoiseThreshold    = document.getElementById('cp-noise-threshold');
const cpAudioFile         = document.getElementById('cp-audio-file');
const cpSendAudio         = document.getElementById('cp-send-audio');
const cpTransferProgress  = document.getElementById('cp-transfer-progress');
const cpTransferBar       = document.getElementById('cp-transfer-bar');
const cpTransferPct       = document.getElementById('cp-transfer-pct');
const cpFilePlayback      = document.getElementById('cp-file-playback');
const cpFileName          = document.getElementById('cp-file-name');
const cpFilePlay          = document.getElementById('cp-file-play');
const cpFilePause         = document.getElementById('cp-file-pause');
const cpFileStop          = document.getElementById('cp-file-stop');
const cpDisconnect        = document.getElementById('cp-disconnect');

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Browser compatibility check (TASK-045)
// Run immediately at module load — before any user interaction or init().
// ---------------------------------------------------------------------------

const _compatResult = showCompatWarnings();

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  setupTheme();
  maybePromptDarkMode();
  await requestWakeLock();
  await showNotificationPermissionScreen(notifScreen); // TASK-047
  showDashboard();

  // Check URL params before deciding which screen to show first.
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('mode') === 'add-parent') {
    // Launched from "Add Parent Device" on the home screen
    showAddParent();
  } else if (monitors.size === 0) {
    // No monitors connected yet — jump straight to pairing wizard
    showPairing();
  }
}

// ---------------------------------------------------------------------------
// Theme (TASK-046)
// ---------------------------------------------------------------------------

function setupTheme() {
  const saved = lsGet(SETTING_KEYS.THEME, null);
  if (saved === 'dark') {
    document.body.classList.add('dark-mode');
    if (themeIcon) themeIcon.textContent = '☀️';
  }
}

function maybePromptDarkMode() {
  const alreadySeen = lsGet(SETTING_KEYS.THEME_PROMPT_SEEN, false);
  if (alreadySeen || lsGet(SETTING_KEYS.THEME, null) !== null) return;

  const hour = new Date().getHours();
  if (hour >= 19 || hour < 7) {
    // Subtle non-blocking prompt — implementation in TASK-046
    lsSet(SETTING_KEYS.THEME_PROMPT_SEEN, true);
  }
}

darkModeToggle?.addEventListener('click', () => {
  const isDark = document.body.classList.toggle('dark-mode');
  saveSetting(SETTING_KEYS.THEME, isDark ? 'dark' : 'light');
  if (themeIcon) themeIcon.textContent = isDark ? '☀️' : '🌙';
});

// ---------------------------------------------------------------------------
// Wake Lock (TASK-003)
// ---------------------------------------------------------------------------

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    console.warn('[parent] Wake lock request failed:', err);
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && !wakeLock) {
    await requestWakeLock();
  }
});

// ---------------------------------------------------------------------------
// Notification permission (TASK-047)
// Handled by showNotificationPermissionScreen() in js/notifications.js,
// called from init() above. The notification state is persisted to localStorage
// via SETTING_KEYS.NOTIF_PROMPTED and SETTING_KEYS.NOTIF_GRANTED.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Screen helpers
// ---------------------------------------------------------------------------

function showDashboard() {
  tapOverlay?.classList.add('hidden');
  pairingSection?.classList.add('hidden');
  addParentSection?.classList.add('hidden');
  parentDashboard?.classList.remove('hidden');
  controlPanel?.classList.add('hidden');
  safeSlotScreen?.classList.add('hidden');
  settingsScreen?.classList.add('hidden');
  refreshGridEmpty();
}

function showPairing() {
  parentDashboard?.classList.add('hidden');
  pairingSection?.classList.remove('hidden');
  addParentSection?.classList.add('hidden');
  controlPanel?.classList.add('hidden');
  showPairingMethodStep();
}

function showAddParent() {
  parentDashboard?.classList.add('hidden');
  pairingSection?.classList.add('hidden');
  addParentSection?.classList.remove('hidden');
  startAddParentFlow();
}

// ---------------------------------------------------------------------------
// Pairing flow (TASK-006)
// ---------------------------------------------------------------------------

function showPairingMethodStep() {
  pairingMethodStep?.classList.remove('hidden');
  pairingPeerjsStep?.classList.add('hidden');
  pairingOfflineStep?.classList.add('hidden');
}

/** Method 1: PeerJS — scan QR from baby device. */
async function startPeerJsPairing() {
  pairingMethodStep?.classList.add('hidden');
  pairingPeerjsStep?.classList.remove('hidden');

  // Remove any leftover fallback button from a previous attempt
  pairingPeerjsStep?.querySelector('.peerjs-fallback-btn')?.remove();

  if (peerjsScanStatus) peerjsScanStatus.textContent = 'Connecting to pairing server…';

  // Unsubscribe any previous status listener to prevent duplicates
  _peerStatusUnsub?.();

  // Register a status listener that drives the pairing UI in real time.
  _peerStatusUnsub = onPeerStatus((status, detail) => {
    // Only update UI while the PeerJS pairing step is visible
    if (pairingPeerjsStep?.classList.contains('hidden')) return;

    if (status === 'disconnected') {
      if (peerjsScanStatus) peerjsScanStatus.textContent = 'Reconnecting to pairing server…';
    } else if (status === 'error') {
      const msg = detail?.message ?? 'PeerJS connection error. Try Offline QR pairing.';
      if (peerjsScanStatus) peerjsScanStatus.textContent = msg;

      // Offer a one-tap fallback to Offline QR when the server is unreachable
      if (detail?.serverUnavailable || detail?.type === PEER_ERROR.LIBRARY_UNAVAILABLE) {
        _showPeerjsOfflineFallback();
      }
    }
  });

  try {
    const peerjsServerConfig = lsGet(SETTING_KEYS.PEERJS_SERVER, null);
    await initPeer(peerjsServerConfig);

    if (peerjsScanStatus) peerjsScanStatus.textContent = 'Scan the QR code on the baby device.';

    const babyPeerId = await scanSingle(peerjsScanVideo, {
      onProgress(msg) {
        if (peerjsScanStatus) peerjsScanStatus.textContent = msg;
      },
    });

    if (peerjsScanStatus) peerjsScanStatus.textContent = 'Connecting to baby device…';
    stopScanner();

    // PeerJS pairing flow:
    // 1. We scanned the baby's QR code and have the baby's peer ID.
    // 2. We set up parentListenPeerJs() to receive the baby's incoming media call.
    // 3. We open a data connection to the baby device, signalling that a parent
    //    is ready — this triggers the baby to call us back with its media stream.
    // 4. When the baby calls, parentListenPeerJs fires onReady with the connection.
    parentListenPeerJs({
      onReady(conn) {
        _peerStatusUnsub?.();
        _peerStatusUnsub = null;
        stopScanner();
        addMonitor(conn);
        showDashboard();
      },
      onState(s) {
        if (s === 'disconnected' || s === 'failed') {
          removeMonitor(babyPeerId);
        }
      },
      onMessage(msg) {
        // Route the message to the correct monitor using the baby's peer ID.
        // After addMonitor() the entry is keyed by conn.deviceId which equals babyPeerId.
        handleDataMessage(babyPeerId, msg);
      },
    });

    // Open a data connection to the baby. The baby's peer.on('connection') handler
    // receives this, reads our peer ID, then calls us back with its media stream.
    const peer = getPeer();
    const triggerConn = peer.connect(babyPeerId, { reliable: true });
    triggerConn.on('error', (err) => {
      console.error('[parent] Trigger data connection to baby failed:', err);
      if (!pairingPeerjsStep?.classList.contains('hidden')) {
        if (peerjsScanStatus) {
          peerjsScanStatus.textContent = 'Failed to reach baby device. Please try again.';
        }
      }
    });
  } catch (err) {
    // Fatal error: status listener already updated the UI text.
    console.error('[parent] PeerJS pairing fatal error:', err);
  }
}

/**
 * Show a "Use Offline QR instead" button in the PeerJS pairing step.
 * Called when the PeerJS server is unreachable so the user has a clear
 * one-tap path to the offline connection method.
 */
function _showPeerjsOfflineFallback() {
  if (!pairingPeerjsStep) return;
  if (pairingPeerjsStep.querySelector('.peerjs-fallback-btn')) return;

  const btn = document.createElement('button');
  btn.className   = 'action-btn peerjs-fallback-btn';
  btn.textContent = 'Use Offline QR instead';
  btn.setAttribute('aria-label', 'Switch to Offline QR pairing');

  btn.addEventListener('click', () => {
    _peerStatusUnsub?.();
    _peerStatusUnsub = null;
    destroyPeer();
    stopScanner();
    // Return to method selection so the user can pick Offline QR
    pairingPeerjsStep?.classList.add('hidden');
    pairingMethodStep?.classList.remove('hidden');
  });

  if (peerjsScanStatus) {
    pairingPeerjsStep.insertBefore(btn, peerjsScanStatus);
  } else {
    pairingPeerjsStep.appendChild(btn);
  }
}

/** Method 2: Offline QR — scan baby SDP grid, show answer grid. */
async function startOfflinePairing() {
  pairingMethodStep?.classList.add('hidden');
  pairingOfflineStep?.classList.remove('hidden');

  if (pairingStatusOffline) pairingStatusOffline.textContent = 'Scan the QR grid shown on the baby device.';

  try {
    // Step 1: scan baby's offer grid
    const offerJson = await scanMulti(offlineScanVideo, {
      onProgress(scanned, total) {
        if (offlineScanProgress) {
          offlineScanProgress.textContent = total
            ? `Scanned ${scanned} of ${total}`
            : `Scanned ${scanned}…`;
        }
      },
    });

    if (pairingStatusOffline) pairingStatusOffline.textContent = 'Generating answer…';

    // Temporary device ID for the offline connection
    const tempDeviceId = 'offline-' + crypto.randomUUID().slice(0, 8);

    // Step 2: generate SDP answer from offer
    const answerJson = await offlineParentReceiveOffer(offerJson, {
      onReady(conn) {
        stopScanner();
        addMonitor({ ...conn, deviceId: tempDeviceId });
        showDashboard();
      },
      onState(s) {
        if (s === 'disconnected' || s === 'failed') {
          removeMonitor(tempDeviceId);
        }
      },
      onMessage(msg) {
        handleDataMessage(tempDeviceId, msg);
      },
    });

    // Step 3: show answer as QR grid for baby to scan
    if (offlineScanVideo.parentElement) offlineScanVideo.parentElement.classList.add('hidden');
    if (offlineAnswerContainer) {
      offlineAnswerContainer.classList.remove('hidden');
      // No explicit qrSize: renderQRGrid will size cells to fit the container.
      renderQRGrid(offlineAnswerContainer, answerJson);
      if (pairingStatusOffline) {
        pairingStatusOffline.textContent = 'Show this to the baby device camera.';
      }
    }
  } catch (err) {
    console.error('[parent] Offline pairing error:', err);
  }
}

/** Method 3: add additional parent — scan existing parent's QR (TASK-006). */
async function startAddParentFlow() {
  // Implementation in TASK-006 / TASK-058
  const addScanVideo  = document.getElementById('add-parent-scan-video');
  const addScanStatus = document.getElementById('add-parent-scan-status');

  if (addScanStatus) addScanStatus.textContent = 'Point at the QR code on the first parent device.';

  try {
    const firstParentPeerId = await scanSingle(addScanVideo, {
      onProgress(msg) {
        if (addScanStatus) addScanStatus.textContent = msg;
      },
    });

    if (addScanStatus) addScanStatus.textContent = 'Connecting…';

    // Full implementation in TASK-006
    console.log('[parent] Add parent — first parent peer ID:', firstParentPeerId);
  } catch (err) {
    console.error('[parent] Add parent flow error:', err);
  }
}

// ---------------------------------------------------------------------------
// Monitor management (TASK-021, TASK-022)
// ---------------------------------------------------------------------------

/**
 * Add a newly connected baby monitor to the dashboard.
 * @param {import('./webrtc.js').Connection} conn
 */
function addMonitor(conn) {
  if (monitors.size >= MAX_MONITORS) {
    console.warn('[parent] Maximum monitors reached');
    return;
  }

  const { deviceId } = conn;
  if (monitors.has(deviceId)) return; // Already connected

  // Load or create device profile (TASK-023)
  const profile = getDeviceProfile(deviceId) ?? {
    id:               deviceId,
    label:            `Baby ${monitors.size + 1}`,
    noiseThreshold:   60,
    motionThreshold:  50,
    batteryThreshold: 15,
    backupPoolJson:   null,
  };
  saveDeviceProfile(profile);

  // -------------------------------------------------------------------------
  // Set up Web Audio graph (TASK-011)
  // Architecture:  MediaStreamSourceNode (audio track only)
  //                   → GainNode    (TASK-011 volume / TASK-056 smooth-ramp hookup)
  //                   → AnalyserNode (TASK-024 noise-visualiser hookup)
  //                   → AudioContext.destination
  //
  // The video element (created in createMonitorPanel) has the `muted` attribute
  // set so it never plays audio — all audio flows through this graph.
  // -------------------------------------------------------------------------
  const audioCtx = new AudioContext();

  // Resume immediately — the user has already interacted with the page via the
  // tap-to-begin overlay, so this should succeed on all major browsers.
  audioCtx.resume().catch(err => console.warn('[parent] AudioContext resume failed:', err));

  // Default gain: 80% — matches the monitor volume slider default (value="80").
  const initialGain = Number(cpMonitorVolume?.value ?? 80) / 100;
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = initialGain;

  // AnalyserNode — TASK-024 hookup point (noise visualiser reads from this).
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;

  // Wire: gain → analyser → speakers
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  // Create the MediaStreamSourceNode from the audio track(s) only.
  // The full stream (including video) is attached to the <video> element
  // separately; here we only want audio in the Web Audio graph.
  let sourceNode = null;
  if (conn.mediaStream) {
    const audioTracks = conn.mediaStream.getAudioTracks();
    if (audioTracks.length > 0) {
      const audioOnlyStream = new MediaStream(audioTracks);
      sourceNode = audioCtx.createMediaStreamSource(audioOnlyStream);
      sourceNode.connect(gainNode);
    }
  }

  // Create the panel DOM element
  const panelEl = createMonitorPanel(deviceId, profile.label, conn);
  monitorGrid?.insertBefore(panelEl, monitorGridEmpty ?? null);

  /** @type {MonitorEntry} */
  const entry = {
    deviceId,
    label:          profile.label,
    conn,
    mediaStream:    conn.mediaStream,
    panelEl,
    audioCtx,
    sourceNode,           // stored for disconnection on cleanup (TASK-011)
    gainNode,
    analyserNode:   analyser,
    desiredGain:    initialGain, // preserved across mute/unmute (TASK-050)
    noiseThreshold: profile.noiseThreshold,
    audioMuted:     false,
  };

  monitors.set(deviceId, entry);
  monitorGrid?.setAttribute('data-count', String(monitors.size));
  refreshGridEmpty();

  // Start noise visualiser (TASK-024)
  startNoiseVisualiser(entry);
}

/**
 * Remove a monitor and clean up its resources.
 * @param {string} deviceId
 */
function removeMonitor(deviceId) {
  const entry = monitors.get(deviceId);
  if (!entry) return;

  // Abort any active file transfer to this device (TASK-013).
  // Setting _activeTransfer to null causes the send loop to exit cleanly on
  // its next iteration; we also re-enable the file picker / send button here
  // because the async sender loop may not get a chance to do so.
  if (_activeTransfer?.deviceId === deviceId) {
    _activeTransfer = null;
    _setTransferUiActive(false);
    _clearTransferUi();
  }

  // Close the WebRTC connection cleanly (closes data channel / peer connection)
  try { entry.conn?.close?.(); } catch (_) { /* ignore */ }

  // Stop media tracks
  entry.mediaStream?.getTracks().forEach(t => t.stop());

  // Disconnect Web Audio nodes (TASK-011: disconnect in source→gain→analyser order)
  try {
    entry.sourceNode?.disconnect();   // disconnect source first to stop feeding the graph
    entry.gainNode?.disconnect();
    entry.analyserNode?.disconnect();
    entry.audioCtx?.close();
  } catch (_) {/* ignore */}

  // Remove panel from DOM
  entry.panelEl?.remove();

  monitors.delete(deviceId);
  monitorGrid?.setAttribute('data-count', String(monitors.size));
  refreshGridEmpty();

  if (controlPanelDeviceId === deviceId) {
    closeControlPanel();
  }
}

function refreshGridEmpty() {
  if (!monitorGridEmpty) return;
  monitorGridEmpty.classList.toggle('hidden', monitors.size > 0);
  if (btnAddMonitor) {
    btnAddMonitor.disabled   = monitors.size >= MAX_MONITORS;
    btnAddMonitor.title      = monitors.size >= MAX_MONITORS
      ? 'Maximum 4 baby monitors connected'
      : 'Add baby monitor';
  }
}

// ---------------------------------------------------------------------------
// Monitor panel DOM (TASK-021)
// ---------------------------------------------------------------------------

/**
 * Create a monitor panel element for a baby device.
 * @param {string} deviceId
 * @param {string} label
 * @param {import('./webrtc.js').Connection} conn
 * @returns {HTMLElement}
 */
function createMonitorPanel(deviceId, label, conn) {
  const panel = document.createElement('div');
  panel.className   = 'monitor-panel';
  panel.dataset.deviceId = deviceId;
  panel.setAttribute('role', 'listitem');
  panel.setAttribute('aria-label', `Baby monitor: ${label}`);
  panel.setAttribute('tabindex', '0');

  panel.innerHTML = `
    <div class="monitor-panel__header">
      <span class="monitor-panel__label">${escapeHtml(label)}</span>
      <div class="monitor-panel__meta">
        <span class="status-badge" title="Connection status"></span>
        <span class="panel-battery" title="Battery"></span>
      </div>
    </div>
    <div class="monitor-panel__video-wrap">
      <video class="monitor-panel__video" autoplay playsinline muted
             aria-label="Video from ${escapeHtml(label)}"></video>
      <div class="monitor-panel__conn-overlay hidden">
        <span>Connecting…</span>
      </div>
    </div>
    <div class="monitor-panel__footer">
      <div class="noise-bar-wrap" title="Noise level" aria-label="Noise level">
        <div class="noise-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>
      </div>
      <button class="monitor-panel__controls-btn" aria-label="Open controls for ${escapeHtml(label)}"
              title="Controls">⚙️</button>
    </div>
  `;

  // Attach media stream to video element
  const videoEl = panel.querySelector('.monitor-panel__video');
  if (videoEl && conn.mediaStream) {
    videoEl.srcObject = conn.mediaStream;
  }

  // Open control panel on click (excluding the controls button, which already does it)
  panel.addEventListener('click', (e) => {
    if (e.target.closest('.monitor-panel__controls-btn')) {
      openControlPanel(deviceId);
    }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') openControlPanel(deviceId);
  });

  panel.querySelector('.monitor-panel__controls-btn')
    ?.addEventListener('click', (e) => {
      e.stopPropagation();
      openControlPanel(deviceId);
    });

  return panel;
}

// ---------------------------------------------------------------------------
// Noise visualiser (TASK-024)
// ---------------------------------------------------------------------------

/**
 * Start a noise level visualiser for a monitor entry.
 * @param {MonitorEntry} entry
 */
function startNoiseVisualiser(entry) {
  const panel   = entry.panelEl;
  const noiseBar = panel?.querySelector('.noise-bar');
  if (!noiseBar || !entry.analyserNode) return;

  const bufferLength = entry.analyserNode.frequencyBinCount;
  const dataArray    = new Uint8Array(bufferLength);
  let frameCount     = 0;

  function tick() {
    if (!monitors.has(entry.deviceId)) return; // Monitor removed

    frameCount++;
    // Throttle to ~10 fps (every 6th frame at 60fps)
    if (frameCount % 6 === 0) {
      entry.analyserNode.getByteTimeDomainData(dataArray);

      // Compute RMS
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const norm = (dataArray[i] / 128.0) - 1;
        sum += norm * norm;
      }
      const rms = Math.sqrt(sum / bufferLength);
      const level = Math.min(100, Math.round(rms * 300));

      noiseBar.style.width = `${level}%`;
      noiseBar.setAttribute('aria-valuenow', String(level));

      const aboveThreshold = level > entry.noiseThreshold;
      noiseBar.classList.toggle('above-threshold', aboveThreshold && level < 80);
      noiseBar.classList.toggle('high',            level >= 80);
      entry.panelEl?.classList.toggle('monitor-panel--alert', aboveThreshold);
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Control panel (TASK-025)
// ---------------------------------------------------------------------------

/**
 * Open the control panel for a specific baby monitor.
 * @param {string} deviceId
 */
function openControlPanel(deviceId) {
  const entry = monitors.get(deviceId);
  if (!entry) return;

  controlPanelDeviceId = deviceId;
  if (controlPanelTitle) controlPanelTitle.textContent = `Controls — ${entry.label}`;

  // Populate noise threshold from profile
  if (cpNoiseThreshold) cpNoiseThreshold.value = String(entry.noiseThreshold);

  // Sync monitor volume slider to this entry's current desired gain (TASK-011).
  // Opening the control panel is always in response to a user gesture, so
  // this is also the right place to resume a suspended AudioContext.
  if (cpMonitorVolume) {
    cpMonitorVolume.value = String(Math.round(entry.desiredGain * 100));
  }
  entry.audioCtx?.resume().catch(() => {});

  // Restore file playback controls if a file was previously transferred to this device (TASK-013).
  const tf = _lastTransferredFile.get(deviceId);
  if (tf && cpFilePlayback) {
    cpFilePlayback.classList.remove('hidden');
    if (cpFileName)  cpFileName.textContent = tf.name;
    if (cpFilePlay)  cpFilePlay.disabled  = false;
    if (cpFilePause) cpFilePause.disabled = true;
    if (cpFileStop)  cpFileStop.disabled  = true;
  } else if (cpFilePlayback) {
    cpFilePlayback.classList.add('hidden');
  }

  // Also reset the file input and hide the progress bar when switching device context.
  if (cpAudioFile)        cpAudioFile.value   = '';
  if (cpSendAudio)        cpSendAudio.disabled = true;
  if (cpTransferProgress) cpTransferProgress.classList.add('hidden');

  controlPanel?.classList.remove('hidden');
}

function closeControlPanel() {
  controlPanel?.classList.add('hidden');
  controlPanelDeviceId = null;
  stopScanner();
}

/** Get the connection for the currently open control panel. */
function getActiveConn() {
  if (!controlPanelDeviceId) return null;
  return monitors.get(controlPanelDeviceId)?.conn ?? null;
}

controlPanelClose?.addEventListener('click', closeControlPanel);

// Control panel mode buttons
controlPanel?.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    const conn = getActiveConn();
    if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_MODE, mode);
    // Update aria-pressed locally
    controlPanel.querySelectorAll('.mode-btn').forEach(b =>
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')
    );
  });
});

// Baby device music volume slider — sends SET_VOLUME message to baby (controls soothing music).
cpVolume?.addEventListener('input', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_VOLUME, Number(cpVolume.value));
});

// Monitor volume slider (TASK-011) — adjusts the local GainNode for this baby's audio output.
// Uses a short linear ramp for smooth gain changes (ramp pattern reused by TASK-056).
cpMonitorVolume?.addEventListener('input', () => {
  if (!controlPanelDeviceId) return;
  const entry = monitors.get(controlPanelDeviceId);
  if (!entry) return;

  const targetGain = Number(cpMonitorVolume.value) / 100;
  // Smooth 50 ms ramp — prevents clicks/pops on rapid slider movement.
  const rampEnd = entry.audioCtx.currentTime + 0.05;
  entry.gainNode.gain.cancelScheduledValues(entry.audioCtx.currentTime);
  entry.gainNode.gain.setValueAtTime(entry.gainNode.gain.value, entry.audioCtx.currentTime);
  entry.gainNode.gain.linearRampToValueAtTime(targetGain, rampEnd);

  // Persist as the desired gain so it can be restored after a mute (TASK-050).
  entry.desiredGain = targetGain;
  entry.audioMuted  = (targetGain === 0);
});

// Track selector
cpTrackSelect?.addEventListener('change', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_TRACK, cpTrackSelect.value);
});

// Timer buttons
for (const btn of cpTimerBtns) {
  btn.addEventListener('click', () => {
    const duration = Number(btn.dataset.duration);
    const conn = getActiveConn();
    if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_FADE_TIMER, duration * 60);
    cpTimerBtns.forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
  });
}

// Speak-through (push-to-talk default, TASK-012)
cpSpeakBtn?.addEventListener('pointerdown', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SPEAK_START);
  cpSpeakBtn.setAttribute('aria-pressed', 'true');
  cpSpeakBtn.classList.add('active');
});

cpSpeakBtn?.addEventListener('pointerup', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SPEAK_STOP);
  cpSpeakBtn.setAttribute('aria-pressed', 'false');
  cpSpeakBtn.classList.remove('active');
});

// Camera flip
cpFlipCamera?.addEventListener('click', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.FLIP_CAMERA);
});

// Audio-only toggle
cpAudioOnly?.addEventListener('change', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_AUDIO_ONLY, cpAudioOnly.checked);
});

// Noise threshold
cpNoiseThreshold?.addEventListener('change', () => {
  if (!controlPanelDeviceId) return;
  const entry = monitors.get(controlPanelDeviceId);
  if (entry) {
    entry.noiseThreshold = Number(cpNoiseThreshold.value);
    const profile = getDeviceProfile(controlPanelDeviceId);
    if (profile) saveDeviceProfile({ ...profile, noiseThreshold: entry.noiseThreshold });
  }
});

// Audio file picker — enable send button when a valid file is selected (TASK-013)
cpAudioFile?.addEventListener('change', () => {
  // Only enable when no transfer is already in progress and a file is selected
  if (cpSendAudio) {
    cpSendAudio.disabled = !cpAudioFile.files?.length || !!_activeTransfer;
  }
});

// Send audio file to baby device (TASK-013) — chunked base64 transfer over data channel
cpSendAudio?.addEventListener('click', async () => {
  if (_activeTransfer) return; // Guard: only one transfer at a time
  const conn = getActiveConn();
  if (!conn?.dataChannel || !cpAudioFile?.files?.length) return;

  const file        = cpAudioFile.files[0];
  const transferId  = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE);
  // Capture the target device at click time so later changes to controlPanelDeviceId
  // (e.g. the user closes and reopens the panel) don't corrupt the transfer record.
  const targetDeviceId = controlPanelDeviceId;

  _activeTransfer = { id: transferId, deviceId: targetDeviceId, totalChunks, sentChunks: 0 };

  // Disable the file picker and send button for the duration of the transfer
  _setTransferUiActive(true);

  try {
    // Step 1: send file metadata so the baby can prepare its receive buffer
    sendMessage(conn.dataChannel, MSG.FILE_META, {
      id:          transferId,
      name:        file.name,
      size:        file.size,
      mimeType:    file.type || 'audio/mpeg',
      totalChunks,
    });

    // Step 2: read the file as a single ArrayBuffer then slice into chunks
    const buffer = await file.arrayBuffer();
    const bytes  = new Uint8Array(buffer);

    for (let seq = 0; seq < totalChunks; seq++) {
      // Abort if the connection dropped and removeMonitor() cleared _activeTransfer
      if (!_activeTransfer || _activeTransfer.id !== transferId) break;

      // Slice chunk and base64-encode it for JSON transport
      const start  = seq * FILE_CHUNK_SIZE;
      const end    = Math.min(start + FILE_CHUNK_SIZE, bytes.byteLength);
      const chunk  = bytes.subarray(start, end);
      let   binary = '';
      for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
      const data = btoa(binary);

      sendMessage(conn.dataChannel, MSG.FILE_CHUNK, { id: transferId, seq, data });

      // Update progress
      _activeTransfer.sentChunks = seq + 1;
      _updateTransferProgress(seq + 1, totalChunks);

      // Yield to event loop every 10 chunks to keep the page responsive
      if (seq % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }

    // Step 3: send completion marker (only if not aborted mid-transfer)
    if (_activeTransfer?.id === transferId) {
      sendMessage(conn.dataChannel, MSG.FILE_COMPLETE, { id: transferId });
      _lastTransferredFile.set(targetDeviceId, { name: file.name });
      _activeTransfer = null;
      _setTransferUiActive(false);
      _showFilePlaybackControls(targetDeviceId, file.name);
    }
  } catch (err) {
    console.error('[parent] File transfer error:', err);
    if (_activeTransfer?.id === transferId) {
      // Try to notify the baby; ignore errors if the channel is already closed
      try {
        sendMessage(conn.dataChannel, MSG.FILE_ABORT, { id: transferId, reason: err.message });
      } catch (_) { /* channel may already be closed */ }
      _activeTransfer = null;
      _setTransferUiActive(false);
      _clearTransferUi();
    }
  }
});

// Transferred audio playback controls (TASK-013) — send commands to baby device
cpFilePlay?.addEventListener('click', () => {
  const conn = getActiveConn();
  if (!conn?.dataChannel) return;
  sendMessage(conn.dataChannel, MSG.FILE_PLAY);
  if (cpFilePlay)  cpFilePlay.disabled  = true;
  if (cpFilePause) cpFilePause.disabled = false;
  if (cpFileStop)  cpFileStop.disabled  = false;
});

cpFilePause?.addEventListener('click', () => {
  const conn = getActiveConn();
  if (!conn?.dataChannel) return;
  sendMessage(conn.dataChannel, MSG.FILE_PAUSE);
  if (cpFilePlay)  cpFilePlay.disabled  = false;
  if (cpFilePause) cpFilePause.disabled = true;
  // Stop remains enabled so the user can cancel from the paused state
});

cpFileStop?.addEventListener('click', () => {
  const conn = getActiveConn();
  if (!conn?.dataChannel) return;
  sendMessage(conn.dataChannel, MSG.FILE_STOP);
  if (cpFilePlay)  cpFilePlay.disabled  = false;
  if (cpFilePause) cpFilePause.disabled = true;
  if (cpFileStop)  cpFileStop.disabled  = true;
});

// ---------------------------------------------------------------------------
// File transfer helpers (TASK-013)
// ---------------------------------------------------------------------------

/**
 * Enable or disable the file picker and send button during a transfer.
 * When `active` is true the controls are disabled and the progress bar is shown.
 * @param {boolean} active
 */
function _setTransferUiActive(active) {
  if (cpAudioFile) cpAudioFile.disabled = active;
  if (cpSendAudio) cpSendAudio.disabled = active;
  if (active) {
    cpTransferProgress?.classList.remove('hidden');
    if (cpTransferBar) cpTransferBar.value = 0;
    if (cpTransferPct) cpTransferPct.textContent = '0%';
  }
}

/**
 * Update the transfer progress bar.
 * @param {number} sent   — chunks sent so far
 * @param {number} total  — total chunks
 */
function _updateTransferProgress(sent, total) {
  const pct = Math.round((sent / total) * 100);
  if (cpTransferBar) cpTransferBar.value = pct;
  if (cpTransferPct) cpTransferPct.textContent = `${pct}%`;
}

/**
 * Hide the transfer progress bar and reset its value.
 */
function _clearTransferUi() {
  cpTransferProgress?.classList.add('hidden');
  if (cpTransferBar) cpTransferBar.value = 0;
  if (cpTransferPct) cpTransferPct.textContent = '0%';
}

/**
 * Show the playback controls section after a successful transfer.
 * Only shows if the control panel is currently open for `deviceId`.
 * @param {string} deviceId
 * @param {string} fileName
 */
function _showFilePlaybackControls(deviceId, fileName) {
  if (!cpFilePlayback) return;
  // Only update the UI if this device's control panel is currently open
  if (controlPanelDeviceId !== deviceId) return;
  cpFilePlayback.classList.remove('hidden');
  if (cpFileName)  cpFileName.textContent = fileName;
  if (cpFilePlay)  cpFilePlay.disabled  = false;
  if (cpFilePause) cpFilePause.disabled = true;
  if (cpFileStop)  cpFileStop.disabled  = true;
  _clearTransferUi();
}

// Disconnect
cpDisconnect?.addEventListener('click', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.DISCONNECT);
  if (controlPanelDeviceId) removeMonitor(controlPanelDeviceId);
  closeControlPanel();
});

// ---------------------------------------------------------------------------
// Incoming data channel messages (TASK-009, TASK-048)
// ---------------------------------------------------------------------------

/**
 * Handle a message from a baby device.
 * @param {string} deviceId
 * @param {object} msg
 */
function handleDataMessage(deviceId, msg) {
  const entry = monitors.get(deviceId);

  switch (msg.type) {

    case MSG.STATE_SNAPSHOT: {
      // Synchronise control panel with baby device state (TASK-048)
      if (!entry) break;
      const s = msg.value;
      if (controlPanelDeviceId === deviceId) {
        // Update mode buttons
        controlPanel?.querySelectorAll('.mode-btn').forEach(b =>
          b.setAttribute('aria-pressed', b.dataset.mode === s.soothingMode ? 'true' : 'false')
        );
        if (cpVolume)      cpVolume.value     = String(s.musicVolume ?? 70);
        if (cpAudioOnly)   cpAudioOnly.checked = Boolean(s.audioOnly);
      }
      break;
    }

    case MSG.BATTERY_LEVEL: {
      const { level, charging } = msg.value ?? {};
      if (!entry) break;
      const batteryEl = entry.panelEl?.querySelector('.panel-battery');
      if (batteryEl) {
        batteryEl.textContent = `${level}%${charging ? '⚡' : ''}`;
      }
      // Low battery alert (TASK-036)
      const profile = getDeviceProfile(deviceId);
      const threshold = profile?.batteryThreshold ?? 15;
      if (level < threshold && !charging) {
        showBatteryAlert(deviceId, level, entry.label);
      }
      break;
    }

    case MSG.ALERT_BATTERY_LOW: {
      // Explicit low-battery alert sent by baby when it crosses the 20% threshold.
      // showBatteryAlert() handles deduplication via the activeAlerts Set, so it
      // is safe to call even if a BATTERY_LEVEL alert was already shown.
      const { level } = msg.value ?? {};
      if (entry) showBatteryAlert(deviceId, level ?? 0, entry.label);
      break;
    }

    case MSG.CONN_STATUS: {
      // Baby is reporting its own connection state (e.g. 'reconnecting').
      // Update the status badge on the monitor panel so the parent can see it.
      if (!entry) break;
      const statusBadge = entry.panelEl?.querySelector('.status-badge');
      if (statusBadge) {
        statusBadge.className = 'status-badge';
        if (msg.value === 'connected')    statusBadge.classList.add('connected');
        if (msg.value === 'reconnecting') statusBadge.classList.add('reconnecting');
      }
      break;
    }

    case MSG.ID_POOL: {
      // TASK-061 — baby is sending its pre-agreed pool of backup peer IDs.
      // Persist to the device profile so the parent can use them for reconnection.
      if (entry) {
        const profile = getDeviceProfile(deviceId);
        if (profile) {
          saveDeviceProfile({ ...profile, backupPoolJson: JSON.stringify(msg.value ?? []) });
        }
      }
      break;
    }

    case MSG.FILE_ACK: {
      // Baby confirmed it received and stored the complete file (TASK-013).
      console.log('[parent] Baby acknowledged file receipt:', msg.value?.id);
      break;
    }

    case MSG.FILE_TRANSFER_FAILED: {
      // Baby reported a transfer failure (e.g. storage error, TASK-013).
      const { id, reason } = msg.value ?? {};
      console.error('[parent] Baby reported file transfer failure:', id, reason);
      if (_activeTransfer?.id === id) {
        _activeTransfer = null;
        _setTransferUiActive(false);
        _clearTransferUi();
      }
      break;
    }

    case MSG.FILE_META:
    case MSG.FILE_CHUNK:
    case MSG.FILE_COMPLETE:
    case MSG.FILE_ABORT:
      // File transfers are parent→baby only; receiving these from baby is unexpected.
      console.warn('[parent] Unexpected file transfer message received from baby:', msg.type);
      break;

    default:
      console.log('[parent] Unhandled message from', deviceId, ':', msg.type);
  }
}

// ---------------------------------------------------------------------------
// Alerts (TASK-036, TASK-027)
// ---------------------------------------------------------------------------

/** @type {Set<string>} Active alert keys (deviceId + type) */
const activeAlerts = new Set();

/**
 * Display a low-battery alert banner for a device.
 * @param {string} deviceId
 * @param {number} level
 * @param {string} label
 */
function showBatteryAlert(deviceId, level, label) {
  const key = `${deviceId}:battery`;
  if (activeAlerts.has(key)) return;
  activeAlerts.add(key);

  const banner = document.createElement('div');
  banner.className = 'alert-banner alert-banner--battery';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `
    🔋 <strong>${escapeHtml(label)}</strong>: Battery low (${level}%)
    <button class="alert-banner__dismiss" aria-label="Dismiss battery alert">✕</button>
  `;
  banner.querySelector('.alert-banner__dismiss')?.addEventListener('click', () => {
    banner.remove();
    activeAlerts.delete(key);
  });

  alertBanners?.prepend(banner);

  // Browser notification (TASK-047)
  if (lsGet(SETTING_KEYS.NOTIF_GRANTED, false) && document.visibilityState !== 'visible') {
    new Notification(`Baby Monitor — Low Battery`, {
      body: `${label}: Battery is at ${level}%.`,
      tag:  key,
    });
  }
}

// ---------------------------------------------------------------------------
// Header button event listeners
// ---------------------------------------------------------------------------

btnAddMonitor?.addEventListener('click', () => {
  if (monitors.size < MAX_MONITORS) showPairing();
});

btnSafeSleep?.addEventListener('click', () => {
  parentDashboard?.classList.add('hidden');
  safeSlotScreen?.classList.remove('hidden');
  const inner = safeSlotScreen?.querySelector('.safe-sleep-screen__inner');
  if (inner) renderSafeSleepContent(inner);
});

document.getElementById('safe-sleep-back')?.addEventListener('click', () => {
  safeSlotScreen?.classList.add('hidden');
  parentDashboard?.classList.remove('hidden');
});

btnDashboardSettings?.addEventListener('click', () => {
  parentDashboard?.classList.add('hidden');
  settingsScreen?.classList.remove('hidden');
});

document.getElementById('settings-back')?.addEventListener('click', () => {
  settingsScreen?.classList.add('hidden');
  parentDashboard?.classList.remove('hidden');
});

// Pairing method buttons
document.getElementById('method-peerjs')?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.PREFERRED_METHOD, 'peerjs');
  startPeerJsPairing();
});

document.getElementById('method-offline')?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.PREFERRED_METHOD, 'offline');
  startOfflinePairing();
});

// Empty-state start pairing button
document.getElementById('btn-start-pairing')?.addEventListener('click', () => {
  showPairing();
});

// ---------------------------------------------------------------------------
// Audio control helpers — TASK-011 hookup points for TASK-050 and TASK-056
// ---------------------------------------------------------------------------

/**
 * Set a monitor's audio gain with a smooth linear ramp.
 * Called directly by this module when volume changes; also the pattern used by
 * TASK-056 (speak-through ducking) to smoothly reduce gain while parent speaks.
 *
 * @param {string} deviceId
 * @param {number} gain       Target gain value (0 = silent, 1 = unity, >1 = amplified)
 * @param {number} [rampMs=50] Ramp duration in milliseconds
 */
function setMonitorGain(deviceId, gain, rampMs = 50) {
  const entry = monitors.get(deviceId);
  if (!entry) return;
  const ctx = entry.audioCtx;
  const targetGain = Math.max(0, gain);
  const rampEnd = ctx.currentTime + (rampMs / 1000);
  entry.gainNode.gain.cancelScheduledValues(ctx.currentTime);
  entry.gainNode.gain.setValueAtTime(entry.gainNode.gain.value, ctx.currentTime);
  entry.gainNode.gain.linearRampToValueAtTime(targetGain, rampEnd);
}

/**
 * Mute or unmute a monitor's audio output (TASK-050 hookup).
 * Muting ramps gain to 0 in 10 ms; unmuting restores `entry.desiredGain` in 100 ms.
 * `entry.desiredGain` is unaffected so the previous level is always recoverable.
 *
 * @param {string}  deviceId
 * @param {boolean} muted
 */
function setMonitorMuted(deviceId, muted) {
  const entry = monitors.get(deviceId);
  if (!entry) return;
  if (muted) {
    setMonitorGain(deviceId, 0, 10);
    entry.audioMuted = true;
  } else {
    setMonitorGain(deviceId, entry.desiredGain, 100);
    entry.audioMuted = false;
    // Sync slider if this monitor's control panel is open
    if (controlPanelDeviceId === deviceId && cpMonitorVolume) {
      cpMonitorVolume.value = String(Math.round(entry.desiredGain * 100));
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Tap-to-begin overlay (TASK-037)
// ---------------------------------------------------------------------------

// If the browser is blocked (iOS Safari), the compat modal is already visible
// and the tap overlay has been hidden — do not wire up the tap-to-begin handler.
if (_compatResult !== 'blocked') {
  tapOverlay?.addEventListener('click', () => {
    tapOverlay.classList.add('hidden');
    init().catch(err => {
      console.error('[parent] init error:', err);
    });
  }, { once: true });
}
