import { describe, expect, it } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { mulberry32 } from '../src/core/controller/math';
import { type PulseInit, PulseList } from '../src/core/controller/pulses';
import { MAX_PULSES, OFF_COUNTS, OFF_PULSE } from '../src/core/engine/frame-block';

function controller() {
  const c = new Controller({ random: mulberry32(5), config: { lift: { enabled: false } } });
  c.setViewport({ hostCssW: 620, hostCssH: 620, dpr: 1, deviceW: 0, deviceH: 0 });
  return c;
}

function init(p: Partial<PulseInit> = {}): PulseInit {
  return {
    space: 0,
    x: 0,
    y: 0,
    strength: 1,
    speed: 10,
    width: 1,
    r: 1,
    g: 1,
    b: 1,
    colorMix: 0,
    duration: 1,
    minor: false,
    ...p,
  };
}

describe('pulses', () => {
  it('ring grows at speed (cells/s) and fades out over its duration', () => {
    const c = controller();
    c.pulse({ x: 310, y: 310, speed: 10, width: 2, strength: 1, duration: 1 });
    let f = c.update(0.1).frame;
    const pitch = c.geo.pitchPx;
    expect(f[OFF_COUNTS + 1]).toBe(1);
    expect(f[OFF_PULSE]).toBeCloseTo(c.geo.hostX + 310);
    expect(f[OFF_PULSE + 2]).toBeCloseTo(0.1 * 10 * pitch, 4); // radius
    expect(f[OFF_PULSE + 3]).toBeCloseTo(2 * pitch); // width
    const s1 = f[OFF_PULSE + 4] as number;
    expect(s1).toBeGreaterThan(0.8);
    // update() clamps dt to 0.1 s (stall protection): advance in small steps.
    for (let i = 0; i < 14; i++) f = c.update(0.05).frame; // age 0.8
    const s2 = f[OFF_PULSE + 4] as number;
    expect(s2).toBeLessThan(s1);
    expect(s2).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) f = c.update(0.05).frame; // age 1.05
    expect(f[OFF_COUNTS + 1]).toBe(0);
  });

  it('defaults come from config.interaction', () => {
    const c = controller();
    c.pulse({ x: 0.5, y: 0.5, space: 'norm' });
    const f = c.update(1 / 60).frame;
    const pitch = c.geo.pitchPx;
    expect(f[OFF_PULSE]).toBeCloseTo(c.geo.centerX);
    expect(f[OFF_PULSE + 3]).toBeCloseTo(1.5 * pitch); // rippleWidth
    expect(f[OFF_PULSE + 2]).toBeCloseTo((18 / 60) * pitch, 3); // rippleSpeed
  });

  it('color and mix', () => {
    const c = controller();
    c.pulse({ x: 3, y: 3, space: 'cells', color: '#0000ff' });
    const f = c.update(1 / 60).frame;
    expect(f[OFF_PULSE + 5]).toBeCloseTo(0.5);
    expect(f[OFF_PULSE + 10]).toBeCloseTo(1);
    expect(f[OFF_PULSE]).toBeCloseTo(c.geo.originX + (c.geo.pad + 3.5) * c.geo.pitchPx);
  });

  it('keeps at most MAX_PULSES, replacing minor (landing) pulses first, then the oldest', () => {
    const list = new PulseList();
    list.add(init({ minor: true, x: 999 }));
    for (let i = 1; i < MAX_PULSES; i++) list.add(init({ x: i }));
    expect(list.count).toBe(MAX_PULSES);
    list.add(init({ x: 1000 }));
    expect(list.count).toBe(MAX_PULSES);
    const geo = new Controller({ random: mulberry32(1) }).geo;
    const frame = new Float32Array(4096);
    list.step(0, geo, 0, 0, frame);
    const xs = [];
    for (let i = 0; i < MAX_PULSES; i++) xs.push(frame[OFF_PULSE + i * 12]);
    expect(xs).toContain(geo.hostX + 1000);
    expect(xs).not.toContain(geo.hostX + 999);
    // Now full of normal pulses of different ages: the oldest goes.
    list.step(0.1, geo, 0, 0, frame);
    list.add(init({ x: 2000, duration: 5 }));
    list.step(0, geo, 0, 0, frame);
    const xs2 = [];
    for (let i = 0; i < MAX_PULSES; i++) xs2.push(frame[OFF_PULSE + i * 12]);
    expect(xs2).toContain(geo.hostX + 2000);
  });

  it('strength envelope has a soft attack', () => {
    const list = new PulseList();
    list.add(init({ duration: 2 }));
    const geo = new Controller({ random: mulberry32(1) }).geo;
    const frame = new Float32Array(4096);
    list.step(0.01, geo, 0, 0, frame);
    const a = list.strengthAt(0);
    list.step(0.05, geo, 0, 0, frame);
    const b = list.strengthAt(0);
    expect(a).toBeLessThan(b);
    expect(a).toBeGreaterThan(0);
  });
});
