/**
 * pwa-install.js — PWA install prompt (TASK-052)
 *
 * Displays an in-app install banner after the user completes first-run
 * onboarding and establishes their first baby monitor connection.
 *
 * Behaviour:
 *   - Intercepts `beforeinstallprompt` to suppress the browser mini-infobar.
 *   - Shows the banner on the first connection (after onboarding is done).
 *   - "Install" button triggers the deferred browser install prompt.
 *   - "Not now" dismisses the banner and persists a timestamp; the banner
 *     will not reappear for at least 7 days.
 *   - If the app is already installed as a PWA, no banner is shown.
 *   - On iOS Chrome (CriOS), where `beforeinstallprompt` is never fired,
 *     a manual "Tap Share → Add to Home Screen" instruction is shown instead.
 *
 * Public API:
 *   maybeShowPwaInstallBanner(bannerEl)
 *     — Call once when the first successful connection is established.
 *       No-ops if the banner element is absent or conditions are not met.
 */

import { lsGet, lsSet, SETTING_KEYS } from './storage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum milliseconds between banner appearances after a "Not now" dismiss. */
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Install prompt capture (runs at module load time)
// ---------------------------------------------------------------------------

/**
 * The deferred install prompt event captured from `beforeinstallprompt`.
 * @type {BeforeInstallPromptEvent|null}
 */
let _installPromptEvent = null;

// Intercept the browser's native mini-infobar so we can show our own banner
// at the right moment (after the first connection, not immediately on load).
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPromptEvent = e;
});

// If the app is installed via any route, clear the stored event.
window.addEventListener('appinstalled', () => {
  _installPromptEvent = null;
});

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the app is already running as an installed PWA.
 * @returns {boolean}
 */
function _isAlreadyInstalled() {
  // Standard display-mode check (Chrome, Edge, Samsung Internet, …)
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS — set to true when launched from the home screen icon.
  if (navigator.standalone === true) return true;
  return false;
}

/**
 * Returns true if the browser is iOS Chrome (CriOS).
 * On iOS, all browsers use WebKit under the hood and `beforeinstallprompt`
 * is never fired.  iOS Safari is already blocked by the compat check
 * (TASK-045); iOS Chrome users reach this code path normally.
 * @returns {boolean}
 */
function _isIosChrome() {
  const ua = navigator.userAgent;
  return /CriOS/.test(ua) && /iP(hone|ad|od)/.test(ua);
}

/**
 * Returns true when all preconditions for showing the install banner are met.
 * @returns {boolean}
 */
function _shouldShow() {
  // Never show if already installed.
  if (_isAlreadyInstalled()) return false;

  // Only show after onboarding is complete.
  if (lsGet(SETTING_KEYS.ONBOARDING_DONE, false) !== true) return false;

  // Respect the 7-day cooldown after a "Not now" dismiss.
  const dismissedAt = lsGet(SETTING_KEYS.PWA_INSTALL_DISMISSED_AT, 0);
  if (dismissedAt && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maybe show the PWA install prompt banner.
 *
 * Call this once when the first baby monitor connection is established.
 * If all conditions are met the banner is shown; otherwise this is a no-op.
 *
 * @param {HTMLElement|null} bannerEl — the #pwa-install-banner element
 */
export function maybeShowPwaInstallBanner(bannerEl) {
  if (!bannerEl) return;
  if (!_shouldShow()) return;

  if (_isIosChrome()) {
    // iOS Chrome: `beforeinstallprompt` is never available.
    // Show manual "Tap Share → Add to Home Screen" instructions instead.
    _renderBanner(bannerEl, /* isIos= */ true);
    return;
  }

  if (_installPromptEvent) {
    // Install prompt already captured — show the banner right away.
    _renderBanner(bannerEl, /* isIos= */ false);
  } else {
    // Prompt not yet captured (rare: event usually fires before first connection).
    // Register a one-time listener so the banner appears as soon as it arrives.
    window.addEventListener('beforeinstallprompt', () => {
      if (_shouldShow()) _renderBanner(bannerEl, /* isIos= */ false);
    }, { once: true });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Populate the banner content and make it visible.
 *
 * @param {HTMLElement} bannerEl — the banner root element
 * @param {boolean}     isIos   — true → show iOS manual instructions,
 *                                false → show Install / Not now buttons
 */
function _renderBanner(bannerEl, isIos) {
  const msgEl      = bannerEl.querySelector('.pwa-install-banner__msg');
  const installBtn = bannerEl.querySelector('#pwa-install-btn');
  const notNowBtn  = bannerEl.querySelector('#pwa-install-not-now');

  if (msgEl) {
    msgEl.textContent = isIos
      ? "Tap the Share button then 'Add to Home Screen' for the best experience."
      : 'Install this app for better background performance and battery life.';
  }

  if (installBtn) {
    if (isIos) {
      // No native install prompt on iOS — hide the Install button.
      installBtn.classList.add('hidden');
    } else {
      installBtn.classList.remove('hidden');
      installBtn.addEventListener('click', async () => {
        if (!_installPromptEvent) return;
        _installPromptEvent.prompt();
        const { outcome } = await _installPromptEvent.userChoice;
        console.log('[pwa-install] Install outcome:', outcome, '(TASK-052)');
        _installPromptEvent = null;
        _hideBanner(bannerEl);
      }, { once: true });
    }
  }

  if (notNowBtn) {
    notNowBtn.addEventListener('click', () => {
      // Record dismissal timestamp — prevents re-showing for 7 days.
      lsSet(SETTING_KEYS.PWA_INSTALL_DISMISSED_AT, Date.now());
      _hideBanner(bannerEl);
    }, { once: true });
  }

  // Automatically hide if the app gets installed via any other route
  // (e.g. the bg-banner's "Install as app" button from TASK-029).
  window.addEventListener('appinstalled', () => _hideBanner(bannerEl), { once: true });

  bannerEl.classList.remove('hidden');
}

/**
 * Hide the install banner.
 * @param {HTMLElement} bannerEl
 */
function _hideBanner(bannerEl) {
  bannerEl.classList.add('hidden');
}
