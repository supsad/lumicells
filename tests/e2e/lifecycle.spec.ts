/**
 * Lifecycle leaks: 20 cycles of mounting LumiCells instances and destroying them again (on the
 * fixture page tests/e2e/site/lifecycle.html) must leave no WebGL context alive, no canvas in the
 * document or held anywhere (after a GC), and the JS heap where it was.
 *
 * The cycles rotate through both renderers and three moments of destruction:
 * - shared / live: 100 small cards ('auto' puts them on the shared renderer), destroyed once
 *   every one draws (seats, the shared device, programs and atlas all exist);
 * - shared / mid-setup: the same, destroyed one frame after the shared device's context was
 *   created (programs compiling, first draws in flight: the races of a list that unmounts
 *   quickly);
 * - own / live: DESKTOP_MAX_CONTEXTS cards with renderer 'own' (every one gets an Engine and a
 *   context of its own), destroyed once all draw;
 * - own / mid-setup: the same, destroyed one frame after the first own context was created;
 * - shared / before-request: 100 cards destroyed two frames after the mount, before the
 *   scheduler asked for any context (destroy before request).
 * Live and mid-setup cycles must have created contexts, so none of them can degrade into a no-op.
 */
import { CONTEXT_CEILING, DESKTOP_MAX_CONTEXTS, LIFECYCLE } from './support/pages';
import { cdp, expect, heapAfterGc, test } from './support/test';

const CYCLES = 20;
/** Cards of a shared cycle (all on one 1440x900 screen). */
const N_SHARED = 100;
/** Cards of an own cycle: as many as the default budget has contexts, so every one draws. */
const N_OWN = DESKTOP_MAX_CONTEXTS;

type Renderer = 'own' | 'shared';
type Moment = 'live' | 'mid-setup' | 'before-request';
interface Kind {
  renderer: Renderer;
  moment: Moment;
}

const KINDS: readonly Kind[] = [
  { renderer: 'shared', moment: 'live' },
  { renderer: 'shared', moment: 'mid-setup' },
  { renderer: 'own', moment: 'live' },
  { renderer: 'own', moment: 'mid-setup' },
  { renderer: 'shared', moment: 'before-request' },
];

/** Cycles before the heap baseline (one per renderer): program caches, compiled code and pools. */
const WARMUP: readonly Kind[] = [
  { renderer: 'shared', moment: 'live' },
  { renderer: 'own', moment: 'live' },
];
/**
 * Allowed heap growth over the baseline after all cycles. Measured about 0.2 MB (compiled code,
 * inline caches); 100 leaked instances per cycle would add megabytes.
 */
const HEAP_TOLERANCE_BYTES = 1024 * 1024;

test('mount and destroy instances 20 times: no contexts, canvases or heap left', async ({
  page,
  problems,
  perf,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LIFECYCLE);
  await page.waitForFunction(() => window.lifecycle !== undefined);
  const session = await cdp(page);

  const cycle = async ({ renderer, moment }: Kind) =>
    page.evaluate(
      async ({ n, renderer, moment }) => {
        const lc = window.lifecycle;
        const probe = window.__glProbe;
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const start = performance.now();
        probe.resetPeak();
        const created0 = probe.counters.created;
        // 'own' explicitly; 'shared' through the default ('auto' puts small cards there).
        lc.mount(n, renderer === 'own' ? { renderer: 'own' } : {});
        let live = 0;
        let framesToContext = -1;
        if (moment === 'live') {
          live = (await lc.untilLive()).live;
        } else if (moment === 'mid-setup') {
          // Frame by frame until the first context of this cycle exists, then one frame more.
          for (let f = 0; f < 600 && probe.counters.created === created0; f++) {
            await frame();
            framesToContext = f + 1;
          }
          await frame();
        } else {
          for (let i = 0; i < 2; i++) await frame();
        }
        const states = lc.states();
        const peak = probe.counters.peakLive;
        const peakOwn = probe.counters.peakLiveOwn;
        const created = probe.counters.created - created0;
        lc.destroyAll();
        // Releases settle within a frame or two (the shared device goes with its last seat).
        for (let i = 0; i < 3; i++) await frame();
        return {
          live,
          peak,
          peakOwn,
          created,
          framesToContext,
          states,
          ms: Math.round(performance.now() - start),
          liveAfter: probe.liveNow(),
          canvasesInDocument: document.querySelectorAll('canvas').length,
        };
      },
      { n: renderer === 'own' ? N_OWN : N_SHARED, renderer, moment },
    );

  const state = () =>
    page.evaluate(() => ({
      liveContexts: window.__glProbe.liveNow(),
      canvasesInDocument: document.querySelectorAll('canvas').length,
      canvasesAlive: window.__glProbe.canvasesAlive(),
      counters: { ...window.__glProbe.counters },
    }));

  const heapStart = await heapAfterGc(session);
  for (const kind of WARMUP) await cycle(kind);
  const heapBase = await heapAfterGc(session);
  const base = await state();

  const cycles = [];
  for (let i = 0; i < CYCLES; i++) {
    const kind = KINDS[i % KINDS.length] as Kind;
    const n = kind.renderer === 'own' ? N_OWN : N_SHARED;
    const c = await cycle(kind);
    const at = `cycle ${i} (${kind.renderer} / ${kind.moment})`;
    cycles.push({ i, ...kind, ...c });
    if (kind.moment === 'live') expect(c.live, `${at}: instances live`).toBe(n);
    if (kind.moment !== 'before-request') {
      // The cycle reached the GPU side it is about.
      expect(c.created, `${at}: contexts created`).toBeGreaterThan(0);
      expect(c.peak, `${at}: live contexts at peak`).toBeGreaterThan(0);
    }
    if (kind.renderer === 'own' && kind.moment === 'live') {
      // Every card had an Engine and a context of its own at once.
      expect(c.peakOwn, `${at}: live own contexts at peak`).toBe(N_OWN);
    }
    expect(c.peak, `${at}: live contexts at peak`).toBeLessThanOrEqual(CONTEXT_CEILING);
    expect(c.peakOwn, `${at}: live own contexts at peak`).toBeLessThanOrEqual(DESKTOP_MAX_CONTEXTS);
    expect(c.canvasesInDocument, `${at}: canvases left in the document`).toBe(0);
  }

  // Every context released, every canvas collectable.
  await expect.poll(async () => (await state()).liveContexts, { message: 'live contexts' }).toBe(0);
  const heapEnd = await heapAfterGc(session);
  const end = await state();
  await session.detach();

  perf.set('heap', {
    startMB: +(heapStart / 1048576).toFixed(2),
    baselineMB: +(heapBase / 1048576).toFixed(2),
    endMB: +(heapEnd / 1048576).toFixed(2),
    growthKB: Math.round((heapEnd - heapBase) / 1024),
  });
  perf.set('state', { base, end });
  perf.set('cycles', cycles);
  const waited = cycles.filter((c) => c.moment === 'live').map((c) => c.ms);
  perf.check('cycleLiveMsMax', Math.max(...waited), {
    hardware: { target: 2000, gross: 10_000 },
    swiftshader: { target: 8000, gross: 30_000 },
  });

  expect(end.counters.evicted, 'contexts lost to the browser').toBe(0);
  expect(end.liveContexts, 'live WebGL contexts').toBe(0);
  expect(end.canvasesInDocument, 'canvases in the document').toBe(0);
  expect(end.canvasesAlive.total, 'canvases still alive after GC').toBe(0);
  expect(heapEnd - heapBase, `JS heap growth over ${CYCLES} cycles (bytes)`).toBeLessThanOrEqual(
    HEAP_TOLERANCE_BYTES,
  );
  expect(problems.unexpected()).toEqual([]);
});
