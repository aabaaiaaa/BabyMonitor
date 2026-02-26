/**
 * Shared test helpers for the WebRTC Baby Monitor E2E tests.
 *
 * The core helper (`createDevicePair`) launches two isolated browser
 * contexts within the same test — one representing the baby device and one
 * representing the parent device.  Each context has its own localStorage so
 * the app treats them as completely separate devices, mirroring real usage
 * where each device is a different browser.
 *
 * Usage
 * -----
 *   const { test } = require('@playwright/test');
 *   const { createDevicePair } = require('./helpers');
 *
 *   test('baby and parent can pair', async ({ browser }) => {
 *     const { baby, parent, cleanup } = await createDevicePair(browser);
 *     try {
 *       await baby.page.goto('/baby.html');
 *       await parent.page.goto('/parent.html');
 *       // ... assertions ...
 *     } finally {
 *       await cleanup();
 *     }
 *   });
 */

'use strict';

const { mockPeerJsSignaling } = require('./peerjs-mock');

/**
 * Fake media launch args applied to every context so getUserMedia succeeds
 * without real hardware.  These mirror the args in playwright.config.js and
 * are repeated here for contexts created with `browser.newContext()`, which
 * does not inherit project-level launchOptions.
 */
const FAKE_MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

/**
 * Options applied to every browser context to keep each device isolated.
 *
 * - `storageState` is explicitly empty so there is no shared localStorage,
 *   sessionStorage, or cookies between baby and parent contexts.
 * - Permissions for camera and microphone are granted automatically so tests
 *   do not block on permission prompts.
 */
const ISOLATED_CONTEXT_OPTIONS = {
  permissions: ['camera', 'microphone'],
  storageState: {
    cookies: [],
    origins: [],
  },
};

/**
 * Create a pair of browser contexts representing a baby device and a parent
 * device.
 *
 * @param {import('@playwright/test').Browser} browser
 *   The Playwright Browser instance (passed in from the test fixture).
 * @param {object} [options]
 * @param {string} [options.babyURL]
 *   URL to navigate the baby page to immediately.  Defaults to '/baby.html'.
 * @param {string} [options.parentURL]
 *   URL to navigate the parent page to immediately.  Defaults to '/parent.html'.
 * @param {boolean} [options.navigate=true]
 *   When true (default) both pages are navigated to their respective URLs
 *   before the function returns.
 *
 * @returns {Promise<{
 *   baby: { context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page },
 *   parent: { context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page },
 *   cleanup: () => Promise<void>
 * }>}
 */
async function createDevicePair(browser, options = {}) {
  const {
    babyURL = '/baby.html',
    parentURL = '/parent.html',
    navigate = true,
  } = options;

  // Create two fully isolated browser contexts — each has its own
  // localStorage, sessionStorage, IndexedDB, and cookie jar.
  const babyContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
  const parentContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);

  const babyPage = await babyContext.newPage();
  const parentPage = await parentContext.newPage();

  if (navigate) {
    // Navigate in parallel to save test setup time.
    await Promise.all([
      babyPage.goto(babyURL),
      parentPage.goto(parentURL),
    ]);
  }

  /**
   * Close both contexts and their pages.  Call this in a finally block to
   * ensure cleanup even when a test assertion fails.
   */
  async function cleanup() {
    await Promise.all([
      babyContext.close(),
      parentContext.close(),
    ]);
  }

  return {
    baby: { context: babyContext, page: babyPage },
    parent: { context: parentContext, page: parentPage },
    cleanup,
  };
}

/**
 * Wait for a WebRTC peer connection to reach 'connected' state on a given
 * page.  Polls the page's JS environment for a global `window.__peerState`
 * property that the app is expected to expose.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<void>}
 */
async function waitForPeerConnected(page, timeoutMs = 15_000) {
  await page.waitForFunction(
    () => window.__peerState === 'connected',
    { timeout: timeoutMs },
  );
}

/**
 * Read a key from localStorage on the given page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function getLocalStorage(page, key) {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

/**
 * Set a key in localStorage on the given page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
async function setLocalStorage(page, key, value) {
  await page.evaluate(
    ([k, v]) => localStorage.setItem(k, v),
    [key, value],
  );
}

/**
 * Pre-set the notification-prompted flag so the parent's permission screen is
 * skipped in tests.  Must be called after goto() but before clicking the overlay.
 *
 * @param {import('@playwright/test').Page} page
 */
async function skipNotifications(page) {
  await page.evaluate(() => {
    localStorage.setItem('bm:notifprompted', JSON.stringify(true));
  });
}

/**
 * Dismiss the tap-to-begin overlay.
 *
 * Skips the click if the overlay is already hidden (e.g. the parent page has
 * already been initialised in a previous pairing step).
 *
 * @param {import('@playwright/test').Page} page
 */
async function tapToBegin(page) {
  const overlay = page.locator('#tap-overlay');
  if (await overlay.isVisible()) {
    await overlay.click();
  }
}

/**
 * Drive the baby page through tap-to-begin and Quick Pair (PeerJS) selection,
 * then wait for the peer ID to appear.  Returns the peer ID string.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [peerJsTimeoutMs=15000]
 * @param {object} [opts]
 * @param {boolean} [opts.skipMock=false]  Set true when mockPeerJsSignaling was
 *   already called on the page BEFORE page.goto() (required for routeWebSocket
 *   to intercept the PeerJS WebSocket connection).
 * @returns {Promise<string>}
 */
async function setupBabyPeerJs(page, peerJsTimeoutMs = 15_000, { skipMock = false } = {}) {
  // Set up the PeerJS signaling mock BEFORE clicking "Quick Pair (PeerJS)" so
  // the WebSocket route intercept is in place when PeerJS initialises.
  // NOTE: routeWebSocket only works when registered BEFORE page.goto().  If the
  // caller already called mockPeerJsSignaling before goto(), pass skipMock:true.
  if (!skipMock) await mockPeerJsSignaling(page);
  await tapToBegin(page);
  await page.waitForSelector('#pairing-section:not(.hidden)', { timeout: 5_000 });
  await page.click('#method-peerjs');
  await page.waitForFunction(
    () => {
      const el = document.getElementById('peerjs-peer-id');
      return el != null && el.textContent.trim().length > 0;
    },
    { timeout: peerJsTimeoutMs },
  );
  return page.evaluate(
    () => document.getElementById('peerjs-peer-id')?.textContent?.trim() ?? '',
  );
}

/**
 * Drive the parent page through tap-to-begin and Quick Pair (PeerJS) selection,
 * injecting the baby's peer ID as the QR-scan result so no camera is required.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} babyPeerId
 * @param {object} [opts]
 * @param {boolean} [opts.skipMock=false]  Set true when mockPeerJsSignaling was
 *   already called on the page BEFORE page.goto().
 */
async function setupParentPeerJs(page, babyPeerId, { skipMock = false } = {}) {
  // Set up the PeerJS signaling mock BEFORE clicking "Quick Pair (PeerJS)" so
  // the WebSocket route intercept is in place when PeerJS initialises.
  if (!skipMock) await mockPeerJsSignaling(page);
  await skipNotifications(page);
  await tapToBegin(page);
  await page.waitForSelector('#pairing-section:not(.hidden)', { timeout: 5_000 });
  await page.evaluate((id) => { window.__TEST_SCAN_RESULT = id; }, babyPeerId);
  await page.click('#method-peerjs');
}

/**
 * Wait until both baby and parent pages report __peerState === 'connected'.
 *
 * @param {import('@playwright/test').Page} babyPage
 * @param {import('@playwright/test').Page} parentPage
 * @param {number} [timeoutMs=20000]
 */
async function waitForBothConnected(babyPage, parentPage, timeoutMs = 20_000) {
  await Promise.all([
    babyPage.waitForFunction(
      () => window.__peerState === 'connected',
      { timeout: timeoutMs },
    ),
    parentPage.waitForFunction(
      () => window.__peerState === 'connected',
      { timeout: timeoutMs },
    ),
  ]);
}

module.exports = {
  FAKE_MEDIA_ARGS,
  ISOLATED_CONTEXT_OPTIONS,
  createDevicePair,
  waitForPeerConnected,
  getLocalStorage,
  setLocalStorage,
  skipNotifications,
  tapToBegin,
  setupBabyPeerJs,
  setupParentPeerJs,
  waitForBothConnected,
  mockPeerJsSignaling,
};
