/**
 * audio-file-transfer.spec.js — E2E tests for audio file transfer (TASK-068)
 *
 * Coverage (as specified in TASK-068):
 *   (1)  After pairing, inject a small synthetic WAV Blob into the parent
 *        context's file picker via page.setInputFiles, trigger the transfer
 *        and verify a progress indicator appears in the parent UI.
 *   (2)  Verify the baby context receives the file and it appears in the
 *        local audio library (listAudioFiles returns a matching entry).
 *   (3)  Verify the transferred file can be selected for playback on the
 *        baby device — AudioContext decodes the buffer without error and the
 *        isFileAudioPlaying flag transitions to true.
 *   (4)  Simulate a mid-transfer interruption by closing the data channel
 *        using page.evaluate → __testCloseMonitorDataChannel; verify the
 *        parent UI clears the partial transfer cleanly (progress hidden,
 *        _activeTransfer null) without throwing an unhandled error.
 *   (5)  Attempt to start a second transfer while one is already in progress
 *        and verify it is rejected with a user-visible alert message,
 *        confirming the no-concurrent-transfers rule.
 *
 * App hooks used (added in TASK-068 unless noted):
 *   window.__testGetActiveTransfer()           — parent: current transfer state or null
 *   window.__testOpenControlPanel(deviceId)    — parent: open control panel for device
 *   window.__testSaveAudioFileToParentLibrary(name, base64, mime) — parent: add library file
 *   window.__testSendLibraryFileToBaby(id, name) — parent: trigger library-file send
 *   window.__testSetTransferChunkDelay(ms)     — parent: per-chunk delay for reliable testing
 *   window.__testCloseMonitorDataChannel(id)   — parent: close data channel mid-transfer
 *   window.__testGetIncomingTransfer()         — baby: current incoming transfer info or null
 *   window.__testGetReceivedFileId()           — baby: IndexedDB ID of last received file
 *   window.__testListAudioFiles()              — baby: Promise<array> of audio library entries
 *   window.__testPlayReceivedFile()            — baby: trigger playback of last received file
 *   window.__testIsFileAudioPlaying()          — baby: true while transferred file is playing
 *   window.__testIsTransferProgressVisible()   — baby: true while transfer overlay is visible
 *   window.__testGetAudioContextState()        — baby: AudioContext state string (TASK-065)
 *   window.__testMonitorEntry                  — parent: most-recently-added MonitorEntry (TASK-063)
 *   window.__peerState                         — current peer connection state (TASK-063)
 *
 * Prerequisites:
 *   • App served on http://localhost:3000 (npx serve .. -l 3000 from tests/).
 *   • Internet access for PeerJS cloud signaling (0.peerjs.com).
 *   • Playwright launched with --use-fake-device-for-media-stream (configured
 *     in playwright.config.js) so getUserMedia succeeds without real hardware.
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
// WAV file generator
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PCM WAV audio Buffer containing silence.
 * Chrome's Web Audio API decodes this format (16-bit mono PCM, any sample
 * rate) without error, making it suitable for transfer-and-playback tests.
 *
 * @param {number} durationSec  — duration in seconds
 * @param {number} [sampleRate=44100]
 * @returns {Buffer}
 */
function createSilentWav(durationSec, sampleRate = 44_100) {
  const channels      = 1;
  const bitsPerSample = 16;
  const numSamples    = Math.floor(sampleRate * durationSec);
  const dataSize      = numSamples * (bitsPerSample / 8);
  const blockAlign    = channels * (bitsPerSample / 8);
  const byteRate      = sampleRate * blockAlign;

  const buf = Buffer.alloc(44 + dataSize);   // allocates zero-filled = silence

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);  // ChunkSize
  buf.write('WAVE', 8);

  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);            // SubChunk1Size (PCM)
  buf.writeUInt16LE(1, 20);             // AudioFormat = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);

  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);      // SubChunk2Size

  // Data region is already zero (silence) from Buffer.alloc.
  return buf;
}

// ---------------------------------------------------------------------------
// Small file: 0.2 s — fits in a single 16 KB chunk; used for success tests
// and the concurrent-transfer test (transfer completes quickly).
// ---------------------------------------------------------------------------
const SMALL_WAV = createSilentWav(0.2);

// ---------------------------------------------------------------------------
// Large file: ~6 s — ≈33 chunks of 16 KB; used with the 50 ms per-chunk
// test delay so the mid-transfer interrupt test has a reliable window.
// ---------------------------------------------------------------------------
const LARGE_WAV = createSilentWav(6);

// ---------------------------------------------------------------------------
// Shared pairing setup
// ---------------------------------------------------------------------------

/**
 * Fully pair a baby and parent context via PeerJS and wait for both to reach
 * 'connected'.  Returns baby device, parent device, the baby's deviceId as
 * seen by the parent, and a cleanup function.
 *
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<{
 *   baby:     { context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page },
 *   parent:   { context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page },
 *   deviceId: string,
 *   cleanup:  () => Promise<void>
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

  // The parent exposes __testMonitorEntry once addMonitor() runs.
  const deviceId = await parent.page.evaluate(
    () => window.__testMonitorEntry?.deviceId ?? null,
  );

  return { baby, parent, deviceId, cleanup };
}

// ---------------------------------------------------------------------------
// Helper: start a file transfer via the parent's control panel UI
// ---------------------------------------------------------------------------

/**
 * Open the parent control panel for the given device and send the supplied
 * WAV buffer via the file-picker input.  Returns without waiting for the
 * transfer to complete.
 *
 * @param {import('@playwright/test').Page} parentPage
 * @param {string}  deviceId
 * @param {Buffer}  wavBuffer
 * @param {string}  [fileName='test-audio.wav']
 */
async function startTransfer(parentPage, deviceId, wavBuffer, fileName = 'test-audio.wav') {
  // Open the control panel for this baby device.
  await parentPage.evaluate((id) => window.__testOpenControlPanel(id), deviceId);

  // Inject the WAV file into the (visually hidden) file input.
  // setInputFiles works on hidden <input type="file"> elements — no force
  // option is required because Playwright bypasses the native file picker.
  await parentPage.setInputFiles('#cp-audio-file', {
    name:     fileName,
    mimeType: 'audio/wav',
    buffer:   wavBuffer,
  });

  // Wait for the change event to enable the send button.
  await parentPage.waitForFunction(
    () => {
      const btn = document.getElementById('cp-send-audio');
      return btn != null && !btn.disabled;
    },
    { timeout: 3_000 },
  );

  // Click the send button to start the transfer.
  await parentPage.click('#cp-send-audio');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Audio file transfer (TASK-068)', () => {

  /**
   * 90 s per test: generous to accommodate PeerJS registration (~15 s),
   * chunk-delay transfers (6 s WAV × 50 ms/chunk ≈ 1.6 s), and assertions.
   */
  test.setTimeout(90_000);

  // -------------------------------------------------------------------------
  // Test 1: Progress indicator appears in the parent UI during transfer
  // -------------------------------------------------------------------------

  test('parent shows transfer progress indicator while sending the file', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      // Add a per-chunk delay so the test can observe the in-progress state
      // before the small file's single chunk has been sent.
      await parent.page.evaluate(() => window.__testSetTransferChunkDelay(80));

      // Kick off the transfer (does not await completion).
      await startTransfer(parent.page, deviceId, SMALL_WAV, 'progress-test.wav');

      // Verify the progress bar becomes visible while the transfer runs.
      await parent.page.waitForSelector('#cp-transfer-progress:not(.hidden)', {
        timeout: 5_000,
      });

      // Wait for the transfer to complete (progress bar hides, _activeTransfer null).
      await parent.page.waitForFunction(
        () => window.__testGetActiveTransfer() === null,
        { timeout: 15_000 },
      );

      // After completion the progress bar must be hidden again.
      const progressHidden = await parent.page.evaluate(
        () => document.getElementById('cp-transfer-progress')?.classList.contains('hidden') ?? true,
      );
      expect(progressHidden).toBe(true);
    } finally {
      await parent.page.evaluate(() => window.__testSetTransferChunkDelay(0));
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Baby receives the file and it appears in the local audio library
  // -------------------------------------------------------------------------

  test('baby receives the file and it appears in the local audio library', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      // Count library entries before the transfer.
      const countBefore = await baby.page.evaluate(async () => {
        const files = await window.__testListAudioFiles();
        return files.length;
      });

      await startTransfer(parent.page, deviceId, SMALL_WAV, 'library-test.wav');

      // Wait until the baby has a non-null _receivedFileDbId — this means
      // _finaliseTransfer() completed and the file was saved to IndexedDB.
      await baby.page.waitForFunction(
        () => window.__testGetReceivedFileId() !== null,
        { timeout: 15_000 },
      );

      // The audio library should now contain one more entry than before.
      const filesAfter = await baby.page.evaluate(
        () => window.__testListAudioFiles(),
      );

      expect(filesAfter.length).toBeGreaterThan(countBefore);

      // The transferred file must appear in the library with a matching name.
      const match = filesAfter.find((f) => f.name === 'library-test.wav');
      expect(match).toBeDefined();
      expect(match.size).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Transferred file can be selected for playback without decode error
  // -------------------------------------------------------------------------

  test('transferred file loads into AudioContext and plays without error', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      // Transfer a 0.2-second silent WAV — valid PCM that Chrome decodes.
      await startTransfer(parent.page, deviceId, SMALL_WAV, 'playback-test.wav');

      // Wait for the file to be received and saved on the baby side.
      await baby.page.waitForFunction(
        () => window.__testGetReceivedFileId() !== null,
        { timeout: 15_000 },
      );

      // Trigger playback of the received file.
      // _playReceivedFile() calls decodeAudioData() internally; if the WAV is
      // invalid it throws, which would cause __testPlayReceivedFile to reject.
      await baby.page.evaluate(() => window.__testPlayReceivedFile());

      // After a successful decode the AudioContext must be in 'running' state.
      await baby.page.waitForFunction(
        () => window.__testGetAudioContextState?.() === 'running',
        { timeout: 5_000 },
      );

      // The audio file must be actively playing (source node is connected).
      await baby.page.waitForFunction(
        () => window.__testIsFileAudioPlaying?.() === true,
        { timeout: 5_000 },
      );

      // Verify the AudioContext state is 'running' (explicit assertion).
      const audioState = await baby.page.evaluate(
        () => window.__testGetAudioContextState?.() ?? null,
      );
      expect(audioState).toBe('running');

      // Verify the file is marked as playing.
      const isPlaying = await baby.page.evaluate(
        () => window.__testIsFileAudioPlaying?.() ?? false,
      );
      expect(isPlaying).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 4 (loop fix): Voice recording AudioBufferSourceNode has loop enabled
  // -------------------------------------------------------------------------

  test('transferred file plays on loop — AudioBufferSourceNode.loop is true', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      await startTransfer(parent.page, deviceId, SMALL_WAV, 'loop-test.wav');

      await baby.page.waitForFunction(
        () => window.__testGetReceivedFileId() !== null,
        { timeout: 15_000 },
      );

      await baby.page.evaluate(() => window.__testPlayReceivedFile());

      await baby.page.waitForFunction(
        () => window.__testIsFileAudioPlaying?.() === true,
        { timeout: 5_000 },
      );

      const loop = await baby.page.evaluate(
        () => window.__testGetAudioSourceLoop?.() ?? null,
      );
      expect(loop, 'AudioBufferSourceNode.loop should be true so the recording repeats').toBe(true);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Mid-transfer interruption — data channel closed, UI clears cleanly
  // -------------------------------------------------------------------------

  test('closing the data channel mid-transfer clears the parent UI without unhandled errors', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);

    // Collect any unhandled page errors during this test.
    const pageErrors = [];
    parent.page.on('pageerror', (err) => pageErrors.push(err.message));

    try {
      // Set a 50 ms delay per chunk so the loop runs slowly enough for the
      // test to intercept after a few chunks have been sent.
      await parent.page.evaluate(() => window.__testSetTransferChunkDelay(50));

      // Start the large-file transfer (≈33 chunks × 50 ms = ~1.65 s window).
      await startTransfer(parent.page, deviceId, LARGE_WAV, 'interrupt-test.wav');

      // Wait until the parent has sent at least 5 chunks — this confirms the
      // transfer loop is mid-flight and the progress bar is visible.
      await parent.page.waitForFunction(
        () => (window.__testGetActiveTransfer()?.sentChunks ?? 0) >= 5,
        { timeout: 10_000 },
      );

      // Confirm the baby-side progress overlay is visible (FILE_META received).
      const babyProgressVisible = await baby.page.evaluate(
        () => window.__testIsTransferProgressVisible?.() ?? false,
      );
      expect(babyProgressVisible).toBe(true);

      // Simulate mid-transfer interruption by closing the data channel from
      // the parent side via page.evaluate — the transfer loop will catch the
      // resulting send error on its next iteration and clean up _activeTransfer.
      await parent.page.evaluate(
        (id) => window.__testCloseMonitorDataChannel(id),
        deviceId,
      );

      // Wait for the transfer loop's catch block to clear _activeTransfer.
      // Timeout is generous: catch block runs after the next 50 ms chunk delay.
      await parent.page.waitForFunction(
        () => window.__testGetActiveTransfer() === null,
        { timeout: 5_000 },
      );

      // The progress bar must be hidden after the abort (set by _clearTransferUi).
      const progressHidden = await parent.page.evaluate(
        () =>
          document
            .getElementById('cp-transfer-progress')
            ?.classList.contains('hidden') ?? true,
      );
      expect(progressHidden).toBe(true);

      // Wait for the baby-side progress overlay to also be hidden (it is
      // cleared by handleDisconnect when the connection drops).
      await baby.page.waitForFunction(
        () => !(window.__testIsTransferProgressVisible?.() ?? false),
        { timeout: 10_000 },
      );

      // Confirm no unhandled JS errors were thrown during the abort sequence.
      // The transfer loop wraps sendMessage in try/catch so the error is
      // handled internally; no unhandled promise rejection should appear.
      expect(pageErrors).toHaveLength(0);
    } finally {
      await parent.page.evaluate(() => window.__testSetTransferChunkDelay(0));
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Second transfer is rejected with a user-visible message
  // -------------------------------------------------------------------------

  test('attempting a second transfer while one is in progress is rejected with an alert', async ({ browser }) => {
    const { baby, parent, deviceId, cleanup } = await pairDevices(browser);
    try {
      // Add a small WAV to the parent's audio library so we have something
      // to attempt sending as the "second transfer".
      const libFileBase64 = SMALL_WAV.toString('base64');
      const libFileId = await parent.page.evaluate(
        ([name, b64]) => window.__testSaveAudioFileToParentLibrary(name, b64, 'audio/wav'),
        ['second-transfer.wav', libFileBase64],
      );
      expect(typeof libFileId).toBe('string');

      // Set a per-chunk delay so the large-file transfer takes long enough
      // for us to attempt a second transfer while it is still running.
      await parent.page.evaluate(() => window.__testSetTransferChunkDelay(50));

      // Start the first (large) transfer.
      await startTransfer(parent.page, deviceId, LARGE_WAV, 'first-transfer.wav');

      // Wait for the first transfer to be actively in progress.
      await parent.page.waitForFunction(
        () => (window.__testGetActiveTransfer()?.sentChunks ?? 0) >= 2,
        { timeout: 10_000 },
      );

      // Set up a dialog handler to capture the "already in progress" alert
      // before triggering the conflicting transfer.  The handler auto-accepts
      // the dialog so the test does not hang.
      let alertMessage = null;
      parent.page.once('dialog', async (dialog) => {
        if (dialog.type() === 'alert') {
          alertMessage = dialog.message();
        }
        await dialog.accept();
      });

      // Attempt to send the library file while the first transfer is running.
      // _sendLibraryFileToBaby() checks _activeTransfer and calls alert() if
      // a transfer is already in progress — the no-concurrent-transfers rule.
      await parent.page.evaluate(
        ([id, name]) => window.__testSendLibraryFileToBaby(id, name),
        [libFileId, 'second-transfer.wav'],
      );

      // The alert must have been shown with the expected message.
      expect(alertMessage).not.toBeNull();
      expect(alertMessage).toContain('already in progress');

      // The first transfer must still be active — the second attempt was
      // rejected without starting a new transfer or clearing the active one.
      const activeAfter = await parent.page.evaluate(
        () => window.__testGetActiveTransfer(),
      );
      expect(activeAfter).not.toBeNull();
      expect(activeAfter.sentChunks).toBeGreaterThan(0);

      // Wait for the first transfer to complete so cleanup is tidy.
      await parent.page.waitForFunction(
        () => window.__testGetActiveTransfer() === null,
        { timeout: 30_000 },
      );
    } finally {
      await parent.page.evaluate(() => window.__testSetTransferChunkDelay(0));
      await cleanup();
    }
  });

});
