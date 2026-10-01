/**
 * Smoke tests of the published pages (the GitHub Pages build): each loads without console errors
 * or warnings, failed requests or uncaught exceptions, and every LumiCells canvas on it shows
 * rendered pixels that change over time (a CSS poster or a frozen canvas would not).
 */
import { GPU_MODE } from './support/env';
import { PAGES } from './support/pages';
import { canvasShot, changedShare, pixelStats } from './support/pixels';
import { expect, rendererNotes, test } from './support/test';

test('WebGL2 is available (records the renderer)', async ({ gl, perf }) => {
  perf.set('webgl', gl);
  expect(gl.webgl2, 'WebGL2 context in headless Chromium').toBe(true);
  if (GPU_MODE === 'swiftshader') {
    expect(gl.software, `SwiftShader requested, got ${gl.renderer}`).toBe(true);
  } else {
    // The other specs still run (perf limits and waits follow the renderer in use, see the `gpu`
    // fixture); this one says why a hardware run is not one.
    expect(
      gl.software,
      `hardware mode requested but Chromium uses ${gl.renderer}; set LC_E2E_GPU=swiftshader`,
    ).toBe(false);
  }
});

const SMOKE: readonly { name: string; path: string; canvases: number }[] = [
  { name: 'stand', path: PAGES.stand, canvases: 1 },
  { name: 'web component example', path: PAGES.webComponent, canvases: 3 },
  { name: 'core example', path: PAGES.coreBasic, canvases: 2 },
];

for (const { name, path, canvases } of SMOKE) {
  test(`${name}: loads clean and renders`, async ({ page, problems, perf, gl }) => {
    const start = Date.now();
    await page.goto(path);
    const all = page.locator('canvas[data-lumicells]');
    // Hidden (visibility) until the instance has drawn its first frame.
    await expect(all.first()).toBeVisible();
    // A fresh browser has no shader cache: on Windows (ANGLE on D3D11) the first page that
    // compiles the stand's programs takes several seconds (measured 5-6 s, later pages 0.3 s).
    perf.check('firstCanvasMs', Date.now() - start, {
      hardware: { target: 8000, gross: 30_000 },
      swiftshader: { target: 8000, gross: 30_000 },
    });
    await expect(all).toHaveCount(canvases);

    const results = [];
    for (let i = 0; i < canvases; i++) {
      const canvas = all.nth(i);
      await canvas.scrollIntoViewIfNeeded();
      await expect(canvas).toBeVisible();
      const first = await canvasShot(canvas);
      const stats = pixelStats(first);
      // Animated: some later frame differs (secondary instances may present at a lower rate).
      let changed = 0;
      await expect
        .poll(
          async () => {
            changed = changedShare(first, await canvasShot(canvas));
            return changed;
          },
          { message: `canvas ${i} animates`, intervals: [250, 500, 1000] },
        )
        .toBeGreaterThan(0.001);
      results.push({ index: i, width: first.width, height: first.height, ...stats, changed });
      expect(stats.lit, `canvas ${i}: share of non-background pixels`).toBeGreaterThan(0.02);
      expect(stats.colors, `canvas ${i}: distinct colors`).toBeGreaterThan(16);
      expect(stats.white, `canvas ${i}: blank (white) pixels`).toBeLessThan(0.05);
    }
    perf.set('canvases', results);
    expect(problems.unexpected(rendererNotes(gl))).toEqual([]);
  });
}
