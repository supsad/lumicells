/**
 * Context loss on the stress bench: forced losses (bench.lossTest -> loseContextForTesting(), the
 * browser restores the context about 0.5 s later) must never leave a dead canvas on screen (a
 * lost WebGL canvas shows as a blank area) and every affected card must come back.
 *
 * - shared: the cards share the library's shared renderer; one loss hits all of them, each keeps
 *   its last frame in its 2D canvas until the device is rebuilt;
 * - own: the cards own their contexts (renderer 'own'); a lost card shows its CSS poster until
 *   its context is restored.
 *
 * Besides the bench's per-frame check of the cards' styles, screenshots taken during the loss
 * window are checked: every card must keep showing an image (its last frame or its poster). A
 * lost canvas left in place shows as a flat area: transparent in headless Chromium (the card's
 * background shows through), a white box in a headed one.
 */
import type { Page } from '@playwright/test';
import type { BrowserName, GpuMode } from './support/env';
import { CONTEXT_CEILING, DESKTOP_MAX_CONTEXTS, stressUrl } from './support/pages';
import { pageShot, pixelStats, type Rect } from './support/pixels';
import { browserOf, expect, rendererNotes, startupTimeoutMs, test } from './support/test';

/**
 * The longest lossTest() watches (it stops SETTLE_MS after every card is live again), by the
 * renderer in use (the `gpu` fixture) and the browser: the restore comes after 0.5 s, then the
 * device or engines are rebuilt (programs compiled again: 1-4 s on SwiftShader locally, more on a
 * CI runner). Firefox keeps no program cache across contexts and has no
 * KHR_parallel_shader_compile: every restored context compiles its programs anew, one after the
 * other in the GPU process (measured on Windows/D3D11, RTX 5090: 1.6-1.7 s per context, 4 own
 * contexts live again after 7.0-8.0 s). WebKit (Windows port) compiles a restored context's
 * programs anew too, one context after the other, and blocks in fenceSync (a synchronous call
 * there) meanwhile (4 own contexts: 9.6-17.0 s).
 */
function watchMs(gpu: GpuMode, browser: BrowserName): number {
  if (browser !== 'chromium') return 30_000;
  return gpu === 'swiftshader' ? 15_000 : 3000;
}

/**
 * How long the watch goes on once every card is live again: the screenshots cover the recovery
 * and a second of drawing after it, not whatever the cards do later (an adaptive quality step
 * resizes their canvases a few seconds after they start drawing).
 */
const SETTLE_MS = 1000;

/** Chrome's console notes about GL calls on a lost context (expected while it is lost). */
const LOSS_NOTES = [/CONTEXT_LOST_WEBGL/];

async function settleLive(page: Page, gpu: GpuMode, n: number) {
  await page.waitForFunction(() => window.bench?.mounted === true);
  await expect
    .poll(() => page.evaluate(() => window.bench.snapshot().instances.visibleLive), {
      message: 'visible cards live',
      timeout: startupTimeoutMs(gpu, browserOf(page)),
    })
    .toBe(n);
}

async function cardRects(page: Page): Promise<Rect[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.card')].map((el) => {
      const r = el.getBoundingClientRect();
      // Inset: the rounded corners show the page behind the card.
      return { x: r.left + 6, y: r.top + 6, w: r.width - 12, h: r.height - 12 };
    }),
  );
}

/** What the cards showed in the screenshots taken during a loss (the worst of all of them). */
interface Looks {
  shots: number;
  /** Lowest share of non-background pixels of any card in any screenshot (flat: about 0). */
  minLit: number;
  /** Highest share of white pixels of any card in any screenshot. */
  maxWhite: number;
  /** Card of the worst value above. */
  worstCard: number;
}

/**
 * Runs bench.lossTest() and, while it watches, screenshots the page as often as it can. Returns
 * the bench's report, what the cards looked like before the loss and during it.
 */
async function lossWithScreenshots(
  page: Page,
  opts: { count: number; watchMs: number; settleMs?: number },
) {
  const rects = await cardRects(page);
  const look = (into: Looks, img: Awaited<ReturnType<typeof pageShot>>) => {
    into.shots++;
    rects.forEach((r, i) => {
      const { lit, white } = pixelStats(img, r);
      if (lit < into.minLit) {
        into.minLit = lit;
        into.worstCard = i;
      }
      if (white > into.maxWhite) {
        into.maxWhite = white;
        into.worstCard = i;
      }
    });
  };
  const before: Looks = { shots: 0, minLit: 1, maxWhite: 0, worstCard: -1 };
  look(before, await pageShot(page));
  const report = page.evaluate((o) => window.bench.lossTest(o), opts);
  let done = false;
  const stop = () => {
    done = true;
  };
  report.then(stop, stop);
  const during: Looks = { shots: 0, minLit: 1, maxWhite: 0, worstCard: -1 };
  while (!done) look(during, await pageShot(page));
  return { report: await report, before, during };
}

/** Assertions on the screenshots of lossWithScreenshots(). */
function expectImagesKept(before: Looks, during: Looks): void {
  expect(
    before.minLit,
    `card ${before.worstCard} before the loss: non-background pixels`,
  ).toBeGreaterThan(0.1);
  expect(during.shots, 'screenshots during the loss').toBeGreaterThan(0);
  expect(
    during.minLit,
    `card ${during.worstCard} during the loss: non-background pixels`,
  ).toBeGreaterThan(0.1);
  expect(during.maxWhite, `card ${during.worstCard} during the loss: white pixels`).toBeLessThan(
    0.05,
  );
}

test.describe('context loss', () => {
  test('shared renderer: cards keep their last frame and recover', async ({
    page,
    problems,
    perf,
    gl,
    gpu,
    browserName,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(stressUrl({ n: 20, layout: 'visible' }));
    await settleLive(page, gpu, 20);
    const {
      report: r,
      before,
      during,
    } = await lossWithScreenshots(page, {
      count: 4,
      watchMs: watchMs(gpu, browserName),
      settleMs: SETTLE_MS,
    });
    perf.set('loss', { ...r, end: undefined, centers: undefined, params: undefined });
    perf.set('screenshots', { before, during });

    expect(r.watched, 'cards watched (every shared card)').toBe(20);
    expect(r.forced, 'cards that heard the loss').toBe(20);
    expect(r.framesWithDead, 'frames with a dead canvas').toBe(0);
    expect(r.maxVisibleDead, 'dead canvases on screen').toBe(0);
    expectImagesKept(before, during);
    expect(
      r.allLiveAgainMs,
      'all cards live again (ms, -1: not within the window)',
    ).toBeGreaterThan(0);
    expect(r.restoredEvents, "'contextrestored' events").toBe(20);
    expect(r.contextChurn.evicted, 'contexts lost to the browser').toBe(0);
    expect(r.end.contexts.peakLive).toBeLessThanOrEqual(CONTEXT_CEILING);
    expect(r.end.instances.visibleLive, 'cards live at the end').toBe(20);
    perf.check('allLiveAgainMs', r.allLiveAgainMs, {
      hardware: { target: 1200, gross: 2500 },
      swiftshader: { target: 4000, gross: 12_000 },
      browsers: {
        firefox: {
          hardware: { target: 2500, gross: 5000 },
          why:
            'Firefox, D3D11, RTX 5090: the restored device compiles its programs anew (no ' +
            'program cache across contexts, 1.6-1.7 s) after the 0.5 s restore: 2.3-3.3 s',
        },
      },
    });
    expect(problems.unexpected([...LOSS_NOTES, ...rendererNotes(gl)])).toEqual([]);
  });

  test('own contexts: lost cards show their poster and recover', async ({
    page,
    problems,
    perf,
    gl,
    gpu,
    browserName,
  }) => {
    // Renderer 'own', as many cards as the default budget has contexts: all of them draw.
    const n = DESKTOP_MAX_CONTEXTS;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(stressUrl({ n, layout: 'visible', renderer: 'own' }));
    await settleLive(page, gpu, n);
    const {
      report: r,
      before,
      during,
    } = await lossWithScreenshots(page, {
      count: 4,
      watchMs: watchMs(gpu, browserName),
      settleMs: SETTLE_MS,
    });
    perf.set('loss', { ...r, end: undefined, centers: undefined, params: undefined });
    perf.set('screenshots', { before, during });

    expect(r.watched, 'cards watched').toBe(n);
    expect(r.forced, 'cards that lost their context').toBe(n);
    expect(r.framesWithDead, 'frames with a dead canvas').toBe(0);
    expect(r.maxVisibleDead, 'dead canvases on screen').toBe(0);
    expect(r.looks.poster ?? 0, 'card-frames on the poster').toBeGreaterThan(0);
    expectImagesKept(before, during);
    expect(
      r.allLiveAgainMs,
      'all cards live again (ms, -1: not within the window)',
    ).toBeGreaterThan(0);
    expect(r.restoredEvents, "'contextrestored' events").toBe(n);
    expect(r.contextChurn.evicted, 'contexts lost to the browser').toBe(0);
    expect(r.end.contexts.peakLive).toBeLessThanOrEqual(CONTEXT_CEILING);
    // Every card had a context of its own (restored ones included), never more than the budget.
    const own = await page.evaluate(() => window.__glProbe.counters.peakLiveOwn);
    expect(own, 'live own contexts at peak (page probe)').toBe(n);
    expect(r.end.instances.visibleLive, 'cards live at the end').toBe(n);
    perf.check('allLiveAgainMs', r.allLiveAgainMs, {
      hardware: { target: 1200, gross: 2500 },
      swiftshader: { target: 4000, gross: 12_000 },
      browsers: {
        firefox: {
          hardware: { target: 8000, gross: 12_000 },
          why:
            'Firefox, D3D11, RTX 5090: 4 restored contexts each compile their programs anew, one ' +
            'after the other in the GPU process (no program cache across contexts, 1.6-1.7 s ' +
            'each): 7.9-10.2 s',
        },
        webkit: {
          hardware: { target: 15_000, gross: 25_000 },
          why:
            'WebKit 26.6 (Windows port), RTX 5090: restored contexts compile their programs ' +
            'anew, one after the other, and each warm-up blocks in fenceSync (synchronous ' +
            'there) for 1.2-1.8 s: 9.6-17.0 s',
        },
      },
    });
    expect(problems.unexpected([...LOSS_NOTES, ...rendererNotes(gl)])).toEqual([]);
  });
});
