/**
 * Settings of an end-to-end run, read from the environment by playwright.config.ts and by the
 * specs (each Playwright worker evaluates this module again, with the same environment). This
 * header is the reference the READMEs point to.
 *
 * Running: `npx playwright install chromium firefox webkit` once, then `npm run test:e2e`: every
 * spec runs in the three Playwright projects `chromium`, `firefox` and `webkit`, one after the
 * other. One browser: `npm run test:e2e -- --project=firefox` (any project name; install only
 * that browser then, e.g. `npx playwright install firefox`). The test server
 * (tests/e2e/site/serve.mjs) builds the site like GitHub Pages (base /lumicells/) into dist/e2e,
 * with the dev-only pages under /lumicells/dev/, and serves it on LC_E2E_PORT. Outputs:
 * playwright-report/ (HTML), test-results/e2e-results.json and test-results/e2e-perf.json (the
 * CI e2e jobs upload them as artifacts, one set per browser).
 *
 *   CI=1                   GitHub Actions: software rendering, retries, no reuse of a running
 *                          server
 *   LC_E2E_GPU=swiftshader  ask for a software rasterizer (what CI runs on; the default on CI
 *                           and on Linux): SwiftShader in Chromium, WARP (Windows) or llvmpipe
 *                           (Linux, Mesa) in Firefox; WebKit has no switch and renders with
 *                           whatever the platform gives it (llvmpipe on a GPU-less Linux)
 *   LC_E2E_GPU=hardware     ask for the GPU (the default locally on Windows and macOS): ANGLE's
 *                           platform backend in Chromium, the GPU blocklist ignored in Firefox
 *   LC_E2E_SERVER=dev       test against the Vite dev server instead of the Pages build
 *   LC_E2E_PORT=5285        port of the test server
 *   LC_E2E_REUSE=1          reuse a server already running on the port (locally)
 *   LC_E2E_PERF_SLACK=2     multiply every gross perf limit (slow machine)
 *
 * GPU_MODE is the mode asked for (launch options, config-level timeout). Perf limits and the
 * specs' waits follow the renderer the browser actually uses (the `gpu` fixture in test.ts): a
 * hardware run that silently lands on a software rasterizer gets software limits, and the smoke
 * test 'WebGL2 is available' fails with a hint instead. WebKit reports every GPU as 'Apple GPU'
 * (WEBGL_debug_renderer_info is masked there), so its renderer cannot be told from the string:
 * the `gpu` fixture takes the mode asked for and the smoke test records that it could not check.
 * A browser without WebGL2 fails every test at once with the reason (the `webgl2` fixture), so a
 * run never passes on posters alone.
 */

export const CI = !!process.env.CI;

export type GpuMode = 'swiftshader' | 'hardware';

/** The Playwright projects (playwright.config.ts), one per browser engine. */
export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export const BROWSERS: readonly BrowserName[] = ['chromium', 'firefox', 'webkit'];

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

/**
 * Firefox preferences for the GPU mode. Playwright's Firefox already allows software WebGL
 * (webgl.forbid-software false in its playwright.cfg), which is what a GPU-less Linux runner gets:
 * Mesa's llvmpipe. Software mode forbids the GPU outright locally (webgl.forbid-hardware: WARP on
 * Windows, llvmpipe on Linux); on CI, where llvmpipe is all there is, nothing is forced (the
 * smoke test checks the renderer is a software one). Hardware mode ignores the GPU blocklist,
 * like --ignore-gpu-blocklist for Chromium. Nothing else is changed: timer precision (1 ms),
 * context limits and the program cache stay what a Firefox user has.
 */
export function firefoxPrefs(mode: GpuMode = GPU_MODE): Record<string, string | number | boolean> {
  if (mode === 'hardware') return { 'webgl.force-enabled': true };
  return CI ? {} : { 'webgl.forbid-hardware': true };
}
