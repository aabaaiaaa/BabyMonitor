/**
 * peerjs-pairing.spec.js — E2E tests for the PeerJS pairing flow (TASK-063)
 *
 * These tests drive both a baby device context and a parent device context
 * through the Quick Pair (PeerJS) connection method.  The key technique is
 * setting `window.__TEST_SCAN_RESULT` on the parent page before clicking
 * "Quick Pair"; this causes qr.js's `scanSingle()` to return the value
 * immediately instead of opening the camera, letting the test provide the
 * baby's peer ID without any real QR-scanning hardware.
 *
 * App hooks used (added in TASK-063):
 *   window.__TEST_SCAN_RESULT  — pre-loaded scan result consumed by scanSingle()
 *   window.__peerState         — current connection state string (baby & parent)
 *   window.__testMonitorConn   — last Connection object added to parent monitors
 *   window.__lastStateSnapshot — last STATE_SNAPSHOT value received by parent
 *   window.__lastBabyMessage   — last data-channel message received by baby
 *
 * Prerequisites:
 *   • The app must be served on http://localhost:3000 (run `npx serve .. -l 3000`
 *     from the tests/ directory before running the suite).
 *   • Internet access is required for the PeerJS cloud signaling server
 *     (0.peerjs.com).  Tests that require a live PeerJS connection are skipped
 *     in environments where the server is unreachable.
 */

'use strict';

const { test, expect } = require('@playwright/test');
const { createDevicePair } = require('./helpers');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Pre-set the notification-prompted flag so the parent's notification
 * permission screen is skipped in tests.  Must be called after goto() but
 * before clicking the tap-overlay.
 *
 * @param {import('@playwright/test').Page} page
 */
async function skipNotifications(page) {
  await page.evaluate(() => {
    // lsGet/lsSet use the "bm:" prefix and JSON-encode values.
    localStorage.setItem('bm:notifprompted', JSON.stringify(true));
  });
}

/**
 * Dismiss the tap-to-begin overlay.
 *
 * @param {import('@playwright/test').Page} page
 */
async function tapToBegin(page) {
  await page.click('#tap-overlay');
}

/**
 * Navigate the baby page through the tap-to-begin gesture and
 * "Quick Pair (PeerJS)" method selection, then wait for the PeerJS
 * peer ID to appear.  Returns the peer ID string.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [peerJsTimeoutMs=15000]
 * @returns {Promise<string>} the baby's PeerJS peer ID
 */
async function setupBabyPeerJs(page, peerJsTimeoutMs = 15_000) {
  await tapToBegin(page);

  // Wait for the pairing section to become visible (init() → showPairing())
  await page.waitForSelector('#pairing-section:not(.hidden)', { timeout: 5_000 });

  // Choose Quick Pair (PeerJS)
  await page.click('#method-peerjs');

  // Wait for the peer ID text element to be populated — this means PeerJS has
  // successfully registered this device with the signaling server.
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
 * Navigate the parent page through the tap-to-begin gesture and
 * "Quick Pair (PeerJS)" method selection, injecting the baby's peer ID as
 * the QR-scan result so no camera is required.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} babyPeerId
 */
async function setupParentPeerJs(page, babyPeerId) {
  await skipNotifications(page);
  await tapToBegin(page);

  // Wait for the pairing section (init() → showDashboard() → showPairing())
  await page.waitForSelector('#pairing-section:not(.hidden)', { timeout: 5_000 });

  // Pre-load the scan result before clicking "Quick Pair" so that scanSingle()
  // resolves immediately with the baby's peer ID (test hook in qr.js).
  await page.evaluate((id) => { window.__TEST_SCAN_RESULT = id; }, babyPeerId);

  // Choose Quick Pair (PeerJS)
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('PeerJS pairing flow', () => {

  // -------------------------------------------------------------------------
  // Test 1: Baby peer ID and QR code are displayed after tap-to-begin
  // -------------------------------------------------------------------------

  test('baby shows readable peer ID text and a QR code after tap-to-begin', async ({ browser }) => {
    const { baby, cleanup } = await createDevicePair(browser, {
      navigate: false,
      parentURL: '/parent.html', // not used but required by createDevicePair
    });

    try {
      await baby.page.goto('/baby.html');

      const peerId = await setupBabyPeerJs(baby.page);

      // 1a. Peer ID must be a UUID (36 hex-and-dash characters)
      expect(peerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // 1b. QR container must have a rendered <canvas> element (qrcodejs)
      const qrHasCanvas = await baby.page.evaluate(() => {
        const container = document.getElementById('peerjs-qr-container');
        return container != null && container.querySelector('canvas') != null;
      });
      expect(qrHasCanvas).toBe(true);

      // 1c. The status text indicates the device is waiting for a parent
      const statusText = await baby.page.textContent('#pairing-status-peerjs');
      expect(statusText).toContain('Waiting');

    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Full pairing — both contexts reach "connected" state
  // -------------------------------------------------------------------------

  test('baby and parent both reach "connected" state within the connection timeout', async ({ browser }) => {
    const { baby, parent, cleanup } = await createDevicePair(browser, { navigate: false });

    try {
      // Navigate both pages in parallel
      await Promise.all([
        baby.page.goto('/baby.html'),
        parent.page.goto('/parent.html'),
      ]);

      // Baby: register with PeerJS and wait for peer ID
      const babyPeerId = await setupBabyPeerJs(baby.page);

      // Parent: register with PeerJS and inject baby's peer ID as the scan result
      await setupParentPeerJs(parent.page, babyPeerId);

      // Both sides must reach 'connected' within the overall test timeout
      await waitForBothConnected(baby.page, parent.page);

    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Data channel open — bidirectional round-trip via SET_MODE / STATE_SNAPSHOT
  // -------------------------------------------------------------------------

  test('data channel is open: SET_MODE command reaches baby and STATE_SNAPSHOT returns to parent', async ({ browser }) => {
    const { baby, parent, cleanup } = await createDevicePair(browser, { navigate: false });

    try {
      await Promise.all([
        baby.page.goto('/baby.html'),
        parent.page.goto('/parent.html'),
      ]);

      const babyPeerId = await setupBabyPeerJs(baby.page);
      await setupParentPeerJs(parent.page, babyPeerId);
      await waitForBothConnected(baby.page, parent.page);

      // --- Outbound: parent → baby ---
      // Use the test-exposed connection object to send SET_MODE 'stars'
      await parent.page.evaluate(() => {
        const conn = window.__testMonitorConn;
        if (conn?.dataChannel) {
          conn.dataChannel.send({ type: 'setMode', value: 'stars' });
        }
      });

      // Baby must receive the SET_MODE message
      await baby.page.waitForFunction(
        () => window.__lastBabyMessage?.type === 'setMode' &&
              window.__lastBabyMessage?.value === 'stars',
        { timeout: 8_000 },
      );

      // --- Inbound: baby → parent (STATE_SNAPSHOT response) ---
      // Baby calls sendStateSnapshot() after applying SET_MODE, so the parent
      // should receive a snapshot confirming soothingMode === 'stars'.
      await parent.page.waitForFunction(
        () => window.__lastStateSnapshot?.soothingMode === 'stars',
        { timeout: 8_000 },
      );

    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Initial STATE_SNAPSHOT is received by parent on connection
  // -------------------------------------------------------------------------

  test('parent receives initial state snapshot with soothingMode and quality on connection', async ({ browser }) => {
    const { baby, parent, cleanup } = await createDevicePair(browser, { navigate: false });

    try {
      await Promise.all([
        baby.page.goto('/baby.html'),
        parent.page.goto('/parent.html'),
      ]);

      const babyPeerId = await setupBabyPeerJs(baby.page);
      await setupParentPeerJs(parent.page, babyPeerId);

      // Baby's startMonitor() calls sendStateSnapshot() immediately after connection.
      // Wait for the parent to receive it (may arrive before or after __peerState).
      await parent.page.waitForFunction(
        () => window.__lastStateSnapshot != null,
        { timeout: 20_000 },
      );

      const snapshot = await parent.page.evaluate(() => window.__lastStateSnapshot);

      // soothingMode must be one of the valid enum values
      expect(['candle', 'water', 'stars', 'music', 'off']).toContain(snapshot.soothingMode);

      // quality must be present (default: 'medium')
      expect(snapshot).toHaveProperty('quality');
      expect(['low', 'medium', 'high']).toContain(snapshot.quality);

      // audioOnly must be a boolean
      expect(typeof snapshot.audioOnly).toBe('boolean');

      // deviceId must be a non-empty string
      expect(typeof snapshot.deviceId).toBe('string');
      expect(snapshot.deviceId.length).toBeGreaterThan(0);

    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Sad path — invalid/unknown peer ID shows error without crashing
  // -------------------------------------------------------------------------

  test('sad path: an invalid or unknown peer ID shows an error message without crashing', async ({ browser }) => {
    // Only the parent context is needed for this test
    const { parent, cleanup } = await createDevicePair(browser, { navigate: false });

    try {
      await parent.page.goto('/parent.html');

      // Use a peer ID that is syntactically invalid (PeerJS will fire an error)
      const badPeerId = 'not-a-real-peer____INVALID';

      await skipNotifications(parent.page);
      await tapToBegin(parent.page);
      await parent.page.waitForSelector('#pairing-section:not(.hidden)', { timeout: 5_000 });

      // Inject the bad peer ID as the QR scan result
      await parent.page.evaluate((id) => { window.__TEST_SCAN_RESULT = id; }, badPeerId);

      // Start PeerJS pairing
      await parent.page.click('#method-peerjs');

      // The PeerJS step should become visible
      await parent.page.waitForSelector('#pairing-peerjs-step:not(.hidden)', { timeout: 5_000 });

      // Wait for an error or failure message to appear in the status element.
      // Possible messages from the app:
      //   'Failed to reach baby device. Please try again.'  — from triggerConn.on('error')
      //   'PeerJS error: unknown-error'                     — from peer.on('error') peer-unavailable
      //   'PeerJS error: invalid-id'                        — for invalid format IDs
      //   Any message containing 'error', 'Error', 'unavailable', or 'Failed'
      await parent.page.waitForFunction(
        () => {
          const el = document.getElementById('peerjs-scan-status');
          if (!el) return false;
          const text = el.textContent ?? '';
          return (
            text.includes('Failed') ||
            text.includes('error') ||
            text.includes('Error') ||
            text.includes('unavailable') ||
            text.includes('try again') ||
            text.includes('invalid')
          );
        },
        { timeout: 15_000 },
      );

      // The pairing step must still be visible — the page must not have crashed
      // or navigated away.
      const pairingStepVisible = await parent.page.evaluate(
        () => !document.getElementById('pairing-peerjs-step')?.classList.contains('hidden'),
      );
      expect(pairingStepVisible).toBe(true);

      // The parent dashboard must NOT be visible (no phantom "connected" state)
      const dashboardHidden = await parent.page.evaluate(
        () => document.getElementById('parent-dashboard')?.classList.contains('hidden') ?? true,
      );
      expect(dashboardHidden).toBe(true);

    } finally {
      await cleanup();
    }
  });

});
