import { defineConfig } from '@playwright/test';
import {
  BASE_URL,
  CI,
  chromiumArgs,
  firefoxPrefs,
  GPU_MODE,
  PORT,
  SERVER,
  testTimeoutMs,
} from './tests/e2e/support/env';

/**
 * Browser end-to-end tests (`npm run test:e2e`): smoke tests of the published pages,
 * multi-instance invariants on the stress bench, lifecycle leaks, context loss and the parity
 * pages, in Chromium, Firefox and WebKit (one project each; `--project=<name>` runs one).
 * Environment switches are documented in tests/e2e/support/env.ts.
 *
 * The web server builds the demo like GitHub Pages does (base /lumicells/) plus the dev-only
 * pages the tests need, and serves it with `vite preview` (tests/e2e/site/serve.mjs). Artifacts:
 * playwright-report/ (HTML), test-results/e2e-results.json (JSON results) and
 * test-results/e2e-perf.json (timings).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/e2e',
  // WebGL timings and context budgets are page-wide and machine-wide: one test at a time, and
  // the projects one after the other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // By the mode asked for; a hardware run that lands on SwiftShader gets the longer timeout from
  // the `gpu` fixture (support/test.ts).
  timeout: testTimeoutMs(GPU_MODE),
  expect: { timeout: 15_000 },
  reporter: [
    [CI ? 'github' : 'list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/e2e-results.json' }],
    ['./tests/e2e/support/perf-reporter.ts', { outputFile: 'test-results/e2e-perf.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Launch options per engine (see env.ts): the Chromium flags only apply to Chromium.
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', launchOptions: { args: chromiumArgs(GPU_MODE) } },
    },
    {
      name: 'firefox',
      use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: firefoxPrefs(GPU_MODE) } },
    },
    // No GPU switch exists for WebKit: it renders with what the platform gives it.
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `node tests/e2e/site/serve.mjs --port ${PORT}${SERVER === 'dev' ? ' --dev' : ''}`,
    url: BASE_URL,
    reuseExistingServer: !CI && process.env.LC_E2E_REUSE === '1',
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
