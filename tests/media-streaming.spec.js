/**
 * media-streaming.spec.js — E2E tests for video and audio streaming (TASK-064)
 *
 * These tests verify that, after a successful PeerJS pairing, the WebRTC
 * media pipeline is genuinely active.  Chromium's fake device flags
 * (--use-fake-device-for-media-stream) inject a solid-colour video frame
 * and a sine-wave audio tone automatically, so no real hardware is needed.
 *
 * Test coverage:
 *   1. Video stream alive   — parent's <video> element has videoWidth > 0 and
 *                             readyState >= 2 (HAVE_CURRENT_DATA) after pairing.
 *   2. Audio/noise active   — noise visualiser aria-valuenow > 0, confirming
 *                             the baby's fake sine-wave audio is flowing.
 *   3. Speak-through ducking — triggering speak-through on the parent calls
 *                             getUserMedia (microphone capture) AND ramps the
 *                             baby-audio GainNode to 0 (TASK-056 ducking).
 *   4. AudioContext gate    — after tap-to-begin satisfies the autoplay policy
 *                             (TASK-037), a new AudioContext starts in 'running'
 *                             state rather than 'suspended'.
 *
 * App hooks used (all defined in TASK-064 additions):
 *   window.__testMonitorEntry          — MonitorEntry for the connected baby
 *   window.__testActivateSpeakThrough  — async(deviceId) → opens control panel
 *                                        and calls startSpeakThrough()
 * App hooks from TASK-063:
 *   window.__peerState                 — 'connected' once pairing complete
 *   window.__testMonitorConn           — last connection added to monitors map
 *   window.__lastStateSnapshot         — last STATE_SNAPSHOT received by parent
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
} = require('./helpers');

// ---------------------------------------------------------------------------
// Shared pairing setup
// ---------------------------------------------------------------------------

/**
 * Fully pair a baby and parent context and wait for both to be 'connected'.
 * Returns the deviceId reported by window.__testMonitorEntry on the parent page.
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

  await Promise.all([
    baby.page.goto('/baby.html'),
    parent.page.goto('/parent.html'),
  ]);

  const babyPeerId = await setupBabyPeerJs(baby.page);
  await setupParentPeerJs(parent.page, babyPeerId);
  await waitForBothConnected(baby.page, parent.page);

  // Read the deviceId from the monitor entry that was just added.
  const deviceId = await parent.page.evaluate(
    () => window.__testMonitorEntry?.deviceId ?? null,
  );

  return { baby, parent, deviceId, cleanup };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Media streaming', () => {

  // -------------------------------------------------------------------------
  // Test 1: Video stream is alive on the parent dashboard
  // -------------------------------------------------------------------------

  test('parent dashboard video has frames after pairing (videoWidth > 0, readyState ≥ 2)', async ({ browser }) => {
    const { parent, cleanup } = await pairDevices(browser);

    try {
      // Wait until the video element has decoded at least one frame.
      // videoWidth > 0  — the decoder knows the frame dimensions (stream active)
      // readyState >= 2 — HAVE_CURRENT_DATA: at least the current frame is available
      await parent.page.waitForFunction(
        () => {
          const video = document.querySelector('.monitor-panel__video');
          if (!video) return false;
          return video.videoWidth > 0 && video.readyState >= 2;
        },
        { timeout: 15_000 },
      );

      const { videoWidth, readyState } = await parent.page.evaluate(() => {
        const video = document.querySelector('.monitor-panel__video');
        return {
          videoWidth:  video?.videoWidth  ?? 0,
          readyState:  video?.readyState  ?? 0,
        };
      });

      expect(videoWidth).toBeGreaterThan(0);
      expect(readyState).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Noise visualiser shows a non-zero level (audio track is live)
  // -------------------------------------------------------------------------

  test('noise visualiser shows non-zero level confirming baby audio track is live', async ({ browser }) => {
    const { parent, cleanup } = await pairDevices(browser);

    try {
      // The noise visualiser ticks on requestAnimationFrame (every 6th frame).
      // Wait until aria-valuenow is updated to a value > 0, confirming the
      // AnalyserNode is receiving real audio data from the fake sine-wave device.
      await parent.page.waitForFunction(
        () => {
          const bar = document.querySelector('.noise-bar');
          if (!bar) return false;
          const val = parseInt(bar.getAttribute('aria-valuenow') ?? '0', 10);
          return val > 0;
        },
        { timeout: 15_000 },
      );

      const level = await parent.page.evaluate(() => {
        const bar = document.querySelector('.noise-bar');
        return parseInt(bar?.getAttribute('aria-valuenow') ?? '0', 10);
      });

      expect(level).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Speak-through — getUserMedia called and baby-audio gain is ducked
  // -------------------------------------------------------------------------

  test('speak-through calls getUserMedia on parent and ramps baby-audio GainNode to zero', async ({ browser }) => {
    const { parent, cleanup } = await pairDevices(browser);

    try {
      // --- 3a. Spy on getUserMedia BEFORE triggering speak-through ---
      // The spy wraps navigator.mediaDevices.getUserMedia so we can detect when
      // it is called (microphone capture for speak-through, TASK-012).
      await parent.page.evaluate(() => {
        window.__getUserMediaCalled = false;
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          window.__getUserMediaCalled = true;
          window.__getUserMediaConstraints = constraints;
          return origGetUserMedia(constraints);
        };
      });

      // --- 3b. Trigger speak-through via the test hook ---
      // __testActivateSpeakThrough(deviceId) calls openControlPanel(deviceId)
      // to set the active device, then calls startSpeakThrough() which invokes
      // getUserMedia and ramps the baby-audio GainNode to 0 (TASK-056).
      const deviceId = await parent.page.evaluate(
        () => window.__testMonitorEntry?.deviceId ?? null,
      );
      expect(deviceId).not.toBeNull();

      await parent.page.evaluate(
        async (id) => { await window.__testActivateSpeakThrough(id); },
        deviceId,
      );

      // --- 3c. Verify getUserMedia was called ---
      await parent.page.waitForFunction(
        () => window.__getUserMediaCalled === true,
        { timeout: 8_000 },
      );

      const constraints = await parent.page.evaluate(
        () => window.__getUserMediaConstraints,
      );
      // The speak-through call requests audio only (with echo cancellation)
      expect(constraints).toHaveProperty('audio');
      expect(constraints.video).toBeFalsy();

      // --- 3d. Verify the baby-audio GainNode was ducked toward 0 ---
      // The ramp takes 200 ms; wait 350 ms to ensure it has completed.
      await parent.page.waitForTimeout(350);

      const gainValue = await parent.page.evaluate(() => {
        const entry = window.__testMonitorEntry;
        if (!entry?.gainNode) return null;
        return entry.gainNode.gain.value;
      });

      expect(gainValue).not.toBeNull();
      // After the 200 ms linear ramp the gain should be at or very close to 0.
      expect(gainValue).toBeLessThan(0.05);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Baby AudioContext is in 'running' state after tap-to-begin
  // -------------------------------------------------------------------------
  //
  // TASK-037 implements the tap-to-begin overlay to satisfy the browser's
  // autoplay/AudioContext policy.  After the tap gesture, any AudioContext
  // created on the page should start in 'running' (not 'suspended') state,
  // confirming the user-activation gate was properly handled.
  //
  // This test verifies the gate on the baby page: it checks immediately after
  // the tap-to-begin click — before getUserMedia is called during pairing —
  // to prove the policy was satisfied by the tap gesture alone.

  test('baby AudioContext is in running state after tap-to-begin satisfies autoplay gate', async ({ browser }) => {
    const { baby, cleanup } = await createDevicePair(browser, { navigate: false });

    try {
      await baby.page.goto('/baby.html');

      // Click the tap-to-begin overlay (TASK-037 gate satisfaction).
      await baby.page.click('#tap-overlay');

      // Immediately after the click (still within the user-activation window),
      // create a new AudioContext and read its state.  If tap-to-begin correctly
      // satisfied the autoplay policy, the context should start as 'running'.
      const audioCtxState = await baby.page.evaluate(() => {
        const ctx = new AudioContext();
        const state = ctx.state;
        // Close it so we don't leak resources in the test browser context.
        ctx.close();
        return state;
      });

      expect(audioCtxState).toBe('running');
    } finally {
      await cleanup();
    }
  });

});
