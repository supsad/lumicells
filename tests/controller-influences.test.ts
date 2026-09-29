import { describe, expect, it } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { mulberry32 } from '../src/core/controller/math';
import { MAX_INFLUENCES, OFF_COUNTS, OFF_INF } from '../src/core/engine/frame-block';

function controller(overflow = 0) {
  const warns: string[] = [];
  const c = new Controller({
    random: mulberry32(11),
    config: { render: { overflow } },
    onWarn: (code) => warns.push(code),
  });
  c.setViewport({ hostCssW: 800, hostCssH: 600, dpr: 2, deviceW: 0, deviceH: 0 });
  return { c, warns };
}

function rec(f: Float32Array, i: number): number[] {
  return Array.from(f.subarray(OFF_INF + i * 12, OFF_INF + i * 12 + 12));
}

/** Runs frames until the fade-in completes. */
function settle(c: Controller, seconds = 0.5) {
  let f = c.update(1 / 60);
  for (let i = 0; i < seconds * 60; i++) f = c.update(1 / 60);
  return f;
}

describe('influence spaces', () => {
  it('host space: CSS px from the host corner, scaled to device px', () => {
    const { c } = controller();
    c.addInfluence({ x: 100, y: 50, w: 40, h: 20, cornerRadius: 4, strength: 1, falloff: 2 });
    const f = settle(c).frame;
    const g = c.geo;
    expect(g.sx).toBe(2);
    const r = rec(f, 0);
    expect(r[0]).toBeCloseTo(g.hostX + 200);
    expect(r[1]).toBeCloseTo(g.hostY + 100);
    expect(r[2]).toBeCloseTo(40); // half width, device px
    expect(r[3]).toBeCloseTo(20);
    expect(r[4]).toBeCloseTo(8); // corner
    expect(r[5]).toBeCloseTo(2 * g.pitchPx); // falloff in cells
    expect(r[6]).toBeCloseTo(1); // strength * presence
    expect(r[7]).toBe(0); // light
  });

  it('host space respects the overflow margin', () => {
    const { c } = controller(40);
    c.addInfluence({ x: 0, y: 0, radius: 10 });
    const f = settle(c).frame;
    expect(c.geo.hostX).toBe(80);
    const r = rec(f, 0);
    expect(r[0]).toBeCloseTo(80);
    expect(r[1]).toBeCloseTo(80);
    // Radius-only: zero half size, corner = radius.
    expect(r[2]).toBe(0);
    expect(r[4]).toBeCloseTo(20);
  });

  it('norm space: fractions of the host, following resizes', () => {
    const { c } = controller();
    c.addInfluence({ space: 'norm', x: 0.5, y: 0.5, w: 0.5, h: 0.25, type: 'shadow' });
    let f = settle(c).frame;
    const g = c.geo;
    let r = rec(f, 0);
    expect(r[0]).toBeCloseTo(g.centerX);
    expect(r[1]).toBeCloseTo(g.centerY);
    expect(r[2]).toBeCloseTo(g.hostW * 0.25);
    expect(r[3]).toBeCloseTo(g.hostH * 0.125);
    expect(r[7]).toBe(1);
    c.setViewport({ hostCssW: 400, hostCssH: 400, dpr: 1, deviceW: 0, deviceH: 0 });
    f = c.update(1 / 60).frame;
    r = rec(f, 0);
    expect(r[0]).toBeCloseTo(200);
    expect(r[2]).toBeCloseTo(100);
  });

  it('cells space: integer coordinates are cell centers, (0,0) the top-left visible cell', () => {
    const { c } = controller();
    c.addInfluence({ space: 'cells', x: 3, y: 2, radius: 1.5, type: 'lift' });
    const f = settle(c).frame;
    const g = c.geo;
    const r = rec(f, 0);
    expect(r[0]).toBeCloseTo(g.originX + (g.pad + 3.5) * g.pitchPx);
    expect(r[1]).toBeCloseTo(g.originY + (g.pad + 2.5) * g.pitchPx);
    expect(r[4]).toBeCloseTo(1.5 * g.pitchPx);
    expect(r[7]).toBe(2);
  });

  it('client space: converted with the host client origin every frame', () => {
    const { c } = controller();
    c.setClientOrigin(100, 200);
    c.addInfluence({ space: 'client', x: 150, y: 260, radius: 5 });
    expect(c.needsClientOrigin).toBe(true);
    let f = settle(c).frame;
    expect(rec(f, 0)[0]).toBeCloseTo(c.geo.hostX + 100);
    expect(rec(f, 0)[1]).toBeCloseTo(c.geo.hostY + 120);
    c.setClientOrigin(100, 100); // page scrolled: the influence stays under the same viewport point
    f = c.update(1 / 60).frame;
    expect(rec(f, 0)[1]).toBeCloseTo(c.geo.hostY + 320);
  });

  it('default strength / falloff follow the config live', () => {
    const { c } = controller();
    c.addInfluence({ x: 10, y: 10 });
    let f = settle(c).frame;
    expect(rec(f, 0)[6]).toBeCloseTo(0.8);
    c.setConfig({ interaction: { influenceStrength: 1.5 } }, { transition: 0 });
    f = c.update(1 / 60).frame;
    expect(rec(f, 0)[6]).toBeCloseTo(1.5);
  });

  it('color sets a tint with a visible default mix', () => {
    const { c } = controller();
    c.addInfluence({ x: 10, y: 10, color: '#ff0000' });
    const r = rec(settle(c).frame, 0);
    expect(r[8]).toBeCloseTo(1);
    expect(r[9]).toBeCloseTo(0);
    expect(r[11]).toBeCloseTo(0.5);
  });
});

describe('influence lifetimes', () => {
  it('fades in over fadeInMs and out over fadeOutMs, then frees the slot', () => {
    const { c } = controller();
    const h = c.addInfluence({ x: 10, y: 10, strength: 1, fadeInMs: 100, fadeOutMs: 200 });
    let f = c.update(1 / 60).frame;
    const s1 = rec(f, 0)[6] as number;
    expect(s1).toBeGreaterThan(0);
    expect(s1).toBeLessThan(0.5);
    for (let i = 0; i < 10; i++) f = c.update(1 / 60).frame;
    expect(rec(f, 0)[6]).toBeCloseTo(1);
    expect(h.active).toBe(true);
    h.dispose();
    f = c.update(1 / 20).frame;
    const s2 = rec(f, 0)[6] as number;
    expect(s2).toBeGreaterThan(0);
    expect(s2).toBeLessThan(1);
    for (let i = 0; i < 20; i++) f = c.update(1 / 60).frame;
    expect(f[OFF_COUNTS]).toBe(0);
    expect(h.active).toBe(false);
    expect(c.influences.size).toBe(0);
    h.update({ x: 5 }); // no-op, no throw
  });

  it('ttlMs disposes automatically', () => {
    const { c } = controller();
    const h = c.addInfluence({ x: 1, y: 1, ttlMs: 200, fadeOutMs: 0 });
    for (let i = 0; i < 6; i++) c.update(1 / 60);
    expect(h.active).toBe(true);
    for (let i = 0; i < 12; i++) c.update(1 / 60);
    expect(h.active).toBe(false);
    expect(c.influences.size).toBe(0);
  });

  it('an AbortSignal disposes the influence', () => {
    const { c } = controller();
    const ac = new AbortController();
    const h = c.addInfluence({ x: 1, y: 1, fadeOutMs: 0 }, ac.signal);
    c.update(1 / 60);
    expect(h.active).toBe(true);
    ac.abort();
    c.update(1 / 60);
    c.update(1 / 60);
    expect(h.active).toBe(false);
    // Already-aborted signals dispose immediately.
    const h2 = c.addInfluence({ x: 1, y: 1 }, ac.signal);
    c.update(1 / 60);
    expect(h2.active).toBe(false);
  });
});

describe('more influences than GPU slots', () => {
  it('keeps the top 64 by priority, then strength x area, and warns once', () => {
    const { c, warns } = controller();
    const small = [];
    for (let i = 0; i < 70; i++)
      small.push(c.addInfluence({ x: i, y: 0, radius: 2, strength: 0.5 }));
    const big = c.addInfluence({ x: 400, y: 300, radius: 50, strength: 0.5 });
    const vip = c.addInfluence({ x: 1, y: 1, radius: 1, strength: 0.1, priority: 5 });
    let f = c.update(1 / 60).frame;
    expect(f[OFF_COUNTS]).toBe(MAX_INFLUENCES);
    expect(big.active).toBe(true);
    expect(vip.active).toBe(true);
    expect(small.filter((h) => h.active).length).toBe(62);
    expect(warns).toEqual(['influence-overflow']);
    for (let i = 0; i < 30; i++) f = c.update(1 / 60).frame;
    expect(warns.length).toBe(1);
    expect(c.influences.activeCount).toBe(MAX_INFLUENCES);
  });

  it('hands over slots without pops: the loser fades out before the newcomer fades in', () => {
    const { c } = controller();
    const hs = [];
    for (let i = 0; i < MAX_INFLUENCES; i++) {
      hs.push(
        c.addInfluence({ x: i, y: 0, radius: 2, strength: 1, fadeOutMs: 200, fadeInMs: 100 }),
      );
    }
    settle(c);
    const newcomer = c.addInfluence({ x: 5, y: 5, radius: 40, strength: 1, fadeInMs: 100 });
    let f = c.update(1 / 60).frame;
    // Still 64 on the GPU: the displaced one is fading, the newcomer waits.
    expect(f[OFF_COUNTS]).toBe(MAX_INFLUENCES);
    expect(newcomer.active).toBe(false);
    let minStrength = 1;
    for (let i = 0; i < MAX_INFLUENCES; i++)
      minStrength = Math.min(minStrength, rec(f, i)[6] as number);
    expect(minStrength).toBeGreaterThan(0.5); // faded a little, not popped
    for (let i = 0; i < 20; i++) f = c.update(1 / 60).frame;
    expect(newcomer.active).toBe(true);
    expect(hs.filter((h) => h.active).length).toBe(MAX_INFLUENCES - 1);
  });

  it('frees everything on destroy', () => {
    const { c } = controller();
    const h = c.addInfluence({ x: 1, y: 1 });
    c.update(1 / 60);
    c.destroy();
    expect(h.active).toBe(false);
    expect(c.addInfluence({ x: 1, y: 1 }).id).toBe(-1);
  });
});
