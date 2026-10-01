/**
 * Settings of an end-to-end run, read from the environment by playwright.config.ts and by the
 * specs (each Playwright worker evaluates this module again, with the same environment). This
 * header is the reference the READMEs point to.
 *
 * Running: `npx playwright install chromium` once, then `npm run test:e2e`. The test server
 * (tests/e2e/site/serve.mjs) builds the site like GitHub Pages (base /lumicells/) into dist/e2e,
 * with the dev-only pages under /lumicells/dev/, and serves it on LC_E2E_PORT. Outputs:
 * playwright-report/ (HTML), test-results/e2e-results.json and test-results/e2e-perf.json (the
 * CI e2e job uploads them as artifacts).
 *
 *   CI=1                   GitHub Actions: SwiftShader, retries, no reuse of a running server
 *   LC_E2E_GPU=swiftshader  force the software rasterizer (what CI runs on; the default on CI
 *                           and on Linux, where headless Chromium rarely gets a GPU)
 *   LC_E2E_GPU=hardware     ask ANGLE for the platform's GPU backend (the default locally on
 *                           Windows and macOS)
 *   LC_E2E_SERVER=dev       test against the Vite dev server instead of the Pages build
 *   LC_E2E_PORT=5285        port of the test server
 *   LC_E2E_REUSE=1          reuse a server already running on the port (locally)
 *   LC_E2E_PERF_SLACK=2     multiply every gross perf limit (slow machine)
 *
 * GPU_MODE is the mode asked for (Chromium flags, config-level timeout). Perf limits and the
 * specs' waits follow the renderer Chromium actually uses (the `gpu` fixture in test.ts): a
 * hardware run that silently lands on SwiftShader gets SwiftShader limits, and the smoke test
 * 'WebGL2 is available' fails with a hint instead.
 */

export const CI = !!process.env.CI;

export type GpuMode = 'swiftshader' | 'hardware';

function gpuMode(): GpuMode {
  const v = process.env.LC_E2E_GPU;
  if (v === 'swiftshader' || v === 'hardware') return v;
  if (CI) return 'swiftshader';
  // Linux: no ANGLE backend is forced (see chromiumArgs) and headless Chromium falls back to
  // SwiftShader without a usable GPU; ask for it explicitly unless LC_E2E_GPU=hardware.
  return process.platform === 'win32' || process.platform === 'darwin' ? 'hardware' : 'swiftshader';
}

export const GPU_MODE: GpuMode = gpuMode();

/** Timeout of one test (SwiftShader renders on the CPU: the stress and parity pages need time). */
export function testTimeoutMs(mode: GpuMode): number {
  return mode === 'swiftshader' ? 240_000 : 120_000;
}

export const PORT = Number(process.env.LC_E2E_PORT ?? 5285);

export const SERVER: 'preview' | 'dev' = process.env.LC_E2E_SERVER === 'dev' ? 'dev' : 'preview';

/** The site is served under the same base path as GitHub Pages. */
export const BASE_URL = `http://127.0.0.1:${PORT}/lumicells/`;

/** Multiplier of the gross perf limits (see perf.ts). */
export const PERF_SLACK = Math.max(1, Number(process.env.LC_E2E_PERF_SLACK ?? 1) || 1);

/**
 * URL (relative to BASE_URL) of a dev-only page given by its path in the repository: the preview
 * build serves them under dev/ (see site/serve.mjs), the dev server at their own path.
 */
export function devPage(path: string): string {
  return SERVER === 'dev' ? path : `dev/${path}`;
}

/**
 * Chromium flags for the GPU mode. Headless Chromium falls back to SwiftShader on its own when it
 * finds no usable GPU (always on a GitHub runner); the flags make that explicit (and allow it:
 * Chromium refuses software WebGL without --enable-unsafe-swiftshader). In hardware mode ANGLE is
 * asked for the platform's backend, which headless Chromium otherwise skips on Windows; on Linux
 * the default is kept (it may still end up on SwiftShader). The specs record the renderer string.
 */
export function chromiumArgs(mode: GpuMode = GPU_MODE): string[] {
  if (mode === 'swiftshader') return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const backend =
    process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : null;
  return backend
    ? [`--use-angle=${backend}`, '--ignore-gpu-blocklist']
    : ['--ignore-gpu-blocklist'];
}
