import { describe, expect, it } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { createParamLayout } from '../src/core/controller/layout';
import { hexToOklabInto, mulberry32, oklabToLinearInto } from '../src/core/controller/math';
import { ParamStore } from '../src/core/controller/tween';
import { OFF_MISC } from '../src/core/engine/frame-block';
import { getDefaults } from '../src/schema';

const layout = createParamLayout();

function store() {
  return new ParamStore(layout, getDefaults());
}

function run(s: ParamStore, seconds: number, fps = 60): void {
  const dt = 1 / fps;
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) s.update(dt);
}

function slot(path: string): number {
  const sl = layout.slots.get(path);
  if (!sl) throw new Error(path);
  return sl.offset;
}

describe('ParamStore scalar tween', () => {
  it('starts at the config values with the whole block dirty', () => {
    const s = store();
    expect(s.dirty).toBe(true);
    expect(s.getEffective('modes.sphere.radius')).toBeCloseTo(0.68);
    expect(s.params[slot('modes.sphere.radius')]).toBeCloseTo(0.68);
  });

  it('converges exponentially: ~99.3% after the duration, exact after snapping', () => {
    const s = store();
    s.setTarget('modes.sphere.radius', 1.18, 600);
    run(s, 0.6);
    const v = s.getEffective('modes.sphere.radius');
    const progress = (v - 0.68) / 0.5;
    expect(progress).toBeGreaterThan(0.99);
    expect(progress).toBeLessThan(1);
    expect(s.animating).toBe(true);
    run(s, 1.5);
    expect(s.animating).toBe(false);
    expect(s.getEffective('modes.sphere.radius')).toBe(1.18);
    expect(s.params[slot('modes.sphere.radius')]).toBeCloseTo(1.18, 6);
  });

  it('is frame-rate independent', () => {
    const a = store();
    const b = store();
    a.setTarget('glow.bloom.strength', 1.5, 800);
    b.setTarget('glow.bloom.strength', 1.5, 800);
    run(a, 1 / 3, 30);
    run(b, 1 / 3, 144);
    expect(a.getEffective('glow.bloom.strength')).toBeCloseTo(
      b.getEffective('glow.bloom.strength'),
      4,
    );
    // Analytic value: 0.8 + (1.5 - 0.8) * (1 - e^(-5 t / d))
    expect(a.getEffective('glow.bloom.strength')).toBeCloseTo(
      0.8 + 0.7 * (1 - Math.exp(-5 / 3 / 0.8)),
      5,
    );
  });

  it('snaps within range * 1e-4 and then stops writing (no dirty frames when idle)', () => {
    const s = store();
    s.setTarget('animation.gamma', 2, 100);
    run(s, 1);
    expect(s.getEffective('animation.gamma')).toBe(2);
    s.dirty = false;
    expect(s.update(1 / 60)).toBe(false);
    expect(s.dirty).toBe(false);
  });

  it('applies instantly with duration 0 or for non-tweenable fields', () => {
    const s = store();
    s.dirty = false;
    s.setTarget('grid.gap', 0.5, 0);
    expect(s.getEffective('grid.gap')).toBe(0.5);
    expect(s.params[slot('grid.gap')]).toBeCloseTo(0.5);
    expect(s.dirty).toBe(true);
    s.setTarget('lift.enabled', false, 600);
    expect(s.getEffective('lift.enabled')).toBe(0);
    s.setTarget('render.maxDpr', 1, 600);
    expect(s.getEffective('render.maxDpr')).toBe(1);
  });

  it('retargets mid-tween smoothly (no jump back)', () => {
    const s = store();
    s.setTarget('scene.zoom', 2, 600);
    run(s, 0.2);
    const mid = s.getEffective('scene.zoom');
    s.setTarget('scene.zoom', 0.5, 600);
    s.update(1 / 60);
    const next = s.getEffective('scene.zoom');
    // Continues from where it was: one exponential step toward the new target, no reset.
    const k = 1 - Math.exp(-5 / 60 / 0.6);
    expect(next).toBeCloseTo(mid + (0.5 - mid) * k, 9);
    expect(next).toBeLessThan(mid);
    expect(next).toBeGreaterThan(1);
  });

  it('tweens vec2 components together', () => {
    const s = store();
    s.setTarget('scene.center', [0.5, -0.5], 400);
    run(s, 0.2);
    const id = s.id('scene.center');
    const x = s.comp(id, 0);
    const y = s.comp(id, 1);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(0.5);
    // Same progress on both axes.
    expect((x + 0.02) / 0.52).toBeCloseTo((y + 0.02) / -0.48, 6);
    run(s, 1);
    expect(s.params[slot('scene.center')]).toBeCloseTo(0.5, 6);
    expect(s.params[slot('scene.center') + 1]).toBeCloseTo(-0.5, 6);
  });
});

describe('ParamStore color tween (OKLab)', () => {
  it('interpolates in OKLab and uploads linear RGB', () => {
    const s = store();
    s.setTarget('background.color', '#ff2000', 600);
    run(s, 0.3);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    hexToOklabInto('#000032', a);
    hexToOklabInto('#ff2000', b);
    const k = 1 - Math.exp(-2.5);
    const lab = [0, 1, 2].map((i) => (a[i] as number) + ((b[i] as number) - (a[i] as number)) * k);
    const lin = [0, 0, 0];
    oklabToLinearInto(lab[0] as number, lab[1] as number, lab[2] as number, lin);
    const o = slot('background.color');
    for (let i = 0; i < 3; i++)
      expect(s.params[o + i]).toBeCloseTo(Math.max(0, lin[i] as number), 4);
    run(s, 2);
    expect(s.params[o]).toBeCloseTo(1, 4);
    expect(s.params[o + 2]).toBeCloseTo(0, 4);
  });

  it('never goes through a muddy grey between complementary colors', () => {
    const s = store();
    const o = slot('background.color');
    s.setTarget('background.color', '#ff0000', 0);
    s.setTarget('background.color', '#00ffff', 600);
    let minMax = 1;
    for (let i = 0; i < 60; i++) {
      s.update(1 / 60);
      const m = Math.max(
        s.params[o] as number,
        s.params[o + 1] as number,
        s.params[o + 2] as number,
      );
      minMax = Math.min(minMax, m);
    }
    // A plain sRGB lerp dips to max channel ~0.5 (in sRGB ~0.21 linear); OKLab keeps it brighter.
    expect(minMax).toBeGreaterThan(0.25);
  });
});

describe('ParamStore angles', () => {
  it('takes the shortest arc across 0/360', () => {
    const s = store();
    s.setTarget('modes.sphere.lightAngle', 350, 0);
    s.setTarget('modes.sphere.lightAngle', 10, 600);
    const seen: number[] = [];
    for (let i = 0; i < 90; i++) {
      s.update(1 / 60);
      seen.push(s.getEffective('modes.sphere.lightAngle'));
    }
    for (const v of seen) expect(v >= 350 || v <= 10).toBe(true);
    expect(seen.some((v) => v < 5)).toBe(true);
    expect(s.getEffective('modes.sphere.lightAngle')).toBe(10);
    // GPU value in radians, wrapped.
    expect(s.params[slot('modes.sphere.lightAngle')]).toBeCloseTo((10 * Math.PI) / 180, 5);
  });

  it('limited-range angles tween linearly', () => {
    const s = store();
    s.setTarget('modes.sphere.tilt', -50, 0);
    s.setTarget('modes.sphere.tilt', 50, 600);
    run(s, 0.3);
    const v = s.getEffective('modes.sphere.tilt');
    expect(v).toBeGreaterThan(-50);
    expect(v).toBeLessThan(50);
  });
});

describe('enum crossfade (color.mapping)', () => {
  it('switches the index at once and crossfades from the previous one', () => {
    const c = new Controller({ random: mulberry32(1) });
    c.setViewport({ hostCssW: 400, hostCssH: 300, dpr: 1, deviceW: 0, deviceH: 0 });
    let f = c.update(1 / 60);
    expect(f.frame[OFF_MISC + 1]).toBe(1);
    c.setConfig({ color: { mapping: 'radial' } }, { transition: 600 });
    f = c.update(1 / 60);
    expect(f.params[slot('color.mapping')]).toBe(1);
    expect(f.frame[OFF_MISC]).toBe(0);
    const m1 = f.frame[OFF_MISC + 1] as number;
    expect(m1).toBeGreaterThan(0);
    expect(m1).toBeLessThan(0.2);
    for (let i = 0; i < 18; i++) f = c.update(1 / 60);
    const m2 = f.frame[OFF_MISC + 1] as number;
    expect(m2).toBeGreaterThan(m1);
    expect(m2).toBeLessThan(1);
    for (let i = 0; i < 120; i++) f = c.update(1 / 60);
    expect(f.frame[OFF_MISC + 1]).toBe(1);
  });

  it('instant enums (blend) switch without crossfade', () => {
    const c = new Controller({ random: mulberry32(1) });
    c.setConfig({ animation: { blend: 'max' } });
    const f = c.update(1 / 60);
    expect(f.params[slot('animation.blend')]).toBe(2);
  });
});
