/// <reference types="node" />
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { mulberry32 } from '../src/core/controller/math';

// A real gc() so the heap delta measures only what update() allocates.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const src: { t: number; energy: number; radius: { set(v: number): void } | null } = {
  t: 0,
  energy: 1,
  radius: null,
};

/** Every subsystem busy: >64 influences (ranked), modulators, tweens, LUT, pulses, lifts. */
function busyController(randomLifts: boolean): Controller {
  const c = new Controller({
    random: mulberry32(99),
    config: {
      lift: { enabled: randomLifts, amount: 0.03, cluster: 0.3, holdMin: 10, holdMax: 10 },
      color: { drift: 0.05 },
    },
  });
  c.setViewport({ hostCssW: 1280, hostCssH: 800, dpr: 1.5, deviceW: 0, deviceH: 0 });
  for (let i = 0; i < 80; i++) {
    c.addInfluence({
      x: (i * 37) % 1280,
      y: (i * 53) % 800,
      radius: 10 + (i % 7),
      priority: i % 3,
    });
  }
  c.addInfluence({ space: 'norm', x: 0.5, y: 0.5, w: 0.2, h: 0.1, type: 'shadow' });
  // A numeric source moved every frame through the handle (the allocation-free way to animate
  // a knob) and a getter over a stored value. A getter that computes a fresh double, like
  // `() => Math.sin(t)`, boxes its result: that allocation is the caller's.
  src.radius = c.modulate('modes.sphere.radius', 0, { smoothingMs: 50 });
  c.modulate('animation.energy', { get: () => src.energy }, { blend: 'mul' });
  return c;
}

function frame(c: Controller): void {
  src.t += 0.016;
  src.energy = src.t % 2 < 1 ? 1.2 : 0.8;
  src.radius?.set(src.t % 3 < 1.5 ? 0.1 : -0.1);
  c.update(1 / 60, 0);
  c.commitFrame();
}

/** Heap growth over `frames` frames; process.memoryUsage() itself allocates a fixed amount. */
function heapDelta(c: Controller, frames: number): number {
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < frames; i++) frame(c);
  return process.memoryUsage().heapUsed - before;
}

/** Bytes per frame, best of `rounds`, minus the measurement's own overhead. */
function measure(c: Controller, frames: number, rounds = 3): number {
  let overhead = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rounds; r++) overhead = Math.min(overhead, heapDelta(c, 0));
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rounds; r++) best = Math.min(best, heapDelta(c, frames));
  return Math.max(0, best - overhead) / frames;
}

/**
 * Exercises every code path (all lift phases, pulses of all ages, color/number/LUT tweens) long
 * enough for the JIT to settle: code first reached after warm-up runs unoptimized for a while,
 * and unoptimized code boxes every intermediate double.
 */
function warmUp(c: Controller): void {
  for (let i = 0; i < 8000; i++) {
    if (i % 40 === 0) c.pulse({ x: 640, y: 400 });
    if (i % 400 === 0) {
      c.lift({ x: 300 + (i % 700), y: 400, count: 8, radius: 5 });
      c.pulse({ x: 200, y: 200, duration: 8, speed: 3, color: '#ff00aa' });
    }
    if (i % 1000 === 0) {
      const odd = (i / 1000) % 2 === 1;
      c.setConfig(
        {
          color: { palette: odd ? ['#ff0000', '#0000ff'] : ['#00ff00', '#ff00ff', '#000044'] },
          background: { color: odd ? '#112233' : '#331100' },
          modes: { flow: { scale: odd ? 2 : 3 } },
        },
        { transition: 3000 },
      );
    }
    frame(c);
  }
  // In flight during the measurement: long pulses, held lifts, long tweens and a palette fade.
  for (let i = 0; i < 6; i++) c.pulse({ x: 100 * i, y: 300, duration: 30, speed: 2 });
  c.lift({ x: 640, y: 400, count: 12, radius: 6 });
  c.setConfig({ color: { palette: ['#ff0066', '#3300ff', '#00ffcc'] } }, { transition: 60000 });
  c.setConfig(
    { modes: { flow: { scale: 4 } }, background: { color: '#221144' } },
    { transition: 60000 },
  );
  for (let i = 0; i < 120; i++) frame(c);
}

describe('Controller.update allocations', () => {
  it('allocates nothing per frame in steady state (all subsystems busy)', () => {
    const c = busyController(false);
    warmUp(c);
    expect(c.lifts.count).toBeGreaterThan(5);
    expect(c.pulses.count).toBeGreaterThan(0);
    expect(c.influences.activeCount).toBe(64);
    expect(c.store.animating).toBe(true);
    expect(c.lut.transitioning).toBe(true);
    const perFrame = measure(c, 400);
    // No object, array or closure is created per frame (those would cost kilobytes with 81
    // influences and a dozen lifts). What remains is V8 boxing a few doubles in code that is
    // not optimized yet, which depends on JIT state and is typically 0-50 bytes.
    expect(perFrame).toBeLessThan(64);
  });

  it('per-frame allocation does not grow with the number of influences and lifts', () => {
    const small = busyController(false);
    const large = busyController(false);
    for (let i = 0; i < 120; i++)
      large.addInfluence({ x: i * 9, y: i * 5, radius: 4, strength: 0.3 });
    warmUp(small);
    warmUp(large);
    large.lift({ x: 300, y: 300, count: 20, radius: 8 });
    for (let i = 0; i < 30; i++) frame(large);
    expect(large.influences.size).toBeGreaterThan(small.influences.size + 100);
    expect(large.lifts.count).toBeGreaterThan(small.lifts.count + 10);
    // Short enough that no lift lands during the measurement (hold is 10 s).
    const a = measure(small, 200, 2);
    const b = measure(large, 200, 2);
    expect(b - a).toBeLessThan(48);
  });

  it('random lift spawning allocates only per spawn event, not per frame', () => {
    const c = busyController(true);
    warmUp(c);
    const perFrame = measure(c, 3000);
    // ~10 spawns/s at 60 fps; cold spawn code boxes a few random numbers per event.
    expect(perFrame).toBeLessThan(400);
  });

  it('update() is fast (well under 1 ms per frame)', () => {
    const c = busyController(true);
    warmUp(c);
    const N = 2000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) frame(c);
    const ms = (performance.now() - t0) / N;
    expect(ms).toBeLessThan(0.25);
  });
});
