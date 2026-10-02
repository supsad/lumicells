/**
 * The suite's `test`: Playwright's, plus
 * - the WebGL probe (gl-probe.ts) installed in every page before its scripts run;
 * - `problems`: console errors and warnings, uncaught exceptions, failed requests and HTTP
 *   errors of the page, attached to the report when there are any. Messages of the browser's
 *   console waivers (known-issues.ts) are left out and recorded as annotations; at the end of the
 *   test the page probe must have seen no context lost to the browser (evicted), whatever the
 *   spec checked itself;
 * - `gl`: the WebGL renderer the browser uses and what it supports (read once per worker in a
 *   page of its own, so no page under test gets an extra context);
 * - `webgl2`: fails every test at once, with the reason, in a browser without WebGL2 (a run on
 *   posters alone must never pass);
 * - `gpu`: the GPU mode the browser actually renders with ('swiftshader' for a software
 *   rasterizer, whatever was asked for; the mode asked for where the renderer is masked): the
 *   specs' waits and the perf limits follow it, and a test on an unexpected software rasterizer
 *   gets the SwiftShader timeout;
 * - `perf`: timings of the test (see perf.ts), attached to the report at its end.
 */
import { test as base, type CDPSession, type Page } from '@playwright/test';
import { isSoftwareRenderer } from '../../../src/core/gl/caps';
import { type BrowserName, GPU_MODE, type GpuMode, testTimeoutMs } from './env';
import { installGlProbe } from './gl-probe';
import { type ConsoleWaiver, consoleWaivers } from './known-issues';
import { PerfRecord } from './perf';

export { expect } from '@playwright/test';

export interface PageProblem {
  kind: 'console-error' | 'console-warning' | 'pageerror' | 'requestfailed' | 'http';
  text: string;
}

export class PageProblems {
  readonly list: PageProblem[] = [];
  /** Console messages a waiver of the browser took off the list (see known-issues.ts). */
  readonly waived = new Map<ConsoleWaiver, number>();

  constructor(
    page: Page,
    readonly waivers: readonly ConsoleWaiver[] = [],
  ) {
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') {
        const text = m.text();
        const w = waivers.find((x) => x.text.test(text));
        if (w) {
          this.waived.set(w, (this.waived.get(w) ?? 0) + 1);
          return;
        }
        this.list.push({ kind: t === 'error' ? 'console-error' : 'console-warning', text });
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
  /** The renderer is a CPU rasterizer (by the library's own rule, isSoftwareRenderer). */
  software: boolean;
  /**
   * The browser names no GPU (WebKit answers 'Apple GPU' everywhere): `software` cannot be told
   * from the string, the `gpu` fixture takes the mode asked for.
   */
  masked: boolean;
  /** What the library adapts to (recorded for the report: absent ones change its paths). */
  features: {
    parallelCompile: boolean;
    timerQuery: boolean;
    colorBufferFloat: boolean;
    offscreenWebgl2: boolean;
    longTasks: boolean;
  };
  /** Smallest step of performance.now(), ms: 1 in Firefox and WebKit, 0.1 in Chromium. */
  timerStepMs: number;
}

/** WebKit's UNMASKED_RENDERER_WEBGL on every platform (WebGLRenderingContextBase.cpp). */
const MASKED_RENDERER = /^Apple GPU$/;

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
  {
    problems: PageProblems;
    perf: PerfRecord;
    softwareTimeout: undefined;
    webgl2: undefined;
  },
  { gl: GlInfo; gpu: GpuMode }
>({
  page: async ({ page }, use) => {
    await page.addInitScript(installGlProbe);
    await use(page);
  },
  // Attached in teardown, so the timings reach the report when an assertion failed too.
  perf: async ({ gl, gpu, browserName }, use, testInfo) => {
    const perf = new PerfRecord(testInfo, gpu, browserName);
    await use(perf);
    if (!perf.empty) {
      perf.set('gl', gl.renderer);
      await perf.attach();
    }
  },
  problems: async ({ page, browserName }, use, testInfo) => {
    const problems = new PageProblems(page, consoleWaivers(browserName));
    await use(problems);
    for (const [w, n] of problems.waived) {
      testInfo.annotations.push({
        type: 'known-issue-hit',
        description: `${browserName} console waiver, ${n}x: ${w.text.source} (${w.seen})`,
      });
    }
    if (problems.list.length > 0) {
      await testInfo.attach('page-problems', {
        body: JSON.stringify(problems.list, null, 2),
        contentType: 'application/json',
      });
    }
    // The console waivers lean on this: no context of the page was lost to the browser.
    const evicted = await page
      .evaluate(() => window.__glProbe?.counters.evicted ?? 0)
      .catch(() => 0);
    if (evicted > 0) {
      throw new Error(`${evicted} WebGL context(s) lost to the browser (page probe: evicted)`);
    }
  },
  gl: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const raw = await page.evaluate(() => {
        // The library's own rule (src/core/gl/caps.ts readRenderer): the debug extension only
        // where RENDERER is the generic mask (Firefox warns once it is enabled).
        const gl = document.createElement('canvas').getContext('webgl2');
        let step = Number.POSITIVE_INFINITY;
        const t0 = performance.now();
        for (let last = t0, t = t0; t - t0 < 30; t = performance.now()) {
          if (t !== last) step = Math.min(step, t - last);
          last = t;
        }
        const longTasks = (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask');
        const off =
          typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(1, 1).getContext('webgl2')
            : null;
        off?.getExtension('WEBGL_lose_context')?.loseContext();
        const offscreenWebgl2 = !!off;
        if (!gl) {
          return { webgl2: false, renderer: '', vendor: '', step, longTasks, offscreenWebgl2 };
        }
        const plainRenderer = String(gl.getParameter(gl.RENDERER) ?? '');
        const ext = /^webkit webgl$/i.test(plainRenderer)
          ? gl.getExtension('WEBGL_debug_renderer_info')
          : null;
        const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : plainRenderer);
        const vendor = String(
          ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        );
        const features = {
          parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
          timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
          colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
        };
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return { webgl2: true, renderer, vendor, step, longTasks, offscreenWebgl2, features };
      });
      const info: GlInfo = {
        webgl2: raw.webgl2,
        renderer: raw.renderer,
        vendor: raw.vendor,
        software: raw.webgl2 && isSoftwareRenderer(raw.renderer),
        masked: MASKED_RENDERER.test(raw.renderer),
        features: {
          parallelCompile: raw.features?.parallelCompile ?? false,
          timerQuery: raw.features?.timerQuery ?? false,
          colorBufferFloat: raw.features?.colorBufferFloat ?? false,
          offscreenWebgl2: raw.offscreenWebgl2,
          longTasks: raw.longTasks,
        },
        timerStepMs: Number.isFinite(raw.step) ? Math.round(raw.step * 1000) / 1000 : -1,
      };
      // Closed at the end of the worker: on Windows (D3D11), closing a context that had a WebGL
      // context stalls the next navigation by seconds, which would land on the first test.
      await use(info);
      await context.close();
    },
    { scope: 'worker' },
  ],
  gpu: [
    async ({ gl }, use) => use(gl.masked ? GPU_MODE : gl.software ? 'swiftshader' : 'hardware'),
    { scope: 'worker' },
  ],
  webgl2: [
    async ({ gl, browserName }, use) => {
      if (!gl.webgl2) {
        throw new Error(
          `${browserName} has no WebGL2 here (getContext('webgl2') returned null), and every ` +
            'test needs it. On a GPU-less Linux machine Firefox and WebKit need Mesa (llvmpipe): ' +
            'see tests/e2e/support/env.ts and the e2e job of .github/workflows/ci.yml.',
        );
      }
      await use(undefined);
    },
    { auto: true },
  ],
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

/** The engine a page runs in. */
export function browserOf(page: Page): BrowserName {
  return (page.context().browser()?.browserType().name() ?? 'chromium') as BrowserName;
}

/**
 * How long the backgrounds of a page may take to all come alive (the hard limit of the specs'
 * waits), by the renderer in use (the `gpu` fixture) and the browser: 20 s on a GPU in Chromium,
 * 60 s on a software rasterizer, and in Firefox and WebKit, where every context compiles its
 * shaders anew (measured on Windows, RTX 5090, a fresh browser, 4 own contexts: about 7 s in
 * Firefox, 19.5-22 s in WebKit's Windows port, whose warm-ups block in a synchronous fenceSync).
 */
export function startupTimeoutMs(gpu: GpuMode, browser: BrowserName): number {
  return gpu === 'swiftshader' || browser !== 'chromium' ? 60_000 : 20_000;
}

/**
 * A CDP session for heap measurements: Chromium only (Firefox and WebKit have no protocol to
 * force a garbage collection and read the heap; the specs skip just that check there).
 */
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
