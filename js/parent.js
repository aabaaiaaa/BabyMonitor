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
  getDeviceProfile, saveDeviceProfile, getDeviceProfiles, deleteDeviceProfile,
} from './storage.js';
import { renderSafeSleepContent } from './safe-sleep.js';
import {
  initPeer, destroyPeer,
  parentListenPeerJs, getPeer,
  offlineParentReceiveOffer,
  sendMessage, MSG,
  onPeerStatus, getPeerStatus, PEER_ERROR,
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
 * @property {string}          deviceId
 * @property {string}          label
 * @property {object}          conn            — normalised connection
 * @property {MediaStream|null} mediaStream
 * @property {HTMLElement}     panelEl
 * @property {AudioContext}    audioCtx
 * @property {MediaStreamAudioSourceNode|null} sourceNode — TASK-011: stored for cleanup
 * @property {GainNode}        gainNode        — TASK-011 / TASK-056 hookup: volume + smooth ramp
 * @property {AnalyserNode}    analyserNode    — TASK-024 hookup: noise visualiser
 * @property {number}          desiredGain     — TASK-011: last user-set gain (0–1); preserved across mute
 * @property {number}          noiseThreshold
 * @property {number}          motionThreshold  — TASK-026: movement detection sensitivity (0–100)
 * @property {number|null}     motionTimerId    — TASK-026: setInterval ID for motion detection loop
 * @property {ImageData|null}  motionPrevFrame  — TASK-026: previous video frame pixel data for diff
 * @property {boolean}         audioMuted
 * @property {object|null}     babyState       — TASK-025: last STATE_SNAPSHOT from baby device
 * @property {boolean}         powerSaverMode  — TASK-028: reduced analysis frequency on this monitor
 * @property {string[]|null}   backupPool      — TASK-061: backup peer ID pool received from baby
 * @property {number}          backupPoolIndex — TASK-061: last known pool index (synced via MSG.ID_POOL)
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
// Auto-reconnect state (TASK-030)
// ---------------------------------------------------------------------------

/**
 * Per-device reconnect state.
 * Key: deviceId. Value: { timerId: number|null, aborted: boolean, poolIds: string[], poolStartIndex: number }
 * @type {Map<string, { timerId: number|null, aborted: boolean, poolIds: string[], poolStartIndex: number }>}
 */
const _reconnectState = new Map();

/** Maximum number of parent-side reconnect attempts per device (TASK-030) */
const PARENT_RECONNECT_MAX_ATTEMPTS = 3;

/** Delays in ms for parent-side reconnect attempts — attempt 1, 2, 3 (TASK-030) */
const PARENT_RECONNECT_DELAYS_MS = [3000, 6000, 12000];

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
// Speak-through state (TASK-012)
// ---------------------------------------------------------------------------

/** @type {MediaStream|null} Parent microphone capture stream for speak-through. */
let _speakMicStream = null;

/** @type {RTCRtpSender|null} The RTP sender added to the peer connection for the mic track. */
let _speakMicSender = null;

/** @type {boolean} True while speak-through microphone is actively transmitting. */
let _speakActive = false;

/**
 * Device ID of the monitor whose gain was ramped down for speak-through ducking
 * (TASK-056).  Null when no ducking is active.
 * @type {string|null}
 */
let _speakDeviceId = null;

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
const cpSpeakHint         = document.querySelector('.speak-hint'); // TASK-012
const cpVolume            = document.getElementById('cp-volume');
const cpMonitorVolume     = document.getElementById('cp-monitor-volume'); // TASK-011
const cpTrackSelect       = document.getElementById('cp-track-select');
const cpTimerBtns         = controlPanel?.querySelectorAll('.timer-btn') ?? [];
const cpQualityBtns       = controlPanel?.querySelectorAll('.quality-btn') ?? [];
const cpTimerCountdown    = document.getElementById('cp-timer-countdown');
const cpTimerCustom       = document.getElementById('cp-timer-custom');       // TASK-014
const cpTimerCustomSet    = document.getElementById('cp-timer-custom-set');   // TASK-014
const cpFlipCamera        = document.getElementById('cp-flip-camera');
const cpAudioOnly         = document.getElementById('cp-audio-only');
const cpNoiseThreshold    = document.getElementById('cp-noise-threshold');
const cpMotionThreshold   = document.getElementById('cp-motion-threshold'); // TASK-026
// Snooze controls (TASK-027) — event delegation wired via cp-snooze-group / cp-snooze-all-group
const cpSnoozeGroup       = document.getElementById('cp-snooze-group');
const cpSnoozeAllGroup    = document.getElementById('cp-snooze-all-group');
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

// Battery-saving controls (TASK-028)
const cpVideoPaused       = document.getElementById('cp-video-paused');   // pause video from parent
const cpScreenDim         = document.getElementById('cp-screen-dim');     // dim baby display
const cpPowerSaver        = document.getElementById('cp-power-saver');    // reduced analysis on parent

// Device rename controls (TASK-023)
const cpRenameBtn         = document.getElementById('cp-rename-btn');
const cpRenameForm        = document.getElementById('cp-rename-form');
const cpRenameInput       = document.getElementById('cp-rename-input');
const cpRenameCancel      = document.getElementById('cp-rename-cancel');

// Background persistence banner (TASK-029)
const bgBanner            = document.getElementById('bg-banner');
const bgBannerPwa         = document.getElementById('bg-banner-pwa');
const bgBannerInstall     = document.getElementById('bg-banner-install');
const bgBannerDismiss     = document.getElementById('bg-banner-dismiss');

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

// ---------------------------------------------------------------------------
// Page Visibility API — background tab persistence (TASK-029)
// ---------------------------------------------------------------------------
//
// When the parent monitor tab is hidden (user switches app, phone locks, etc.):
//   • The Wake Lock is released by the OS — this is expected and unavoidable.
//   • All WebRTC connections (monitors Map) and AudioContext graphs MUST stay
//     alive. We deliberately do NOT close connections when the tab is hidden;
//     doing so would drop the live video/audio stream and require re-pairing.
//   • Browser notifications are used to deliver movement and battery alerts
//     while the tab is in the background (see showBatteryAlert, etc.).
//
// When the tab becomes visible again:
//   • Re-acquire the Wake Lock so the screen stays on during monitoring.
//   • AudioContexts may have been suspended; they will be resumed automatically
//     when the user interacts with the page (e.g. opens a control panel).

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    // Tab went to background — all connections are intentionally kept alive.
    // The Wake Lock is released automatically by the browser; we will
    // re-request it when the tab becomes visible again.
    console.log('[parent] Tab hidden — all WebRTC connections kept alive (TASK-029)');
  } else if (document.visibilityState === 'visible') {
    // Tab came back to foreground — re-acquire the Wake Lock (TASK-003).
    if (!wakeLock) {
      await requestWakeLock();
    }
    console.log('[parent] Tab visible — Wake Lock re-acquired if possible (TASK-029)');
  }
});

// ---------------------------------------------------------------------------
// Notification permission (TASK-047)
// Handled by showNotificationPermissionScreen() in js/notifications.js,
// called from init() above. The notification state is persisted to localStorage
// via SETTING_KEYS.NOTIF_PROMPTED and SETTING_KEYS.NOTIF_GRANTED.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Background persistence banner (TASK-029)
// ---------------------------------------------------------------------------

/**
 * Deferred PWA install prompt captured from the `beforeinstallprompt` event.
 * @type {Event|null}
 */
let _deferredInstallPrompt = null;

// Capture the install prompt before the browser shows its own mini-infobar.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  bgBannerPwa?.classList.remove('hidden');
});

// If the user installs the PWA, clear the deferred prompt and hide the button.
window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  bgBannerPwa?.classList.add('hidden');
  console.log('[parent] PWA installed (TASK-029)');
});

/**
 * True once the user has tapped ✕ on the banner during this session.
 * Prevents re-showing the banner every time showDashboard() is called.
 * @type {boolean}
 */
let _bgBannerDismissed = false;

/**
 * Show the "keep this tab open" / install-as-app banner (TASK-029).
 * Called when the parent dashboard first becomes active.
 * The banner is persistent but dismissible for the session.
 */
function showBgBanner() {
  if (!bgBanner || _bgBannerDismissed) return;
  bgBanner.classList.remove('hidden');

  if (_deferredInstallPrompt) {
    bgBannerPwa?.classList.remove('hidden');
  }
}

// Dismiss button — hides for this session (not persisted across reloads).
bgBannerDismiss?.addEventListener('click', () => {
  bgBanner?.classList.add('hidden');
  _bgBannerDismissed = true;
});

// "Install as app" button — trigger the deferred install prompt.
bgBannerInstall?.addEventListener('click', async () => {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  console.log('[parent] PWA install prompt outcome:', outcome, '(TASK-029)');
  _deferredInstallPrompt = null;
  bgBannerPwa?.classList.add('hidden');
});

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
  // Show background persistence banner once the dashboard is active (TASK-029).
  showBgBanner();
}

function showPairing() {
  parentDashboard?.classList.add('hidden');
  pairingSection?.classList.remove('hidden');
  addParentSection?.classList.add('hidden');
  controlPanel?.classList.add('hidden');
  showPairingMethodStep();

  // TASK-022: show the "Back to Dashboard" cancel button only when there are
  // already connected monitors — the user may want to cancel adding a new one.
  // When there are no monitors yet (first pairing) there is nowhere to go back.
  const pairingCancelBtn = document.getElementById('pairing-cancel-btn');
  if (pairingCancelBtn) {
    pairingCancelBtn.classList.toggle('hidden', monitors.size === 0);
  }
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

    // TASK-022: Preserve existing monitor connections by reusing the active peer
    // when one is already registered with the signalling server.  Calling
    // initPeer() calls destroyPeerManager() internally, which would close the
    // existing PeerJS Peer and disconnect every currently-connected baby monitor.
    // Only initialise (and therefore destroy) the peer when there is no active
    // peer yet (first pairing, or after an unexpected disconnection).
    if (getPeerStatus() === 'ready') {
      // Already registered — go straight to scanning; no server round-trip needed.
      if (peerjsScanStatus) peerjsScanStatus.textContent = 'Scan the QR code on the baby device.';
    } else {
      await initPeer(peerjsServerConfig);
      if (peerjsScanStatus) peerjsScanStatus.textContent = 'Scan the QR code on the baby device.';
    }

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
    //    TASK-022: pass babyPeerId so the listener only processes events from this
    //    specific baby, preventing handlers from earlier pairing sessions interfering.
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
          // TASK-030: attempt auto-reconnect via backup ID pool before removing monitor
          if (monitors.has(babyPeerId)) {
            _startParentReconnect(babyPeerId, babyPeerId);
          } else {
            removeMonitor(babyPeerId);
          }
        }
      },
      onMessage(msg) {
        // Route the message to the correct monitor using the baby's peer ID.
        // After addMonitor() the entry is keyed by conn.deviceId which equals babyPeerId.
        handleDataMessage(babyPeerId, msg);
      },
    }, babyPeerId); // TASK-022: filter events to this baby only

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
        // TASK-030: offline path — show reconnecting state; baby handles ICE restart
        if (s === 'reconnecting') {
          _updateMonitorConnStatus(tempDeviceId, 'reconnecting');
        } else if (s === 'connected') {
          _updateMonitorConnStatus(tempDeviceId, 'connected');
        } else if (s === 'disconnected' || s === 'failed') {
          _updateMonitorConnStatus(tempDeviceId, 'disconnected');
          // No backup pool for offline connections — show re-pair prompt directly
          _showReconnectFailedBanner(tempDeviceId);
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
  // Set up Web Audio graph (TASK-011 / TASK-056)
  // Architecture:  MediaStreamSourceNode (audio track only)
  //                   → GainNode    (TASK-011 volume / TASK-056 smooth-ramp hookup)
  //                   → AudioContext.destination
  //                   → AnalyserNode (TASK-024 noise-visualiser hookup — reads
  //                                   PRE-GAIN signal so visualiser stays active
  //                                   during speak-through ducking; no destination)
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

  // AnalyserNode — TASK-024 / TASK-056 hookup point.
  // Connected directly to the source (pre-gain) so that noise visualiser data
  // remains available even when gain is ramped to 0 during speak-through
  // ducking.  The analyser is NOT connected to the destination — it is a
  // branch used only for analysis.
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;

  // Wire playback path: gain → speakers
  gainNode.connect(audioCtx.destination);

  // Create the MediaStreamSourceNode from the audio track(s) only.
  // The full stream (including video) is attached to the <video> element
  // separately; here we only want audio in the Web Audio graph.
  let sourceNode = null;
  if (conn.mediaStream) {
    const audioTracks = conn.mediaStream.getAudioTracks();
    if (audioTracks.length > 0) {
      const audioOnlyStream = new MediaStream(audioTracks);
      sourceNode = audioCtx.createMediaStreamSource(audioOnlyStream);
      // Playback branch: source → gain → destination
      sourceNode.connect(gainNode);
      // Analysis branch (TASK-056): source → analyser (pre-gain, always active)
      sourceNode.connect(analyser);
    }
  }

  // Create the panel DOM element
  const panelEl = createMonitorPanel(deviceId, profile.label, conn);
  monitorGrid?.insertBefore(panelEl, monitorGridEmpty ?? null);

  // TASK-061: Restore backup pool from device profile if present.
  // The pool is stored as JSON { pool: string[], index: number } in backupPoolJson.
  let _restoredPool  = null;
  let _restoredIndex = 0;
  if (profile.backupPoolJson) {
    try {
      const poolData = JSON.parse(profile.backupPoolJson);
      if (Array.isArray(poolData.pool)) {
        _restoredPool  = poolData.pool;
        _restoredIndex = typeof poolData.index === 'number' ? poolData.index : 0;
      }
    } catch {
      // Corrupt stored value — starts fresh; pool will be re-sent by baby on connect
    }
  }

  /** @type {MonitorEntry} */
  const entry = {
    deviceId,
    label:            profile.label,
    conn,
    mediaStream:      conn.mediaStream,
    panelEl,
    audioCtx,
    sourceNode,             // stored for disconnection on cleanup (TASK-011)
    gainNode,
    analyserNode:     analyser,
    desiredGain:      initialGain, // preserved across mute/unmute (TASK-050)
    noiseThreshold:   profile.noiseThreshold,
    motionThreshold:  profile.motionThreshold ?? 50, // TASK-026: motion sensitivity
    motionTimerId:    null,  // TASK-026: setInterval ID; cleared on disconnect
    motionPrevFrame:  null,  // TASK-026: previous frame ImageData for differencing
    audioMuted:       false,
    babyState:        null, // TASK-025: last known baby state (updated by STATE_SNAPSHOT)
    powerSaverMode:   false, // TASK-028: reduced analysis frequency
    backupPool:       _restoredPool,  // TASK-061: backup peer ID pool
    backupPoolIndex:  _restoredIndex, // TASK-061: last known pool index
  };

  monitors.set(deviceId, entry);
  monitorGrid?.setAttribute('data-count', String(monitors.size));
  refreshGridEmpty();

  // Start noise visualiser (TASK-024)
  startNoiseVisualiser(entry);

  // Start motion detection (TASK-026)
  startMotionDetection(entry);

  // E2E test hooks (TASK-063): expose connection state and last connection for assertions.
  window.__peerState = 'connected';
  window.__testMonitorConn = conn;
  // E2E test hook (TASK-064): expose the full monitor entry so tests can inspect
  // the gainNode value (e.g. during speak-through ducking) and the analyserNode.
  window.__testMonitorEntry = entry;
}

/**
 * Remove a monitor and clean up its resources.
 * @param {string} deviceId
 */
function removeMonitor(deviceId) {
  const entry = monitors.get(deviceId);
  if (!entry) return;

  // Cancel any pending auto-reconnect for this device (TASK-030)
  _cancelParentReconnect(deviceId);

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

  // Stop motion detection (TASK-026): clear interval and reset state.
  stopMotionDetection(entry);

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

/**
 * Return the unused backup peer IDs for a baby device, starting from the
 * last known pool index.
 *
 * Used by TASK-030's auto-reconnect logic when the primary peer ID is no
 * longer reachable.  The parent should try each returned ID in order until
 * one successfully connects; after a successful reconnect it should call
 * updateBackupPoolIndex() to record the new index.
 *
 * Falls back to the persisted device profile if the in-memory entry has no
 * pool (e.g. after a page reload, before the baby sends a fresh MSG.ID_POOL).
 *
 * @param {string} deviceId
 * @returns {{ ids: string[], startIndex: number }|null} null if no pool is stored
 */
function getBackupPoolForReconnect(deviceId) {
  const entry = monitors.get(deviceId);

  // Use in-memory entry first (most up-to-date after replenishment broadcasts).
  if (entry?.backupPool?.length) {
    const startIndex = entry.backupPoolIndex;
    const ids = entry.backupPool.slice(startIndex);
    return ids.length > 0 ? { ids, startIndex } : null;
  }

  // Fall back to persisted profile (available even after a full app restart).
  try {
    const profile = getDeviceProfile(deviceId);
    if (!profile?.backupPoolJson) return null;
    const poolData = JSON.parse(profile.backupPoolJson);
    if (!Array.isArray(poolData.pool)) return null;
    const startIndex = typeof poolData.index === 'number' ? poolData.index : 0;
    const ids = poolData.pool.slice(startIndex);
    return ids.length > 0 ? { ids, startIndex } : null;
  } catch {
    return null;
  }
}

/**
 * Update the in-memory pool index for a device after a successful reconnect
 * using a backup pool ID.
 *
 * Called by TASK-030 once a backup pool ID has been verified as working.
 * Also persists the new index to the device profile so subsequent restarts
 * start from the correct position.
 *
 * @param {string} deviceId
 * @param {number} newIndex — the pool index of the ID that successfully connected
 */
function updateBackupPoolIndex(deviceId, newIndex) {
  const entry = monitors.get(deviceId);
  if (entry) {
    entry.backupPoolIndex = newIndex;
  }
  // Persist so the index is correct after a page reload.
  try {
    const profile = getDeviceProfile(deviceId);
    if (profile?.backupPoolJson) {
      const poolData = JSON.parse(profile.backupPoolJson);
      poolData.index = newIndex;
      saveDeviceProfile({ ...profile, backupPoolJson: JSON.stringify(poolData) });
    }
  } catch {
    // Non-fatal — the baby will re-send the pool (with updated index) on reconnect.
  }
  console.log('[parent] Updated backup pool index for', deviceId, 'to', newIndex, '(TASK-061)');
}

// ---------------------------------------------------------------------------
// Connection health monitoring and auto-reconnect (TASK-030)
// ---------------------------------------------------------------------------

/**
 * Update the connection status badge and overlay on a monitor panel (TASK-030).
 *
 * @param {string} deviceId
 * @param {'connected'|'reconnecting'|'disconnected'} state
 */
function _updateMonitorConnStatus(deviceId, state) {
  const entry = monitors.get(deviceId);
  if (!entry) return;

  const statusBadge = entry.panelEl?.querySelector('.status-badge');
  const connOverlay = entry.panelEl?.querySelector('.monitor-panel__conn-overlay');
  const overlaySpan = connOverlay?.querySelector('span');

  if (statusBadge) {
    statusBadge.className = 'status-badge';
    if (state === 'connected')    statusBadge.classList.add('connected');
    if (state === 'reconnecting') statusBadge.classList.add('reconnecting');
    statusBadge.setAttribute('aria-label', `Status: ${state}`);
  }

  if (connOverlay) {
    if (state === 'connected') {
      connOverlay.classList.add('hidden');
    } else if (state === 'reconnecting') {
      if (overlaySpan) overlaySpan.textContent = 'Reconnecting…';
      connOverlay.classList.remove('hidden');
    } else if (state === 'disconnected') {
      if (overlaySpan) overlaySpan.textContent = 'Disconnected';
      connOverlay.classList.remove('hidden');
    }
  }
}

/**
 * Start the parent-side PeerJS auto-reconnect flow for a disconnected baby (TASK-030).
 *
 * Retrieves the backup ID pool for the device and cycles through IDs in order,
 * listening for the baby to re-register under each one.  On success the monitor
 * entry is updated in-place.  On failure a re-pair banner is shown.
 *
 * @param {string} deviceId   — monitor entry key
 * @param {string} originalId — the baby's original primary peer ID
 */
function _startParentReconnect(deviceId, originalId) {
  // Cancel any existing reconnect for this device
  _cancelParentReconnect(deviceId);

  const poolData = getBackupPoolForReconnect(deviceId);
  if (!poolData?.ids.length) {
    console.log('[parent] No backup pool for', deviceId, '— cannot auto-reconnect (TASK-030)');
    _onParentReconnectFailed(deviceId);
    return;
  }

  console.log('[parent] Starting auto-reconnect for', deviceId,
              '— pool has', poolData.ids.length, 'backup IDs (TASK-030)');

  _updateMonitorConnStatus(deviceId, 'reconnecting');

  _reconnectState.set(deviceId, {
    timerId:        null,
    aborted:        false,
    poolIds:        poolData.ids,
    poolStartIndex: poolData.startIndex,
  });

  _scheduleParentReconnect(deviceId, originalId, 1);
}

/**
 * Schedule the next parent-side reconnect attempt with a delay (TASK-030).
 * @param {string} deviceId
 * @param {string} originalId
 * @param {number} attempt — 1-based
 */
function _scheduleParentReconnect(deviceId, originalId, attempt) {
  const state = _reconnectState.get(deviceId);
  if (!state || state.aborted) return;

  const delay = PARENT_RECONNECT_DELAYS_MS[attempt - 1] ?? PARENT_RECONNECT_DELAYS_MS.at(-1);
  state.timerId = setTimeout(() => {
    state.timerId = null;
    _attemptParentReconnect(deviceId, originalId, attempt);
  }, delay);
}

/**
 * Attempt to reconnect to a baby device from the parent side (TASK-030).
 *
 * Listens for the baby to register under the backup ID at poolIds[attempt-1]
 * and also sends a trigger data connection to prompt it to call back.
 *
 * @param {string} deviceId
 * @param {string} originalId
 * @param {number} attempt — 1-based
 */
async function _attemptParentReconnect(deviceId, originalId, attempt) {
  const reconnect = _reconnectState.get(deviceId);
  if (!reconnect || reconnect.aborted) return;

  const entry = monitors.get(deviceId);
  if (!entry) return;

  // Get the target backup ID for this attempt
  const idIndex  = attempt - 1;
  if (idIndex >= reconnect.poolIds.length) {
    console.warn('[parent] Backup pool exhausted for', deviceId, '(TASK-030)');
    _onParentReconnectFailed(deviceId);
    return;
  }

  const targetId = reconnect.poolIds[idIndex];
  console.log(`[parent] Reconnect attempt ${attempt}/${PARENT_RECONNECT_MAX_ATTEMPTS}`
              + ` to ${targetId} (TASK-030)`);

  // Update overlay text to show progress
  const connOverlay = entry.panelEl?.querySelector('.monitor-panel__conn-overlay');
  const overlaySpan = connOverlay?.querySelector('span');
  if (overlaySpan) {
    overlaySpan.textContent = `Reconnecting… (${attempt}/${PARENT_RECONNECT_MAX_ATTEMPTS})`;
  }

  const peer = getPeer();
  if (!peer) {
    _onParentReconnectFailed(deviceId);
    return;
  }

  // Per-attempt timeout: if neither onReady nor a failure fires within this window,
  // advance to the next attempt automatically.
  const ATTEMPT_TIMEOUT_MS = 12_000;
  let attemptDone = false;

  const attemptTimer = setTimeout(() => {
    if (attemptDone) return;
    attemptDone = true;
    console.log(`[parent] Reconnect attempt ${attempt} to ${targetId} timed out (TASK-030)`);
    if (attempt < PARENT_RECONNECT_MAX_ATTEMPTS) {
      _scheduleParentReconnect(deviceId, originalId, attempt + 1);
    } else {
      _onParentReconnectFailed(deviceId);
    }
  }, ATTEMPT_TIMEOUT_MS);

  const advanceOrFail = () => {
    if (attemptDone) return;
    attemptDone = true;
    clearTimeout(attemptTimer);
    if (attempt < PARENT_RECONNECT_MAX_ATTEMPTS) {
      _scheduleParentReconnect(deviceId, originalId, attempt + 1);
    } else {
      _onParentReconnectFailed(deviceId);
    }
  };

  try {
    // Listen for the baby calling back under the backup ID
    parentListenPeerJs({
      onReady(conn) {
        if (attemptDone || reconnect.aborted) {
          conn.close?.();
          return;
        }
        attemptDone = true;
        clearTimeout(attemptTimer);

        // Record the pool index that succeeded
        const succeededIndex = reconnect.poolStartIndex + idIndex + 1;
        updateBackupPoolIndex(deviceId, succeededIndex);
        _reconnectState.delete(deviceId);

        // Update the entry with the new connection
        entry.conn = conn;
        entry.mediaStream = conn.mediaStream;

        // Reconnect the Web Audio source to the new media stream
        if (conn.mediaStream && entry.audioCtx) {
          const audioTracks = conn.mediaStream.getAudioTracks();
          if (audioTracks.length > 0) {
            try {
              entry.sourceNode?.disconnect();
              const audioOnlyStream = new MediaStream(audioTracks);
              entry.sourceNode = entry.audioCtx.createMediaStreamSource(audioOnlyStream);
              entry.sourceNode.connect(entry.gainNode);
              entry.sourceNode.connect(entry.analyserNode);
            } catch (e) {
              console.warn('[parent] Failed to reconnect audio source:', e);
            }
          }
        }

        // Update the video element with the new stream
        const videoEl = entry.panelEl?.querySelector('.monitor-panel__video');
        if (videoEl && conn.mediaStream) {
          videoEl.srcObject = conn.mediaStream;
        }

        _updateMonitorConnStatus(deviceId, 'connected');
        console.log('[parent] Reconnect to', deviceId, 'succeeded via', targetId, '(TASK-030)');
      },
      onState(s) {
        if (attemptDone || reconnect.aborted) return;
        if (s === 'disconnected' || s === 'failed') {
          advanceOrFail();
        }
      },
      onMessage(msg) {
        handleDataMessage(deviceId, msg);
      },
    }, targetId); // Only accept the specific backup ID (TASK-022 pattern)

    // Send a trigger data connection to the baby's new peer ID to prompt it to call back
    const triggerConn = peer.connect(targetId, { reliable: true });
    triggerConn.on('error', (err) => {
      // Non-fatal: the timeout will handle this case
      console.log(`[parent] Trigger to ${targetId} failed: ${err.message} (waiting for timeout)`);
    });

  } catch (err) {
    console.warn('[parent] Error setting up reconnect listener for', targetId, err);
    advanceOrFail();
  }
}

/**
 * Cancel a pending parent-side reconnect for a device (TASK-030).
 * Safe to call when no reconnect is in progress.
 * @param {string} deviceId
 */
function _cancelParentReconnect(deviceId) {
  const state = _reconnectState.get(deviceId);
  if (!state) return;
  state.aborted = true;
  if (state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  _reconnectState.delete(deviceId);
}

/**
 * Called when all parent-side reconnect attempts have failed (TASK-030).
 * Shows a re-pair banner and leaves the monitor panel in a disconnected state.
 * @param {string} deviceId
 */
function _onParentReconnectFailed(deviceId) {
  console.log('[parent] All reconnect attempts failed for', deviceId, '(TASK-030)');
  _cancelParentReconnect(deviceId);
  _updateMonitorConnStatus(deviceId, 'disconnected');
  _showReconnectFailedBanner(deviceId);
}

/**
 * Show an alert banner prompting the user to re-pair a disconnected device (TASK-030).
 * @param {string} deviceId
 */
function _showReconnectFailedBanner(deviceId) {
  const entry = monitors.get(deviceId);
  if (!entry) return;

  const bannerKey = `${deviceId}:reconnect-failed`;
  if (alertBanners?.querySelector(`[data-alert-key="${escapeHtml(bannerKey)}"]`)) return;

  const banner = document.createElement('div');
  banner.className = 'alert-banner alert-banner--warning';
  banner.setAttribute('role', 'alert');
  banner.dataset.alertKey = bannerKey;
  banner.innerHTML = `
    📡 <strong>${escapeHtml(entry.label)}</strong> disconnected — could not reconnect automatically.
    <button class="alert-banner__repair-btn action-btn action-btn--small">Re-pair</button>
    <button class="alert-banner__dismiss" aria-label="Dismiss">✕</button>
  `;

  banner.querySelector('.alert-banner__repair-btn')?.addEventListener('click', () => {
    banner.remove();
    removeMonitor(deviceId);
    showPairing();
  });

  banner.querySelector('.alert-banner__dismiss')?.addEventListener('click', () => {
    banner.remove();
    removeMonitor(deviceId);
  });

  alertBanners?.prepend(banner);
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
      <span class="motion-indicator" title="Movement detected" aria-label="Movement detected" aria-hidden="true"
            data-level="0">🚶</span>
      <button class="monitor-panel__controls-btn" aria-label="Open controls for ${escapeHtml(label)}"
              title="Controls">⚙️</button>
    </div>
  `;

  // Attach media stream to video element
  const videoEl = panel.querySelector('.monitor-panel__video');
  if (videoEl && conn.mediaStream) {
    videoEl.srcObject = conn.mediaStream;
  }

  // Set initial connection status (TASK-021):
  // Show the "Connecting…" overlay if no stream is available yet; once a stream is
  // present the badge is considered connected and the overlay stays hidden.
  const initBadge   = panel.querySelector('.status-badge');
  const initOverlay = panel.querySelector('.monitor-panel__conn-overlay');
  if (conn.mediaStream) {
    if (initBadge)   initBadge.classList.add('connected');
    initBadge?.setAttribute('aria-label', 'Status: connected');
  } else {
    // No stream yet — display the overlay so the user sees a connecting state
    if (initOverlay) initOverlay.classList.remove('hidden');
    initBadge?.setAttribute('aria-label', 'Status: connecting');
  }

  // Open control panel by tapping/clicking anywhere on the panel (TASK-025).
  // The controls button (⚙️) calls stopPropagation to prevent double-firing.
  panel.addEventListener('click', () => {
    openControlPanel(deviceId);
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

    // TASK-028: in power-saver mode analyse at ~2 fps (every 30th frame at 60fps)
    // instead of the normal ~10 fps (every 6th frame).  This reduces CPU usage
    // and indirectly reduces battery consumption on the parent device.
    const sampleInterval = entry.powerSaverMode ? 30 : 6;

    if (frameCount % sampleInterval === 0) {
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
// Motion detection (TASK-026)
// ---------------------------------------------------------------------------

/**
 * Start frame-differencing motion detection for a monitor entry.
 *
 * Architecture:
 *  - An offscreen <canvas> (160×120) is used to draw downscaled video frames.
 *  - Every MOTION_INTERVAL ms the current frame is captured via drawImage(),
 *    its greyscale pixel data compared to the previous frame, and a motion
 *    score (0–100) computed from the mean absolute per-pixel difference.
 *  - The score drives a visual indicator badge on the panel and triggers
 *    showMovementAlert() when the score exceeds entry.motionThreshold.
 *  - In power-saver mode the interval is tripled to reduce CPU load.
 *
 * @param {MonitorEntry} entry
 */
function startMotionDetection(entry) {
  const panel = entry.panelEl;
  if (!panel) return;

  const videoEl = panel.querySelector('.monitor-panel__video');
  const motionIndicator = panel.querySelector('.motion-indicator');
  if (!videoEl || !motionIndicator) return;

  // Offscreen canvas at a low resolution — enough for frame differencing but
  // cheap to compute.  160×120 gives 19,200 pixels per frame.
  const CANVAS_W = 160;
  const CANVAS_H = 120;
  const MOTION_INTERVAL_NORMAL = 2500; // ms between samples
  const MOTION_INTERVAL_SAVER  = 6000; // ms in power-saver mode

  const canvas = document.createElement('canvas');
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  // Cooldown: prevent the same device from spamming repeated alerts within a
  // short window.  Reset after ALERT_COOLDOWN_MS.
  const ALERT_COOLDOWN_MS = 10_000;
  let lastAlertTime = 0;

  function sample() {
    if (!monitors.has(entry.deviceId)) return; // monitor removed — loop already stopped

    // Skip analysis if the video has no real data yet.
    if (videoEl.readyState < 2 || videoEl.videoWidth === 0) return;

    try {
      ctx.drawImage(videoEl, 0, 0, CANVAS_W, CANVAS_H);
    } catch {
      // drawImage can throw if the video element is in an invalid state.
      return;
    }

    const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
    const pixels    = imageData.data; // Uint8ClampedArray: [R,G,B,A, R,G,B,A, …]
    const numPixels = CANVAS_W * CANVAS_H;

    if (entry.motionPrevFrame) {
      const prev = entry.motionPrevFrame.data;
      let totalDiff = 0;

      // Compute mean absolute grey-level difference across all pixels.
      // Using (R+G+B)/3 as a cheap greyscale approximation.
      for (let i = 0; i < pixels.length; i += 4) {
        const currGrey = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        const prevGrey = (prev[i]   + prev[i + 1]   + prev[i + 2])   / 3;
        totalDiff += Math.abs(currGrey - prevGrey);
      }

      const avgDiff    = totalDiff / numPixels; // 0–255
      // Map to 0–100 scale; a mean difference of ~25/255 scores 100.
      const motionScore = Math.min(100, Math.round((avgDiff / 25) * 100));

      // Update the motion indicator badge visibility and level attribute.
      motionIndicator.setAttribute('data-level', String(motionScore));
      const aboveThreshold = motionScore > entry.motionThreshold;
      motionIndicator.classList.toggle('motion-indicator--active', aboveThreshold);
      panel.classList.toggle('monitor-panel--motion-alert', aboveThreshold);

      // Trigger alert (with cooldown to avoid repeated banners).
      if (aboveThreshold) {
        const now = Date.now();
        if (now - lastAlertTime > ALERT_COOLDOWN_MS) {
          lastAlertTime = now;
          showMovementAlert(entry.deviceId, entry.label);
        }
      }
    }

    // Store current frame for the next comparison.
    entry.motionPrevFrame = imageData;
  }

  // Schedule the recurring sample.  Store the ID so removeMonitor() can stop it.
  const interval = entry.powerSaverMode ? MOTION_INTERVAL_SAVER : MOTION_INTERVAL_NORMAL;
  entry.motionTimerId = setInterval(sample, interval);

  // When power-saver mode changes the interval must be recreated; that happens
  // in the cpPowerSaver change listener which calls restartMotionDetection().
}

/**
 * Stop the motion detection loop for an entry and clear its state.
 * @param {MonitorEntry} entry
 */
function stopMotionDetection(entry) {
  if (entry.motionTimerId !== null) {
    clearInterval(entry.motionTimerId);
    entry.motionTimerId   = null;
    entry.motionPrevFrame = null;
  }
  // Clear the visual indicator
  const motionIndicator = entry.panelEl?.querySelector('.motion-indicator');
  motionIndicator?.classList.remove('motion-indicator--active');
  entry.panelEl?.classList.remove('monitor-panel--motion-alert');
}

/**
 * Restart motion detection with the current interval setting (e.g. after
 * toggling power-saver mode).
 * @param {MonitorEntry} entry
 */
function restartMotionDetection(entry) {
  stopMotionDetection(entry);
  startMotionDetection(entry);
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

  // Populate motion threshold from profile (TASK-026)
  if (cpMotionThreshold) cpMotionThreshold.value = String(entry.motionThreshold);

  // Sync snooze button state for this device (TASK-027)
  _syncSnoozeUI(deviceId);

  // Sync monitor volume slider to this entry's current desired gain (TASK-011).
  // Opening the control panel is always in response to a user gesture, so
  // this is also the right place to resume a suspended AudioContext.
  if (cpMonitorVolume) {
    cpMonitorVolume.value = String(Math.round(entry.desiredGain * 100));
  }
  entry.audioCtx?.resume().catch(() => {});

  // Sync all TASK-025 controls to the baby's last known state (TASK-025).
  // If no snapshot has arrived yet the panel still shows sensible defaults.
  _syncControlPanelState(entry.babyState);

  // Sync TASK-028 parent-side power-saver toggle from entry state
  if (cpPowerSaver) cpPowerSaver.checked = entry.powerSaverMode;

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

  // Reset the rename form so it is hidden when the panel opens (TASK-023).
  cpRenameForm?.classList.add('hidden');

  controlPanel?.classList.remove('hidden');
}

function closeControlPanel() {
  // Stop speak-through if it is active when the panel is closed (TASK-012).
  if (_speakActive) stopSpeakThrough();
  controlPanel?.classList.add('hidden');
  controlPanelDeviceId = null;
  stopScanner();
}

// ---------------------------------------------------------------------------
// Device labelling (TASK-023)
// ---------------------------------------------------------------------------

/**
 * Rename a baby monitor — updates in-memory entry, persisted device profile,
 * monitor panel label, and control panel title.
 *
 * @param {string} deviceId — the device to rename
 * @param {string} newLabel — the new user-assigned label (trimmed before use)
 */
function _renameMonitor(deviceId, newLabel) {
  const label = newLabel.trim();
  if (!label) return;

  // Update in-memory entry
  const entry = monitors.get(deviceId);
  if (entry) {
    entry.label = label;
    // Update panel label in the DOM
    const labelEl = entry.panelEl?.querySelector('.monitor-panel__label');
    if (labelEl) labelEl.textContent = label;
    // Update accessibility attribute
    entry.panelEl?.setAttribute('aria-label', `Baby monitor: ${label}`);
    const videoEl = entry.panelEl?.querySelector('.monitor-panel__video');
    if (videoEl) videoEl.setAttribute('aria-label', `Video from ${label}`);
    const controlsBtn = entry.panelEl?.querySelector('.monitor-panel__controls-btn');
    if (controlsBtn) controlsBtn.setAttribute('aria-label', `Open controls for ${label}`);
  }

  // Update control panel title if currently open for this device
  if (controlPanelDeviceId === deviceId && controlPanelTitle) {
    controlPanelTitle.textContent = `Controls — ${label}`;
  }

  // Persist to device profile
  const profile = getDeviceProfile(deviceId);
  if (profile) {
    saveDeviceProfile({ ...profile, label });
  } else {
    saveDeviceProfile({ id: deviceId, label, noiseThreshold: 60, motionThreshold: 50, batteryThreshold: 15, backupPoolJson: null });
  }
}

/**
 * Render the list of saved device profiles into the settings screen.
 * Called each time the settings screen is opened.
 */
function _renderSavedDevices() {
  const listEl = document.getElementById('saved-devices-list');
  const statusEl = document.getElementById('saved-devices-status');
  if (!listEl) return;

  const profiles = getDeviceProfiles();
  listEl.innerHTML = '';

  if (profiles.length === 0) {
    listEl.innerHTML = '<p class="saved-devices-empty">No saved devices. Pair a baby monitor to save it.</p>';
    return;
  }

  for (const profile of profiles) {
    const isConnected = monitors.has(profile.id);
    const row = document.createElement('div');
    row.className = 'saved-device-row';
    row.dataset.deviceId = profile.id;

    row.innerHTML = `
      <div class="saved-device-row__info">
        <span class="saved-device-row__label">${escapeHtml(profile.label)}</span>
        ${isConnected ? '<span class="saved-device-row__status">Connected</span>' : ''}
      </div>
      <div class="saved-device-row__display">
        <button class="action-btn action-btn--small saved-device-row__rename-btn"
                aria-label="Rename ${escapeHtml(profile.label)}">Rename</button>
        <button class="action-btn action-btn--small action-btn--danger saved-device-row__delete-btn"
                aria-label="Delete saved device ${escapeHtml(profile.label)}">Delete</button>
      </div>
      <form class="saved-device-row__rename-form hidden" aria-label="Rename device">
        <input type="text" class="saved-device-row__rename-input cp-rename-input"
               value="${escapeHtml(profile.label)}" maxlength="40"
               aria-label="New name for ${escapeHtml(profile.label)}"
               autocomplete="off" />
        <button type="submit" class="action-btn action-btn--small">Save</button>
        <button type="button" class="action-btn action-btn--small action-btn--secondary saved-device-row__rename-cancel">Cancel</button>
      </form>
    `;

    // Rename button — show inline form
    row.querySelector('.saved-device-row__rename-btn')?.addEventListener('click', () => {
      const form = row.querySelector('.saved-device-row__rename-form');
      const display = row.querySelector('.saved-device-row__display');
      form?.classList.remove('hidden');
      display?.classList.add('hidden');
      form?.querySelector('input')?.focus();
    });

    // Cancel button inside inline form
    row.querySelector('.saved-device-row__rename-cancel')?.addEventListener('click', () => {
      const form = row.querySelector('.saved-device-row__rename-form');
      const display = row.querySelector('.saved-device-row__display');
      form?.classList.add('hidden');
      display?.classList.remove('hidden');
    });

    // Submit rename form
    row.querySelector('.saved-device-row__rename-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = row.querySelector('.saved-device-row__rename-input');
      const newLabel = input?.value.trim() ?? '';
      if (!newLabel) return;
      _renameMonitor(profile.id, newLabel);
      // Update the displayed label in this row and close the form
      const labelEl = row.querySelector('.saved-device-row__label');
      if (labelEl) labelEl.textContent = newLabel;
      const form = row.querySelector('.saved-device-row__rename-form');
      const display = row.querySelector('.saved-device-row__display');
      form?.classList.add('hidden');
      display?.classList.remove('hidden');
      if (statusEl) {
        statusEl.textContent = `Renamed to "${newLabel}".`;
        statusEl.className = 'settings-status settings-status--success';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
    });

    // Delete button — remove from storage (does not disconnect an active session)
    row.querySelector('.saved-device-row__delete-btn')?.addEventListener('click', () => {
      deleteDeviceProfile(profile.id);
      row.remove();
      // If now empty, show the empty-state message
      if (listEl.querySelectorAll('.saved-device-row').length === 0) {
        listEl.innerHTML = '<p class="saved-devices-empty">No saved devices. Pair a baby monitor to save it.</p>';
      }
      if (statusEl) {
        statusEl.textContent = `Removed "${profile.label}".`;
        statusEl.className = 'settings-status';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
    });

    listEl.appendChild(row);
  }
}

// Wire up the control-panel rename button (TASK-023)
cpRenameBtn?.addEventListener('click', () => {
  if (!controlPanelDeviceId) return;
  const entry = monitors.get(controlPanelDeviceId);
  if (!entry) return;
  if (cpRenameInput) cpRenameInput.value = entry.label;
  cpRenameForm?.classList.remove('hidden');
  cpRenameInput?.focus();
});

cpRenameCancel?.addEventListener('click', () => {
  cpRenameForm?.classList.add('hidden');
});

cpRenameForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!controlPanelDeviceId) return;
  const newLabel = cpRenameInput?.value.trim() ?? '';
  if (!newLabel) return;
  _renameMonitor(controlPanelDeviceId, newLabel);
  cpRenameForm?.classList.add('hidden');
});

/**
 * Sync all control-panel UI controls to a baby device state snapshot (TASK-025).
 * Called when the panel opens (with the last cached state) and whenever a fresh
 * STATE_SNAPSHOT arrives while the panel is open.
 * @param {object} s — state snapshot sent by the baby device
 */
function _syncControlPanelState(s) {
  if (!s) return;

  // Soothing mode buttons
  controlPanel?.querySelectorAll('.mode-btn').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.mode === s.soothingMode ? 'true' : 'false')
  );

  // Music volume slider
  if (cpVolume && s.musicVolume != null) cpVolume.value = String(s.musicVolume);

  // Track selector — set to the current track (or '' if none)
  if (cpTrackSelect) cpTrackSelect.value = s.currentTrack ?? '';

  // Audio-only toggle
  if (cpAudioOnly && s.audioOnly != null) cpAudioOnly.checked = Boolean(s.audioOnly);

  // Quality buttons
  cpQualityBtns.forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.quality === s.quality ? 'true' : 'false')
  );

  // TASK-028: battery-saving state from baby device
  if (cpScreenDim   && s.screenDim   != null) cpScreenDim.checked   = Boolean(s.screenDim);
  if (cpVideoPaused && s.videoPaused != null) cpVideoPaused.checked = Boolean(s.videoPaused);

  // TASK-014: Fade-out timer countdown and button state
  const fadeRemaining = s.fadeRemaining ?? 0;
  const fadeDuration  = s.fadeDuration  ?? 0;

  // Update countdown display.
  if (cpTimerCountdown) {
    if (fadeRemaining > 0) {
      const mins = Math.floor(fadeRemaining / 60);
      const secs = fadeRemaining % 60;
      cpTimerCountdown.textContent = `Stopping in ${mins}:${String(secs).padStart(2, '0')}`;
    } else {
      cpTimerCountdown.textContent = '';
    }
  }

  // Update timer button pressed state.
  // When a timer is active, highlight the matching preset button (or none for custom).
  // When the timer is off, highlight the "Off" button (data-duration="0").
  cpTimerBtns.forEach(b => {
    const btnSeconds = Number(b.dataset.duration) * 60;
    let pressed;
    if (fadeRemaining > 0) {
      // Timer running: press the preset that matches the original duration.
      pressed = (btnSeconds === fadeDuration && btnSeconds > 0);
    } else {
      // Timer off: press the "Off" button.
      pressed = (btnSeconds === 0);
    }
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  });
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

// Timer buttons (TASK-014)
for (const btn of cpTimerBtns) {
  btn.addEventListener('click', () => {
    const duration = Number(btn.dataset.duration);
    const conn = getActiveConn();
    if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_FADE_TIMER, duration * 60);
    // Optimistic visual update — STATE_SNAPSHOT from baby will confirm.
    cpTimerBtns.forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
    if (cpTimerCountdown && duration === 0) cpTimerCountdown.textContent = '';
  });
}

// Custom timer input + Set button (TASK-014)
cpTimerCustomSet?.addEventListener('click', () => {
  const mins = parseInt(cpTimerCustom?.value ?? '0', 10);
  if (!mins || mins < 1) return;
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_FADE_TIMER, mins * 60);
  // Clear preset button selection — custom duration won't match any preset.
  cpTimerBtns.forEach(b => b.setAttribute('aria-pressed', 'false'));
});

// Quality buttons (TASK-025) — send SET_QUALITY to baby; baby applies and confirms via snapshot
for (const btn of cpQualityBtns) {
  btn.addEventListener('click', () => {
    const quality = btn.dataset.quality;
    const conn = getActiveConn();
    if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_QUALITY, quality);
    // Optimistically update aria-pressed; STATE_SNAPSHOT from baby will confirm.
    cpQualityBtns.forEach(b =>
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')
    );
  });
}

// ---------------------------------------------------------------------------
// Speak-through implementation (TASK-012)
// Supports two modes (configurable in Settings):
//   • push-to-talk (PTT): hold the button to transmit, release to stop (default)
//   • toggle:             tap once to start, tap again to stop
// ---------------------------------------------------------------------------

/**
 * Update the speak button label and hint text to reflect the current mode.
 * Called once on init and whenever the speak mode setting changes.
 */
function updateSpeakBtnLabel() {
  if (!cpSpeakBtn) return;
  const isToggle = settings.speakMode === 'toggle';
  if (isToggle) {
    cpSpeakBtn.textContent = _speakActive ? '🎤 Tap to Stop' : '🎤 Tap to Speak';
    cpSpeakBtn.setAttribute('aria-label', 'Tap to toggle speak-through microphone');
  } else {
    cpSpeakBtn.textContent = _speakActive ? '🎤 Speaking…' : '🎤 Hold to Speak';
    cpSpeakBtn.setAttribute('aria-label', 'Hold to speak to baby');
  }
  if (cpSpeakHint) {
    cpSpeakHint.textContent = isToggle
      ? 'Tap once to start speaking; tap again to stop.'
      : 'Hold down to speak; release to stop. Baby device will play your voice.';
  }
}

/**
 * Start the speak-through microphone capture and add the audio track to the
 * active peer connection so the baby device hears the parent's voice (TASK-012).
 *
 * Captures the microphone with echo cancellation to suppress baby audio playing
 * through the parent's speakers.
 *
 * @returns {Promise<void>}
 */
async function startSpeakThrough() {
  if (_speakActive) return;
  const conn = getActiveConn();
  if (!conn) return;

  try {
    _speakMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:  true,
        noiseSuppression:  true,
        autoGainControl:   true,
      },
    });

    const micTrack = _speakMicStream.getAudioTracks()[0];

    // Add the microphone track to the peer connection so it is transmitted to
    // the baby device.  PeerJS handles the resulting renegotiation automatically.
    if (conn.peerConnection) {
      _speakMicSender = conn.peerConnection.addTrack(micTrack, _speakMicStream);
    }

    _speakActive = true;

    // TASK-056: duck the incoming baby audio to prevent speaker feedback.
    // Ramp down to silent over 200 ms; the AnalyserNode (pre-gain branch) keeps
    // feeding the noise visualiser throughout so the parent can still see activity.
    const duckDeviceId = controlPanelDeviceId;
    if (duckDeviceId && monitors.has(duckDeviceId)) {
      _speakDeviceId = duckDeviceId;
      setMonitorGain(duckDeviceId, 0, 200);
      console.log(`[parent] Speak-through ducking: muting baby audio for ${duckDeviceId} (TASK-056)`);
    }

    // Notify baby device so it can show its own visual indicator.
    if (conn.dataChannel) sendMessage(conn.dataChannel, MSG.SPEAK_START);

    cpSpeakBtn?.classList.add('active');
    cpSpeakBtn?.setAttribute('aria-pressed', 'true');
    updateSpeakBtnLabel();
    console.log('[parent] Speak-through started (TASK-012)');
  } catch (err) {
    // Microphone access denied or unavailable — clean up and inform the user.
    _speakMicStream?.getTracks().forEach(t => t.stop());
    _speakMicStream = null;
    console.error('[parent] Microphone access failed (TASK-012):', err);

    // Show a brief error on the button
    if (cpSpeakBtn) {
      const origText = cpSpeakBtn.textContent;
      cpSpeakBtn.textContent = '⚠️ Mic unavailable';
      setTimeout(() => {
        updateSpeakBtnLabel();
      }, 2500);
    }
  }
}

/**
 * Stop the speak-through microphone and remove the track from the peer
 * connection.  Sends SPEAK_STOP to the baby device (TASK-012).
 */
function stopSpeakThrough() {
  if (!_speakActive) return;
  const conn = getActiveConn();

  // Remove the sender from the peer connection so the baby can no longer hear
  // the parent's microphone.  PeerJS renegotiates automatically.
  if (_speakMicSender && conn?.peerConnection) {
    try {
      conn.peerConnection.removeTrack(_speakMicSender);
    } catch (err) {
      console.warn('[parent] removeTrack failed (TASK-012):', err);
    }
    _speakMicSender = null;
  }

  // Stop the mic capture completely to release the microphone hardware.
  _speakMicStream?.getTracks().forEach(t => t.stop());
  _speakMicStream = null;

  _speakActive = false;

  // TASK-056: restore the baby audio that was ducked when speak-through started.
  // Ramp back up to the user's desired gain over 500 ms.  Skip if the user has
  // explicitly muted that monitor via the volume control.
  if (_speakDeviceId) {
    const duckEntry = monitors.get(_speakDeviceId);
    if (duckEntry && !duckEntry.audioMuted) {
      setMonitorGain(_speakDeviceId, duckEntry.desiredGain, 500);
      console.log(`[parent] Speak-through ducking: restoring baby audio for ${_speakDeviceId} (TASK-056)`);
    }
    _speakDeviceId = null;
  }

  // Notify baby device to hide its visual indicator.
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SPEAK_STOP);

  cpSpeakBtn?.classList.remove('active');
  cpSpeakBtn?.setAttribute('aria-pressed', 'false');
  updateSpeakBtnLabel();
  console.log('[parent] Speak-through stopped (TASK-012)');
}

// Push-to-talk mode: start on pointerdown, stop on pointerup / pointerleave / pointercancel
cpSpeakBtn?.addEventListener('pointerdown', (e) => {
  if (settings.speakMode !== 'ptt') return;
  e.preventDefault(); // Prevent context menu on long-press (mobile)
  startSpeakThrough();
});

cpSpeakBtn?.addEventListener('pointerup', () => {
  if (settings.speakMode !== 'ptt') return;
  stopSpeakThrough();
});

cpSpeakBtn?.addEventListener('pointerleave', () => {
  if (settings.speakMode !== 'ptt') return;
  stopSpeakThrough();
});

cpSpeakBtn?.addEventListener('pointercancel', () => {
  if (settings.speakMode !== 'ptt') return;
  stopSpeakThrough();
});

// Toggle mode: tap once to start, tap again to stop
cpSpeakBtn?.addEventListener('click', () => {
  if (settings.speakMode !== 'toggle') return;
  if (_speakActive) {
    stopSpeakThrough();
  } else {
    startSpeakThrough();
  }
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

// TASK-028: Pause video toggle — tells baby to stop/resume its video track while
// keeping audio and the data channel alive.
cpVideoPaused?.addEventListener('change', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_VIDEO_PAUSED, cpVideoPaused.checked);
});

// TASK-028: Screen dim toggle — dims the baby device display to near-black.
// Battery hint: turning the display dark saves ~30 % battery on most phones.
cpScreenDim?.addEventListener('change', () => {
  const conn = getActiveConn();
  if (conn?.dataChannel) sendMessage(conn.dataChannel, MSG.SET_SCREEN_DIM, cpScreenDim.checked);
});

// TASK-028: Power-saver mode toggle — reduces noise analysis frequency on the
// parent device from ~10 fps to ~2 fps.  Saves CPU and battery on the parent.
// TASK-026: Also restarts motion detection with the updated interval.
cpPowerSaver?.addEventListener('change', () => {
  if (!controlPanelDeviceId) return;
  const entry = monitors.get(controlPanelDeviceId);
  if (entry) {
    entry.powerSaverMode = cpPowerSaver.checked;
    console.log(`[parent] Power-saver mode ${entry.powerSaverMode ? 'on' : 'off'} for ${entry.label}`);
    // Restart motion detection to pick up the new interval (TASK-026).
    restartMotionDetection(entry);
  }
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

// Motion sensitivity threshold (TASK-026)
cpMotionThreshold?.addEventListener('change', () => {
  if (!controlPanelDeviceId) return;
  const entry = monitors.get(controlPanelDeviceId);
  if (entry) {
    entry.motionThreshold = Number(cpMotionThreshold.value);
    const profile = getDeviceProfile(controlPanelDeviceId);
    if (profile) saveDeviceProfile({ ...profile, motionThreshold: entry.motionThreshold });
  }
});

// ---------------------------------------------------------------------------
// Movement alert snooze controls (TASK-027)
// ---------------------------------------------------------------------------

// Per-device snooze duration buttons + unsnooze (event delegation on the group).
cpSnoozeGroup?.addEventListener('click', (e) => {
  const btn = /** @type {HTMLButtonElement|null} */ (e.target.closest('.snooze-btn'));
  if (!btn || !controlPanelDeviceId) return;

  if (btn.id === 'cp-snooze-cancel') {
    // Cancel the per-device snooze.
    _snoozeUntil.delete(controlPanelDeviceId);
    const bannerKey = `${controlPanelDeviceId}:snooze`;
    alertBanners?.querySelector(`[data-alert-key="${escapeHtml(bannerKey)}"]`)?.remove();
    _syncSnoozeUI(controlPanelDeviceId);
    return;
  }

  const durationMs = parseInt(btn.dataset.duration, 10);
  if (!durationMs || isNaN(durationMs)) return;

  const entry = monitors.get(controlPanelDeviceId);
  if (entry) {
    snoozeMovementAlerts(controlPanelDeviceId, entry.label, durationMs);
    _syncSnoozeUI(controlPanelDeviceId);
  }
});

// Global snooze duration buttons + unsnooze all (event delegation on the group).
cpSnoozeAllGroup?.addEventListener('click', (e) => {
  const btn = /** @type {HTMLButtonElement|null} */ (e.target.closest('.snooze-btn'));
  if (!btn) return;

  if (btn.id === 'cp-snooze-all-cancel') {
    // Cancel the global snooze.
    _snoozeUntil.delete('global');
    const bannerKey = 'global:snooze';
    alertBanners?.querySelector(`[data-alert-key="${escapeHtml(bannerKey)}"]`)?.remove();
    _syncSnoozeUI(null);
    return;
  }

  const durationMs = parseInt(btn.dataset.duration, 10);
  if (!durationMs || isNaN(durationMs)) return;

  snoozeMovementAlerts('global', 'All monitors', durationMs);
  _syncSnoozeUI(null);
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
      // Cache the baby's state for when the control panel is opened (TASK-025 / TASK-048).
      if (!entry) break;
      entry.babyState = msg.value;
      // E2E test hook (TASK-063): expose the latest snapshot for Playwright assertions.
      window.__lastStateSnapshot = msg.value;
      // If the control panel is currently open for this device, live-sync its controls.
      if (controlPanelDeviceId === deviceId) {
        _syncControlPanelState(msg.value);
      }
      // TASK-048: if the snapshot carries battery state, update the panel battery
      // indicator so the parent always sees battery info on first connect and
      // after reconnection, before the next dedicated BATTERY_LEVEL message arrives.
      if (msg.value?.batteryLevel != null) {
        const { batteryLevel: level, batteryCharging: charging } = msg.value;
        const batteryEl = entry.panelEl?.querySelector('.panel-battery');
        if (batteryEl) {
          batteryEl.textContent = `${level}%${charging ? '⚡' : ''}`;
          batteryEl.title = `Battery: ${level}%${charging ? ' (charging)' : ''}`;
        }
      }
      break;
    }

    case MSG.BATTERY_LEVEL: {
      const { level, charging } = msg.value ?? {};
      if (!entry) break;
      const batteryEl = entry.panelEl?.querySelector('.panel-battery');
      if (batteryEl) {
        if (level == null) {
          batteryEl.textContent = '?';
          batteryEl.title = 'Battery level unknown';
        } else {
          batteryEl.textContent = `${level}%${charging ? '⚡' : ''}`;
          batteryEl.title = `Battery: ${level}%${charging ? ' (charging)' : ''}`;
        }
      }
      // Low battery alert (TASK-036) — only when level is known
      if (level != null) {
        const profile = getDeviceProfile(deviceId);
        const threshold = profile?.batteryThreshold ?? 15;
        if (level < threshold && !charging) {
          showBatteryAlert(deviceId, level, entry.label);
        }
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
      // Update the status badge and the connection overlay on the monitor panel.
      if (!entry) break;
      const statusBadge   = entry.panelEl?.querySelector('.status-badge');
      const connOverlay   = entry.panelEl?.querySelector('.monitor-panel__conn-overlay');
      const overlaySpan   = connOverlay?.querySelector('span');

      if (statusBadge) {
        statusBadge.className = 'status-badge';
        if (msg.value === 'connected')    statusBadge.classList.add('connected');
        if (msg.value === 'reconnecting') statusBadge.classList.add('reconnecting');
        statusBadge.setAttribute('aria-label', `Status: ${msg.value}`);
      }

      // TASK-021: show/hide the video overlay based on connection state.
      if (connOverlay) {
        if (msg.value === 'connected') {
          connOverlay.classList.add('hidden');
        } else if (msg.value === 'reconnecting') {
          if (overlaySpan) overlaySpan.textContent = 'Reconnecting…';
          connOverlay.classList.remove('hidden');
        } else if (msg.value === 'disconnected') {
          if (overlaySpan) overlaySpan.textContent = 'Disconnected';
          connOverlay.classList.remove('hidden');
        }
      }
      break;
    }

    case MSG.ID_POOL: {
      // TASK-061 — baby is sending its pre-agreed backup ID pool.
      // Payload: { pool: string[], index: number }
      //   pool  — full array of backup PeerJS peer IDs
      //   index — current/last-used index within the pool
      //
      // Persist to the device profile (survives app restart) and update the
      // in-memory entry so TASK-030's reconnect logic can access the pool
      // immediately without re-reading localStorage.
      //
      // This message is also sent after every replenishment (when the pool
      // falls below 5 unused IDs) so the parent always has an up-to-date copy.
      const poolPayload = msg.value;
      if (!poolPayload || !Array.isArray(poolPayload.pool)) break;

      const { pool, index } = poolPayload;
      const safeIndex = typeof index === 'number' ? index : 0;

      // Update the in-memory entry immediately.
      if (entry) {
        entry.backupPool      = pool;
        entry.backupPoolIndex = safeIndex;
      }

      // Persist to the device profile so the pool survives a page reload or
      // app restart (TASK-030 needs it for reconnection even after full restart).
      const profile = getDeviceProfile(deviceId);
      if (profile) {
        saveDeviceProfile({ ...profile, backupPoolJson: JSON.stringify({ pool, index: safeIndex }) });
      }

      console.log(
        '[parent] Received backup ID pool from baby', deviceId,
        '— pool length', pool.length, ', index', safeIndex, '(TASK-061)',
      );
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

// ---------------------------------------------------------------------------
// Movement alert snooze state (TASK-027)
// ---------------------------------------------------------------------------

/**
 * Movement alert snooze state.
 * Key: deviceId for per-device snooze, or 'global' to silence all monitors.
 * Value: epoch-ms timestamp after which alerts should resume.
 * @type {Map<string, number>}
 */
const _snoozeUntil = new Map();

/** Named snooze durations in milliseconds (TASK-027). */
const SNOOZE_DURATIONS_MS = {
  '10min': 10 * 60_000,
  '30min': 30 * 60_000,
  '1hour': 60 * 60_000,
};

/**
 * Returns true if movement alerts for the given device are currently snoozed.
 * Checks both per-device snooze and the global snooze (TASK-027).
 * @param {string} deviceId
 * @returns {boolean}
 */
function isMovementAlertSnoozed(deviceId) {
  const now = Date.now();
  const globalUntil = _snoozeUntil.get('global');
  if (globalUntil && now < globalUntil) return true;
  const deviceUntil = _snoozeUntil.get(deviceId);
  return deviceUntil != null && now < deviceUntil;
}

/**
 * Snooze movement alerts for a device or for all monitors (TASK-027).
 * Shows a snooze-confirmation banner in the alert area with a Cancel button.
 *
 * @param {string} key          — deviceId, or 'global' to snooze all monitors
 * @param {string} displayLabel — human-readable name for the confirmation banner
 * @param {number} durationMs   — snooze duration in milliseconds
 */
function snoozeMovementAlerts(key, displayLabel, durationMs) {
  _snoozeUntil.set(key, Date.now() + durationMs);

  // Remove any existing snooze-confirmation banner for this key.
  const bannerKey = `${key}:snooze`;
  const existing = alertBanners?.querySelector(`[data-alert-key="${escapeHtml(bannerKey)}"]`);
  if (existing) existing.remove();

  const mins = Math.round(durationMs / 60_000);
  const banner = document.createElement('div');
  banner.className = 'alert-banner alert-banner--snooze';
  banner.setAttribute('role', 'status');
  banner.dataset.alertKey = bannerKey;
  banner.innerHTML = `
    🔕 <strong>${escapeHtml(displayLabel)}</strong> movement alerts snoozed for ${mins} min
    <button class="alert-banner__dismiss" aria-label="Cancel snooze">Cancel</button>
  `;
  banner.querySelector('.alert-banner__dismiss')?.addEventListener('click', () => {
    _snoozeUntil.delete(key);
    banner.remove();
    _syncSnoozeUI(key === 'global' ? null : key);
  });

  alertBanners?.prepend(banner);

  // Auto-remove the confirmation banner when the snooze period expires.
  setTimeout(() => {
    _snoozeUntil.delete(key);
    if (banner.isConnected) banner.remove();
    _syncSnoozeUI(key === 'global' ? null : key);
  }, durationMs);
}

/**
 * Refresh the snooze button visibility in the control panel for a given device.
 * Shows the "Unsnooze" button when the device (or global) is snoozed; hides it otherwise.
 * Called after a snooze is set, cancelled, or expires (TASK-027).
 *
 * @param {string|null} deviceId — null means re-sync using the current controlPanelDeviceId
 */
function _syncSnoozeUI(deviceId) {
  const id = deviceId ?? controlPanelDeviceId;

  // Per-device snooze cancel button
  const unsnoozeBtnDevice = document.getElementById('cp-snooze-cancel');
  if (unsnoozeBtnDevice && id) {
    const deviceSnoozed = _snoozeUntil.has(id) && Date.now() < (_snoozeUntil.get(id) ?? 0);
    unsnoozeBtnDevice.classList.toggle('hidden', !deviceSnoozed);
  }

  // Global snooze cancel button
  const unsnoozeBtnGlobal = document.getElementById('cp-snooze-all-cancel');
  if (unsnoozeBtnGlobal) {
    const globalSnoozed = _snoozeUntil.has('global') && Date.now() < (_snoozeUntil.get('global') ?? 0);
    unsnoozeBtnGlobal.classList.toggle('hidden', !globalSnoozed);
  }
}

/**
 * Send a browser notification if permission is granted and the tab is hidden.
 * Used to deliver movement, battery, and noise alerts in the background (TASK-029).
 *
 * @param {string} title   — Notification title
 * @param {string} body    — Notification body text
 * @param {string} tag     — Dedup tag (prevents the same alert spawning twice)
 */
function _sendBackgroundNotification(title, body, tag) {
  // Only send when the tab is hidden so we don't duplicate in-app banners.
  if (document.visibilityState !== 'hidden') return;
  // Guard: Notification API must be available and permission granted.
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (!lsGet(SETTING_KEYS.NOTIF_GRANTED, false)) return;
  try {
    new Notification(title, { body, tag });
  } catch (err) {
    console.warn('[parent] Failed to show notification:', err);
  }
}

/**
 * Display a low-battery alert banner for a device and send a background
 * notification if the tab is hidden (TASK-036, TASK-029).
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

  // Background notification (TASK-029): delivered when the tab is hidden.
  _sendBackgroundNotification(
    'Baby Monitor — Low Battery',
    `${label}: Battery is at ${level}%.`,
    key,
  );
}

/**
 * Display a movement alert banner and send a background notification if the
 * tab is hidden (TASK-027, TASK-029).
 * Called by the movement detection logic (TASK-026) when motion is detected.
 * Respects per-device and global snooze state (TASK-027).
 *
 * @param {string} deviceId
 * @param {string} label
 */
function showMovementAlert(deviceId, label) {
  // Do not show the alert while snoozed (TASK-027).
  if (isMovementAlertSnoozed(deviceId)) return;

  const key = `${deviceId}:movement`;
  // Allow the alert to re-fire for each new movement event; do not deduplicate
  // indefinitely — remove the existing banner (if any) before adding a new one.
  const existing = alertBanners?.querySelector(`[data-alert-key="${escapeHtml(key)}"]`);
  if (existing) existing.remove();
  activeAlerts.delete(key);
  activeAlerts.add(key);

  const banner = document.createElement('div');
  banner.className = 'alert-banner alert-banner--movement';
  banner.setAttribute('role', 'alert');
  banner.dataset.alertKey = key;
  banner.innerHTML = `
    🚶 <strong>${escapeHtml(label)}</strong>: Movement detected
    <button class="alert-banner__snooze" aria-label="Snooze movement alerts for 10 minutes">Snooze 10 min</button>
    <button class="alert-banner__dismiss" aria-label="Dismiss movement alert">✕</button>
  `;
  // "Snooze 10 min" button: snooze this device for 10 minutes and remove banner (TASK-027).
  banner.querySelector('.alert-banner__snooze')?.addEventListener('click', () => {
    snoozeMovementAlerts(deviceId, label, SNOOZE_DURATIONS_MS['10min']);
    banner.remove();
    activeAlerts.delete(key);
    _syncSnoozeUI(deviceId);
  });
  banner.querySelector('.alert-banner__dismiss')?.addEventListener('click', () => {
    banner.remove();
    activeAlerts.delete(key);
  });

  alertBanners?.prepend(banner);

  // Background notification (TASK-029): delivered when the tab is hidden.
  _sendBackgroundNotification(
    'Baby Monitor — Movement Detected',
    `${label}: Movement has been detected.`,
    key,
  );
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
  _syncSettingsScreen(); // TASK-012: sync speak mode radio to current setting
});

document.getElementById('settings-back')?.addEventListener('click', () => {
  settingsScreen?.classList.add('hidden');
  parentDashboard?.classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// Settings screen — speak-through mode (TASK-012) + advanced connection (TASK-008)
// ---------------------------------------------------------------------------

/**
 * Sync the settings screen form fields with current stored values.
 * Called each time the settings screen is opened.
 */
function _syncSettingsScreen() {
  // Speak mode radios (TASK-012)
  const pttRadio    = document.getElementById('speak-mode-ptt');
  const toggleRadio = document.getElementById('speak-mode-toggle');
  if (pttRadio && toggleRadio) {
    if (settings.speakMode === 'toggle') {
      toggleRadio.checked = true;
      pttRadio.checked    = false;
    } else {
      pttRadio.checked    = true;
      toggleRadio.checked = false;
    }
  }

  // TURN server fields (TASK-008)
  const turnConfig = lsGet(SETTING_KEYS.TURN_CONFIG, null);
  const turnUrlEl       = document.getElementById('turn-url');
  const turnUsernameEl  = document.getElementById('turn-username');
  const turnCredentialEl = document.getElementById('turn-credential');
  if (turnUrlEl)        turnUrlEl.value        = turnConfig?.urls       ?? '';
  if (turnUsernameEl)   turnUsernameEl.value   = turnConfig?.username   ?? '';
  if (turnCredentialEl) turnCredentialEl.value = turnConfig?.credential ?? '';
  const turnStatusEl = document.getElementById('turn-status');
  if (turnStatusEl) {
    turnStatusEl.textContent = turnConfig?.urls ? 'TURN server configured.' : '';
    turnStatusEl.className   = turnConfig?.urls ? 'settings-status settings-status--success' : 'settings-status';
  }

  // Custom PeerJS server fields (TASK-008)
  const peerjsConfig = lsGet(SETTING_KEYS.PEERJS_SERVER, null);
  const peerjsHostEl   = document.getElementById('peerjs-host');
  const peerjsPortEl   = document.getElementById('peerjs-port');
  const peerjsPathEl   = document.getElementById('peerjs-path');
  const peerjsSecureEl = document.getElementById('peerjs-secure');
  if (peerjsHostEl)   peerjsHostEl.value     = peerjsConfig?.host ?? '';
  if (peerjsPortEl)   peerjsPortEl.value     = peerjsConfig?.port != null ? String(peerjsConfig.port) : '';
  if (peerjsPathEl)   peerjsPathEl.value     = peerjsConfig?.path ?? '';
  if (peerjsSecureEl) peerjsSecureEl.checked = peerjsConfig ? (peerjsConfig.secure !== false) : true;
  const peerjsStatusEl = document.getElementById('peerjs-status');
  if (peerjsStatusEl) {
    peerjsStatusEl.textContent = peerjsConfig?.host ? 'Custom PeerJS server configured.' : '';
    peerjsStatusEl.className   = peerjsConfig?.host ? 'settings-status settings-status--success' : 'settings-status';
  }

  // Saved devices list (TASK-023)
  _renderSavedDevices();
}

// Wire up speak mode radio buttons
document.getElementById('speak-mode-ptt')?.addEventListener('change', () => {
  settings.speakMode = 'ptt';
  saveSetting(SETTING_KEYS.SPEAK_MODE, 'ptt');
  updateSpeakBtnLabel();
});

document.getElementById('speak-mode-toggle')?.addEventListener('change', () => {
  settings.speakMode = 'toggle';
  saveSetting(SETTING_KEYS.SPEAK_MODE, 'toggle');
  updateSpeakBtnLabel();
});

// Wire up TURN server save / clear buttons (TASK-008)
document.getElementById('btn-save-turn')?.addEventListener('click', () => {
  const url        = document.getElementById('turn-url')?.value.trim()        ?? '';
  const username   = document.getElementById('turn-username')?.value.trim()   ?? '';
  const credential = document.getElementById('turn-credential')?.value.trim() ?? '';
  const statusEl   = document.getElementById('turn-status');

  if (!url) {
    if (statusEl) {
      statusEl.textContent = 'Please enter a TURN server URL.';
      statusEl.className   = 'settings-status settings-status--error';
    }
    return;
  }

  const config = { urls: url };
  if (username)   config.username   = username;
  if (credential) config.credential = credential;

  saveSetting(SETTING_KEYS.TURN_CONFIG, config);
  settings = getSettings(); // refresh in-memory settings

  if (statusEl) {
    statusEl.textContent = 'TURN server saved. Takes effect on the next connection.';
    statusEl.className   = 'settings-status settings-status--success';
  }
});

document.getElementById('btn-clear-turn')?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.TURN_CONFIG, null);
  settings = getSettings();

  const turnUrlEl       = document.getElementById('turn-url');
  const turnUsernameEl  = document.getElementById('turn-username');
  const turnCredentialEl = document.getElementById('turn-credential');
  if (turnUrlEl)        turnUrlEl.value        = '';
  if (turnUsernameEl)   turnUsernameEl.value   = '';
  if (turnCredentialEl) turnCredentialEl.value = '';

  const statusEl = document.getElementById('turn-status');
  if (statusEl) {
    statusEl.textContent = 'TURN server cleared.';
    statusEl.className   = 'settings-status';
  }
});

// Wire up custom PeerJS server save / clear buttons (TASK-008)
document.getElementById('btn-save-peerjs')?.addEventListener('click', () => {
  const host     = document.getElementById('peerjs-host')?.value.trim()  ?? '';
  const portRaw  = document.getElementById('peerjs-port')?.value.trim()  ?? '';
  const path     = document.getElementById('peerjs-path')?.value.trim()  ?? '/';
  const secure   = document.getElementById('peerjs-secure')?.checked     ?? true;
  const statusEl = document.getElementById('peerjs-status');

  if (!host) {
    if (statusEl) {
      statusEl.textContent = 'Please enter a PeerJS server host.';
      statusEl.className   = 'settings-status settings-status--error';
    }
    return;
  }

  const port = portRaw ? parseInt(portRaw, 10) : 9000;
  if (isNaN(port) || port < 1 || port > 65535) {
    if (statusEl) {
      statusEl.textContent = 'Port must be a number between 1 and 65535.';
      statusEl.className   = 'settings-status settings-status--error';
    }
    return;
  }

  const config = { host, port, path: path || '/', secure };
  saveSetting(SETTING_KEYS.PEERJS_SERVER, config);
  settings = getSettings();

  if (statusEl) {
    statusEl.textContent = 'PeerJS server saved. Takes effect on the next connection.';
    statusEl.className   = 'settings-status settings-status--success';
  }
});

document.getElementById('btn-clear-peerjs')?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.PEERJS_SERVER, null);
  settings = getSettings();

  const peerjsHostEl   = document.getElementById('peerjs-host');
  const peerjsPortEl   = document.getElementById('peerjs-port');
  const peerjsPathEl   = document.getElementById('peerjs-path');
  const peerjsSecureEl = document.getElementById('peerjs-secure');
  if (peerjsHostEl)   peerjsHostEl.value     = '';
  if (peerjsPortEl)   peerjsPortEl.value     = '';
  if (peerjsPathEl)   peerjsPathEl.value     = '';
  if (peerjsSecureEl) peerjsSecureEl.checked = true;

  const statusEl = document.getElementById('peerjs-status');
  if (statusEl) {
    statusEl.textContent = 'Custom PeerJS server cleared. Using public PeerJS server.';
    statusEl.className   = 'settings-status';
  }
});

// Initialise speak button label on load (TASK-012)
updateSpeakBtnLabel();

// TASK-022: "Back to Dashboard" cancel button shown during pairing when monitors
// are already connected.  Stops any active scanner, cleans up the peer status
// listener set up by startPeerJsPairing(), and returns to the dashboard.
// Existing WebRTC connections are unaffected — they stay alive throughout the
// pairing flow because we never close them in showPairing().
document.getElementById('pairing-cancel-btn')?.addEventListener('click', () => {
  stopScanner();
  _peerStatusUnsub?.();
  _peerStatusUnsub = null;
  showDashboard();
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

// ---------------------------------------------------------------------------
// E2E test hooks — speak-through (TASK-064)
// ---------------------------------------------------------------------------
// Expose a helper that opens the control panel for a given device ID and then
// starts speak-through so Playwright tests can trigger the full speak-through
// flow without needing to interact with the DOM directly.
// Only wired up once the module has loaded; safe to call any time after that.
window.__testActivateSpeakThrough = async (deviceId) => {
  openControlPanel(deviceId);
  await startSpeakThrough();
};

window.__testStopSpeakThrough = () => {
  stopSpeakThrough();
};

// ---------------------------------------------------------------------------
// E2E test hooks (TASK-067)
// ---------------------------------------------------------------------------

/**
 * Override the in-memory backup pool start index for a given device so that
 * the parent's very first reconnect attempt uses poolIds[index] instead of
 * poolIds[0].  Setting this to 1 makes attempt 1 target pool[1], which is the
 * same ID the baby advances to on its first reconnect (index 0 → 1), allowing
 * the two sides to converge on the matching backup peer ID immediately without
 * sitting through the 12-second per-attempt timeout.
 *
 * @param {string} deviceId
 * @param {number} index
 */
window.__testSetPoolStartIndex = (deviceId, index) => {
  const entry = monitors.get(deviceId);
  if (entry) entry.backupPoolIndex = index;
};
