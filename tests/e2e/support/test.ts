/**
 * The suite's `test`: Playwright's, plus
 * - the WebGL probe (gl-probe.ts) installed in every page before its scripts run;
 * - `problems`: console errors and warnings, uncaught exceptions, failed requests and HTTP
 *   errors of the page, attached to the report when there are any;
 * - `gl`: the WebGL renderer the browser uses (read once per worker in a page of its own, so no
 *   page under test gets an extra context);
 * - `gpu`: the GPU mode Chromium actually renders with ('swiftshader' for a software rasterizer,
 *   whatever was asked for): the specs' waits and the perf limits follow it, and a test on an
 *   unexpected software rasterizer gets the SwiftShader timeout;
 * - `perf`: timings of the test (see perf.ts), attached to the report at its end.
 */
import { test as base, type CDPSession, type Page } from '@playwright/test';
import { GPU_MODE, type GpuMode, testTimeoutMs } from './env';
import { installGlProbe } from './gl-probe';
import { PerfRecord } from './perf';

export { expect } from '@playwright/test';

export interface PageProblem {
  kind: 'console-error' | 'console-warning' | 'pageerror' | 'requestfailed' | 'http';
  text: string;
}

export class PageProblems {
  readonly list: PageProblem[] = [];

  constructor(page: Page) {
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') {
        this.list.push({
          kind: t === 'error' ? 'console-error' : 'console-warning',
          text: m.text(),
        });
      }
    });
    page.on('pageerror', (e) => this.list.push({ kind: 'pageerror', text: e.stack ?? String(e) }));
    page.on('requestfailed', (r) =>
      this.list.push({
        kind: 'requestfailed',
        text: `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`,
      }),
    );
    page.on('response', (r) => {
      if (r.status() >= 400) this.list.push({ kind: 'http', text: `${r.status()} ${r.url()}` });
    });
  }

  /** The problems no pattern of `allow` matches (by text). */
  unexpected(allow: readonly RegExp[] = []): PageProblem[] {
    return this.list.filter((p) => !allow.some((re) => re.test(p.text)));
  }
}

export interface GlInfo {
  webgl2: boolean;
  renderer: string;
  vendor: string;
  software: boolean;
}

/**
 * The library's 'warn' event on a software rasterizer (SwiftShader, as on CI): it announces the
 * low-quality, small-budget mode it switches to. Expected there, a problem anywhere else.
 */
export const SOFTWARE_WARN_CODE = 'software-webgl';

/** Console patterns a page may print because of the renderer itself (see SOFTWARE_WARN_CODE). */
export function rendererNotes(gl: GlInfo): RegExp[] {
  return gl.software ? [new RegExp(SOFTWARE_WARN_CODE)] : [];
}

/** 'warn' event counts by code without the ones the renderer explains. */
export function unexpectedWarnCodes(
  codes: Record<string, number>,
  gl: GlInfo,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(codes).filter(([code]) => !(gl.software && code === SOFTWARE_WARN_CODE)),
  );
}

export const test = base.extend<
  { problems: PageProblems; perf: PerfRecord; softwareTimeout: undefined },
  { gl: GlInfo; gpu: GpuMode }
>({
  page: async ({ page }, use) => {
    await page.addInitScript(installGlProbe);
    await use(page);
  },
  // Attached in teardown, so the timings reach the report when an assertion failed too.
  perf: async ({ gl, gpu }, use, testInfo) => {
    const perf = new PerfRecord(testInfo, gpu);
    await use(perf);
    if (!perf.empty) {
      perf.set('gl', gl.renderer);
      await perf.attach();
    }
  },
  problems: async ({ page }, use, testInfo) => {
    const problems = new PageProblems(page);
    await use(problems);
    if (problems.list.length > 0) {
      await testInfo.attach('page-problems', {
        body: JSON.stringify(problems.list, null, 2),
        contentType: 'application/json',
      });
    }
  },
  gl: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const info = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return { webgl2: false, renderer: '', vendor: '', software: false };
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = String(
          ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        );
        const vendor = String(
          ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        );
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return { webgl2: true, renderer, vendor, software: /swiftshader|llvmpipe/i.test(renderer) };
      });
      // Closed at the end of the worker: on Windows (D3D11), closing a context that had a WebGL
      // context stalls the next navigation by seconds, which would land on the first test.
      await use(info);
      await context.close();
    },
    { scope: 'worker' },
  ],
  gpu: [async ({ gl }, use) => use(gl.software ? 'swiftshader' : 'hardware'), { scope: 'worker' }],
  // The config's timeout follows the mode asked for; a hardware run that landed on SwiftShader
  // needs the SwiftShader one (0: no timeout, e.g. --debug, stays).
  softwareTimeout: [
    async ({ gpu }, use, testInfo) => {
      if (gpu !== GPU_MODE && testInfo.timeout > 0) {
        testInfo.setTimeout(Math.max(testInfo.timeout, testTimeoutMs(gpu)));
      }
      await use(undefined);
    },
    { auto: true },
  ],
});

/** A CDP session for heap measurements (Chromium only). */
export async function cdp(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Used JS heap after two full garbage collections, in bytes. */
export async function heapAfterGc(session: CDPSession): Promise<number> {
  await session.send('HeapProfiler.collectGarbage');
  await session.send('HeapProfiler.collectGarbage');
  const usage = await session.send('Runtime.getHeapUsage');
  return usage.usedSize;
}
