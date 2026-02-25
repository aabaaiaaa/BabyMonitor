/**
 * sw-update.js — Service Worker update detection and refresh prompt (TASK-053)
 *
 * When a new version of the app is deployed, the Service Worker detects it via
 * the `updatefound` / `statechange` lifecycle. This module shows a non-blocking
 * banner at the top of the screen:
 *
 *   "A new version is available — tap to update."
 *
 * Behaviour:
 *   - Banner is shown when a new SW enters the 'installed' (waiting) state.
 *   - "Update" button calls skipWaiting() on the new SW and reloads once the
 *     new SW takes control — ensuring the freshly cached assets are served.
 *   - No auto-reload: the user must explicitly tap the update button.
 *     An unexpected reload during an active monitoring session would be
 *     disruptive, so user consent is required.
 *   - Dismissing the banner hides it for the current session only.
 *     On the next page load, if a waiting SW is still present, the banner
 *     is shown again (per the task requirement).
 *   - On first install (no existing controller) the banner is NOT shown,
 *     as the new SW activates immediately without displacing a running version.
 *
 * This module is self-initialising and requires no external imports.
 * Include it as <script type="module" src="js/sw-update.js"></script> on
 * every page that registers the Service Worker.
 *
 * Corresponding SW-side changes (sw.js):
 *   - `self.skipWaiting()` is NOT called in `install`; the SW waits for this
 *     module to send { type: 'SKIP_WAITING' } before activating.
 *   - A `message` listener in sw.js responds to that message.
 */

// No-op if Service Worker is not supported in this browser.
if (!('serviceWorker' in navigator)) {
  // Nothing to do.
} else {

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** True if the user has dismissed the banner this session. */
  let _dismissedThisSession = false;

  /**
   * The waiting ServiceWorker that will be activated when the user taps
   * "Update". Set when the banner is shown; cleared when the page reloads.
   * @type {ServiceWorker|null}
   */
  let _waitingSW = null;

  // -------------------------------------------------------------------------
  // Banner helpers
  // -------------------------------------------------------------------------

  /**
   * Make the update banner visible and bind the waiting SW.
   *
   * @param {ServiceWorker} waitingSW — the new SW in the waiting state
   */
  function _showBanner(waitingSW) {
    if (_dismissedThisSession) return;

    const bannerEl = document.getElementById('sw-update-banner');
    if (!bannerEl) return;

    _waitingSW = waitingSW;
    bannerEl.classList.remove('hidden');

    console.log('[sw-update] Update available — banner shown (TASK-053)');
  }

  /**
   * Hide the update banner.
   */
  function _hideBanner() {
    const bannerEl = document.getElementById('sw-update-banner');
    bannerEl?.classList.add('hidden');
  }

  // -------------------------------------------------------------------------
  // Button event wiring
  // -------------------------------------------------------------------------

  /**
   * Wire the "Update" and "Dismiss" buttons inside the banner element.
   * Called once at init time; the banner element must be present in the DOM.
   */
  function _wireBannerButtons() {
    const bannerEl  = document.getElementById('sw-update-banner');
    if (!bannerEl) return;

    const updateBtn  = document.getElementById('sw-update-btn');
    const dismissBtn = document.getElementById('sw-update-dismiss');

    // "Tap to update" — tell the waiting SW to skip waiting, then reload.
    updateBtn?.addEventListener('click', () => {
      if (!_waitingSW) return;

      // Once the new SW takes control of this page, reload to serve fresh assets.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        console.log('[sw-update] Controller changed — reloading (TASK-053)');
        window.location.reload();
      }, { once: true });

      // Ask the waiting SW to activate immediately.
      _waitingSW.postMessage({ type: 'SKIP_WAITING' });
    });

    // "Dismiss" — hide for this session only; banner reappears on next load.
    dismissBtn?.addEventListener('click', () => {
      _dismissedThisSession = true;
      _hideBanner();
      console.log('[sw-update] Banner dismissed for this session (TASK-053)');
    });
  }

  // -------------------------------------------------------------------------
  // Update detection
  // -------------------------------------------------------------------------

  /**
   * Initialise SW update detection.
   *
   * 1. If there is already a waiting SW (from a previous dismissed session or
   *    a background update), show the banner immediately.
   * 2. Listen for future `updatefound` events and show the banner when the
   *    new SW reaches the `installed` (waiting) state.
   * 3. Trigger an explicit `registration.update()` check so that long-lived
   *    tabs (parent monitor running all night) also detect updates promptly.
   */
  function _initUpdateDetection() {
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration) return;

      // --- Case 1: There is already a waiting SW ----------------------------
      // This happens when:
      //   (a) The user dismissed the banner last session, OR
      //   (b) A background update completed while the page was closed and this
      //       is the first new page load since then.
      if (registration.waiting) {
        _showBanner(registration.waiting);
      }

      // --- Case 2: Listen for future SW updates ----------------------------
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          // 'installed' means the new SW has pre-cached assets and is now
          // waiting to take control.  Only show the banner if there is an
          // existing controller — on a first-ever install there is no old SW
          // to displace and the new one activates automatically.
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            _showBanner(newWorker);
          }
        });
      });

      // --- Case 3: Trigger an update check on page load --------------------
      // Browsers only check for SW updates every 24 h by default (unless the
      // SW script byte-differs and is fetched fresh).  Calling update() here
      // ensures long-lived pages (e.g. an overnight parent monitor session)
      // detect new deploys promptly.
      registration.update().catch((err) => {
        // Network unavailable — update check failure is non-fatal.
        console.debug('[sw-update] update() check skipped (offline?):', err);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  // Wire the buttons first (DOM is ready because this module is placed at the
  // end of <body>), then start update detection.
  _wireBannerButtons();
  _initUpdateDetection();
}
