/**
 * main.js — Entry point for index.html (mode selection / home screen)
 *
 * Handles:
 *   - Browser compatibility check (TASK-045)
 *   - Theme initialisation and dark mode prompt (TASK-046)
 *   - Tap-to-begin overlay (TASK-037)
 *   - Navigation to baby.html or parent.html
 *   - Safe sleep screen and settings screen toggling
 */

import { lsGet, lsSet, getSettings, saveSetting, SETTING_KEYS } from './storage.js';
import { renderSafeSleepContent } from './safe-sleep.js';
import { showCompatWarnings } from './browser-compat.js';
import { isOnboardingRequired, startOnboarding, resetOnboarding } from './onboarding.js';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const tapOverlay        = document.getElementById('tap-overlay');
const homeScreen        = document.getElementById('home');
const themeIcon         = document.getElementById('theme-icon');
const darkModeToggle    = document.getElementById('dark-mode-toggle');
const btnBaby           = document.getElementById('btn-baby');
const btnParent         = document.getElementById('btn-parent');
const btnAddParent      = document.getElementById('btn-add-parent');
const btnSafeSleep      = document.getElementById('btn-safe-sleep');
const btnSettings       = document.getElementById('btn-settings');
const safeSleepScreen   = document.getElementById('safe-sleep-screen');
const safeSleepBack     = document.getElementById('safe-sleep-back');
const settingsScreen    = document.getElementById('settings-screen');
const settingsBack      = document.getElementById('settings-back');
const onboardingWizard  = document.getElementById('onboarding-wizard');

// ---------------------------------------------------------------------------
// Browser compatibility check (TASK-045)
// Run immediately at module load — before any user interaction or init().
// ---------------------------------------------------------------------------

const _compatResult = showCompatWarnings();

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init() {
  setupTheme();
  maybePromptDarkMode();

  // First-run onboarding (TASK-031): show the setup wizard on the very first
  // open. On subsequent opens (ONBOARDING_DONE=true) show the home screen
  // directly, which already shows role selection.
  if (isOnboardingRequired()) {
    startOnboarding(onboardingWizard, () => {
      // onSkip callback: user chose to bypass the wizard
      homeScreen?.classList.remove('hidden');
    });
  } else {
    homeScreen?.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Theme (TASK-046)
// ---------------------------------------------------------------------------

function setupTheme() {
  const saved = lsGet(SETTING_KEYS.THEME, null);
  const isDark = saved === 'dark';
  document.body.classList.toggle('dark-mode', isDark);
  if (themeIcon) themeIcon.textContent = isDark ? '☀️' : '🌙';
}

function maybePromptDarkMode() {
  // Don't prompt if already seen or preference already set
  if (lsGet(SETTING_KEYS.THEME_PROMPT_SEEN, false)) return;
  if (lsGet(SETTING_KEYS.THEME, null) !== null) return;

  const hour = new Date().getHours();
  if (hour >= 19 || hour < 7) {
    // Non-blocking prompt — full UI implementation in TASK-046
    // For now, just mark as seen to avoid repeating the check
    lsSet(SETTING_KEYS.THEME_PROMPT_SEEN, true);
    // TODO: Show subtle banner asking "Switch to dark mode?"
  }
}

darkModeToggle?.addEventListener('click', () => {
  const isDark = document.body.classList.toggle('dark-mode');
  saveSetting(SETTING_KEYS.THEME, isDark ? 'dark' : 'light');
  if (themeIcon) themeIcon.textContent = isDark ? '☀️' : '🌙';
});

// ---------------------------------------------------------------------------
// Mode navigation
// ---------------------------------------------------------------------------

btnBaby?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.DEVICE_ROLE, 'baby');
  window.location.href = 'baby.html';
});

btnParent?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.DEVICE_ROLE, 'parent');
  window.location.href = 'parent.html';
});

btnAddParent?.addEventListener('click', () => {
  saveSetting(SETTING_KEYS.DEVICE_ROLE, 'parent');
  // Navigate to parent.html with a flag indicating add-parent mode
  window.location.href = 'parent.html?mode=add-parent';
});

// ---------------------------------------------------------------------------
// Safe sleep screen (TASK-044)
// ---------------------------------------------------------------------------

btnSafeSleep?.addEventListener('click', () => {
  homeScreen?.classList.add('hidden');
  safeSleepScreen?.classList.remove('hidden');
  const inner = safeSleepScreen?.querySelector('.safe-sleep-screen__inner');
  if (inner) renderSafeSleepContent(inner);
});

safeSleepBack?.addEventListener('click', () => {
  safeSleepScreen?.classList.add('hidden');
  homeScreen?.classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// Settings screen (TASK-032, TASK-008)
// ---------------------------------------------------------------------------

/**
 * Populate the home settings screen form fields from localStorage.
 * Called each time the settings screen is opened.
 */
function _syncHomeSettings() {
  // TURN server fields
  const turnConfig = lsGet(SETTING_KEYS.TURN_CONFIG, null);
  const turnUrlEl        = document.getElementById('home-turn-url');
  const turnUsernameEl   = document.getElementById('home-turn-username');
  const turnCredentialEl = document.getElementById('home-turn-credential');
  if (turnUrlEl)        turnUrlEl.value        = turnConfig?.urls       ?? '';
  if (turnUsernameEl)   turnUsernameEl.value   = turnConfig?.username   ?? '';
  if (turnCredentialEl) turnCredentialEl.value = turnConfig?.credential ?? '';
  const turnStatusEl = document.getElementById('home-turn-status');
  if (turnStatusEl) {
    turnStatusEl.textContent = turnConfig?.urls ? 'TURN server configured.' : '';
    turnStatusEl.className   = turnConfig?.urls ? 'settings-status settings-status--success' : 'settings-status';
  }

  // Custom PeerJS server fields
  const peerjsConfig = lsGet(SETTING_KEYS.PEERJS_SERVER, null);
  const peerjsHostEl   = document.getElementById('home-peerjs-host');
  const peerjsPortEl   = document.getElementById('home-peerjs-port');
  const peerjsPathEl   = document.getElementById('home-peerjs-path');
  const peerjsSecureEl = document.getElementById('home-peerjs-secure');
  if (peerjsHostEl)   peerjsHostEl.value     = peerjsConfig?.host ?? '';
  if (peerjsPortEl)   peerjsPortEl.value     = peerjsConfig?.port != null ? String(peerjsConfig.port) : '';
  if (peerjsPathEl)   peerjsPathEl.value     = peerjsConfig?.path ?? '';
  if (peerjsSecureEl) peerjsSecureEl.checked = peerjsConfig ? (peerjsConfig.secure !== false) : true;
  const peerjsStatusEl = document.getElementById('home-peerjs-status');
  if (peerjsStatusEl) {
    peerjsStatusEl.textContent = peerjsConfig?.host ? 'Custom PeerJS server configured.' : '';
    peerjsStatusEl.className   = peerjsConfig?.host ? 'settings-status settings-status--success' : 'settings-status';
  }
}

btnSettings?.addEventListener('click', () => {
  homeScreen?.classList.add('hidden');
  settingsScreen?.classList.remove('hidden');
  _syncHomeSettings();
});

settingsBack?.addEventListener('click', () => {
  settingsScreen?.classList.add('hidden');
  homeScreen?.classList.remove('hidden');
});

// TURN server save / clear (TASK-008)
document.getElementById('home-btn-save-turn')?.addEventListener('click', () => {
  const url        = document.getElementById('home-turn-url')?.value.trim()        ?? '';
  const username   = document.getElementById('home-turn-username')?.value.trim()   ?? '';
  const credential = document.getElementById('home-turn-credential')?.value.trim() ?? '';
  const statusEl   = document.getElementById('home-turn-status');

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

  lsSet(SETTING_KEYS.TURN_CONFIG, config);

  if (statusEl) {
    statusEl.textContent = 'TURN server saved. Takes effect on the next connection.';
    statusEl.className   = 'settings-status settings-status--success';
  }
});

document.getElementById('home-btn-clear-turn')?.addEventListener('click', () => {
  lsSet(SETTING_KEYS.TURN_CONFIG, null);

  const turnUrlEl        = document.getElementById('home-turn-url');
  const turnUsernameEl   = document.getElementById('home-turn-username');
  const turnCredentialEl = document.getElementById('home-turn-credential');
  if (turnUrlEl)        turnUrlEl.value        = '';
  if (turnUsernameEl)   turnUsernameEl.value   = '';
  if (turnCredentialEl) turnCredentialEl.value = '';

  const statusEl = document.getElementById('home-turn-status');
  if (statusEl) {
    statusEl.textContent = 'TURN server cleared.';
    statusEl.className   = 'settings-status';
  }
});

// Custom PeerJS server save / clear (TASK-008)
document.getElementById('home-btn-save-peerjs')?.addEventListener('click', () => {
  const host     = document.getElementById('home-peerjs-host')?.value.trim()  ?? '';
  const portRaw  = document.getElementById('home-peerjs-port')?.value.trim()  ?? '';
  const path     = document.getElementById('home-peerjs-path')?.value.trim()  ?? '/';
  const secure   = document.getElementById('home-peerjs-secure')?.checked     ?? true;
  const statusEl = document.getElementById('home-peerjs-status');

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
  lsSet(SETTING_KEYS.PEERJS_SERVER, config);

  if (statusEl) {
    statusEl.textContent = 'PeerJS server saved. Takes effect on the next connection.';
    statusEl.className   = 'settings-status settings-status--success';
  }
});

document.getElementById('home-btn-clear-peerjs')?.addEventListener('click', () => {
  lsSet(SETTING_KEYS.PEERJS_SERVER, null);

  const peerjsHostEl   = document.getElementById('home-peerjs-host');
  const peerjsPortEl   = document.getElementById('home-peerjs-port');
  const peerjsPathEl   = document.getElementById('home-peerjs-path');
  const peerjsSecureEl = document.getElementById('home-peerjs-secure');
  if (peerjsHostEl)   peerjsHostEl.value     = '';
  if (peerjsPortEl)   peerjsPortEl.value     = '';
  if (peerjsPathEl)   peerjsPathEl.value     = '';
  if (peerjsSecureEl) peerjsSecureEl.checked = true;

  const statusEl = document.getElementById('home-peerjs-status');
  if (statusEl) {
    statusEl.textContent = 'Custom PeerJS server cleared. Using public PeerJS server.';
    statusEl.className   = 'settings-status';
  }
});

// ---------------------------------------------------------------------------
// Re-run setup wizard (TASK-031)
// ---------------------------------------------------------------------------

document.getElementById('home-btn-rerun-setup')?.addEventListener('click', () => {
  // Reset all onboarding flags and reload the page so the wizard runs again
  resetOnboarding();
  settingsScreen?.classList.add('hidden');
  window.location.reload();
});

// ---------------------------------------------------------------------------
// Tap-to-begin overlay (TASK-037)
// ---------------------------------------------------------------------------

// If the browser is blocked (iOS Safari), the compat modal is already visible
// and the tap overlay has been hidden — do not wire up the tap-to-begin handler.
if (_compatResult !== 'blocked') {
  tapOverlay?.addEventListener('click', () => {
    tapOverlay.classList.add('hidden');
    init();
  }, { once: true });
}
