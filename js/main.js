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

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const tapOverlay        = document.getElementById('tap-overlay');
const compatModal       = document.getElementById('compat-modal');
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

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init() {
  checkBrowserCompatibility();
  setupTheme();
  maybePromptDarkMode();
  homeScreen?.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Browser compatibility check (TASK-045)
// ---------------------------------------------------------------------------

function checkBrowserCompatibility() {
  const ua = navigator.userAgent;
  const isIosSafari = /iP(hone|ad|od)/.test(ua) && !/CriOS/.test(ua);

  if (isIosSafari) {
    // Block iOS Safari with a full-screen modal
    if (compatModal) {
      document.getElementById('compat-modal-message').textContent =
        'This app requires Chrome to function. ' +
        'Please open this page in Chrome on your iPhone or iPad.';
      const urlEl = document.getElementById('compat-modal-url');
      if (urlEl) urlEl.textContent = window.location.href;
      compatModal.classList.remove('hidden');
    }
    // Do not proceed
    return;
  }

  // Soft warning for other non-Chrome browsers
  const isChrome = /Chrome/.test(ua) && !/Edg/.test(ua) && !/OPR/.test(ua);
  if (!isChrome) {
    console.warn('[main] Non-Chrome browser detected. App may not work as expected.');
    // Soft banner shown in TASK-045
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
// Settings screen
// ---------------------------------------------------------------------------

btnSettings?.addEventListener('click', () => {
  homeScreen?.classList.add('hidden');
  settingsScreen?.classList.remove('hidden');
});

settingsBack?.addEventListener('click', () => {
  settingsScreen?.classList.add('hidden');
  homeScreen?.classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// Tap-to-begin overlay (TASK-037)
// ---------------------------------------------------------------------------

tapOverlay?.addEventListener('click', () => {
  tapOverlay.classList.add('hidden');
  init();
}, { once: true });
