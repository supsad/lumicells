/**
 * Multi-instance invariants on the stress bench (examples/stress.html) with the library's default
 * settings (renderer 'auto', default context budget): 100 small cards on one screen, a feed of
 * 100 cards scrolled through, and large cards that get WebGL contexts of their own.
 * - no WebGL context is ever lost to the browser (evicted) and no instance hears 'contextlost',
 *   'fallback' or 'error';
 * - live WebGL contexts never exceed the budget + the shared device, and live own contexts
 *   never exceed the budget;
 * - every visible card is live after a settle period, none ever shows a dead canvas;
 * - mount, settle and frame timings are recorded; only gross regressions fail (see perf.ts).
 */
import type { Page } from '@playwright/test';
import type { BrowserName, GpuMode } from './support/env';
import { CONTEXT_CEILING, DESKTOP_MAX_CONTEXTS, stressUrl } from './support/pages';
import type { Limits, PerfRecord } from './support/perf';
import {
  browserOf,
  expect,
  rendererNotes,
  startupTimeoutMs,
  test,
  unexpectedWarnCodes,
} from './support/test';

/**
 * Waits until the bench has mounted and every card it sees on screen shows a live canvas.
 * Returns the time since the mount (ms) and the snapshot at that moment.
 */
async function settle(page: Page, gpu: GpuMode, minVisible: number) {
  // How long the visible cards may take to all come alive after the mount (hard limit).
  const limitMs = startupTimeoutMs(gpu, browserOf(page));
  await page.waitForFunction(() => window.bench?.mounted === true);
  const result = await page.evaluate(
    async ({ timeoutMs, minVisible }) => {
      const start = performance.now();
      for (;;) {
        const s = window.bench.snapshot();
        const { visible, visibleLive } = s.instances;
        const done = visible >= minVisible && visibleLive === visible;
        if (done || performance.now() - start > timeoutMs) {
          return { ok: done, ms: Math.round(performance.now() - window.bench.t0), snapshot: s };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    { timeoutMs: limitMs, minVisible },
  );
  expect(
    result.ok,
    `visible cards live after ${limitMs} ms: ${JSON.stringify(result.snapshot.instances)}`,
  ).toBe(true);
  return result;
}

/**
 * Loads the page once and lets it settle, so the browser's program cache is warm for the measured
 * load that follows. A fresh browser compiles every program on first use and, on some backends
 * (ANGLE on D3D11), the first draw blocks the main thread for seconds (measured 2.7 s): that is
 * the driver's cold start, not the cost of mounting, and it depends on which test ran first.
 * Returns the cold settle time for the report.
 */
async function warmUp(page: Page, gpu: GpuMode, url: string, minVisible: number): Promise<number> {
  await page.goto(url);
  const { ms } = await settle(page, gpu, minVisible);
  // The cost reducers (lite pipeline, secondary rate) switch programs after about a second.
  await page.waitForTimeout(1500);
  return ms;
}

/** The init-script probe's view (see support/gl-probe.ts): every context of the page. */
function pageProbe(page: Page) {
  return page.evaluate(() => ({
    ...window.__glProbe.counters,
    liveNow: window.__glProbe.liveNow(),
    liveOwnNow: window.__glProbe.liveOwnNow(),
  }));
}

/** Context budget checks on the page probe (see CONTEXT_CEILING). */
function expectWithinBudget(probe: Awaited<ReturnType<typeof pageProbe>>): void {
  expect(probe.peakLive, 'live contexts at peak (page probe)').toBeLessThanOrEqual(CONTEXT_CEILING);
  expect(probe.peakLiveOwn, 'live own contexts at peak (page probe)').toBeLessThanOrEqual(
    DESKTOP_MAX_CONTEXTS,
  );
}

interface ScrollOptions {
  /** How long each step stays (bench.scrollThrough dwellMs). */
  dwellMs: number;
  /**
   * Steps that may end before all their cards are live without failing the test (default a
   * third of them on SwiftShader, 2 on a GPU).
   */
  unsettledSteps?: number;
  /**
   * Browsers where settling is recorded, not judged (the metrics keep their targets, no gross
   * limit), with the measurement that says why (see perf.ts).
   */
  settleRecordedIn?: Partial<Record<BrowserName, string>>;
}

/** Limits of every browser of `why` (see ScrollOptions.settleRecordedIn): targets only. */
function recordedIn(
  why: Partial<Record<BrowserName, string>> | undefined,
  target: number,
): Limits['browsers'] {
  if (!why) return undefined;
  const limit = { target, gross: Number.MAX_SAFE_INTEGER };
  return Object.fromEntries(
    Object.entries(why).map(([b, w]) => [b, { hardware: limit, swiftshader: limit, why: w }]),
  );
}

/**
 * Scrolls the bench page at `url` down to the end and back (bench.scrollThrough, one screen per
 * step) after a warm-up load, checks the invariants of every step and records the pass.
 */
async function scrollPass(
  page: Page,
  perf: PerfRecord,
  gpu: GpuMode,
  url: string,
  opts: ScrollOptions,
) {
  const { dwellMs } = opts;
  perf.set('coldFirstScreenLiveMs', await warmUp(page, gpu, url, 1));
  await page.goto(url);
  await settle(page, gpu, 1);
  const pass = await page.evaluate(
    (dwellMs) => window.bench.scrollThrough({ dwellMs, stepFraction: 1 }),
    dwellMs,
  );
  // Back at the top: every card on screen comes alive again.
  const back = await settle(page, gpu, 1);
  const probe = await pageProbe(page);
  const t = pass.totals;
  const renderers = back.snapshot.instances.renderers;
  perf.set('scroll', {
    dwellMs,
    totals: t,
    steps: pass.steps.map((s) => ({
      y: s.y,
      fps: s.fps,
      visible: s.visible,
      visibleLive: s.visibleLive,
      settleMs: s.settleMs,
      maxLiveContexts: s.maxLiveContexts,
      states: s.states,
    })),
  });
  perf.set('pageProbe', probe);
  perf.set('renderers', renderers);

  // Invariants.
  expect(t.steps, 'scroll steps').toBeGreaterThan(8);
  expect(t.evicted, 'contexts lost to the browser').toBe(0);
  expect(probe.evicted, 'contexts lost to the browser (page probe)').toBe(0);
  expect(t.instanceContextLost, "'contextlost' events").toBe(0);
  expect(t.peakLiveContexts, 'live contexts at peak').toBeLessThanOrEqual(CONTEXT_CEILING);
  expect(t.maxLiveContextsSampled, 'live contexts sampled per frame').toBeLessThanOrEqual(
    CONTEXT_CEILING,
  );
  expectWithinBudget(probe);
  expect(t.stepsWithVisibleDead, 'steps with a dead canvas on screen').toBe(0);
  const events = await page.evaluate(() => window.bench.measure(500));
  expect(events.instanceEvents, 'instance events').toMatchObject({ fallbacks: 0, errors: 0 });
  expect(events.pageWarnings, 'console.warn calls').toEqual({});

  // Timings: gross regressions only. Settling is judged in frames too: on SwiftShader a frame
  // of large cards takes up to a second (measured 1-4 fps), so milliseconds say little there.
  // A step that did not settle within the dwell counts in stepsNotSettled.
  const why = opts.settleRecordedIn;
  perf.check(
    'maxSettleFrames',
    t.maxSettleFrames,
    {
      hardware: { target: 12, gross: 40 },
      swiftshader: { target: 4, gross: 12 },
      browsers: recordedIn(why, 12),
    },
    'frames',
  );
  perf.check('maxSettleMs', t.maxSettleMs, {
    hardware: { target: 300, gross: 700 },
    swiftshader: { target: 3000, gross: 30_000 },
    browsers: recordedIn(why, 300),
  });
  perf.check(
    'stepsNotSettled',
    t.steps - t.stepsSettled,
    {
      hardware: { target: 0, gross: opts.unsettledSteps ?? 2 },
      swiftshader: { target: 2, gross: opts.unsettledSteps ?? Math.ceil(t.steps / 3) },
      browsers: recordedIn(why, 0),
    },
    'steps',
  );
  return { totals: t, probe, renderers };
}

test.describe('stress bench, default config', () => {
  test('visible layout: 100 cards on one screen', async ({
    page,
    problems,
    perf,
    gl,
    gpu,
    browserName,
  }, testInfo) => {
    // 10 columns x 10 rows of 130x80 cards fit 1440x900.
    await page.setViewportSize({ width: 1440, height: 900 });
    const url = stressUrl({ n: 100, layout: 'visible' });
    perf.set('coldAllVisibleLiveMs', await warmUp(page, gpu, url, 100));
    await page.goto(url);
    const settled = await settle(page, gpu, 100);
    perf.check('allVisibleLiveMs', settled.ms, {
      hardware: { target: 1500, gross: 10_000 },
      swiftshader: { target: 10_000, gross: 45_000 },
      browsers: {
        webkit: {
          hardware: { target: 15_000, gross: 25_000 },
          why:
            'WebKit 26.6 (Windows port), RTX 5090: the page runs at 8-10 fps while the GPU ' +
            "process compiles the device's programs, then the field variants' warm-up blocks " +
            'in fenceSync (synchronous there) for 1.3 s: 7.9-13.3 s',
        },
      },
    });

    // The mount report covers 5 s after the instances were created.
    await page.waitForFunction(() => performance.now() - window.bench.t0 > 5200, null, {
      timeout: 15_000,
    });
    const mount = await page.evaluate(() => window.bench.mount());
    const m = await page.evaluate(() => window.bench.measure(3000));
    const probe = await pageProbe(page);
    perf.set('mount', mount);
    perf.set('measure', {
      fps: m.fps,
      frameMsMedian: m.frameMsMedian,
      frameMsP95: m.frameMsP95,
      jankRatio: m.jankRatio,
      workMsMean: m.workMsMean,
      workMsP95: m.workMsP95,
      cpuMsSum: m.cpuMsSum,
      gpuMsSum: m.gpuMsSum,
      longTasks: m.longTasks,
      renderers: m.instances.renderers,
      quality: m.instances.quality,
      reducers: m.instances.reducers,
      shared: m.shared,
      contexts: m.contexts,
      memory: m.memory,
    });
    perf.set('pageProbe', probe);

    // Invariants.
    expect(m.contexts.evicted, 'contexts lost to the browser').toBe(0);
    expect(probe.evicted, 'contexts lost to the browser (page probe)').toBe(0);
    expect(m.instanceEvents, 'instance events').toMatchObject({
      lost: 0,
      fallbacks: 0,
      errors: 0,
    });
    expect(m.contexts.peakLive, 'live contexts at peak').toBeLessThanOrEqual(CONTEXT_CEILING);
    expectWithinBudget(probe);
    expect(m.instances.visible, 'cards on screen').toBe(100);
    expect(m.instances.visibleLive, 'cards on screen that are live').toBe(100);
    expect(m.instances.visibleDead, 'dead canvases on screen').toBe(0);
    expect(m.instances.lostCanvas, 'lost canvases painted').toBe(0);
    expect(m.pageWarnings, 'console.warn calls').toEqual({});
    expect(unexpectedWarnCodes(m.warnEvents, gl), "'warn' events").toEqual({});

    // Timings: gross regressions only.
    perf.check('mountSyncMs', mount.syncMs, {
      hardware: { target: 60, gross: 500 },
      swiftshader: { target: 150, gross: 1500 },
    });
    // The Long Tasks API is Chromium's: elsewhere the bench reports null and the longest frame
    // after the mount (maxFrameGapMs, in the report) is all there is.
    if (mount.maxLongTaskMs === null) {
      testInfo.annotations.push({
        type: 'skipped-check',
        description: `mountMaxLongTaskMs: no Long Tasks API in ${browserName}`,
      });
    } else {
      perf.check('mountMaxLongTaskMs', mount.maxLongTaskMs, {
        hardware: { target: 50, gross: 500 },
        swiftshader: { target: 1000, gross: 4000 },
      });
    }
    perf.check('frameWorkMsP95', m.workMsP95, {
      hardware: { target: 8, gross: 50 },
      swiftshader: { target: 30, gross: 200 },
    });
    expect(problems.unexpected(rendererNotes(gl))).toEqual([]);
  });

  test('scroll layout: a feed of 100 cards scrolled down and back', async ({
    page,
    problems,
    perf,
    gl,
    gpu,
  }) => {
    await scrollPass(page, perf, gpu, stressUrl({ n: 100, layout: 'scroll' }), {
      dwellMs: gpu === 'swiftshader' ? 1000 : 700,
    });
    expect(problems.unexpected(rendererNotes(gl))).toEqual([]);
  });

  test('large layout: cards that get contexts of their own, within the budget', async ({
    page,
    problems,
    perf,
    gl,
    gpu,
  }) => {
    // 720x720 cards (over promoteArea each): 'auto' gives them own contexts while the budget
    // has room, the shared renderer the rest; scrolling parks and re-creates them.
    await page.setViewportSize({ width: 1600, height: 900 });
    // About 2 Mpx on screen: 1-4 frames per second on SwiftShader (fewer on a CI runner), so
    // fewer cards, longer steps, and steps that end unsettled are only recorded there: this
    // test is about the context budget, the scroll layout covers settling.
    const sw = gpu === 'swiftshader';
    const pass = await scrollPass(
      page,
      perf,
      gpu,
      stressUrl({ n: sw ? 12 : 24, layout: 'large' }),
      {
        dwellMs: sw ? 3000 : 700,
        ...(sw ? { unsettledSteps: Number.MAX_SAFE_INTEGER } : {}),
        // A card that scrolls in takes a new own context: where creating one costs seconds, its
        // steps end unsettled, and settling is recorded, not judged, as on SwiftShader.
        settleRecordedIn: {
          firefox:
            'Firefox, D3D11, RTX 5090: every new own context compiles its programs anew (no ' +
            'program cache across contexts, no KHR_parallel_shader_compile: 1.6-1.7 s with the ' +
            'main thread waiting), longer than a 700 ms step: 5-12 of 19 steps unsettled, ' +
            'settled ones up to 79 frames / 1950 ms',
          webkit:
            "WebKit 26.6 (Windows port), RTX 5090: every new own context's warm-up blocks in " +
            'fenceSync (synchronous there) for 1.2-1.7 s, the page at 0.4-12 fps meanwhile: 17 of ' +
            '19 steps unsettled',
        },
      },
    );
    expect(pass.probe.created, 'contexts created (the budget was exercised)').toBeGreaterThan(
      DESKTOP_MAX_CONTEXTS,
    );
    // The own path ran, and the budget held for own contexts alone (scrollPass checks the
    // maximum): one context more than the budget fails here even with no shared device.
    expect(pass.probe.peakLiveOwn, 'live own contexts at peak').toBeGreaterThan(0);
    expect(problems.unexpected(rendererNotes(gl))).toEqual([]);
  });
});
