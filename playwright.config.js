// @ts-check
import { defineConfig, devices } from '@playwright/test';

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
 *   (run `npx serve . -l 3000` from the project root).
 * - timeout: 20 seconds per test to accommodate WebRTC connection
 *   establishment, which can take several seconds on loopback.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',

  /* Global timeout per test (ms) — generous to allow WebRTC to establish */
  timeout: 20_000,

  /* Limit parallel workers to avoid saturating the PeerJS cloud signaling
   * server (0.peerjs.com).  Each test creates one or more PeerJS peers;
   * with too many concurrent workers the server rate-limits connections and
   * tests time out.  3 workers keeps the test suite fast while staying
   * within the server's throughput limits. */
  workers: 3,

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
