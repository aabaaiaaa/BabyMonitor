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
 * @property {MediaStream}   mediaStream
 * @property {HTMLElement}   panelEl
 * @property {AudioContext}  audioCtx
 * @property {GainNode}      gainNode
 * @property {AnalyserNode}  analyserNode
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
const cpTrackSelect       = document.getElementById('cp-track-select');
const cpTimerBtns         = controlPanel?.querySelectorAll('.timer-btn') ?? [];
const cpTimerCountdown    = document.getElementById('cp-timer-countdown');
const cpFlipCamera        = document.getElementById('cp-flip-camera');
const cpAudioOnly         = document.getElementById('cp-audio-only');
const cpNoiseThreshold    = document.getElementById('cp-noise-threshold');
const cpAudioFile         = document.getElementById('cp-audio-file');
const cpSendAudio         = document.getElementById('cp-send-audio');
const cpTransferProgress  = document.getElementById('cp-transfer-progress');
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

  // Set up Web Audio graph (TASK-011)
  const audioCtx   = new AudioContext();
  const gainNode   = audioCtx.createGain();
  const analyser   = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  if (conn.mediaStream) {
    const source = audioCtx.createMediaStreamSource(conn.mediaStream);
    source.connect(gainNode);
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
    gainNode,
    analyserNode:   analyser,
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

  // Stop media tracks
  entry.mediaStream?.getTracks().forEach(t => t.stop());

  // Disconnect Web Audio nodes
  try {
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

// Volume slider
cpVolume?.addEventListener('input', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_VOLUME, Number(cpVolume.value));
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

// Audio file picker
cpAudioFile?.addEventListener('change', () => {
  if (cpAudioFile.files?.length) {
    if (cpSendAudio) cpSendAudio.disabled = false;
  }
});

// Send audio (TASK-013) — full implementation in TASK-013
cpSendAudio?.addEventListener('click', async () => {
  const conn = getActiveConn();
  if (!conn?.dataChannel || !cpAudioFile?.files?.length) return;
  // Placeholder — chunked binary transfer implemented in TASK-013
  console.log('[parent] Audio file transfer not yet implemented (TASK-013)');
});

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
