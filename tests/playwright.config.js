// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration for the WebRTC Baby Monitor E2E tests.
 *
 * Key decisions:
 * - Chromium only: the app targets modern browsers and WebRTC behaviour is
 *   consistent in Chromium; running a single browser keeps CI fast.
 * - Fake media flags: --use-fake-ui-for-media-stream and
 *   --use-fake-device-for-media-stream allow tests to obtain camera/mic
 *   streams without real hardware or permission prompts.
 * - baseURL: points to a local static file server started with `npx serve`
 *   (run `npx serve .. -l 3000` from the tests/ directory, or from the
 *   project root with `npx serve . -l 3000`).
 * - timeout: 20 seconds per test to accommodate WebRTC connection
 *   establishment, which can take several seconds on loopback.
 */
module.exports = defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',

  /* Global timeout per test (ms) — generous to allow WebRTC to establish */
  timeout: 20_000,

  /* Fail fast in CI; allow retries locally to reduce flakiness */
  retries: process.env.CI ? 2 : 0,

  /* Reporter: concise list in CI, interactive in local runs */
  reporter: process.env.CI ? 'list' : 'html',

  use: {
    /* Base URL for all page.goto() calls that use relative paths */
    baseURL: 'http://localhost:3000',

    /* Capture a trace on first retry to aid debugging */
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            /* Grant getUserMedia without a physical camera/microphone */
            '--use-fake-ui-for-media-stream',
            /* Supply a synthetic audio/video device for MediaStream */
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],
});
