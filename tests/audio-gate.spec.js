/**
 * audio-gate.spec.js — E2E tests for the baby-side audio gate feature.
 *
 * The audio gate lets the parent configure a noise threshold below which the
 * baby device mutes its outgoing microphone track.  This reduces Opus codec
 * CPU usage and radio transmissions on the baby device, saving battery.
 *
 * Coverage:
 *   (1) Parent control panel exposes the audio gate toggle and threshold slider.
 *   (2) On first connect the parent sends the default gate settings to the baby
 *       and the baby reflects them in its internal state.
 *   (3) When the parent enables the gate with threshold at maximum (100), the
 *       baby's outgoing audio track is disabled after the hold-time elapses
 *       (fake device produces a low-level signal that cannot exceed 100).
 *   (4) Audio gate settings (enabled flag and threshold) are persisted in the
 *       parent's device profile (localStorage) and survive control-panel close.
 *
 * App hooks used:
 *   window.__testOpenControlPanel(deviceId)    — parent: open control panel
 *   window.__testGetMonitorGateSettings(id)    — parent: gate settings from MonitorEntry
 *   window.__testGetAudioGateEnabled()         — baby: state.audioGateEnabled
 *   window.__testGetAudioGateThreshold()       — baby: state.audioGateThreshold
 *   window.__testGetAudioTrackEnabled()        — baby: outgoing track.enabled
 *   window.__testGetGateRunning()              — baby: gate interval is running
 *   window.__peerState                         — both: current connection state
 *
 * Prerequisites:
 *   • App served on http://localhost:3000.
 *   • Playwright launched with --use-fake-device-for-media-stream.
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
// Shared pairing helper (mirrors audio-file-transfer.spec.js pattern)
// ---------------------------------------------------------------------------

async function pairDevices(browser) {
  const { baby, parent, cleanup } = await createDevicePair(browser, { navigate: false });

  await Promise.all([
    baby.page.goto('/baby.html'),
    parent.page.goto('/parent.html'),
  ]);

  const babyPeerId = await setupBabyPeerJs(baby.page);
  await setupParentPeerJs(parent.page, babyPeerId);
  await waitForBothConnected(baby.page, parent.page);

  const deviceId = await parent.page.evaluate(
    () => window.__testMonitorEntry?.deviceId ?? null,
  );

  return { baby, parent, deviceId, cleanup };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Audio gate (baby-side mic gating)', () => {

  test.setTimeout(90_000);

  // -------------------------------------------------------------------------
  // Test 1: Control panel UI elements are present
  // -------------------------------------------------------------------------

  test('parent control panel has audio gate toggle and threshold slider', async ({ browser }) => {
    const { parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      await parent.page.evaluate((id) => window.__testOpenControlPanel(id), deviceId);

      // Gate toggle
      const toggleExists = await parent.page.evaluate(
        () => document.getElementById('cp-audio-gate') !== null,
      );
      expect(toggleExists, '#cp-audio-gate toggle should be present').toBe(true);

      // Threshold slider
      const sliderExists = await parent.page.evaluate(
        () => document.getElementById('cp-audio-gate-threshold') !== null,
      );
      expect(sliderExists, '#cp-audio-gate-threshold slider should be present').toBe(true);

      // Threshold output label
      const labelExists = await parent.page.evaluate(
        () => document.getElementById('cp-audio-gate-threshold-value') !== null,
      );
      expect(labelExists, '#cp-audio-gate-threshold-value output should be present').toBe(true);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Default gate settings sent to baby on connect
  // -------------------------------------------------------------------------

  test('baby receives default gate settings from parent on connect', async ({ browser }) => {
    const { baby, deviceId, parent, cleanup } = await pairDevices(browser);
    try {
      // Gate polling loop should be running after connection
      await baby.page.waitForFunction(
        () => window.__testGetGateRunning?.() === true,
        { timeout: 5_000 },
      );

      // Baby state should reflect the parent's defaults (gate off, threshold 20)
      const gateEnabled = await baby.page.evaluate(
        () => window.__testGetAudioGateEnabled?.() ?? null,
      );
      expect(gateEnabled, 'gate should be disabled by default').toBe(false);

      const gateThreshold = await baby.page.evaluate(
        () => window.__testGetAudioGateThreshold?.() ?? null,
      );
      expect(gateThreshold, 'default threshold should be 20').toBe(20);

      // Parent MonitorEntry should also have defaults
      const parentSettings = await parent.page.evaluate(
        (id) => window.__testGetMonitorGateSettings?.(id) ?? null,
        deviceId,
      );
      expect(parentSettings).toEqual({ enabled: false, threshold: 20 });
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Baby disables audio track when gate enabled at max threshold
  // -------------------------------------------------------------------------

  test('baby mutes outgoing audio track when gate is enabled at maximum threshold', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      // Confirm the track starts enabled
      const trackEnabledBefore = await baby.page.evaluate(
        () => window.__testGetAudioTrackEnabled?.() ?? null,
      );
      expect(trackEnabledBefore, 'audio track should start enabled').toBe(true);

      // Open the control panel and enable the gate at the maximum threshold.
      // Threshold = 100 means the level must exceed 100 to keep the gate open.
      // Since level is capped at 100 (Math.min(100, ...)), the gate can never
      // open — the track will be disabled after the first polling interval.
      await parent.page.evaluate((id) => window.__testOpenControlPanel(id), deviceId);

      await parent.page.evaluate(() => {
        // Set threshold slider to maximum before enabling the toggle so the
        // gate immediately closes once enabled.
        const slider = document.getElementById('cp-audio-gate-threshold');
        if (slider) {
          slider.value = '100';
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      await parent.page.evaluate(() => {
        const toggle = document.getElementById('cp-audio-gate');
        if (toggle && !toggle.checked) {
          toggle.click();
        }
      });

      // Wait for the baby to receive the gate command and for the hold-time
      // (1500 ms) plus two polling cycles (200 ms) to elapse.
      await baby.page.waitForFunction(
        () => window.__testGetAudioGateEnabled?.() === true,
        { timeout: 5_000 },
      );

      // Wait for the gate to close the track (hold expires after 1500 ms)
      await baby.page.waitForFunction(
        () => window.__testGetAudioTrackEnabled?.() === false,
        { timeout: 5_000 },
      );

      const trackEnabledAfter = await baby.page.evaluate(
        () => window.__testGetAudioTrackEnabled?.() ?? null,
      );
      expect(trackEnabledAfter, 'audio track should be disabled when gate is closed').toBe(false);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Gate re-opens after closing (regression for analyser-reads-muted-track bug)
  // -------------------------------------------------------------------------

  test('gate re-opens outgoing audio track after threshold is lowered below signal level', async ({ browser }) => {
    // Regression test: _startAudioGate() originally connected the analyser to
    // the same track it toggles.  When the gate closed the track
    // (audioTrack.enabled = false), the Web Audio API replaced that track's
    // output with silence, so getFloatTimeDomainData() returned zeros and the
    // gate could never re-open regardless of actual noise level.
    // Fix: use a cloned track for analysis so the analyser always sees live
    // mic audio independent of the gate's enabled/disabled state.
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      await parent.page.evaluate((id) => window.__testOpenControlPanel(id), deviceId);

      // Enable gate at threshold=100 — gate closes immediately (level ≤ 100 always).
      await parent.page.evaluate(() => {
        const slider = document.getElementById('cp-audio-gate-threshold');
        if (slider) {
          slider.value = '100';
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const toggle = document.getElementById('cp-audio-gate');
        if (toggle && !toggle.checked) toggle.click();
      });

      // Wait for the baby to close the track.
      await baby.page.waitForFunction(
        () => window.__testGetAudioTrackEnabled?.() === false,
        { timeout: 5_000 },
      );

      // Now lower threshold to 0 — the fake device produces a non-zero signal,
      // so the gate should re-open once the analyser reads a level above 0.
      // Without the clone fix the analyser sees only silence (from the disabled
      // track) and the gate stays permanently closed.
      await parent.page.evaluate(() => {
        const slider = document.getElementById('cp-audio-gate-threshold');
        if (slider) {
          slider.value = '0';
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      // Gate should re-open within two polling cycles + hold reset time.
      await baby.page.waitForFunction(
        () => window.__testGetAudioTrackEnabled?.() === true,
        { timeout: 5_000 },
      );

      const trackEnabled = await baby.page.evaluate(
        () => window.__testGetAudioTrackEnabled?.() ?? null,
      );
      expect(trackEnabled, 'audio track should be re-enabled when gate re-opens').toBe(true);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Gate AudioContext is running (regression for suspended-context bug)
  // -------------------------------------------------------------------------

  test('gate AudioContext is in running state after gate polling starts', async ({ browser }) => {
    // Regression test: _startAudioGate() creates a new AudioContext which
    // starts in 'suspended' state on modern browsers unless .resume() is called.
    // When suspended, getFloatTimeDomainData() returns all zeros, making the
    // audio level always 0 — the gate then closes the track immediately
    // regardless of actual noise, blocking all audio from the baby device.
    const { baby, cleanup } = await pairDevices(browser);
    try {
      // Gate polling loop should be running after connection
      await baby.page.waitForFunction(
        () => window.__testGetGateRunning?.() === true,
        { timeout: 5_000 },
      );

      // The AudioContext must be 'running', not 'suspended', so that
      // getFloatTimeDomainData() returns real audio data.
      const ctxState = await baby.page.evaluate(
        () => window.__testGetGateAudioCtxState?.() ?? null,
      );
      expect(ctxState, 'gate AudioContext must be running — a suspended context returns only zeros, causing the gate to always block audio').toBe('running');
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: Gate settings persist in device profile
  // -------------------------------------------------------------------------

  test('audio gate settings are persisted to the device profile in localStorage', async ({ browser }) => {
    const { parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      await parent.page.evaluate((id) => window.__testOpenControlPanel(id), deviceId);

      // Enable the gate and set a custom threshold
      await parent.page.evaluate(() => {
        const slider = document.getElementById('cp-audio-gate-threshold');
        if (slider) {
          slider.value = '35';
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const toggle = document.getElementById('cp-audio-gate');
        if (toggle && !toggle.checked) toggle.click();
      });

      // Read the device profile from localStorage.
      // Profiles are stored as a JSON array under 'bm:paireddevices'; find the
      // one matching this device ID.
      const profile = await parent.page.evaluate((id) => {
        const raw = localStorage.getItem('bm:paireddevices');
        if (!raw) return null;
        const profiles = JSON.parse(raw);
        return profiles.find((p) => p.id === id) ?? null;
      }, deviceId);

      expect(profile, 'device profile should exist in localStorage').not.toBeNull();
      expect(profile.audioGateEnabled, 'audioGateEnabled should be persisted as true').toBe(true);
      expect(profile.audioGateThreshold, 'audioGateThreshold should be persisted as 35').toBe(35);
    } finally {
      await cleanup();
    }
  });

});
