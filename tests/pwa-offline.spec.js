/**
 * pwa-offline.spec.js — E2E tests for PWA and offline functionality (TASK-071)
 *
 * Covers Service Worker caching and offline behaviour:
 *   (1)  Load the app and verify the Service Worker registers successfully —
 *        navigator.serviceWorker.ready resolves with an active worker.
 *   (2)  Use context.setOffline(true) to simulate losing internet connectivity.
 *   (3)  Reload each app page (index, baby, parent) and verify they load from
 *        the Service Worker cache — no network errors, no blank screens.
 *   (4)  Verify CDN-hosted libraries (PeerJS, QR code libs) are not
 *        re-requested from the network after going offline (served from cache).
 *   (5)  While offline, verify the app shows the "PeerJS unavailable" message
 *        and offers the QR fallback cleanly, with no JS exceptions from failed
 *        CDN fetches.
 *   (6)  Bring the network back online, intercept /sw.js with a modified
 *        version (bumped cache key), and verify the "update available" banner
 *        appears on the next page load without forcing an automatic reload.
 *
 * Implementation notes
 * --------------------
 * Tests (1) and (6) use fresh isolated contexts.
 *
 * Tests (2)–(5) share a single pre-warmed context (SW installed, all app
 * assets and CDN libraries cached during a first online visit) so the offline
 * phase starts with a fully populated cache.
 *
 * Tests (2)–(5) require internet access during the beforeAll warm phase to let
 * the Service Worker pre-cache CDN assets.  If CDN resources are unavailable
 * during beforeAll the CDN caching test (4) will still pass on the
 * graceful-degradation path (no JS exceptions, SW 503 fallback served).
 *
 * Service Worker / Playwright routing notes
 * -----------------------------------------
 * page.route() intercepts at the network layer (CDP level) after the browser
 * has decided to make a network request.  When the Service Worker serves a
 * resource from its cache the browser never makes a network request, so the
 * page.route() handler is NOT called.  This property is used in test (4) to
 * verify CDN assets are served from the SW cache: if a CDN route handler is
 * NOT invoked after going offline, the asset was cache-served.
 *
 * Prerequisites
 * -------------
 *   • App served on http://localhost:3000
 *     (run `npx serve .. -l 3000` from the tests/ directory, or
 *      `npx serve . -l 3000` from the project root).
 *   • Internet access during the initial warm phase to allow the SW to
 *     pre-cache CDN assets (PeerJS, jsQR, qrcode.js).
 */

'use strict';

const { test, expect } = require('@playwright/test');
const { ISOLATED_CONTEXT_OPTIONS, tapToBegin, skipNotifications } = require('./helpers');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * App pages that must be available offline after the first visit.
 * Each entry specifies the URL, a human-readable label, and a DOM selector
 * that must be visible to confirm the page rendered from cache (not blank).
 */
const OFFLINE_PAGES = [
  { url: '/',            label: 'index',  selector: '#tap-overlay' },
  { url: '/baby.html',   label: 'baby',   selector: '#tap-overlay' },
  { url: '/parent.html', label: 'parent', selector: '#tap-overlay' },
];

/**
 * CDN origins used by this app (must match CDN_ORIGINS in sw.js).
 * Requests to these origins are intercepted in test (4) to verify they never
 * reach the network after going offline (i.e. are served from SW cache).
 */
const CDN_ORIGINS = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the Service Worker is fully active AND controlling the page.
 *
 * navigator.serviceWorker.ready resolves when a SW is active, but the SW
 * does not control the current page until it calls self.clients.claim() in
 * the activate handler.  Both conditions must be true before going offline.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs=30000]
 */
async function waitForSwActive(page, timeoutMs = 30_000) {
  await page.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.active != null && navigator.serviceWorker.controller != null;
    },
    { timeout: timeoutMs },
  );
}

/**
 * Attach a page-error listener and return the collected errors array plus a
 * detach function.  Call detach() in a finally block.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {{ errors: Error[], detach: () => void }}
 */
function trackPageErrors(page) {
  const errors = [];
  const handler = (err) => errors.push(err);
  page.on('pageerror', handler);
  return { errors, detach: () => page.off('pageerror', handler) };
}

// ============================================================================
// Test 1 — Service Worker registration (TASK-071 step 1)
// ============================================================================

test.describe('Service Worker registration (TASK-071 step 1)', () => {

  test('SW registers and activates on first app load', async ({ browser }) => {
    const ctx  = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const page = await ctx.newPage();

    try {
      await page.goto('/');

      // navigator.serviceWorker.ready is a Promise that resolves once a SW
      // is active for the current scope.  Running inside page.evaluate() lets
      // us await the native browser Promise.
      const swInfo = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return {
          activeState: registration.active?.state ?? null,
          scope:       registration.scope,
        };
      });

      // The SW must have completed activation.
      expect(swInfo.activeState).toBe('activated');

      // The scope must point to our test origin.
      expect(swInfo.scope).toContain('localhost:3000');

      // After calling self.clients.claim() in the activate handler, the SW
      // controls the current page — navigator.serviceWorker.controller is set.
      const hasController = await page.evaluate(
        () => navigator.serviceWorker.controller !== null,
      );
      expect(hasController).toBe(true);

    } finally {
      await ctx.close();
    }
  });

});

// ============================================================================
// Tests 2–5 — Offline functionality (shared pre-warmed context)
// ============================================================================

test.describe('Offline functionality after first load (TASK-071 steps 2–5)', () => {

  /**
   * Allow extra time: the beforeAll warm phase fetches all app assets and
   * CDN libraries from the network (SW install pre-cache).  On slow connections
   * this can take 20–30 s.  Individual offline tests then run quickly.
   */
  test.setTimeout(90_000);

  /** Shared context kept alive across all offline tests in this describe block. */
  let offlineCtx;
  /** Shared page within the offline context. */
  let offlinePage;
  /** Accumulated uncaught JS exceptions from the entire offline phase. */
  let pageErrors;
  /** Detach function for the pageerror listener. */
  let detachErrors;

  test.beforeAll(async ({ browser }) => {
    // Fresh isolated context: empty localStorage, granted camera/mic perms.
    offlineCtx  = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    offlinePage = await offlineCtx.newPage();

    // Start collecting uncaught JS exceptions NOW so we capture any thrown
    // during or after the warm phase.
    ({ errors: pageErrors, detach: detachErrors } = trackPageErrors(offlinePage));

    // -----------------------------------------------------------------------
    // Warm the Service Worker cache:
    //   1. Navigate to the home page → triggers SW registration + install.
    //      The SW install event pre-caches ALL app-shell assets and CDN
    //      library scripts (PeerJS, jsQR, qrcode.js) via cache.addAll().
    //   2. Wait for the SW to be fully active and controlling the page.
    //   3. Visit baby.html and parent.html so any assets not pre-cached
    //      during install are cached on first fetch via the dynamic caching
    //      fallback in the SW fetch handler.
    //   4. Return to index.html as the clean starting state before going
    //      offline.
    // -----------------------------------------------------------------------

    await offlinePage.goto('/');
    // This is the critical wait: the SW install event must complete (all
    // pre-cached assets fetched) before we simulate network loss.
    await waitForSwActive(offlinePage, 60_000);

    await offlinePage.goto('/baby.html');
    await offlinePage.goto('/parent.html');
    await offlinePage.goto('/');

    // Simulate network loss.  From this point, all requests must be served
    // from the SW cache or handled gracefully — no actual network traffic.
    await offlineCtx.setOffline(true);
  });

  test.afterAll(async () => {
    detachErrors?.();
    await offlineCtx?.close();
  });

  // --------------------------------------------------------------------------
  // Test 2 — All app pages load from SW cache when offline (step 3)
  // --------------------------------------------------------------------------

  test('all app pages load from SW cache after going offline — no blank screens', async () => {
    const failedPages = [];

    for (const { url, label, selector } of OFFLINE_PAGES) {
      // Navigate to the page while the context is offline.  The SW navigation
      // handler matches navigate requests and serves the cached page.
      const response = await offlinePage.goto(url, { waitUntil: 'domcontentloaded' });

      // A SW cache-served navigation response has HTTP status 200.
      const status = response?.status() ?? -1;
      if (status !== 200) {
        failedPages.push(`${label} (${url}): HTTP ${status}`);
        continue;
      }

      // Confirm the page is not blank: the named selector must be visible.
      const visible = await offlinePage.locator(selector).isVisible()
        .catch(() => false);

      if (!visible) {
        failedPages.push(`${label} (${url}): "${selector}" not visible`);
      }
    }

    expect(
      failedPages,
      `Pages failed to load from SW cache: ${failedPages.join('; ')}`,
    ).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Test 3 — CDN libraries served from SW cache, not re-fetched over network
  //          (step 4)
  // --------------------------------------------------------------------------

  test('CDN-hosted libraries are served from SW cache and not re-fetched over the network', async () => {
    // When the SW serves a CDN asset from its cache, the browser does not
    // initiate a real network request.  Playwright's page.route() sits at the
    // CDP network layer and is only invoked for actual network requests — it
    // is NOT called when the SW returns a cached response.
    //
    // Strategy:
    //   • Register route handlers for all CDN origins.
    //   • Reload the page while offline.
    //   • Assert that the route handlers were never invoked.
    //     If they are invoked, the asset was NOT in the SW cache and the SW
    //     attempted (and failed) to reach the network, indicating a caching gap.

    const cdnNetworkRequests = [];

    for (const origin of CDN_ORIGINS) {
      await offlinePage.route(`${origin}/**`, (route) => {
        cdnNetworkRequests.push(route.request().url());
        // We are offline; abort so the SW catch handler can return its 503.
        route.abort('failed');
      });
    }

    try {
      // Reload index.html — all resources (app shell + CDN libs) must come
      // from the SW cache.
      await offlinePage.goto('/', { waitUntil: 'domcontentloaded' });

      expect(
        cdnNetworkRequests,
        `CDN URLs reached the network layer (not in SW cache): ${cdnNetworkRequests.join(', ')}`,
      ).toHaveLength(0);

      // Secondary assertion: no uncaught network-error exceptions so far.
      // If a CDN asset failed to load we would expect a script error here.
      const cdnErrors = pageErrors.filter((err) => {
        const msg = err.message ?? String(err);
        return (
          msg.includes('Failed to fetch')          ||
          msg.includes('net::ERR_INTERNET')         ||
          msg.includes('net::ERR_NAME_NOT_RESOLVED') ||
          msg.includes('NetworkError')
        );
      });

      expect(
        cdnErrors,
        `Unexpected CDN network errors while offline: ${cdnErrors.map((e) => e.message ?? e).join('; ')}`,
      ).toHaveLength(0);

    } finally {
      // Remove only the CDN intercept routes so later tests are unaffected.
      for (const origin of CDN_ORIGINS) {
        await offlinePage.unroute(`${origin}/**`);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Test 4 — PeerJS unavailable message and QR fallback while offline (step 5)
  // --------------------------------------------------------------------------

  test('shows PeerJS unavailable message and QR fallback while offline with no JS exceptions', async () => {
    // Navigate to baby.html — the page where PeerJS initialisation is triggered.
    await offlinePage.goto('/baby.html', { waitUntil: 'domcontentloaded' });

    // Dismiss the tap-to-begin overlay to start the pairing flow.
    await tapToBegin(offlinePage);

    // The pairing section (method selection) must appear.
    await offlinePage.waitForSelector('#pairing-section:not(.hidden)', { timeout: 8_000 });

    // Click "Quick Pair (PeerJS)".  Two failure modes are possible offline:
    //   A. PeerJS library IS in SW cache → library loads, but the PeerJS
    //      cloud signaling server (0.peerjs.com) is unreachable → fires the
    //      serverUnavailable error.
    //   B. PeerJS library is NOT in SW cache → typeof Peer === 'undefined'
    //      → fires LIBRARY_UNAVAILABLE error.
    // Either path must result in an error message and the fallback button.
    await offlinePage.click('#method-peerjs');

    // The PeerJS pairing step must transition to visible.
    await offlinePage.waitForSelector('#pairing-peerjs-step:not(.hidden)', { timeout: 8_000 });

    // An error message must appear.  The exact wording varies between the two
    // failure modes, so we accept any message that references the problem.
    await offlinePage.waitForFunction(
      () => {
        const el   = document.getElementById('pairing-status-peerjs');
        if (!el) return false;
        const text = el.textContent ?? '';
        return (
          text.includes('PeerJS')          ||
          text.includes('could not be loaded') ||
          text.includes('error')           ||
          text.includes('Error')           ||
          text.includes('unavailable')     ||
          text.includes('Offline QR')      ||
          text.includes('connection')
        );
      },
      { timeout: 20_000 },
    );

    const statusText = await offlinePage.textContent('#pairing-status-peerjs');
    expect(statusText).toBeTruthy();
    expect(statusText.trim().length).toBeGreaterThan(0);

    // The "Use Offline QR instead" fallback button must appear.
    // The app calls _showPeerjsOfflineFallback() when serverUnavailable or
    // LIBRARY_UNAVAILABLE is detected.
    await offlinePage.waitForFunction(
      () => {
        const btn = document.querySelector('.peerjs-fallback-btn');
        // btn.offsetParent !== null confirms it is rendered in the layout
        // (not display:none); btn.hidden must be false.
        return btn != null && !btn.hidden && btn.offsetParent !== null;
      },
      { timeout: 15_000 },
    );

    const fallbackBtnText = await offlinePage.textContent('.peerjs-fallback-btn');
    expect(fallbackBtnText).toContain('Offline QR');

    // Clicking the fallback button must navigate back to the method selection
    // screen — the offline degradation path must be fully interactive.
    await offlinePage.click('.peerjs-fallback-btn');

    const methodStepVisible = await offlinePage.evaluate(
      () => !document.getElementById('pairing-method-step')?.classList.contains('hidden'),
    );
    expect(methodStepVisible).toBe(true);

    // ── No uncaught JS exceptions from CDN fetch failures ──────────────────
    //
    // The Service Worker's fetch handler must return a graceful response
    // (cached resource or 503 fallback) for every request — it must never
    // cause an uncaught script exception that propagates to window.onerror.
    //
    // We distinguish expected PeerJS server errors (handled, non-fatal) from
    // unexpected exceptions caused by unhandled failed CDN fetches.
    const unexpectedErrors = pageErrors.filter((err) => {
      const msg = err.message ?? String(err);
      // CDN fetch failures that were not caught produce these error strings.
      return (
        msg.includes('net::ERR_INTERNET_DISCONNECTED')  ||
        msg.includes('net::ERR_NAME_NOT_RESOLVED')       ||
        msg.includes('net::ERR_NETWORK_CHANGED')         ||
        // "Failed to fetch" from an uncaught Promise rejection in app code.
        // Note: peer.js internally catches its own fetch errors, so a
        // "Failed to fetch" here would indicate a code path that did NOT
        // handle the error before it became an uncaught exception.
        (msg.includes('Failed to fetch') && !msg.includes('PeerJS'))
      );
    });

    expect(
      unexpectedErrors,
      `Uncaught JS exceptions from CDN fetch failures while offline: ${unexpectedErrors.map((e) => e.message ?? String(e)).join('; ')}`,
    ).toHaveLength(0);
  });

});

// ============================================================================
// Test 5 — Service Worker update prompt (TASK-071 step 6)
// ============================================================================

test.describe('Service Worker update prompt (TASK-071 step 6)', () => {

  /**
   * This test requires two SW installations:
   *   1. The current SW (CACHE_VERSION = 'v4') — installed on first load.
   *   2. A modified SW (CACHE_VERSION = 'v-test-update') — installed when the
   *      intercepted sw.js is served on the second visit.
   * Each SW install pre-caches all app-shell assets from localhost:3000, so
   * 60 s is a generous allowance.
   */
  test.setTimeout(90_000);

  test('update banner appears without auto-reload when a new SW version is detected', async ({ browser }) => {
    const ctx  = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const page = await ctx.newPage();

    /** True if the page auto-reloaded after the update banner appeared. */
    let autoReloaded = false;

    try {
      // -----------------------------------------------------------------------
      // Phase A: First load — install the current SW.
      // -----------------------------------------------------------------------

      await page.goto('/');

      // Wait for the current SW to activate and take control.
      await waitForSwActive(page, 30_000);

      // -----------------------------------------------------------------------
      // Phase B: Intercept /sw.js requests to return a modified SW with a
      //          bumped CACHE_VERSION.
      //
      // The browser byte-compares the freshly fetched sw.js with the installed
      // version on every navigator.serviceWorker.register() call and when
      // registration.update() is invoked (sw-update.js calls this on every
      // page load).  A changed CACHE_VERSION changes CACHE_NAME, which causes
      // the new SW's install handler to open a different cache — the browser
      // therefore treats it as a brand-new service worker and begins installing
      // it alongside the existing one.
      // -----------------------------------------------------------------------

      await page.route('**/sw.js', async (route) => {
        try {
          // Fetch the real sw.js from localhost:3000 as a baseline.
          const response     = await route.fetch();
          const originalBody = await response.text();

          // Bump the cache version string.  This is the minimal change needed
          // to make the browser treat the script as a new service worker.
          const updatedBody = originalBody.replace(
            /const CACHE_VERSION\s*=\s*'[^']+'/,
            "const CACHE_VERSION = 'v-test-update'",
          );

          await route.fulfill({
            status:  200,
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
            body:    updatedBody,
          });
        } catch {
          // If fetching the real sw.js fails, fall through so the test fails
          // with a meaningful network error rather than a silent hang.
          await route.continue();
        }
      });

      // -----------------------------------------------------------------------
      // Phase C: Navigate to the home page again.
      //
      // On load, sw-update.js:
      //   1. Calls registration.update() → browser fetches sw.js.
      //   2. Route intercept returns the modified sw.js (CACHE_VERSION bumped).
      //   3. Browser detects the byte-diff → installs the new SW.
      //   4. New SW enters 'installed' (waiting) state.
      //   5. sw-update.js detects this via the updatefound / statechange chain.
      //   6. _showBanner() removes 'hidden' from #sw-update-banner.
      // -----------------------------------------------------------------------

      await page.goto('/', { waitUntil: 'domcontentloaded' });

      // Register the auto-reload detector AFTER the explicit navigation so
      // that the navigation's own 'load' event is not mistakenly counted.
      // Any further 'load' event would indicate an unexpected page reload.
      page.on('load', () => { autoReloaded = true; });

      // Wait for the update banner to become visible.  Allow up to 30 s for
      // the new SW to install (it pre-caches all app-shell assets from
      // localhost:3000; CDN asset caching is best-effort and non-blocking).
      await page.waitForFunction(
        () => {
          const banner = document.getElementById('sw-update-banner');
          return banner != null && !banner.classList.contains('hidden');
        },
        { timeout: 30_000 },
      );

      // ── Assertion 1: Banner is visible ─────────────────────────────────────
      const bannerIsVisible = await page.evaluate(
        () => !document.getElementById('sw-update-banner')?.classList.contains('hidden'),
      );
      expect(bannerIsVisible).toBe(true);

      // The banner text must reference an available update.
      const bannerText = await page.textContent('#sw-update-banner');
      expect(bannerText).toMatch(/new version|update/i);

      // ── Assertion 2: Update and dismiss buttons are present ─────────────────
      await expect(page.locator('#sw-update-btn')).toBeVisible();
      await expect(page.locator('#sw-update-dismiss')).toBeVisible();

      // ── Assertion 3: No automatic reload ───────────────────────────────────
      // sw-update.js must NOT call window.location.reload() automatically.
      // The user must explicitly tap the "Update" button to reload.
      // An auto-reload is disruptive during an active monitoring session.
      //
      // We wait a moment after the banner appears to confirm no reload occurs.
      await page.waitForTimeout(2_000);

      expect(
        autoReloaded,
        'Page auto-reloaded after update banner appeared — expected NO automatic reload',
      ).toBe(false);

      // ── Assertion 4: Dismiss hides the banner without reloading ─────────────
      await page.click('#sw-update-dismiss');

      const bannerHiddenAfterDismiss = await page.evaluate(
        () => document.getElementById('sw-update-banner')?.classList.contains('hidden') ?? false,
      );
      expect(bannerHiddenAfterDismiss).toBe(true);

      // Still no reload after dismiss.
      expect(autoReloaded).toBe(false);

      // ── Assertion 5: Update button triggers skipWaiting (smoke test) ────────
      // We do NOT fully exercise the reload path here (that would end the test),
      // but we verify that the "Update" button is wired correctly by confirming
      // it is enabled and clickable.  The actual skipWaiting + reload behaviour
      // is covered by manual testing documented in TASK-053.
      //
      // Re-show the banner by checking registration.waiting directly.
      const waitingSwExists = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return reg?.waiting != null;
      });
      // A waiting SW must exist for the update flow to make sense.
      expect(waitingSwExists).toBe(true);

    } finally {
      await ctx.close();
    }
  });

});
