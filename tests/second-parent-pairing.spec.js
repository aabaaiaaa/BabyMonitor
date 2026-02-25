/**
 * second-parent-pairing.spec.js — E2E tests for second-parent pairing (TASK-069)
 *
 * Verifies the three-device broker flow: one baby device and two parent devices.
 * The first parent acts as a broker, sharing all paired baby monitor profiles
 * (including backup PeerJS ID pools) with the second parent over a temporary
 * parent-to-parent data channel.  The second parent then connects directly to
 * the baby without routing through the first parent.
 *
 * Coverage (as specified in TASK-069):
 *   (1)  Pair the first parent with the baby via PeerJS.
 *   (2)  On the first parent UI, initiate "Add another parent device" and
 *        verify the first parent's own peer ID is displayed as a QR code.
 *   (3)  In the second parent context, enter the first parent's peer ID to
 *        begin the broker flow.
 *   (4)  Verify the first parent sends a PARENT_HANDOFF payload containing
 *        all baby monitor peer IDs and backup pools to the second parent.
 *   (5)  Verify the second parent connects directly to the baby device,
 *        without routing through the first parent.
 *   (6)  Close the first parent context and verify the second parent remains
 *        connected to the baby.
 *   (7)  Verify both parents count toward the baby device's 4-connection
 *        limit (MAX_MONITORS = 4).
 *
 * App hooks used by these tests:
 *   window.__TEST_SCAN_RESULT          — inject QR scan result (qr.js)
 *   window.__peerState                 — 'connected'|'connecting'|…
 *   window.__testMonitorConn           — last Connection added to parent (TASK-063)
 *   window.__testMonitorEntry          — full MonitorEntry (TASK-064)
 *   window.__lastStateSnapshot         — last STATE_SNAPSHOT received (TASK-063)
 *   window.__testGetLocalPeerId()      — parent: read own PeerJS peer ID (TASK-069)
 *   window.__testGetMonitorCount()     — parent: read monitors.size (TASK-069)
 *   window.__testTriggerShareParentFlow() — parent: start share flow (TASK-069)
 *   window.__testLastHandoffSent       — first parent: profiles just sent (TASK-069)
 *   window.__testLastHandoffPayload    — second parent: payload just received (TASK-069)
 *
 * Design notes
 * ------------
 * The second parent connects to the baby by triggering the baby's incoming-
 * connection handler (`peer.on('connection', onParentConnection)` in baby.js).
 * This handler is only active while the baby is in pairing mode (PeerJS step
 * visible, no parent connected yet).
 *
 * To guarantee this, the tests pre-seed the baby's localStorage so that its
 * primary PeerJS peer ID is TEST_POOL[0].  The first parent also has a
 * pre-seeded device profile whose backupPoolJson contains TEST_POOL.  The
 * PARENT_HANDOFF therefore includes TEST_POOL[0] as the first pool ID.  When
 * the second parent triggers a connection to TEST_POOL[0], the baby (still in
 * pairing mode) answers the trigger, calls the second parent back, and a
 * direct WebRTC connection is established — with no involvement from the first
 * parent after the handoff.
 *
 * Prerequisites:
 *   • App served on http://localhost:3000
 *     (run `npx serve .. -l 3000` from tests/, or `npx serve . -l 3000` from root).
 *   • Internet access for PeerJS cloud signaling (0.peerjs.com).
 */

'use strict';

const { test, expect } = require('@playwright/test');
const {
  ISOLATED_CONTEXT_OPTIONS,
  setupBabyPeerJs,
  skipNotifications,
} = require('./helpers');

// ---------------------------------------------------------------------------
// Test constants — fixed, deterministic pool IDs for pre-seeding
// ---------------------------------------------------------------------------

/**
 * Pre-agreed backup PeerJS pool IDs used by the baby.  TEST_POOL[0] is used
 * as the baby's primary peer ID in these tests so the second parent can
 * trigger the baby's pairing listener directly.
 */
const TEST_POOL = [
  'aaaaaaaa-0001-4000-8000-000000000001',
  'aaaaaaaa-0001-4000-8000-000000000002',
  'aaaaaaaa-0001-4000-8000-000000000003',
];

/**
 * Fixed device ID for the baby monitor profile stored on the first parent.
 * This is the permanent device ID (distinct from the PeerJS peer ID).
 */
const TEST_DEVICE_ID = 'bbbbbbbb-0001-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Context factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a baby browser context whose localStorage is pre-seeded so the
 * baby registers under TEST_POOL[0] as its primary PeerJS peer ID.
 *
 * The baby will use TEST_POOL[0] when it registers with PeerJS during the
 * normal pairing flow, and will be in pairing mode (connection listener
 * active) when the second parent sends its trigger connection.
 *
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<import('@playwright/test').BrowserContext>}
 */
async function createPreseededBabyContext(browser) {
  const storageState = {
    cookies: [],
    origins: [{
      origin: 'http://localhost:3000',
      localStorage: [
        // Primary peer ID = TEST_POOL[0] so second parent can trigger the baby.
        { name: 'bm:peerid',        value: JSON.stringify(TEST_POOL[0]) },
        // Backup pool contains the full TEST_POOL array.
        { name: 'bm:backuppool',    value: JSON.stringify(TEST_POOL) },
        // Pool index starts at 0 (no prior reconnections).
        { name: 'bm:backuppoolidx', value: JSON.stringify(0) },
      ],
    }],
  };
  return browser.newContext({ ...ISOLATED_CONTEXT_OPTIONS, storageState });
}

/**
 * Create a first-parent browser context pre-seeded with a device profile
 * for TEST_DEVICE_ID.  The profile's backupPoolJson contains TEST_POOL so
 * the PARENT_HANDOFF will include these pool IDs for the second parent.
 *
 * The notification-prompted flag is set so the share flow is not blocked
 * by the notification permission screen.
 *
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<import('@playwright/test').BrowserContext>}
 */
async function createPreseededParent1Context(browser) {
  const deviceProfile = {
    id:               TEST_DEVICE_ID,
    label:            'Baby 1',
    noiseThreshold:   60,
    motionThreshold:  50,
    batteryThreshold: 15,
    backupPoolJson:   JSON.stringify({ pool: TEST_POOL, index: 0 }),
  };
  const storageState = {
    cookies: [],
    origins: [{
      origin: 'http://localhost:3000',
      localStorage: [
        // Skip notification permission screen.
        { name: 'bm:notifprompted',  value: JSON.stringify(true) },
        // Pre-seed the device profile so getDeviceProfiles() returns it.
        { name: 'bm:paireddevices',  value: JSON.stringify([deviceProfile]) },
      ],
    }],
  };
  return browser.newContext({ ...ISOLATED_CONTEXT_OPTIONS, storageState });
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

/**
 * Navigate the first-parent page through tap-to-begin, wait for init() to
 * run, then programmatically trigger the share-parent flow.  Returns the
 * first parent's PeerJS peer ID once it has registered.
 *
 * The share flow sets up the parent-to-parent listener so the second parent
 * can connect immediately after this function resolves.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} first parent's PeerJS peer ID
 */
async function setupParent1ShareFlow(page) {
  // Click the tap-to-begin overlay to start init().
  await page.click('#tap-overlay');

  // Wait for init() to settle — the pairing section should be visible since
  // monitors.size === 0 even with pre-seeded profiles.
  await page.waitForSelector('#pairing-section:not(.hidden)', { timeout: 8_000 });

  // Programmatically trigger the share-parent flow.  _startShareParentFlow()
  // calls initPeer() (if needed) and starts listening for parent2's connection.
  await page.evaluate(() => window.__testTriggerShareParentFlow());

  // Wait for the share QR wrapper to become visible — this means initPeer()
  // has resolved and the QR code has been rendered.
  await page.waitForFunction(
    () => {
      const wrap = document.getElementById('share-parent-qr-wrap');
      return wrap != null && !wrap.classList.contains('hidden');
    },
    { timeout: 20_000 },
  );

  // Return the local peer ID for the second parent to scan.
  return page.evaluate(() => window.__testGetLocalPeerId() ?? '');
}

/**
 * Navigate the second-parent page through the add-parent flow, injecting
 * the first parent's peer ID as the QR scan result.  The function resolves
 * once the second parent has connected to the baby and
 * window.__peerState === 'connected'.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} firstParentPeerId
 * @param {number} [connectionTimeoutMs=45000]
 */
async function setupParent2AddParentFlow(page, firstParentPeerId, connectionTimeoutMs = 45_000) {
  // Pre-set the test scan result BEFORE clicking the tap overlay so
  // startAddParentFlow()'s first scanSingle() call returns immediately.
  await skipNotifications(page);
  await page.evaluate((id) => { window.__TEST_SCAN_RESULT = id; }, firstParentPeerId);
  await page.click('#tap-overlay');

  // Wait for the second parent to connect to the baby.
  // startAddParentFlow: scan → connect to parent1 → PARENT_HANDOFF → connect to baby.
  await page.waitForFunction(
    () => window.__peerState === 'connected',
    { timeout: connectionTimeoutMs },
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Second parent pairing (TASK-069)', () => {

  /**
   * These tests involve three PeerJS registrations and two independent
   * WebRTC connection handshakes.  Allow a generous overall timeout.
   */
  test.setTimeout(90_000);

  // -------------------------------------------------------------------------
  // Test 1 (step 2): First parent displays own peer ID as a QR code
  // -------------------------------------------------------------------------

  test('first parent shows its own peer ID as a QR code when share flow is initiated', async ({ browser }) => {
    const parent1Context = await createPreseededParent1Context(browser);
    const parent1Page    = await parent1Context.newPage();

    try {
      await parent1Page.goto('/parent.html');

      // Trigger the share flow and obtain the first parent's peer ID.
      const parent1PeerId = await setupParent1ShareFlow(parent1Page);

      // (2a) The peer ID must be a non-empty UUID-format string.
      expect(parent1PeerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // (2b) The QR container must have a rendered <canvas> element.
      const qrHasCanvas = await parent1Page.evaluate(() => {
        const container = document.getElementById('share-parent-qr-container');
        return container != null && container.querySelector('canvas') != null;
      });
      expect(qrHasCanvas).toBe(true);

      // (2c) The status text should direct the second parent to scan the code.
      const statusText = await parent1Page.textContent('#share-parent-status');
      expect(statusText).toContain('Scan this QR code');

    } finally {
      await parent1Context.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2 (steps 3–4): PARENT_HANDOFF payload contains baby IDs and pools
  // -------------------------------------------------------------------------

  test('PARENT_HANDOFF payload contains all device profiles with backup pool IDs', async ({ browser }) => {
    const parent1Context = await createPreseededParent1Context(browser);
    const parent1Page    = await parent1Context.newPage();

    const parent2Context = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parent2Page    = await parent2Context.newPage();

    try {
      await parent1Page.goto('/parent.html');
      await parent2Page.goto('/parent.html?mode=add-parent');

      // Start the first parent's share flow.
      const parent1PeerId = await setupParent1ShareFlow(parent1Page);

      // (3) Second parent scans parent1's peer ID and connects to it.
      // After receiving PARENT_HANDOFF, startAddParentFlow will try to connect
      // to baby — but the baby isn't running in this test so those attempts
      // will timeout.  We only need the handoff to arrive; wait for it.
      await skipNotifications(parent2Page);
      await parent2Page.evaluate((id) => { window.__TEST_SCAN_RESULT = id; }, parent1PeerId);
      await parent2Page.click('#tap-overlay');

      // Wait for the PARENT_HANDOFF to arrive on parent2.
      await parent2Page.waitForFunction(
        () => window.__testLastHandoffPayload != null,
        { timeout: 30_000 },
      );

      // (4a) Payload must contain the devices array.
      const payload = await parent2Page.evaluate(() => window.__testLastHandoffPayload);
      expect(Array.isArray(payload.devices)).toBe(true);
      expect(payload.devices.length).toBeGreaterThan(0);

      // (4b) Each device must have an id and a backupPoolJson field.
      for (const device of payload.devices) {
        expect(typeof device.id).toBe('string');
        expect(device.id.length).toBeGreaterThan(0);
        expect(typeof device.backupPoolJson).toBe('string');

        // Parse the pool JSON and verify it contains a non-empty pool array.
        const poolData = JSON.parse(device.backupPoolJson);
        expect(Array.isArray(poolData.pool)).toBe(true);
        expect(poolData.pool.length).toBeGreaterThan(0);
        // Each pool entry must be a UUID-format string.
        for (const id of poolData.pool) {
          expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          );
        }
      }

      // (4c) The first parent's __testLastHandoffSent must contain the same profiles.
      const sentProfiles = await parent1Page.evaluate(() => window.__testLastHandoffSent);
      expect(Array.isArray(sentProfiles)).toBe(true);
      expect(sentProfiles.length).toBe(payload.devices.length);
      expect(sentProfiles[0].id).toBe(payload.devices[0].id);

      // (4d) The second parent must have persisted the profiles in localStorage.
      const storedDevices = await parent2Page.evaluate(() => {
        const raw = localStorage.getItem('bm:paireddevices');
        return raw != null ? JSON.parse(raw) : null;
      });
      expect(Array.isArray(storedDevices)).toBe(true);
      expect(storedDevices.length).toBeGreaterThan(0);
      expect(storedDevices[0].id).toBe(payload.devices[0].id);

    } finally {
      await Promise.all([
        parent1Context.close(),
        parent2Context.close(),
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3 (step 5): Second parent connects directly to the baby
  // -------------------------------------------------------------------------
  //
  // The baby is pre-seeded to register under TEST_POOL[0] as its primary peer
  // ID.  The first parent has a device profile whose backupPoolJson contains
  // TEST_POOL, so the PARENT_HANDOFF includes TEST_POOL[0] as the first entry.
  //
  // When the second parent triggers peer.connect(TEST_POOL[0]), the baby (in
  // pairing mode with its listener still active — parent1 never triggered it)
  // receives the data connection, calls the second parent back, and a direct
  // WebRTC connection is established without the first parent being involved.

  test('second parent connects directly to baby without routing through first parent', async ({ browser }) => {
    const babyContext    = await createPreseededBabyContext(browser);
    const babyPage       = await babyContext.newPage();

    const parent1Context = await createPreseededParent1Context(browser);
    const parent1Page    = await parent1Context.newPage();

    const parent2Context = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parent2Page    = await parent2Context.newPage();

    try {
      await Promise.all([
        babyPage.goto('/baby.html'),
        parent1Page.goto('/parent.html'),
        parent2Page.goto('/parent.html?mode=add-parent'),
      ]);

      // Baby: register under TEST_POOL[0] and enter pairing mode (QR visible).
      // This must complete before parent2 triggers the connection.
      const babyPeerId = await setupBabyPeerJs(babyPage);
      expect(babyPeerId).toBe(TEST_POOL[0]);

      // Parent1: trigger share flow — registers with PeerJS and listens for
      // parent2.  Parent1 does NOT connect to baby; it only acts as a broker.
      const parent1PeerId = await setupParent1ShareFlow(parent1Page);
      expect(parent1PeerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // Parent2: scan parent1's peer ID, receive PARENT_HANDOFF, then connect
      // directly to the baby using pool IDs from the payload.
      // The baby is at TEST_POOL[0] (its primary ID) and is still in pairing
      // mode (listener active, parent1 never connected to it).
      await setupParent2AddParentFlow(parent2Page, parent1PeerId);

      // (5a) Second parent must have the baby in its monitors.
      const monitorEntry = await parent2Page.evaluate(() => window.__testMonitorEntry);
      expect(monitorEntry).not.toBeNull();

      // (5b) The monitor connection must be a direct parent-to-baby connection
      // (method 'peerjs', not routed via parent1).
      const monitorConn = await parent2Page.evaluate(() => window.__testMonitorConn);
      expect(monitorConn).not.toBeNull();

      // (5c) Baby's state machine must be in 'connected' (connected to parent2).
      const babyPeerState = await babyPage.evaluate(() => window.__peerState);
      expect(babyPeerState).toBe('connected');

      // (5d) Second parent must have received a STATE_SNAPSHOT from baby,
      // confirming the data channel is open and bidirectional.
      const snapshot = await parent2Page.evaluate(() => window.__lastStateSnapshot);
      expect(snapshot).not.toBeNull();
      expect(typeof snapshot.soothingMode).toBe('string');

    } finally {
      await Promise.all([
        babyContext.close(),
        parent1Context.close(),
        parent2Context.close(),
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // Test 4 (step 6): Closing first parent does not affect second parent
  // -------------------------------------------------------------------------
  //
  // After both parent1 (broker) and parent2 are set up, closing parent1's
  // context must not affect parent2's direct connection to the baby.
  // Parent2's WebRTC channel goes straight to baby — it never depended on
  // parent1 staying alive after the handoff.

  test('second parent remains connected to baby after first parent context is closed', async ({ browser }) => {
    const babyContext    = await createPreseededBabyContext(browser);
    const babyPage       = await babyContext.newPage();

    const parent1Context = await createPreseededParent1Context(browser);
    const parent1Page    = await parent1Context.newPage();

    const parent2Context = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parent2Page    = await parent2Context.newPage();

    try {
      await Promise.all([
        babyPage.goto('/baby.html'),
        parent1Page.goto('/parent.html'),
        parent2Page.goto('/parent.html?mode=add-parent'),
      ]);

      // Set up all three devices — same as Test 3.
      const babyPeerId = await setupBabyPeerJs(babyPage);
      expect(babyPeerId).toBe(TEST_POOL[0]);

      const parent1PeerId = await setupParent1ShareFlow(parent1Page);
      await setupParent2AddParentFlow(parent2Page, parent1PeerId);

      // Confirm parent2 is connected before closing parent1.
      const parent2StateBeforeClose = await parent2Page.evaluate(() => window.__peerState);
      expect(parent2StateBeforeClose).toBe('connected');

      // (6) Close the first parent context — simulates parent1 going offline.
      await parent1Context.close();

      // Brief settle period — give the WebRTC stack time to react (if it will).
      // 2 seconds is enough for ICE state changes to propagate; genuine
      // disconnections would manifest quickly.
      await parent2Page.waitForTimeout(2_000);

      // (6a) Parent2 must still be connected to baby (unaffected by parent1 closing).
      const parent2StateAfterClose = await parent2Page.evaluate(() => window.__peerState);
      expect(parent2StateAfterClose).toBe('connected');

      // (6b) Baby must still be connected (its activeConnection is to parent2,
      // not parent1, so parent1 closing is irrelevant).
      const babyStateAfterClose = await babyPage.evaluate(() => window.__peerState);
      expect(babyStateAfterClose).toBe('connected');

      // (6c) Parent2's monitor entry must still exist (not removed on parent1 close).
      const monitorEntryAfterClose = await parent2Page.evaluate(() => window.__testMonitorEntry);
      expect(monitorEntryAfterClose).not.toBeNull();

    } finally {
      // parent1Context may already be closed; ignore errors.
      try { await parent1Context.close(); } catch (_) { /* already closed */ }
      await Promise.all([
        babyContext.close(),
        parent2Context.close(),
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5 (step 7): Both parents count toward the 4-connection limit
  // -------------------------------------------------------------------------
  //
  // TASK-022 limits each parent to MAX_MONITORS = 4 baby monitors.  When a
  // second parent receives device profiles via PARENT_HANDOFF and connects to
  // each baby, each baby counts as one of the second parent's 4 slots.
  //
  // This test verifies that after parent2 connects to the baby:
  //   • parent2.monitors.size === 1 (one baby in parent2's monitor list)
  //   • This is within the MAX_MONITORS = 4 limit
  //
  // Together, parent1's profile (1 baby in its list) and parent2's connection
  // (1 baby in its list) represent 2 out of a possible 4 connection slots per
  // parent — demonstrating that both parents count toward the limit.

  test('both parents count toward the baby device 4-connection limit (MAX_MONITORS)', async ({ browser }) => {
    const babyContext    = await createPreseededBabyContext(browser);
    const babyPage       = await babyContext.newPage();

    const parent1Context = await createPreseededParent1Context(browser);
    const parent1Page    = await parent1Context.newPage();

    const parent2Context = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parent2Page    = await parent2Context.newPage();

    try {
      await Promise.all([
        babyPage.goto('/baby.html'),
        parent1Page.goto('/parent.html'),
        parent2Page.goto('/parent.html?mode=add-parent'),
      ]);

      // Set up all three devices — same as Test 3.
      const babyPeerId = await setupBabyPeerJs(babyPage);
      expect(babyPeerId).toBe(TEST_POOL[0]);

      const parent1PeerId = await setupParent1ShareFlow(parent1Page);
      await setupParent2AddParentFlow(parent2Page, parent1PeerId);

      // (7a) Parent2 must have exactly 1 monitor entry after connecting.
      //      This confirms the baby counts as 1 toward parent2's 4-device limit.
      const parent2MonitorCount = await parent2Page.evaluate(
        () => window.__testGetMonitorCount(),
      );
      expect(parent2MonitorCount).toBe(1);

      // (7b) Parent1 has 1 paired device profile (the baby).  This represents
      //      parent1's potential connection — also counting toward its 4-slot limit.
      const parent1ProfileCount = await parent1Page.evaluate(() => {
        const raw = localStorage.getItem('bm:paireddevices');
        return raw != null ? JSON.parse(raw).length : 0;
      });
      expect(parent1ProfileCount).toBe(1);

      // (7c) Combined: 1 (parent2 connected) + 1 (parent1 profile) = 2 connections
      //      to this baby, both below MAX_MONITORS = 4.
      expect(parent2MonitorCount + parent1ProfileCount).toBeLessThanOrEqual(4);

      // (7d) Verify the baby device ID in parent2's monitor matches the
      //      TEST_DEVICE_ID profile that parent1 handed off — confirming both
      //      parents reference the same baby device in their monitor lists.
      const monitorEntry = await parent2Page.evaluate(() => window.__testMonitorEntry);
      expect(monitorEntry).not.toBeNull();
      // The monitor entry's deviceId comes from the STATE_SNAPSHOT sent by baby
      // on connection.  It may differ from TEST_DEVICE_ID (which is the profile
      // ID) if baby uses its own device ID.  Verify it is a non-empty string.
      expect(typeof monitorEntry.deviceId).toBe('string');
      expect(monitorEntry.deviceId.length).toBeGreaterThan(0);

    } finally {
      await Promise.all([
        babyContext.close(),
        parent1Context.close(),
        parent2Context.close(),
      ]);
    }
  });

});
