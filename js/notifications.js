/**
 * notifications.js — Notification permission request (TASK-047)
 *
 * Provides a dedicated explanation screen before triggering the browser's
 * native notification permission prompt. Includes platform-specific messaging
 * for iOS devices, which cannot deliver background web notifications.
 *
 * Public API:
 *   showNotificationPermissionScreen(screenEl)  — Promise<void>
 *   isNotificationAlreadyHandled()              — boolean
 *   isNotificationGranted()                     — boolean
 *
 * Storage keys used:
 *   NOTIF_PROMPTED — set to true once the user has seen or bypassed this screen
 *   NOTIF_GRANTED  — set to true if the user granted permission
 */

import { lsGet, lsSet, SETTING_KEYS } from './storage.js';
import { escapeHtml } from './utils.js';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the current device is running iOS (iPhone, iPad, iPod).
 * Matches both iOS Safari and Chrome on iOS (CriOS), since Apple restricts
 * background notifications for all web apps on iOS regardless of browser.
 * @returns {boolean}
 */
function isIos() {
  return /iP(hone|ad|od)/i.test(navigator.userAgent);
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the notification permission prompt has already been
 * presented on this device, or if it is unnecessary (API unavailable, or
 * the browser already has a non-default permission state).
 * @returns {boolean}
 */
export function isNotificationAlreadyHandled() {
  return lsGet(SETTING_KEYS.NOTIF_PROMPTED, false) === true;
}

/**
 * Returns true if the user has granted notification permission.
 * @returns {boolean}
 */
export function isNotificationGranted() {
  return lsGet(SETTING_KEYS.NOTIF_GRANTED, false) === true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Show the notification permission explanation screen and handle the complete
 * permission request flow. Resolves when the user has either granted or denied
 * permission, or chosen to continue without notifications.
 *
 * If the Notification API is unavailable, or the user was already prompted
 * (NOTIF_PROMPTED flag set), or the browser already has a non-default
 * permission state, the function resolves immediately without showing the
 * screen.
 *
 * @param {HTMLElement} screenEl
 *   The full-screen section element to populate and show. It must start with
 *   the `hidden` class applied. The element must contain a child element with
 *   the class `.notif-screen__inner`.
 * @returns {Promise<void>}
 */
export function showNotificationPermissionScreen(screenEl) {
  return new Promise((resolve) => {

    // Already prompted on a previous visit — skip the screen
    if (isNotificationAlreadyHandled()) {
      resolve();
      return;
    }

    // Notification API not supported in this browser / WebView
    if (!('Notification' in window)) {
      lsSet(SETTING_KEYS.NOTIF_PROMPTED, true);
      lsSet(SETTING_KEYS.NOTIF_GRANTED, false);
      resolve();
      return;
    }

    // Browser already has a non-default permission state (user or OS decided
    // outside of our app). Record the current state and skip the screen.
    if (Notification.permission !== 'default') {
      lsSet(SETTING_KEYS.NOTIF_PROMPTED, true);
      lsSet(SETTING_KEYS.NOTIF_GRANTED, Notification.permission === 'granted');
      resolve();
      return;
    }

    // No screen element supplied — fall back to a bare permission request
    if (!screenEl) {
      Notification.requestPermission().then((result) => {
        lsSet(SETTING_KEYS.NOTIF_PROMPTED, true);
        lsSet(SETTING_KEYS.NOTIF_GRANTED, result === 'granted');
        resolve();
      });
      return;
    }

    // Build and display the explanation screen
    _renderScreen(screenEl, resolve);
    screenEl.classList.remove('hidden');
  });
}

// ---------------------------------------------------------------------------
// Screen rendering
// ---------------------------------------------------------------------------

const _ios = isIos();

/**
 * Inject screen content into screenEl and wire up button events.
 * @param {HTMLElement} screenEl
 * @param {Function} resolve
 */
function _renderScreen(screenEl, resolve) {
  const inner = screenEl.querySelector('.notif-screen__inner');
  if (!inner) return;

  // Idempotency guard: skip if content already injected
  if (inner.querySelector('.notif-content')) return;

  inner.insertAdjacentHTML('beforeend', _buildHtml());
  _wireButtons(inner, screenEl, resolve);
}

/**
 * Build the HTML for the notification permission screen.
 * Text and caveats are tailored for iOS vs non-iOS.
 * @returns {string}
 */
function _buildHtml() {
  const explainText = _ios
    ? 'On iPhone and iPad, notifications will only show while this app is open. ' +
      'For background alerts, keep the app open on screen.'
    : 'Allow notifications so we can alert you about baby movement, unusual sounds, ' +
      'and low battery — even when the app is in the background or your phone screen is off.';

  const iosNote = _ios
    ? `<p class="notif-content__ios-note">
        <strong>Note for iPhone &amp; iPad:</strong> Apple does not currently allow
        web apps to send notifications when the app is closed or in the background.
        Notifications from this app will only appear while it is open in your browser.
        For background monitoring alerts, add this page to your Home Screen and keep
        the browser open.
       </p>`
    : '';

  return `
<div class="notif-content">
  <div class="notif-content__icon" aria-hidden="true">🔔</div>
  <h2 id="notif-heading" class="notif-content__title">Enable Notifications</h2>
  <p class="notif-content__desc">${escapeHtml(explainText)}</p>
  ${iosNote}
  <div id="notif-enable-area" class="notif-content__actions">
    <button id="notif-enable-btn" class="action-btn notif-content__enable-btn">
      Enable Notifications
    </button>
    <button id="notif-skip-btn" class="text-btn notif-content__skip-btn">
      Skip for now
    </button>
  </div>
  <div id="notif-denied-area" class="notif-content__denied hidden">
    <p class="notif-content__denied-msg">
      Notifications are blocked.
    </p>
    <p class="notif-content__denied-hint">
      You will not receive alerts when the app is in the background or your
      screen is off. To enable notifications later, allow them for this site
      in your browser settings.
    </p>
    <button id="notif-continue-btn" class="action-btn">
      Continue without notifications
    </button>
  </div>
</div>
`;
}

/**
 * Wire up button click handlers for the notification screen.
 * @param {HTMLElement} inner
 * @param {HTMLElement} screenEl
 * @param {Function} resolve
 */
function _wireButtons(inner, screenEl, resolve) {
  const enableBtn  = inner.querySelector('#notif-enable-btn');
  const skipBtn    = inner.querySelector('#notif-skip-btn');
  const continueBtn = inner.querySelector('#notif-continue-btn');
  const enableArea = inner.querySelector('#notif-enable-area');
  const deniedArea = inner.querySelector('#notif-denied-area');

  // "Enable Notifications" → trigger the browser permission prompt
  enableBtn?.addEventListener('click', async () => {
    if (enableBtn) enableBtn.disabled = true;

    const result = await Notification.requestPermission();
    lsSet(SETTING_KEYS.NOTIF_PROMPTED, true);
    lsSet(SETTING_KEYS.NOTIF_GRANTED, result === 'granted');

    if (result === 'granted') {
      // Permission granted — close the screen and continue
      _closeScreen(screenEl, resolve);
    } else {
      // Permission denied or dismissed — show the explanation of consequences
      if (enableArea) enableArea.classList.add('hidden');
      if (deniedArea) deniedArea.classList.remove('hidden');
    }
  }, { once: true });

  // "Skip for now" → record as prompted (not granted) and continue
  skipBtn?.addEventListener('click', () => {
    lsSet(SETTING_KEYS.NOTIF_PROMPTED, true);
    lsSet(SETTING_KEYS.NOTIF_GRANTED, false);
    _closeScreen(screenEl, resolve);
  }, { once: true });

  // "Continue without notifications" → close after showing denied state
  continueBtn?.addEventListener('click', () => {
    _closeScreen(screenEl, resolve);
  }, { once: true });
}

/**
 * Hide the notification screen and resolve the pending promise.
 * @param {HTMLElement} screenEl
 * @param {Function} resolve
 */
function _closeScreen(screenEl, resolve) {
  screenEl.classList.add('hidden');
  resolve();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

