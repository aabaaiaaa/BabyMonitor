/**
 * qr-fallback-pairing.spec.js — E2E tests for offline QR code pairing (TASK-070)
 *
 * Covers the full offline QR fallback connection method: both baby and parent
 * exchange SDP offer/answer and ICE candidates via a grid of low-density QR
 * codes, establishing a peer-to-peer WebRTC connection with no server dependency.
 *
 * Coverage (as specified in TASK-070):
 *   (1)  Simulate PeerJS being unavailable (CDN intercepted) and verify the
 *        app surfaces a clear error message and offers the QR fallback option.
 *        Tested on both baby and parent pages.
 *   (2)  In the baby context, activate "Offline QR pairing" and verify the
 *        offer QR grid is rendered as canvas elements inside the container.
 *   (3)  Extract the SDP offer payload from the baby's QR container using the
 *        `data-qr-payload` attribute exposed as a test hook (TASK-070).
 *   (4)  Inject the offer payload into the parent context via
 *        `window.__TEST_MULTI_SCAN_RESULT` and verify the parent renders an
 *        answer QR grid.
 *   (5)  Complete the full SDP + ICE exchange programmatically: read the parent's
 *        answer payload and inject it back into the baby via
 *        `window.__TEST_MULTI_SCAN_RESULT`, allowing the baby's running scanMulti
 *        loop to resolve with the answer.
 *   (6)  Verify both contexts reach "connected" state and the data channel opens,
 *        confirming the offline path works end-to-end with no server dependency.
 *
 * App hooks used by these tests:
 *   window.__TEST_SCAN_RESULT          — single-scan bypass (qr.js, pre-existing)
 *   window.__TEST_MULTI_SCAN_RESULT    — multi-scan bypass, upfront or late-injected (qr.js, TASK-070)
 *   window.__peerState                 — 'connected'|'connecting'|… (baby.js/parent.js)
 *   window.__testMonitorConn           — last Connection added to parent (parent.js, TASK-063)
 *   window.__lastStateSnapshot         — last STATE_SNAPSHOT received by parent (TASK-063)
 *   window.__lastBabyMessage           — last data-channel message received by baby (TASK-063)
 *   #offline-qr-container[data-qr-payload]    — baby's offer JSON (TASK-070)
 *   #offline-answer-container[data-qr-payload] — parent's answer JSON (TASK-070)
 *
 * Implementation notes
 * --------------------
 * The offline QR path does NOT use PeerJS; it uses a raw RTCPeerConnection with
 * a minimal STUN configuration.  PeerJS may or may not be available — the tests
 * use fresh isolated contexts so the Service Worker cache is empty and CDN
 * resources must be fetched from the network.
 *
 * `scanMulti` in qr.js supports two test-hook modes (TASK-070):
 *   • Upfront:  `window.__TEST_MULTI_SCAN_RESULT` is set BEFORE `startOfflinePairing`
 *               is called (used on the parent side so the offer scan is instant).
 *   • Late:     `window.__TEST_MULTI_SCAN_RESULT` is set WHILE `scanMulti` is
 *               already running its camera frame loop (used on the baby side to
 *               inject the answer after the parent has generated it).
 *
 * ICE gathering may contact `stun:stun.l.google.com:19302` and take several
 * seconds to complete per side.  A 90-second suite timeout accommodates worst-
 * case scenarios where STUN is unreachable and the 15-second in-app timeout
 * fires for each side.
 *
 * Prerequisites:
 *   • App served on http://localhost:3000
 *     (run `npx serve .. -l 3000` from the tests/ directory, or
 *      `npx serve . -l 3000` from the project root).
 *   • The PeerJS CDN block tests do NOT require internet access.
 *   • The full pairing E2E tests require local network access (loopback ICE
 *     candidates at 127.0.0.1 are sufficient; internet / STUN is optional).
 */

'use strict';

const { test, expect } = require('@playwright/test');
const {
  ISOLATED_CONTEXT_OPTIONS,
  skipNotifications,
  tapToBegin,
} = require('./helpers');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * URL pattern matching the PeerJS CDN script.
 * Used by page.route() to intercept and abort the request so the app cannot
 * load the PeerJS library, triggering the LIBRARY_UNAVAILABLE error path.
 */
const PEERJS_CDN_PATTERN = '**/peerjs.min.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Navigate the baby page past the tap-to-begin overlay to the pairing method
 * selection screen.
 *
 * @param {import('@playwright/test').Page} page
 */
async function babyToMethodSelection(page) {
  await tapToBegin(page);
  await page.waitForSelector('#pairing-section:not(.hidden)', { timeout: 8_000 });
}

/**
 * Navigate the parent page past the tap-to-begin overlay to the pairing
 * method selection screen (skips the notification permission prompt).
 *
 * @param {import('@playwright/test').Page} page
 */
async function parentToMethodSelection(page) {
  await skipNotifications(page);
  await tapToBegin(page);
  await page.waitForSelector('#pairing-section:not(.hidden)', { timeout: 8_000 });
}

/**
 * Wait for the baby's offline QR offer to be rendered.
 * The offer is complete when `#offline-qr-container` has a canvas inside it
 * AND the `data-qr-payload` attribute is set (TASK-070 test hook).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs=40000]  — allow extra time for ICE gathering
 * @returns {Promise<string>}  the offer JSON string
 */
async function waitForBabyOfferQr(page, timeoutMs = 40_000) {
  await page.waitForFunction(
    () => {
      const container = document.getElementById('offline-qr-container');
      return (
        container != null &&
        container.dataset.qrPayload != null &&
        container.dataset.qrPayload.length > 0 &&
        container.querySelector('canvas') != null
      );
    },
    { timeout: timeoutMs },
  );

  return page.evaluate(
    () => document.getElementById('offline-qr-container')?.dataset.qrPayload ?? '',
  );
}

/**
 * Wait for the parent's offline QR answer to be rendered.
 * The answer is complete when `#offline-answer-container` has a canvas AND
 * the `data-qr-payload` attribute is set (TASK-070 test hook).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs=40000]
 * @returns {Promise<string>}  the answer JSON string
 */
async function waitForParentAnswerQr(page, timeoutMs = 40_000) {
  await page.waitForFunction(
    () => {
      const container = document.getElementById('offline-answer-container');
      return (
        container != null &&
        !container.classList.contains('hidden') &&
        container.dataset.qrPayload != null &&
        container.dataset.qrPayload.length > 0 &&
        container.querySelector('canvas') != null
      );
    },
    { timeout: timeoutMs },
  );

  return page.evaluate(
    () => document.getElementById('offline-answer-container')?.dataset.qrPayload ?? '',
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Offline QR fallback pairing (TASK-070)', () => {

  /**
   * The full offline pairing flow involves two ICE gathering rounds (baby + parent),
   * each of which may wait up to 15 seconds for STUN server responses.
   * Allow a generous 90-second total timeout for the suite.
   */
  test.setTimeout(90_000);

  // -------------------------------------------------------------------------
  // Test 1: Baby — PeerJS CDN unavailable shows error and fallback button
  // -------------------------------------------------------------------------

  test('baby: blocking PeerJS CDN shows error message and "Use Offline QR" fallback button', async ({ browser }) => {
    const babyContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const babyPage   = await babyContext.newPage();

    try {
      // Intercept and abort the PeerJS CDN request BEFORE navigating so that
      // the library script is never loaded.  The app detects typeof Peer === 'undefined'
      // and fires the LIBRARY_UNAVAILABLE error when initPeer() is called.
      await babyPage.route(PEERJS_CDN_PATTERN, (route) => route.abort('failed'));

      await babyPage.goto('/baby.html');
      await babyToMethodSelection(babyPage);

      // Click "Quick Pair (PeerJS)" — this triggers initPeer() → detects library
      // is missing → fires LIBRARY_UNAVAILABLE error.
      await babyPage.click('#method-peerjs');

      // The PeerJS pairing step must become visible.
      await babyPage.waitForSelector('#pairing-peerjs-step:not(.hidden)', { timeout: 8_000 });

      // (1a) The status element must display an error message referencing PeerJS.
      await babyPage.waitForFunction(
        () => {
          const el = document.getElementById('pairing-status-peerjs');
          if (!el) return false;
          const text = el.textContent ?? '';
          // The error message from peer.js for LIBRARY_UNAVAILABLE references
          // "PeerJS library" and "internet connection".
          return (
            text.includes('PeerJS') ||
            text.includes('could not be loaded') ||
            text.includes('error') ||
            text.includes('Error') ||
            text.includes('unavailable') ||
            text.includes('Offline QR')
          );
        },
        { timeout: 10_000 },
      );

      const statusText = await babyPage.textContent('#pairing-status-peerjs');
      expect(statusText).toBeTruthy();
      expect(statusText.length).toBeGreaterThan(0);

      // (1b) A "Use Offline QR instead" fallback button must appear.
      // The app calls _showPeerjsOfflineFallback() when serverUnavailable or
      // LIBRARY_UNAVAILABLE is detected.
      await babyPage.waitForFunction(
        () => {
          const btn = document.querySelector('.peerjs-fallback-btn');
          return btn != null && !btn.hidden;
        },
        { timeout: 10_000 },
      );

      const fallbackBtnText = await babyPage.textContent('.peerjs-fallback-btn');
      expect(fallbackBtnText).toContain('Offline QR');

      // (1c) Clicking the fallback button must return to the method selection screen.
      await babyPage.click('.peerjs-fallback-btn');
      const methodStepVisible = await babyPage.evaluate(
        () => !document.getElementById('pairing-method-step')?.classList.contains('hidden'),
      );
      expect(methodStepVisible).toBe(true);

    } finally {
      await babyContext.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Parent — PeerJS CDN unavailable shows error and fallback button
  // -------------------------------------------------------------------------

  test('parent: blocking PeerJS CDN shows error message and "Use Offline QR" fallback button', async ({ browser }) => {
    const parentContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parentPage    = await parentContext.newPage();

    try {
      await parentPage.route(PEERJS_CDN_PATTERN, (route) => route.abort('failed'));

      await parentPage.goto('/parent.html');
      await parentToMethodSelection(parentPage);

      // Inject a dummy scan result so the PeerJS scan step doesn't block on
      // the camera when the user clicks "Quick Pair".
      await parentPage.evaluate(() => { window.__TEST_SCAN_RESULT = 'dummy-id-for-peerjs-error-test'; });
      await parentPage.click('#method-peerjs');

      // PeerJS pairing step must become visible.
      await parentPage.waitForSelector('#pairing-peerjs-step:not(.hidden)', { timeout: 8_000 });

      // (2a) An error message must appear (peerjs-scan-status element).
      await parentPage.waitForFunction(
        () => {
          const el = document.getElementById('peerjs-scan-status');
          if (!el) return false;
          const text = el.textContent ?? '';
          return (
            text.includes('PeerJS') ||
            text.includes('could not be loaded') ||
            text.includes('error') ||
            text.includes('Error') ||
            text.includes('unavailable') ||
            text.includes('Offline QR')
          );
        },
        { timeout: 10_000 },
      );

      const statusText = await parentPage.textContent('#peerjs-scan-status');
      expect(statusText).toBeTruthy();
      expect(statusText.length).toBeGreaterThan(0);

      // (2b) The fallback button must appear on the parent side too.
      await parentPage.waitForFunction(
        () => {
          const btn = document.querySelector('.peerjs-fallback-btn');
          return btn != null && !btn.hidden;
        },
        { timeout: 10_000 },
      );

      const fallbackBtnText = await parentPage.textContent('.peerjs-fallback-btn');
      expect(fallbackBtnText).toContain('Offline QR');

      // (2c) Clicking it must return to method selection.
      await parentPage.click('.peerjs-fallback-btn');
      const methodStepVisible = await parentPage.evaluate(
        () => !document.getElementById('pairing-method-step')?.classList.contains('hidden'),
      );
      expect(methodStepVisible).toBe(true);

    } finally {
      await parentContext.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Baby renders offer QR grid with canvas elements
  // -------------------------------------------------------------------------

  test('baby renders QR grid with canvas elements when offline pairing is activated', async ({ browser }) => {
    const babyContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const babyPage   = await babyContext.newPage();

    try {
      await babyPage.goto('/baby.html');
      await babyToMethodSelection(babyPage);

      // Click "Offline QR Pair" — starts offlineBabyCreateOffer + renderQRGrid.
      await babyPage.click('#method-offline');

      // The offline pairing step must become visible.
      await babyPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      // Wait for the QR grid to be rendered — may take several seconds while
      // ICE candidates are gathered.
      const offerJson = await waitForBabyOfferQr(babyPage);

      // (3a) The offer payload must be a non-empty string.
      expect(offerJson).toBeTruthy();
      expect(offerJson.length).toBeGreaterThan(0);

      // (3b) The offer JSON must parse successfully and contain an 'sdp' field.
      const offer = JSON.parse(offerJson);
      expect(offer).toHaveProperty('sdp');
      expect(offer.sdp).toHaveProperty('type', 'offer');
      expect(typeof offer.sdp.sdp).toBe('string');

      // (3c) The offer must include an ICE candidates array.
      expect(Array.isArray(offer.candidates)).toBe(true);

      // (3d) The QR container must have at least one canvas element
      //      (one per chunk — the SDP is ~1-2 KB so expect several chunks).
      const canvasCount = await babyPage.evaluate(() => {
        return document.getElementById('offline-qr-container')?.querySelectorAll('canvas').length ?? 0;
      });
      expect(canvasCount).toBeGreaterThan(0);

      // (3e) The offline pairing step text must guide the user.
      const instruction = await babyPage.textContent('#offline-pairing-instruction');
      expect(instruction).toBeTruthy();

    } finally {
      await babyContext.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Extract offer QR data and inject it into the parent context
  // -------------------------------------------------------------------------

  test('parent renders answer QR grid after receiving the baby offer payload', async ({ browser }) => {
    const babyContext    = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const babyPage       = await babyContext.newPage();
    const parentContext  = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parentPage     = await parentContext.newPage();

    try {
      await Promise.all([
        babyPage.goto('/baby.html'),
        parentPage.goto('/parent.html'),
      ]);

      // Baby: navigate to offline pairing and generate the offer.
      await babyToMethodSelection(babyPage);
      await babyPage.click('#method-offline');
      await babyPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      // (3) Extract the offer payload from the baby's QR container.
      const offerJson = await waitForBabyOfferQr(babyPage);
      expect(offerJson.length).toBeGreaterThan(0);

      // Verify the offer is valid before proceeding.
      const offerData = JSON.parse(offerJson);
      expect(offerData.sdp.type).toBe('offer');

      // (4) Inject the offer into the parent context via __TEST_MULTI_SCAN_RESULT
      //     BEFORE clicking "Offline QR Pair" so that the parent's scanMulti()
      //     call resolves immediately with the offer JSON instead of opening the camera.
      await parentToMethodSelection(parentPage);
      await parentPage.evaluate((json) => {
        window.__TEST_MULTI_SCAN_RESULT = json;
      }, offerJson);

      // Click "Offline QR Pair" — parent's scanMulti resolves immediately with offer,
      // offlineParentReceiveOffer generates the answer, then renderQRGrid is called.
      await parentPage.click('#method-offline');
      await parentPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      // Wait for the parent's answer QR grid to appear.
      const answerJson = await waitForParentAnswerQr(parentPage);

      // (4a) The answer payload must be a non-empty string.
      expect(answerJson).toBeTruthy();
      expect(answerJson.length).toBeGreaterThan(0);

      // (4b) The answer must parse and have type 'answer'.
      const answerData = JSON.parse(answerJson);
      expect(answerData).toHaveProperty('sdp');
      expect(answerData.sdp).toHaveProperty('type', 'answer');
      expect(typeof answerData.sdp.sdp).toBe('string');

      // (4c) The answer must include ICE candidates.
      expect(Array.isArray(answerData.candidates)).toBe(true);

      // (4d) The parent's answer container must have canvas elements.
      const answerCanvasCount = await parentPage.evaluate(() => {
        return document.getElementById('offline-answer-container')
          ?.querySelectorAll('canvas').length ?? 0;
      });
      expect(answerCanvasCount).toBeGreaterThan(0);

      // (4e) Parent status must tell the user to show the QR to the baby camera.
      const parentStatus = await parentPage.textContent('#pairing-status-offline');
      expect(parentStatus).toBeTruthy();

    } finally {
      await Promise.all([
        babyContext.close(),
        parentContext.close(),
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Full end-to-end offline QR pairing — both contexts reach 'connected'
  // -------------------------------------------------------------------------
  //
  // This is the core offline path E2E test.  It drives both contexts through
  // the complete SDP + ICE exchange without any server dependency:
  //
  //   1. Baby generates offer (SDP + ICE) and renders it as a QR grid.
  //   2. Test reads the offer via data-qr-payload and injects it into the
  //      parent via __TEST_MULTI_SCAN_RESULT.
  //   3. Parent generates answer (SDP + ICE) and renders it as a QR grid.
  //   4. Test reads the answer via data-qr-payload and injects it into the
  //      baby's running scanMulti loop via __TEST_MULTI_SCAN_RESULT (late injection).
  //   5. Baby processes the answer; data channel opens on both sides.
  //   6. Both contexts reach __peerState === 'connected'.
  //   7. Data channel is verified bidirectionally.

  test('full offline QR pairing: both contexts reach connected state and data channel opens', async ({ browser }) => {
    const babyContext   = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const babyPage      = await babyContext.newPage();
    const parentContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parentPage    = await parentContext.newPage();

    try {
      await Promise.all([
        babyPage.goto('/baby.html'),
        parentPage.goto('/parent.html'),
      ]);

      // --- Step 1: Baby generates offer ---
      await babyToMethodSelection(babyPage);
      await babyPage.click('#method-offline');
      await babyPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      // (3) Extract offer from the baby's QR container (data-qr-payload attribute).
      const offerJson = await waitForBabyOfferQr(babyPage);
      expect(offerJson.length).toBeGreaterThan(0);

      // --- Step 2: Inject offer into parent (upfront hook) ---
      // Pre-load __TEST_MULTI_SCAN_RESULT before clicking "Offline QR Pair" so
      // the parent's scanMulti() returns immediately with the offer.
      await parentToMethodSelection(parentPage);
      await parentPage.evaluate((json) => {
        window.__TEST_MULTI_SCAN_RESULT = json;
      }, offerJson);

      // --- Step 3: Parent generates answer ---
      await parentPage.click('#method-offline');
      await parentPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      // (4) Wait for the parent to render its answer QR grid.
      const answerJson = await waitForParentAnswerQr(parentPage);
      expect(answerJson.length).toBeGreaterThan(0);

      // --- Step 4: Inject answer into baby's running scanMulti (late injection) ---
      // At this point the baby's scanMulti is looping over fake camera frames.
      // Setting __TEST_MULTI_SCAN_RESULT causes the next frame tick to resolve
      // the promise with the answer JSON.
      await babyPage.evaluate((json) => {
        window.__TEST_MULTI_SCAN_RESULT = json;
      }, answerJson);

      // --- Step 5: Wait for both sides to reach 'connected' ---
      // (5) The data channel opens once ICE + DTLS are negotiated.  Both sides
      // set window.__peerState = 'connected' when onReady fires.
      await Promise.all([
        babyPage.waitForFunction(
          () => window.__peerState === 'connected',
          { timeout: 30_000 },
        ),
        parentPage.waitForFunction(
          () => window.__peerState === 'connected',
          { timeout: 30_000 },
        ),
      ]);

      // (6a) Baby must be in 'connected' state.
      const babyState = await babyPage.evaluate(() => window.__peerState);
      expect(babyState).toBe('connected');

      // (6b) Parent must be in 'connected' state.
      const parentState = await parentPage.evaluate(() => window.__peerState);
      expect(parentState).toBe('connected');

      // (6c) Parent must have a monitor connection object.
      const monitorConn = await parentPage.evaluate(() => window.__testMonitorConn);
      expect(monitorConn).not.toBeNull();

      // (6d) Parent must have received an initial STATE_SNAPSHOT from the baby,
      //      confirming the data channel is open and bidirectional.
      await parentPage.waitForFunction(
        () => window.__lastStateSnapshot != null,
        { timeout: 15_000 },
      );

      const snapshot = await parentPage.evaluate(() => window.__lastStateSnapshot);
      expect(snapshot).not.toBeNull();
      expect(['candle', 'water', 'stars', 'music', 'combined', 'off']).toContain(
        snapshot.soothingMode,
      );

      // (6e) Connection method must be 'offline' (not 'peerjs').
      const connMethod = await parentPage.evaluate(
        () => window.__testMonitorConn?.method ?? null,
      );
      expect(connMethod).toBe('offline');

    } finally {
      await Promise.all([
        babyContext.close(),
        parentContext.close(),
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: Data channel bidirectional round-trip after offline pairing
  // -------------------------------------------------------------------------

  test('data channel is functional after offline pairing: SET_MODE reaches baby and STATE_SNAPSHOT returns', async ({ browser }) => {
    const babyContext   = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const babyPage      = await babyContext.newPage();
    const parentContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parentPage    = await parentContext.newPage();

    try {
      await Promise.all([
        babyPage.goto('/baby.html'),
        parentPage.goto('/parent.html'),
      ]);

      // Pair via offline QR exchange (same flow as Test 5).
      await babyToMethodSelection(babyPage);
      await babyPage.click('#method-offline');
      await babyPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      const offerJson = await waitForBabyOfferQr(babyPage);

      await parentToMethodSelection(parentPage);
      await parentPage.evaluate((json) => {
        window.__TEST_MULTI_SCAN_RESULT = json;
      }, offerJson);
      await parentPage.click('#method-offline');
      await parentPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      const answerJson = await waitForParentAnswerQr(parentPage);

      await babyPage.evaluate((json) => {
        window.__TEST_MULTI_SCAN_RESULT = json;
      }, answerJson);

      // Wait for both sides to connect.
      await Promise.all([
        babyPage.waitForFunction(() => window.__peerState === 'connected', { timeout: 30_000 }),
        parentPage.waitForFunction(() => window.__peerState === 'connected', { timeout: 30_000 }),
      ]);

      // --- Outbound: parent → baby (SET_MODE 'water') ---
      await parentPage.evaluate(() => {
        const conn = window.__testMonitorConn;
        if (conn?.dataChannel) {
          conn.dataChannel.send({ type: 'setMode', value: 'water' });
        }
      });

      // Baby must receive the SET_MODE message.
      await babyPage.waitForFunction(
        () => window.__lastBabyMessage?.type === 'setMode' &&
              window.__lastBabyMessage?.value === 'water',
        { timeout: 8_000 },
      );

      // --- Inbound: baby → parent (STATE_SNAPSHOT after mode change) ---
      // Baby calls sendStateSnapshot() after applying SET_MODE.
      await parentPage.waitForFunction(
        () => window.__lastStateSnapshot?.soothingMode === 'water',
        { timeout: 8_000 },
      );

      const finalSnapshot = await parentPage.evaluate(() => window.__lastStateSnapshot);
      expect(finalSnapshot.soothingMode).toBe('water');

    } finally {
      await Promise.all([
        babyContext.close(),
        parentContext.close(),
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // Test 7: Offline pairing requires no internet — PeerJS CDN blocked still works
  // -------------------------------------------------------------------------
  //
  // This test verifies that the offline QR path succeeds even when the PeerJS
  // CDN is completely unreachable.  PeerJS is irrelevant to the offline path;
  // the raw RTCPeerConnection uses only STUN (optional) and local host
  // candidates for loopback connectivity.

  test('offline QR pairing succeeds even when PeerJS CDN is blocked', async ({ browser }) => {
    const babyContext   = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const babyPage      = await babyContext.newPage();
    const parentContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const parentPage    = await parentContext.newPage();

    try {
      // Block PeerJS on both pages — offline path must not depend on it.
      await babyPage.route(PEERJS_CDN_PATTERN,   (route) => route.abort('failed'));
      await parentPage.route(PEERJS_CDN_PATTERN, (route) => route.abort('failed'));

      await Promise.all([
        babyPage.goto('/baby.html'),
        parentPage.goto('/parent.html'),
      ]);

      // Baby: go directly to offline pairing (skip PeerJS step entirely).
      await babyToMethodSelection(babyPage);
      await babyPage.click('#method-offline');
      await babyPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      const offerJson = await waitForBabyOfferQr(babyPage);
      expect(offerJson.length).toBeGreaterThan(0);

      // Verify the offer is valid (ICE gathered without STUN is acceptable —
      // host candidates at 127.0.0.1 are sufficient for loopback).
      const offerData = JSON.parse(offerJson);
      expect(offerData.sdp.type).toBe('offer');

      // Parent: inject offer and generate answer.
      await parentToMethodSelection(parentPage);
      await parentPage.evaluate((json) => {
        window.__TEST_MULTI_SCAN_RESULT = json;
      }, offerJson);
      await parentPage.click('#method-offline');
      await parentPage.waitForSelector('#pairing-offline-step:not(.hidden)', { timeout: 5_000 });

      const answerJson = await waitForParentAnswerQr(parentPage);
      expect(answerJson.length).toBeGreaterThan(0);

      // Baby: inject answer into running scanMulti loop.
      await babyPage.evaluate((json) => {
        window.__TEST_MULTI_SCAN_RESULT = json;
      }, answerJson);

      // Both sides must reach 'connected' even without PeerJS.
      await Promise.all([
        babyPage.waitForFunction(() => window.__peerState === 'connected', { timeout: 30_000 }),
        parentPage.waitForFunction(() => window.__peerState === 'connected', { timeout: 30_000 }),
      ]);

      expect(await babyPage.evaluate(() => window.__peerState)).toBe('connected');
      expect(await parentPage.evaluate(() => window.__peerState)).toBe('connected');

      // The connection method must be 'offline' (not 'peerjs').
      const method = await parentPage.evaluate(
        () => window.__testMonitorConn?.method ?? null,
      );
      expect(method).toBe('offline');

    } finally {
      await Promise.all([
        babyContext.close(),
        parentContext.close(),
      ]);
    }
  });

});
