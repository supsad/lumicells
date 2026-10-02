/**
 * A live look change that needs a new field variant (engine/field-variants.ts): turning a mode
 * on compiles a variant with it in the background. The tween of its weight waits for that
 * variant (Controller.setFieldGate), so the mode fades in over its whole transition instead of
 * appearing mid-tween; the frame gap around the variant's first use (on Direct3D the driver
 * compiles its shader on the GPU process's main thread, which stops presenting for 0.1-0.2 s on
 * a first use) is recorded so its size is tracked over time.
 */
import { LIFECYCLE } from './support/pages';
import { expect, rendererNotes, test } from './support/test';

/** A mode the 'reference' preset leaves off. */
const MODE = 'rain';
const WEIGHT = 0.7;

test('turning a mode on: its weight waits for the variant, then fades in', async ({
  page,
  perf,
  problems,
  gl,
}) => {
  await page.goto(LIFECYCLE);
  await page.waitForFunction(() => !!window.lifecycle);
  await page.evaluate(() => window.lifecycle.mount(1, { renderer: 'own' }));
  const live = await page.evaluate(() => window.lifecycle.untilLive());
  expect(live.live, 'the instance draws').toBe(1);
  // Let start-up settle (warm-ups, the first frames).
  await page.waitForTimeout(1000);

  // At least 3 s, then until the weight is there (the variant may take a while to compile where
  // the browser keeps no program cache: Firefox and WebKit compile every context's programs).
  const log = await page.evaluate(
    ([mode, weight]) =>
      window.lifecycle.setModeWeight(mode as string, weight as number, 3000, 15_000),
    [MODE, WEIGHT],
  );
  const start = log.findIndex((f) => f[2] > 0);
  expect(start, 'the mode turns on within the recording').toBeGreaterThanOrEqual(0);
  // A fade, not a pop: the weight passes several frames between off and nearly its target.
  const fading = log.filter((f) => f[2] > 0 && f[2] < WEIGHT * 0.95).length;
  expect(fading, 'frames of the fade-in').toBeGreaterThanOrEqual(3);
  const first = log[start]?.[2] ?? 0;
  expect(first, 'first weight after the start').toBeLessThan(WEIGHT * 0.7);
  expect(log[log.length - 1]?.[2]).toBeCloseTo(WEIGHT, 3);

  const maxGap = Math.max(...log.map((f) => f[1]));
  perf.set('liveChange', { mode: MODE, startMs: log[start]?.[0], first, fading, maxGap });
  perf.check('modeStartMs', log[start]?.[0] ?? 0, {
    hardware: { target: 1500, gross: 10_000 },
    swiftshader: { target: 5000, gross: 20_000 },
  });
  // The variant's first use (see the header): measured 0.15-0.24 s on ANGLE/D3D11 with a cold
  // shader cache, no gap with a warm one.
  perf.check('modeToggleMaxFrameGapMs', maxGap, {
    hardware: { target: 300, gross: 2000 },
    swiftshader: { target: 2000, gross: 10_000 },
    browsers: {
      firefox: {
        hardware: { target: 1500, gross: 3000 },
        why:
          'Firefox, D3D11, RTX 5090: no KHR_parallel_shader_compile, the variant links while the ' +
          'main thread waits for its link status: 570-1131 ms',
      },
      webkit: {
        hardware: { target: 2500, gross: 4000 },
        why:
          "WebKit 26.6 (Windows port), RTX 5090: the variant's warm-up blocks in fenceSync " +
          '(synchronous there) while the GPU process compiles it: up to 2567 ms',
      },
    },
  });
  expect(problems.unexpected(rendererNotes(gl))).toEqual([]);
});
