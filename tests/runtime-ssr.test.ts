// Node environment: importing the core must not touch window/document (SSR safety).
import { describe, expect, it } from 'vitest';

describe('SSR import', () => {
  it('imports without a DOM and reports WebGL as unsupported', async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    const core = await import('../src/core/index');
    expect(core.PixelLife.isSupported()).toBe(false);
    expect(typeof core.onBeforeFrame).toBe('function');
    expect(core.getDefaults().grid.count).toBe(31);
    // Pure controller modules load too.
    const { Controller } = await import('../src/core/controller/controller');
    const c = new Controller({ random: () => 0.5 });
    expect(c.update(1 / 60).canvasWidth).toBeGreaterThan(0);
  });
});
