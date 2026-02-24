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
  homeScreen?.classList.remove('hidden');
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

// If the browser is blocked (iOS Safari), the compat modal is already visible
// and the tap overlay has been hidden — do not wire up the tap-to-begin handler.
if (_compatResult !== 'blocked') {
  tapOverlay?.addEventListener('click', () => {
    tapOverlay.classList.add('hidden');
    init();
  }, { once: true });
}
