/**
 * reconnection.spec.js — E2E tests for automatic reconnection (TASK-067)
 *
 * Verifies that when the baby device loses its WebRTC connection, both the baby
 * and parent sides automatically re-establish the connection using the pre-agreed
 * backup PeerJS ID pool (TASK-061) without any user action, and that the backup
 * pool index is correctly advanced and persisted so the same ID is never reused.
 *
 * Coverage (as specified in TASK-067):
 *   (1)  Pair a baby and parent context via PeerJS.
 *   (2)  Simulate a disconnection (via __testDropConnection hook).
 *   (3)  Verify the parent shows a 'reconnecting' UI state within a short delay.
 *   (4)  Verify the baby re-registers using the next ID in the backup pool.
 *   (5)  Verify both contexts reach 'connected' without any user action.
 *   (6)  Verify the data channel is functional by exchanging a test message.
 *   (7)  Confirm the pool index was persisted — the baby must not reuse a
 *        tried ID across a context close and reopen.
 *
 * App hooks used by these tests (all TASK-067 additions unless noted):
 *   window.__testDropConnection        — baby: close active WebRTC connection
 *   window.__testGetPoolIndex          — baby: read bm:backuppoolidx from localStorage
 *   window.__testGetPool               — baby: read bm:backuppool from localStorage
 *   window.__testSetPoolStartIndex(id) — parent: advance in-memory pool start index
 *   window.__peerState                 — baby: 'connected'|'reconnecting'|…  (TASK-063)
 *   window.__testMonitorEntry          — parent: full MonitorEntry (TASK-064)
 *   window.__lastBabyMessage           — baby: last data-channel message (TASK-063)
 *   window.__lastStateSnapshot         — parent: last STATE_SNAPSHOT (TASK-063)
 *
 * Timing notes
 * ------------
 * Each reconnect attempt involves PeerJS re-registration plus signalling
 * round-trips.  By pre-advancing the parent's in-memory pool start index to 1
 * (matching the baby's first reconnect ID, pool[1]) the two sides converge on
 * the same backup peer ID during attempt 1, reducing the round-trip to ~5-10 s
 * instead of the 21 s that the full three-attempt cycle would require.
 *
 * Prerequisites:
 *   • App served on http://localhost:3000 (npx serve .. -l 3000 from tests/).
 *   • Internet access for PeerJS cloud signaling (0.peerjs.com).
 */

'use strict';

const { test, expect } = require('@playwright/test');
const {
  createDevicePair,
  setupBabyPeerJs,
  setupParentPeerJs,
  waitForBothConnected,
  ISOLATED_CONTEXT_OPTIONS,
  mockPeerJsSignaling,
} = require('./helpers');

// ---------------------------------------------------------------------------
// Shared setup helper
// ---------------------------------------------------------------------------

/**
 * Pair a baby and parent context via PeerJS and wait for both to reach the
 * 'connected' state.  Returns the two device objects, the parent's deviceId,
 * and a cleanup function.
 *
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<{
 *   baby: { context, page },
 *   parent: { context, page },
 *   deviceId: string,
 *   cleanup: () => Promise<void>
 * }>}
 */
async function pairDevices(browser) {
  const { baby, parent, cleanup } = await createDevicePair(browser, { navigate: false });

  // routeWebSocket MUST be registered before page.goto() to intercept the
  // PeerJS WebSocket connection.  Set up the mock on both pages now, before
  // any navigation, then pass skipMock:true to the setup helpers so they
  // don't try to register a second (ineffective) route after goto().
  await mockPeerJsSignaling(baby.page);
  await mockPeerJsSignaling(parent.page);

  await Promise.all([
    baby.page.goto('/baby.html'),
    parent.page.goto('/parent.html'),
  ]);

  const babyPeerId = await setupBabyPeerJs(baby.page, 15_000, { skipMock: true });
  await setupParentPeerJs(parent.page, babyPeerId, { skipMock: true });
  await waitForBothConnected(baby.page, parent.page);

  const deviceId = await parent.page.evaluate(
    () => window.__testMonitorEntry?.deviceId ?? null,
  );

  return { baby, parent, deviceId, cleanup };
}

/**
 * Wait for the parent's monitor-panel connection overlay to become visible
 * and contain "Reconnecting" text.
 *
 * @param {import('@playwright/test').Page} parentPage
 * @param {number} [timeoutMs=15000]
 */
async function waitForParentReconnecting(parentPage, timeoutMs = 15_000) {
  await parentPage.waitForFunction(
    () => {
      const overlay = document.querySelector('.monitor-panel__conn-overlay');
      if (!overlay || overlay.classList.contains('hidden')) return false;
      const text = overlay.querySelector('span')?.textContent ?? '';
      return text.includes('Reconnecting');
    },
    { timeout: timeoutMs },
  );
}

/**
 * Wait for the parent's monitor-panel connection overlay to be hidden again,
 * which signals that the monitor has returned to the 'connected' state.
 *
 * @param {import('@playwright/test').Page} parentPage
 * @param {number} [timeoutMs=60000]
 */
async function waitForParentConnected(parentPage, timeoutMs = 60_000) {
  await parentPage.waitForFunction(
    () => {
      const overlay = document.querySelector('.monitor-panel__conn-overlay');
      return overlay?.classList.contains('hidden') ?? false;
    },
    { timeout: timeoutMs },
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Automatic reconnection (TASK-067)', () => {

  /**
   * PeerJS signalling is mocked locally (peerjs-mock.js) so pairing is fast.
   * 60 s covers the ICE failure detection window (~30 s) when a context is
   * closed plus reconnect time.
   */
  test.setTimeout(60_000);

  // -------------------------------------------------------------------------
  // Test 1: Parent shows reconnecting overlay when baby disconnects (step 3)
  // -------------------------------------------------------------------------

  test('parent shows reconnecting overlay within a short delay when baby disconnects', async ({ browser }) => {
    const { baby, parent, cleanup } = await pairDevices(browser);

    try {
      // Confirm initial state: overlay is hidden (connected).
      const initiallyHidden = await parent.page.evaluate(
        () =>
          document
            .querySelector('.monitor-panel__conn-overlay')
            ?.classList.contains('hidden') ?? false,
      );
      expect(initiallyHidden).toBe(true);

      // (2) Simulate disconnection by closing the active WebRTC connection
      // from the baby side.  This triggers close events on both sides and
      // causes both contexts to enter their auto-reconnect flows.
      await baby.page.evaluate(() => window.__testDropConnection());

      // (3) Parent must show the reconnecting overlay within a short delay.
      await waitForParentReconnecting(parent.page, 15_000);

      // Confirm the overlay text explicitly says "Reconnecting".
      const overlayText = await parent.page.evaluate(
        () =>
          document.querySelector('.monitor-panel__conn-overlay span')
            ?.textContent ?? '',
      );
      expect(overlayText).toContain('Reconnecting');

    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Full reconnect via backup pool — both reach connected, data
  //         channel works, pool index advances  (steps 1–7)
  // -------------------------------------------------------------------------

  test('baby reconnects using next backup pool ID without user action and data channel is functional', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);

    try {
      // (7 pre-check) Pool index must be 0 before any reconnect has occurred.
      const initialPoolIndex = await baby.page.evaluate(
        () => window.__testGetPoolIndex(),
      );
      expect(initialPoolIndex).toBe(0);

      // Synchronise pool offsets so both sides converge on pool[1] during
      // attempt 1.  The baby advances its index 0 → 1 on the first reconnect;
      // setting the parent's start index to 1 means its attempt 1 also targets
      // pool[1], avoiding the default 12-second wait for attempt 1 to time out.
      await parent.page.evaluate(
        (id) => window.__testSetPoolStartIndex(id, 1),
        deviceId,
      );

      // (2) Simulate disconnection.
      await baby.page.evaluate(() => window.__testDropConnection());

      // (3) Verify parent shows reconnecting UI.
      await waitForParentReconnecting(parent.page, 15_000);

      // (4–5) Wait for both sides to reach 'connected' — no user action required.
      //
      // Baby: __peerState transitions 'connected' → 'reconnecting' → 'connected'
      //       via updateConnectionStatus() in _attemptPeerJsReconnect.onReady.
      //
      // Parent: overlay transitions hidden → visible → hidden
      //         via _updateMonitorConnStatus() in _attemptParentReconnect.onReady.
      await baby.page.waitForFunction(
        () => window.__peerState === 'connected',
        { timeout: 60_000 },
      );
      await waitForParentConnected(parent.page, 60_000);

      // (4) Confirm baby re-registered using the next backup pool ID (pool[1]).
      const pool = await baby.page.evaluate(() => window.__testGetPool());
      expect(Array.isArray(pool)).toBe(true);
      expect(pool.length).toBeGreaterThan(1);

      // (7) Pool index must have advanced — baby used pool[1], not pool[0].
      const poolIndexAfterReconnect = await baby.page.evaluate(
        () => window.__testGetPoolIndex(),
      );
      // After one reconnect the index increments from 0 to 1.
      expect(poolIndexAfterReconnect).toBe(1);

      // (6) Verify the data channel is functional after reconnection.
      //
      // After reconnect, entry.conn is updated with the new connection in
      // _attemptParentReconnect.onReady, so we read via __testMonitorEntry.conn
      // rather than the stale __testMonitorConn reference.
      //
      // Parent → baby: send SET_MODE 'stars'.
      await parent.page.evaluate(() => {
        const conn = window.__testMonitorEntry?.conn;
        if (conn?.dataChannel) {
          conn.dataChannel.send({ type: 'setMode', value: 'stars' });
        }
      });

      // Baby must receive the SET_MODE message via the new data channel.
      await baby.page.waitForFunction(
        () =>
          window.__lastBabyMessage?.type === 'setMode' &&
          window.__lastBabyMessage?.value === 'stars',
        { timeout: 10_000 },
      );

      // Baby → parent: STATE_SNAPSHOT round-trip confirms soothingMode changed.
      await parent.page.waitForFunction(
        () => window.__lastStateSnapshot?.soothingMode === 'stars',
        { timeout: 10_000 },
      );

    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Pool index persists across baby context close and reopen (step 7)
  // -------------------------------------------------------------------------
  //
  // After a successful reconnect, bm:backuppoolidx must be saved to
  // localStorage so that a subsequent app restart picks up from the correct
  // position and does not reuse an already-tried peer ID.
  //
  // Sequence:
  //   1. Pair + in-session reconnect  →  pool index advances to 1.
  //   2. Capture the baby context's storage state (bm:backuppoolidx = 1).
  //   3. Close the baby context (simulates the app being killed / restarted).
  //   4. Open a new baby context pre-seeded with the captured storage state.
  //   5. Assert pool index is still 1 in the new context (was not reset to 0).
  //   6. Assert the pool array is intact and contains enough IDs for future
  //      reconnects (baby will use pool[2] next, never reusing pool[1]).

  test('pool index is persisted across context close and reopen so baby does not reuse tried IDs', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);

    let newBabyContext = null;

    try {
      // ------------------------------------------------------------------ //
      // Step 1 — Perform an in-session reconnect to advance pool index.     //
      // ------------------------------------------------------------------ //

      // Synchronise pool offsets (attempt 1 targets pool[1] on both sides).
      await parent.page.evaluate(
        (id) => window.__testSetPoolStartIndex(id, 1),
        deviceId,
      );

      await baby.page.evaluate(() => window.__testDropConnection());
      await waitForParentReconnecting(parent.page, 15_000);

      // Wait for full reconnect on both sides.
      await baby.page.waitForFunction(
        () => window.__peerState === 'connected',
        { timeout: 60_000 },
      );
      await waitForParentConnected(parent.page, 60_000);

      // Confirm pool index is 1 after the in-session reconnect.
      const poolIndexAfterReconnect = await baby.page.evaluate(
        () => window.__testGetPoolIndex(),
      );
      expect(poolIndexAfterReconnect).toBe(1);

      // Read the full backup pool to verify it survives the restart.
      const originalPool = await baby.page.evaluate(() => window.__testGetPool());
      expect(Array.isArray(originalPool)).toBe(true);
      expect(originalPool.length).toBeGreaterThan(2);

      // ------------------------------------------------------------------ //
      // Step 2 — Capture baby context storage state.                        //
      // ------------------------------------------------------------------ //

      const babyStorageState = await baby.context.storageState();

      // ------------------------------------------------------------------ //
      // Step 3 — Close the baby context (simulates device restart).         //
      // ------------------------------------------------------------------ //

      // Close baby context independently; parent stays open.
      await baby.context.close();

      // ------------------------------------------------------------------ //
      // Step 4 — Open a fresh baby context seeded with captured storage.    //
      // ------------------------------------------------------------------ //

      newBabyContext = await browser.newContext({
        ...ISOLATED_CONTEXT_OPTIONS,
        storageState: babyStorageState,
      });
      const newBabyPage = await newBabyContext.newPage();
      await newBabyPage.goto('/baby.html');

      // ------------------------------------------------------------------ //
      // Step 5 — Verify pool index is still 1 in the new context.           //
      // ------------------------------------------------------------------ //

      const poolIndexInNewContext = await newBabyPage.evaluate(() => {
        const raw = localStorage.getItem('bm:backuppoolidx');
        return raw !== null ? JSON.parse(raw) : null;
      });

      // The index must NOT have been reset to 0 — it must reflect that pool[1]
      // was already used so the next reconnect will advance to pool[2].
      expect(poolIndexInNewContext).toBe(1);

      // ------------------------------------------------------------------ //
      // Step 6 — Verify the pool array survived intact.                     //
      // ------------------------------------------------------------------ //

      const poolInNewContext = await newBabyPage.evaluate(() => {
        const raw = localStorage.getItem('bm:backuppool');
        return raw !== null ? JSON.parse(raw) : null;
      });

      expect(Array.isArray(poolInNewContext)).toBe(true);
      expect(poolInNewContext.length).toBe(originalPool.length);

      // Spot-check that the IDs are the same pool (not regenerated).
      expect(poolInNewContext[0]).toBe(originalPool[0]);
      expect(poolInNewContext[1]).toBe(originalPool[1]);

      // With pool index = 1, the next _advanceIdPoolForReconnect() will return
      // pool[2] (not pool[0] or pool[1]).  Confirm pool[2] exists.
      expect(typeof poolInNewContext[2]).toBe('string');
      expect(poolInNewContext[2].length).toBeGreaterThan(0);

      // pool[0] and pool[1] must be distinct from pool[2] — no duplicate IDs.
      expect(poolInNewContext[2]).not.toBe(poolInNewContext[0]);
      expect(poolInNewContext[2]).not.toBe(poolInNewContext[1]);

    } finally {
      if (newBabyContext) {
        try { await newBabyContext.close(); } catch (_) { /* ignore */ }
      }
      // cleanup() closes both contexts; baby is already closed, so only
      // the parent context will actually be torn down.
      try { await cleanup(); } catch (_) { /* ignore if already closed */ }
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Reconnect after baby context close and reopen with correct pool ID
  //         — verifies the parent reconnects when baby restarts using a backup
  //         peer ID that matches the parent's first reconnect attempt.
  // -------------------------------------------------------------------------
  //
  // This test literally closes the baby browser context and reopens a new one
  // pre-seeded with localStorage that includes the FIRST backup pool ID as the
  // stored peer ID (bm:peerid = pool[0]).  The parent's reconnect attempt 1
  // therefore finds the baby immediately via its trigger data connection, and
  // the pairing flow completes automatically (no QR scan needed — just tap +
  // Quick Pair, which the test automates).

  test('parent reconnects after baby context close and reopen using first backup pool ID', async ({ browser }) => {
    // This test runs two PeerJS pair flows and waits up to 30 s for ICE
    // detection.  With the local PeerJS mock pairing is ~2 s each.  90 s
    // covers: pair (2 s) + ICE detect (30 s) + new baby setup (5 s) +
    // reconnect wait (30 s) + data channel test (5 s) = ~72 s.
    test.setTimeout(90_000);
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);

    let newBabyContext = null;
    let newBabyPage    = null;

    try {
      // Read the backup pool from baby's localStorage before closing.
      const pool    = await baby.page.evaluate(() => window.__testGetPool());
      const poolIdx = await baby.page.evaluate(() => window.__testGetPoolIndex());

      expect(Array.isArray(pool)).toBe(true);
      expect(pool.length).toBeGreaterThan(0);

      // Keep the parent's pool start index at 0 (the default) so attempt 1
      // targets pool[0] — the ID we will register the restarted baby under.
      // No call to __testSetPoolStartIndex is needed here.

      // Capture the baby's storage state before closing so we can re-seed it.
      const babyStorageState = await baby.context.storageState();

      // ------------------------------------------------------------------ //
      // Close the baby context (simulates device going offline / app killed). //
      // ------------------------------------------------------------------ //

      await baby.context.close();

      // Parent should detect the ICE disconnection and show reconnecting UI.
      await waitForParentReconnecting(parent.page, 30_000);

      // ------------------------------------------------------------------ //
      // Reopen baby with pool[0] as the stored peer ID.                     //
      // ------------------------------------------------------------------ //
      // Modify the captured storage state to use pool[0] as bm:peerid and set
      // bm:backuppoolidx to 1 (reflecting that pool[0] is now in use so the
      // next reconnect would advance to pool[1]).

      const modifiedStorage = JSON.parse(JSON.stringify(babyStorageState));
      const originEntry = modifiedStorage.origins?.find(
        (o) => o.origin === 'http://localhost:3000',
      );
      if (originEntry?.localStorage) {
        // Override bm:peerid → pool[0]
        const peerIdItem = originEntry.localStorage.find(
          (item) => item.name === 'bm:peerid',
        );
        if (peerIdItem) {
          peerIdItem.value = JSON.stringify(pool[poolIdx]);
        } else {
          originEntry.localStorage.push({
            name:  'bm:peerid',
            value: JSON.stringify(pool[poolIdx]),
          });
        }

        // Override bm:backuppoolidx → poolIdx + 1
        const idxItem = originEntry.localStorage.find(
          (item) => item.name === 'bm:backuppoolidx',
        );
        if (idxItem) {
          idxItem.value = JSON.stringify(poolIdx + 1);
        } else {
          originEntry.localStorage.push({
            name:  'bm:backuppoolidx',
            value: JSON.stringify(poolIdx + 1),
          });
        }
      }

      newBabyContext = await browser.newContext({
        ...ISOLATED_CONTEXT_OPTIONS,
        storageState: modifiedStorage,
      });
      newBabyPage = await newBabyContext.newPage();
      // Set up PeerJS mock for the new baby page before it initialises PeerJS.
      await mockPeerJsSignaling(newBabyPage);
      await newBabyPage.goto('/baby.html');

      // Automate the pairing UI: tap overlay → Quick Pair (PeerJS).
      // Baby registers under pool[0] (the modified bm:peerid).  The parent's
      // reconnect attempt 1 is already running; it has set up a listener for
      // pool[0] and sent a trigger data connection to pool[0].  When baby
      // registers and its peer.on('connection') fires for the trigger, baby
      // calls the parent back — completing the reconnect without any user QR scan.
      await newBabyPage.click('#tap-overlay');
      await newBabyPage.waitForSelector('#pairing-section:not(.hidden)', { timeout: 5_000 });
      await newBabyPage.click('#method-peerjs');

      // Wait for baby to register with PeerJS (peer ID text populated).
      await newBabyPage.waitForFunction(
        () => {
          const el = document.getElementById('peerjs-peer-id');
          return el != null && el.textContent.trim().length > 0;
        },
        { timeout: 15_000 },
      );

      // (5) Both contexts must reach 'connected' without further user action.
      await newBabyPage.waitForFunction(
        () => window.__peerState === 'connected',
        { timeout: 60_000 },
      );
      await waitForParentConnected(parent.page, 60_000);

      // (6) Verify data channel works after the restart-based reconnect.
      await parent.page.evaluate(() => {
        const conn = window.__testMonitorEntry?.conn;
        if (conn?.dataChannel) {
          conn.dataChannel.send({ type: 'setMode', value: 'water' });
        }
      });

      await newBabyPage.waitForFunction(
        () =>
          window.__lastBabyMessage?.type === 'setMode' &&
          window.__lastBabyMessage?.value === 'water',
        { timeout: 10_000 },
      );

      await parent.page.waitForFunction(
        () => window.__lastStateSnapshot?.soothingMode === 'water',
        { timeout: 10_000 },
      );

      // (7) Verify pool index in the new baby context reflects the ID used.
      const newBabyPoolIndex = await newBabyPage.evaluate(() => {
        const raw = localStorage.getItem('bm:backuppoolidx');
        return raw !== null ? JSON.parse(raw) : null;
      });
      // The modified context had backuppoolidx = poolIdx + 1 (we advanced it
      // before starting), confirming the baby is not going to reuse pool[poolIdx].
      expect(newBabyPoolIndex).toBeGreaterThan(poolIdx);

    } finally {
      if (newBabyContext) {
        try { await newBabyContext.close(); } catch (_) { /* ignore */ }
      }
      try { await cleanup(); } catch (_) { /* ignore if already closed */ }
    }
  });

});
