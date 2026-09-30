import { describe, expect, it } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { createParamLayout } from '../src/core/controller/layout';
import { mulberry32 } from '../src/core/controller/math';
import { composeModulators, Modulator } from '../src/core/controller/modulators';
import { ParamStore } from '../src/core/controller/tween';
import { OFF_CLOCK } from '../src/core/engine/frame-block';
import { getDefaults } from '../src/schema';

const layout = createParamLayout();
const RADIUS = 'modes.sphere.radius';

function slot(path: string): number {
  const s = layout.slots.get(path);
  if (!s) throw new Error(path);
  return s.offset;
}

function controller() {
  const c = new Controller({ random: mulberry32(7), layout });
  c.setViewport({ hostCssW: 400, hostCssH: 400, dpr: 1, deviceW: 0, deviceH: 0 });
  return c;
}

describe('composeModulators', () => {
  it('applies blend modes', () => {
    expect(composeModulators(1, [new Modulator(0.5, 'add')], 0)).toBe(1.5);
    expect(composeModulators(1, [new Modulator(3, 'mul')], 0)).toBe(3);
    expect(composeModulators(1, [new Modulator(0.2, 'override')], 0)).toBe(0.2);
    expect(composeModulators(1, [new Modulator(0.2, 'max')], 0)).toBe(1);
    expect(composeModulators(1, [new Modulator(4, 'max')], 0)).toBe(4);
  });

  it('composes in insertion order', () => {
    const addThenMul = [new Modulator(1, 'add'), new Modulator(2, 'mul')];
    const mulThenAdd = [new Modulator(2, 'mul'), new Modulator(1, 'add')];
    expect(composeModulators(1, addThenMul, 0)).toBe(4);
    expect(composeModulators(1, mulThenAdd, 0)).toBe(3);
  });

  it('reads function and {get} sources every call, ignoring non-finite readings', () => {
    let v = 1;
    const fn = new Modulator(() => v, 'add');
    const obj = new Modulator({ get: () => v * 10 }, 'add');
    expect(composeModulators(0, [fn, obj], 0)).toBe(11);
    v = 2;
    expect(composeModulators(0, [fn, obj], 0)).toBe(22);
    v = Number.NaN;
    expect(composeModulators(0, [fn], 0)).toBe(2);
  });

  it('smooths with the given half-life', () => {
    let target = 0;
    const m = new Modulator(() => target, 'add', 100);
    m.sample(0);
    target = 1;
    // One half-life in 10 steps of 10 ms.
    for (let i = 0; i < 10; i++) m.sample(0.01);
    expect(m.value).toBeCloseTo(0.5, 6);
  });
});

describe('Controller.modulate', () => {
  it('adds on top of the tweened value and writes the GPU slot', () => {
    const c = controller();
    const h = c.modulate(RADIUS, 0.2, { blend: 'add' });
    const f = c.update(1 / 60);
    expect(c.getEffective(RADIUS)).toBeCloseTo(0.88, 6);
    expect(f.params[slot(RADIUS)]).toBeCloseTo(0.88, 6);
    expect(f.paramsDirty).toBe(true);
    // The base config is untouched (never exported).
    expect(c.getConfig().modes.sphere.radius).toBe(0.68);
    h.set(0.4);
    c.update(1 / 60);
    expect(c.getEffective(RADIUS)).toBeCloseTo(1.08, 6);
  });

  it('keeps modulating while the base tweens', () => {
    const c = controller();
    c.modulate(RADIUS, 2, { blend: 'mul' });
    c.setConfig({ modes: { sphere: { radius: 0.3 } } }, { transition: 500 });
    c.update(1 / 60);
    const s = c.store;
    const tweened = s.comp(s.id(RADIUS), 0);
    expect(c.getEffective(RADIUS)).toBeCloseTo(tweened * 2, 6);
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    expect(c.getEffective(RADIUS)).toBeCloseTo(0.6, 6);
  });

  it('clamps the effective value to the field range', () => {
    const c = controller();
    c.modulate(RADIUS, 100, { blend: 'add' });
    c.update(1 / 60);
    expect(c.getEffective(RADIUS)).toBe(1.6);
    c.modulate('modes.sphere.hole', -5, { blend: 'override' });
    c.update(1 / 60);
    expect(c.getEffective('modes.sphere.hole')).toBe(0);
  });

  it('wraps full-circle angles instead of clamping', () => {
    const c = controller();
    c.modulate('color.angle', 350, { blend: 'add' });
    c.update(1 / 60);
    expect(c.getEffective('color.angle')).toBeCloseTo(12, 6); // (22 + 350) mod 360
  });

  it('dispose restores the plain tweened value on the GPU', () => {
    const c = controller();
    const h = c.modulate(RADIUS, 0.5);
    c.update(1 / 60);
    c.commitFrame();
    expect(c.getEffective(RADIUS)).toBeCloseTo(1.18, 6);
    h.dispose();
    h.dispose(); // idempotent
    const f = c.update(1 / 60);
    expect(c.getEffective(RADIUS)).toBeCloseTo(0.68, 6);
    expect(f.params[slot(RADIUS)]).toBeCloseTo(0.68, 6);
    expect(f.paramsDirty).toBe(true);
    expect(c.store.isModulated(RADIUS)).toBe(false);
    h.set(9); // no-op after dispose
    c.update(1 / 60);
    expect(c.getEffective(RADIUS)).toBeCloseTo(0.68, 6);
  });

  it('Symbol.dispose and AbortSignal dispose too', () => {
    const c = controller();
    const ac = new AbortController();
    c.modulate(RADIUS, 0.1, { signal: ac.signal });
    const h2 = c.modulate('scene.zoom', 2, { blend: 'override' });
    c.update(1 / 60);
    expect(c.getEffective(RADIUS)).toBeCloseTo(0.78, 6);
    ac.abort();
    h2[Symbol.dispose]();
    c.update(1 / 60);
    expect(c.getEffective(RADIUS)).toBeCloseTo(0.68, 6);
    expect(c.getEffective('scene.zoom')).toBeCloseTo(1, 6);
  });

  it('smoothingMs smooths a jumping source', () => {
    const c = controller();
    let src = 0;
    c.modulate('animation.brightness', () => src, { blend: 'add', smoothingMs: 200 });
    c.update(1 / 60);
    src = 1;
    for (let i = 0; i < 12; i++) c.update(1 / 60); // 200 ms = one half-life
    expect(c.getEffective('animation.brightness')).toBeCloseTo(1.5, 2);
  });

  it('modulates CPU-side parameters (animation.speed drives the clock)', () => {
    const c = controller();
    c.modulate('animation.speed', 0, { blend: 'override' });
    const before = c.update(1 / 60).frame[OFF_CLOCK];
    const after = c.update(1).frame[OFF_CLOCK];
    expect(after).toBe(before);
  });

  it('non-numeric paths are ignored safely', () => {
    const s = new ParamStore(layout, getDefaults());
    expect(s.addModulator('color.palette', 1)).toBeNull();
  });
});
