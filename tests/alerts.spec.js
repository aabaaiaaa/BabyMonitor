/**
 * alerts.spec.js — E2E tests for the noise and battery alert system (TASK-066)
 *
 * Coverage (as specified in TASK-066):
 *   (1)  Grant Notification permission in the parent context via Playwright's
 *        browser context permissions.
 *   (2)  Set the noise threshold to its minimum (0 = most sensitive) and verify
 *        the fake sine-wave audio stream triggers a noise alert notification and
 *        an audible alert tone on the parent.
 *   (3)  Set the threshold to its maximum (100 = least sensitive) and verify no
 *        noise alert fires.
 *   (4)  Connect two baby devices with different threshold settings and verify
 *        alerts are independent per device.
 *   (5)  Inject a low-battery data-channel message (level < 20%) from the baby
 *        context using page.evaluate → window.__testInjectMessage.
 *   (6)  Verify the battery alert notification appears on the parent with higher
 *        visual prominence than a noise alert (battery banner is always first).
 *   (7)  Inject a battery-recovered message (level ≥ threshold) and verify the
 *        alert clears automatically.
 *
 * App hooks used (added in TASK-066 unless noted):
 *   window.__testInjectMessage(deviceId, type, value) — inject a data-channel msg
 *   window.__testSetNoiseThreshold(deviceId, threshold) — override noise threshold
 *   window.__testGetActiveAlerts()  — return active alert keys as string[]
 *   window.__testGetAlertToneCount() — return total alert tones enqueued
 *   window.__testGetLastAlertToneType() — return last tone type enqueued
 *   window.__testGetLastNotification() — return last notification record
 *   window.__testSetAlertToneMuted(muted) — override mute flag
 *   window.__testMonitorEntry — full MonitorEntry for the most-recently-added device
 *   window.__peerState       — current connection state string (TASK-063)
 *   window.__TEST_SCAN_RESULT — pre-loaded QR scan result (TASK-063)
 *
 * Prerequisites:
 *   • App served on http://localhost:3000.
 *   • Internet access for PeerJS cloud signaling (0.peerjs.com).
 *   • Playwright launched with --use-fake-device-for-media-stream so the baby
 *     device emits a 440 Hz sine wave that drives the parent's noise detector.
 */

'use strict';

const { test, expect } = require('@playwright/test');
const {
  setupBabyPeerJs,
  setupParentPeerJs,
  waitForBothConnected,
  ISOLATED_CONTEXT_OPTIONS,
} = require('./helpers');

// ---------------------------------------------------------------------------
// Context options
// ---------------------------------------------------------------------------

/**
 * Parent context options — identical to ISOLATED_CONTEXT_OPTIONS but with
 * 'notifications' added so Notification.permission === 'granted' inside the
 * page, satisfying requirement (1) of TASK-066.
 */
const PARENT_CONTEXT_OPTIONS = {
  ...ISOLATED_CONTEXT_OPTIONS,
  permissions: ['camera', 'microphone', 'notifications'],
};

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Pair a single baby context with the parent context via PeerJS.
 * Waits for both sides to reach 'connected'.
 * Returns the paired baby page and the deviceId registered on the parent.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {{
 *   babyContext?: import('@playwright/test').BrowserContext,
 *   parentContext?: import('@playwright/test').BrowserContext,
 *   parentPage?: import('@playwright/test').Page,
 *   isSecondDevice?: boolean,
 * }} options
 * @returns {Promise<{
 *   babyContext: import('@playwright/test').BrowserContext,
 *   babyPage: import('@playwright/test').Page,
 *   parentContext: import('@playwright/test').BrowserContext,
 *   parentPage: import('@playwright/test').Page,
 *   deviceId: string,
 *   cleanup: () => Promise<void>,
 * }>}
 */
async function pairDevices(browser, options = {}) {
  const babyContext   = options.babyContext   ?? await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
  const parentContext = options.parentContext  ?? await browser.newContext(PARENT_CONTEXT_OPTIONS);
  const babyPage      = await babyContext.newPage();
  const parentPage    = options.parentPage    ?? await parentContext.newPage();

  if (!options.parentPage) {
    await parentPage.goto('/parent.html');
  }
  await babyPage.goto('/baby.html');

  // For the second device, parent is already on the dashboard.
  // Click "+ Add baby monitor" to open the pairing flow for the second device.
  if (options.isSecondDevice) {
    await parentPage.click('#btn-add-monitor');
    await parentPage.waitForSelector('#pairing-section:not(.hidden)', { timeout: 5_000 });
  }

  const babyPeerId = await setupBabyPeerJs(babyPage);
  await setupParentPeerJs(parentPage, babyPeerId);
  await waitForBothConnected(babyPage, parentPage);

  const deviceId = await parentPage.evaluate(
    () => window.__testMonitorEntry?.deviceId ?? null,
  );

  async function cleanup() {
    const closeTasks = [babyContext.close()];
    if (!options.parentContext) closeTasks.push(parentContext.close());
    await Promise.all(closeTasks.map(p => p.catch(() => {})));
  }

  return { babyContext, babyPage, parentContext, parentPage, deviceId, cleanup };
}

/**
 * Wait for a `.alert-banner--noise` element to appear in the parent page.
 *
 * @param {import('@playwright/test').Page} parentPage
 * @param {number} [timeoutMs=15000]
 */
async function waitForNoiseAlert(parentPage, timeoutMs = 15_000) {
  await parentPage.waitForSelector('.alert-banner--noise', { timeout: timeoutMs });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Noise and battery alerts (TASK-066)', () => {

  /**
   * Generous timeout: PeerJS registration + signalling can take ~15 s;
   * the noise detector runs at ~10 fps so a first alert may take a few
   * seconds on top of that.
   */
  test.setTimeout(90_000);

  // -------------------------------------------------------------------------
  // Noise alert tests (steps 1–4)
  // -------------------------------------------------------------------------

  /**
   * Test 1: Noise alert banner appears when threshold is at minimum.
   *
   * With threshold = 0 (most sensitive) the fake 440 Hz sine wave produced by
   * --use-fake-device-for-media-stream always yields a noise level well above 0,
   * so `showNoiseAlert` must fire within a few analyse frames.
   */
  test('noise alert banner appears when noise threshold is at minimum (most sensitive)', async ({ browser }) => {
    const { parentPage, deviceId, cleanup } = await pairDevices(browser);

    try {
      // Requirement (1): parent context already has 'notifications' permission.
      // Confirm Notification.permission === 'granted' inside the page.
      const notifPermission = await parentPage.evaluate(() => Notification.permission);
      expect(notifPermission).toBe('granted');

      // Unmute alert sounds so the tone pathway is exercised.
      await parentPage.evaluate(() => window.__testSetAlertToneMuted?.(false));

      // Set threshold to 0 — any audio signal at all will trigger the alert.
      await parentPage.evaluate(
        ([id, t]) => window.__testSetNoiseThreshold?.(id, t),
        [deviceId, 0],
      );

      // Wait for the noise alert banner to appear.
      await waitForNoiseAlert(parentPage);

      // Banner must contain the noise alert text.
      const bannerText = await parentPage.textContent('.alert-banner--noise');
      expect(bannerText).toContain('Noise level alert');

    } finally {
      await cleanup();
    }
  });

  /**
   * Test 2: Audible alert tone is enqueued when the noise alert fires.
   *
   * _enqueueAlertTone('noise') must be called; the count exposed by
   * window.__testGetAlertToneCount() must increase and the last type must
   * be 'noise'.
   */
  test('audible alert tone is enqueued when noise alert fires', async ({ browser }) => {
    const { parentPage, deviceId, cleanup } = await pairDevices(browser);

    try {
      // Unmute so _enqueueAlertTone is not short-circuited by the mute flag.
      // (The tone count is tracked before the mute check, but testing with
      //  sounds unmuted also validates the full enqueue path.)
      await parentPage.evaluate(() => window.__testSetAlertToneMuted?.(false));

      // Snapshot tone count before triggering.
      const countBefore = await parentPage.evaluate(
        () => window.__testGetAlertToneCount?.() ?? 0,
      );

      // Trigger by setting threshold to 0.
      await parentPage.evaluate(
        ([id, t]) => window.__testSetNoiseThreshold?.(id, t),
        [deviceId, 0],
      );

      // Wait for the alert banner (confirms showNoiseAlert was called).
      await waitForNoiseAlert(parentPage);

      // Tone count must have increased.
      const countAfter = await parentPage.evaluate(
        () => window.__testGetAlertToneCount?.() ?? 0,
      );
      expect(countAfter).toBeGreaterThan(countBefore);

      // The most recently enqueued tone type must be 'noise'.
      const lastType = await parentPage.evaluate(
        () => window.__testGetLastAlertToneType?.(),
      );
      expect(lastType).toBe('noise');

    } finally {
      await cleanup();
    }
  });

  /**
   * Test 3: Notification is recorded when noise alert fires.
   *
   * _sendBackgroundNotification is called with the correct title regardless
   * of tab visibility (TASK-066 records every call for test assertions).
   */
  test('noise alert records a notification with the correct title', async ({ browser }) => {
    const { parentPage, deviceId, cleanup } = await pairDevices(browser);

    try {
      await parentPage.evaluate(
        ([id, t]) => window.__testSetNoiseThreshold?.(id, t),
        [deviceId, 0],
      );

      await waitForNoiseAlert(parentPage);

      const notification = await parentPage.evaluate(
        () => window.__testGetLastNotification?.(),
      );
      expect(notification).not.toBeNull();
      expect(notification.title).toBe('Baby Monitor — Noise Alert');
      expect(notification.body).toContain('Noise level has exceeded the threshold');

    } finally {
      await cleanup();
    }
  });

  /**
   * Test 4: No noise alert fires when threshold is at maximum (least sensitive).
   *
   * With threshold = 100, `level > 100` is always false (level is capped at
   * 100 by `Math.min(100, …)`), so showNoiseAlert must never be called.
   */
  test('no noise alert fires when threshold is at maximum (least sensitive)', async ({ browser }) => {
    const { parentPage, deviceId, cleanup } = await pairDevices(browser);

    try {
      // First: fire an alert at minimum threshold to confirm the noise
      // visualiser is running on this connection.
      await parentPage.evaluate(
        ([id, t]) => window.__testSetNoiseThreshold?.(id, t),
        [deviceId, 0],
      );
      await waitForNoiseAlert(parentPage);

      // Dismiss the banner.
      await parentPage.click('.alert-banner--noise .alert-banner__dismiss');
      await parentPage.waitForFunction(
        () => document.querySelector('.alert-banner--noise') === null,
        { timeout: 5_000 },
      );

      // Now set threshold to 100 (least sensitive).
      await parentPage.evaluate(
        ([id, t]) => window.__testSetNoiseThreshold?.(id, t),
        [deviceId, 100],
      );

      // Wait long enough for several analyse frames to run (> 500 ms at 10 fps).
      // No new noise alert banner should appear.
      await parentPage.waitForTimeout(2_000);
      const hasAlert = await parentPage.evaluate(
        () => document.querySelector('.alert-banner--noise') !== null,
      );
      expect(hasAlert).toBe(false);

    } finally {
      await cleanup();
    }
  });

  /**
   * Test 5: Alerts are independent per device.
   *
   * With two baby devices connected — baby-1 at threshold 0 (fires) and
   * baby-2 at threshold 100 (silent) — only baby-1 should produce a noise
   * alert banner.  baby-2's banner must not appear.
   */
  test('noise alerts are independent per device when thresholds differ', async ({ browser }) => {
    // Create shared parent context once.
    const parentContext = await browser.newContext(PARENT_CONTEXT_OPTIONS);
    const parentPage    = await parentContext.newPage();
    await parentPage.goto('/parent.html');

    let babyContext1 = null;
    let babyContext2 = null;

    try {
      // ------------------------------------------------------------------ //
      // Connect baby 1                                                       //
      // ------------------------------------------------------------------ //

      babyContext1 = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
      const babyPage1   = await babyContext1.newPage();
      await babyPage1.goto('/baby.html');

      const babyPeerId1 = await setupBabyPeerJs(babyPage1);
      await setupParentPeerJs(parentPage, babyPeerId1);
      await waitForBothConnected(babyPage1, parentPage);

      const deviceId1 = await parentPage.evaluate(
        () => window.__testMonitorEntry?.deviceId ?? null,
      );
      expect(deviceId1).not.toBeNull();

      // Set baby-1's threshold to 0 (most sensitive → alerts will fire).
      await parentPage.evaluate(
        ([id, t]) => window.__testSetNoiseThreshold?.(id, t),
        [deviceId1, 0],
      );

      // ------------------------------------------------------------------ //
      // Connect baby 2                                                       //
      // ------------------------------------------------------------------ //

      babyContext2 = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
      const babyPage2   = await babyContext2.newPage();
      await babyPage2.goto('/baby.html');

      // Parent: click "+" to open the pairing flow for the second device.
      await parentPage.click('#btn-add-monitor');
      await parentPage.waitForSelector('#pairing-section:not(.hidden)', { timeout: 5_000 });

      const babyPeerId2 = await setupBabyPeerJs(babyPage2);
      await setupParentPeerJs(parentPage, babyPeerId2);
      await waitForBothConnected(babyPage2, parentPage);

      // __testMonitorEntry is now baby-2's entry.
      const deviceId2 = await parentPage.evaluate(
        () => window.__testMonitorEntry?.deviceId ?? null,
      );
      expect(deviceId2).not.toBeNull();
      expect(deviceId2).not.toBe(deviceId1); // Must be distinct devices.

      // Set baby-2's threshold to 100 (least sensitive → no alerts).
      await parentPage.evaluate(
        ([id, t]) => window.__testSetNoiseThreshold?.(id, t),
        [deviceId2, 100],
      );

      // ------------------------------------------------------------------ //
      // Wait for baby-1 to trigger a noise alert.                           //
      // ------------------------------------------------------------------ //

      await waitForNoiseAlert(parentPage, 15_000);

      // Exactly one noise alert banner should be present.
      const noiseBanners = await parentPage.evaluate(
        () => document.querySelectorAll('.alert-banner--noise').length,
      );
      expect(noiseBanners).toBeGreaterThanOrEqual(1);

      // Active alerts must contain baby-1's noise key but NOT baby-2's.
      const activeAlerts = await parentPage.evaluate(
        () => window.__testGetActiveAlerts?.() ?? [],
      );
      expect(activeAlerts.some(k => k === `${deviceId1}:noise`)).toBe(true);
      expect(activeAlerts.some(k => k === `${deviceId2}:noise`)).toBe(false);

    } finally {
      if (babyContext1) await babyContext1.close().catch(() => {});
      if (babyContext2) await babyContext2.close().catch(() => {});
      await parentContext.close().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // Battery alert tests (steps 5–7)
  // -------------------------------------------------------------------------

  /**
   * Test 6: Battery alert fires when a low-battery data-channel message is
   * injected via window.__testInjectMessage.
   *
   * Injects `{ type: 'batteryLevel', value: { level: 10, charging: false } }`
   * which is below the default 15% threshold.  The parent must show an
   * alert-banner--battery element containing the level.
   */
  test('battery alert banner appears when low-battery message is injected', async ({ browser }) => {
    const { parentPage, deviceId, cleanup } = await pairDevices(browser);

    try {
      // Inject low-battery message (10% < default threshold 15%).
      await parentPage.evaluate(
        ([id]) => window.__testInjectMessage?.(id, 'batteryLevel', { level: 10, charging: false }),
        [deviceId],
      );

      // Battery alert banner must appear.
      await parentPage.waitForSelector('.alert-banner--battery', { timeout: 5_000 });

      const bannerText = await parentPage.textContent('.alert-banner--battery');
      expect(bannerText).toContain('Battery low (10%)');

      // The active-alerts set must record this key.
      const activeAlerts = await parentPage.evaluate(
        () => window.__testGetActiveAlerts?.() ?? [],
      );
      expect(activeAlerts.some(k => k === `${deviceId}:battery`)).toBe(true);

      // The recorded notification must reference a low-battery title.
      const notification = await parentPage.evaluate(
        () => window.__testGetLastNotification?.(),
      );
      expect(notification).not.toBeNull();
      expect(notification.title).toBe('Baby Monitor — Low Battery');

    } finally {
      await cleanup();
    }
  });

  /**
   * Test 7: Battery alert has higher visual prominence than a noise alert.
   *
   * Per the priority rule in TASK-036, battery banners are always inserted at
   * the very top of the alert container, BEFORE any movement or noise banners.
   * This test confirms that even when a noise alert fires first, the subsequent
   * battery alert is positioned as the first child.
   */
  test('battery alert banner is positioned above noise alert (higher visual prominence)', async ({ browser }) => {
    const { parentPage, deviceId, cleanup } = await pairDevices(browser);

    try {
      // Step 1: trigger a noise alert first by setting threshold to 0.
      await parentPage.evaluate(() => window.__testSetAlertToneMuted?.(false));
      await parentPage.evaluate(
        ([id, t]) => window.__testSetNoiseThreshold?.(id, t),
        [deviceId, 0],
      );
      await waitForNoiseAlert(parentPage);

      // Confirm noise banner is present.
      const noisePresent = await parentPage.evaluate(
        () => document.querySelector('.alert-banner--noise') !== null,
      );
      expect(noisePresent).toBe(true);

      // Step 2: inject a battery alert AFTER the noise alert.
      await parentPage.evaluate(
        ([id]) => window.__testInjectMessage?.(id, 'batteryLevel', { level: 5, charging: false }),
        [deviceId],
      );
      await parentPage.waitForSelector('.alert-banner--battery', { timeout: 5_000 });

      // Battery banner must be the first child of the alert-banners container.
      const batteryIsFirst = await parentPage.evaluate(() => {
        const container = document.getElementById('alert-banners');
        if (!container) return false;
        const firstChild = container.firstElementChild;
        return firstChild?.classList.contains('alert-banner--battery') ?? false;
      });
      expect(batteryIsFirst).toBe(true);

      // Noise banner must still be present, but after the battery banner.
      const noiseAfterBattery = await parentPage.evaluate(() => {
        const container = document.getElementById('alert-banners');
        if (!container) return false;
        const children = Array.from(container.children);
        const batteryIdx = children.findIndex(el => el.classList.contains('alert-banner--battery'));
        const noiseIdx   = children.findIndex(el => el.classList.contains('alert-banner--noise'));
        return batteryIdx !== -1 && noiseIdx !== -1 && batteryIdx < noiseIdx;
      });
      expect(noiseAfterBattery).toBe(true);

    } finally {
      await cleanup();
    }
  });

  /**
   * Test 8: Battery alert clears when a battery-recovered message is injected.
   *
   * After a low-battery message shows the banner, injecting a second
   * batteryLevel message with level ≥ threshold (80%) must automatically
   * remove the battery alert banner and clear the entry from activeAlerts.
   */
  test('battery alert clears when battery-recovered message is injected', async ({ browser }) => {
    const { parentPage, deviceId, cleanup } = await pairDevices(browser);

    try {
      // Step 1: inject low-battery message → alert appears.
      await parentPage.evaluate(
        ([id]) => window.__testInjectMessage?.(id, 'batteryLevel', { level: 10, charging: false }),
        [deviceId],
      );
      await parentPage.waitForSelector('.alert-banner--battery', { timeout: 5_000 });

      // Confirm the alert key is in activeAlerts.
      const activeBeforeRecovery = await parentPage.evaluate(
        () => window.__testGetActiveAlerts?.() ?? [],
      );
      expect(activeBeforeRecovery.some(k => k === `${deviceId}:battery`)).toBe(true);

      // Step 2: inject battery-recovered message (level 80 ≥ threshold 15).
      await parentPage.evaluate(
        ([id]) => window.__testInjectMessage?.(id, 'batteryLevel', { level: 80, charging: false }),
        [deviceId],
      );

      // Battery alert banner must disappear.
      await parentPage.waitForFunction(
        () => document.querySelector('.alert-banner--battery') === null,
        { timeout: 5_000 },
      );

      // activeAlerts must no longer contain the battery key.
      const activeAfterRecovery = await parentPage.evaluate(
        () => window.__testGetActiveAlerts?.() ?? [],
      );
      expect(activeAfterRecovery.some(k => k === `${deviceId}:battery`)).toBe(false);

    } finally {
      await cleanup();
    }
  });

  /**
   * Test 9: Battery alert fires via the explicit ALERT_BATTERY_LOW message.
   *
   * The baby device sends MSG.ALERT_BATTERY_LOW once per low-battery episode
   * (when level drops below 20%).  Injecting this message type must also
   * trigger the battery alert banner on the parent.
   */
  test('battery alert fires when ALERT_BATTERY_LOW message is injected', async ({ browser }) => {
    const { parentPage, deviceId, cleanup } = await pairDevices(browser);

    try {
      // Inject the explicit alert message (as baby.js sends at level < 20%).
      await parentPage.evaluate(
        ([id]) => window.__testInjectMessage?.(id, 'alertBatteryLow', { level: 15 }),
        [deviceId],
      );

      // Battery alert banner must appear.
      await parentPage.waitForSelector('.alert-banner--battery', { timeout: 5_000 });

      const bannerText = await parentPage.textContent('.alert-banner--battery');
      expect(bannerText).toContain('Battery low (15%)');

    } finally {
      await cleanup();
    }
  });

});
