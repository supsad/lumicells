import { describe, expect, it } from 'vitest';
import {
  LOCK_MS,
  type PerfChange,
  PerfController,
  QUALITY_LEVELS,
} from '../src/core/controller/perf';

/** Feeds `seconds` of frames produced by `delta(level, i)`; returns the changes seen. */
function drive(
  p: PerfController,
  seconds: number,
  delta: (level: number, i: number) => number,
  opts: { cpu?: number; gpu?: (level: number) => number | null; t0?: number } = {},
): { changes: (PerfChange & { at: number; level: number })[]; now: number } {
  const changes: (PerfChange & { at: number; level: number })[] = [];
  let now = opts.t0 ?? 0;
  let i = 0;
  while (now < (opts.t0 ?? 0) + seconds * 1000) {
    const d = delta(p.level, i++);
    now += d;
    const ch = p.sample(d, opts.cpu ?? 1, opts.gpu ? opts.gpu(p.level) : null, now);
    if (ch) changes.push({ ...ch, at: now, level: p.level });
  }
  return { changes, now };
}

describe('refresh estimate', () => {
  it('detects 60, 120 and 144 Hz from rAF deltas with jitter', () => {
    for (const [hz, expected] of [
      [60, 16.67],
      [120, 8.33],
      [144, 6.94],
    ] as const) {
      const p = new PerfController();
      drive(p, 2, (_l, i) => 1000 / hz + (i % 2 ? 0.4 : -0.4));
      expect(p.vsyncMs).toBe(expected);
      expect(p.missRatio).toBe(0);
    }
  });

  it('a 120 Hz panel running at half rate is still 120 Hz with ~50% misses', () => {
    const p = new PerfController();
    drive(p, 3, (_l, i) => (i % 2 ? 8.33 : 16.67));
    expect(p.vsyncMs).toBe(8.33);
    expect(p.missRatio).toBeGreaterThan(0.4);
    expect(p.missRatio).toBeLessThan(0.6);
  });

  it('fps and frame time come from the window', () => {
    const p = new PerfController();
    drive(p, 2, () => 16.67);
    expect(p.fps).toBeCloseTo(60, 0);
    expect(p.frameMs).toBeCloseTo(16.67, 1);
  });
});

/** Low-discrepancy miss pattern: exactly `share` of frames take two vsyncs. */
function pattern(share: number, i: number, vsync = 16.67): number {
  return (i * 0.6180339887) % 1 < share ? 2 * vsync : vsync;
}

describe('adaptive steps (no GPU timer)', () => {
  // A GPU whose missed-frame share falls as quality/resolution drop; level 4 keeps up.
  const MISSES = [0.6, 0.5, 0.4, 0.3, 0, 0, 0];
  const loaded = (level: number, i: number) => pattern(MISSES[level] ?? 0, i);

  it('steps down only after 2 s of misses, at most once per 2 s, and stops when it helps', () => {
    const p = new PerfController();
    const { changes } = drive(p, 16, loaded);
    expect(changes.length).toBe(4);
    const downs = changes.filter((c) => c.reason === 'slow');
    expect(downs.length).toBe(4);
    expect(downs[0]?.at).toBeGreaterThan(2000);
    for (let i = 1; i < downs.length; i++) {
      expect((downs[i]?.at ?? 0) - (downs[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(2000);
    }
    expect(p.level).toBe(4);
    expect(p.locked).toBe(false);
    expect(p.quality).toBe(QUALITY_LEVELS[p.level]?.quality);
    expect(p.scale).toBeLessThan(1);
  });

  it('steps back up after 5 s without misses; a failed step up is reverted and blacklisted', () => {
    const p = new PerfController();
    const r1 = drive(p, 16, loaded);
    const level = p.level;
    // Load is still there: stepping up to `level - 1` brings misses back.
    const r2 = drive(p, 20, loaded, { t0: r1.now });
    const ups = r2.changes.filter((c) => c.reason === 'recovered');
    expect(ups.length).toBeGreaterThanOrEqual(1);
    const lastDown = r1.changes[r1.changes.length - 1]?.at ?? 0;
    expect((ups[0]?.at ?? 0) - lastDown).toBeGreaterThan(5000);
    expect(p.level).toBe(level); // reverted
    // Blacklisted for 30 s: no second attempt within the next 20 s.
    expect(ups.length).toBe(1);
    // Load gone: after the blacklist expires it climbs back to high.
    drive(p, 90, () => 16.67, { t0: r2.now });
    expect(p.level).toBe(0);
    expect(p.quality).toBe('high');
    expect(p.scale).toBe(1);
  });

  it('locks when fewer pixels do not reduce misses (display/OS caps rAF)', () => {
    const p = new PerfController();
    const capped = (_l: number, i: number) => pattern(0.5, i);
    const { changes, now } = drive(p, 15, capped);
    expect(changes.map((c) => c.reason)).toEqual(['slow', 'slow', 'locked']);
    expect(p.locked).toBe(true);
    expect(p.level).toBe(0);
    expect(p.quality).toBe('high');
    const more = drive(p, 20, capped, { t0: now });
    expect(more.changes.length).toBe(0);
  });

  it('a GPU stuck at half the refresh rate is detected (sticky refresh estimate)', () => {
    const p = new PerfController();
    const r1 = drive(p, 2, () => 16.67);
    expect(p.vsyncMs).toBe(16.67);
    // Every frame now takes two vsyncs: that is 100% misses, not a 30 Hz display.
    const { changes } = drive(p, 4, (l) => (l === 0 ? 33.33 : 16.67), { t0: r1.now });
    expect(p.vsyncMs).toBe(16.67);
    expect(changes[0]?.reason).toBe('slow');
  });

  it('main-thread jank (high CPU time) is not treated as GPU load', () => {
    const p = new PerfController();
    const { changes } = drive(p, 10, (_l, i) => pattern(0.5, i), { cpu: 9 });
    expect(changes.length).toBe(0);
    expect(p.level).toBe(0);
  });
});

describe('adaptive steps (GPU timer)', () => {
  it('uses the GPU time against 0.75 x vsync', () => {
    const p = new PerfController();
    const { changes } = drive(p, 10, () => 16.67, { gpu: (l) => (l < 2 ? 14 : 6) });
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0]?.reason).toBe('slow');
    expect(p.level).toBe(2);
    expect(p.locked).toBe(false);
  });
});

describe('fixed quality', () => {
  it("quality != 'auto' disables adaptation", () => {
    const p = new PerfController();
    expect(p.setMode('medium')).toBe(true);
    const { changes } = drive(p, 10, (_l, i) => pattern(0.5, i));
    expect(changes.length).toBe(0);
    expect(p.quality).toBe('medium');
    expect(p.scale).toBe(1);
    p.setMode('auto');
    expect(p.quality).toBe('high');
  });
});

describe('adaptive quality recovers from stale conclusions', () => {
  const MISSES = [0.6, 0.5, 0.4, 0.3, 0, 0, 0];
  const loaded = (level: number, i: number) => pattern(MISSES[level] ?? 0, i);

  it('the lock expires after LOCK_MS and resetVsync() clears it', () => {
    const p = new PerfController();
    const capped = (_l: number, i: number) => pattern(0.5, i);
    const r1 = drive(p, 15, capped);
    expect(p.locked).toBe(true);
    // Still locked a while later...
    const r2 = drive(p, 60, capped, { t0: r1.now });
    expect(r2.changes.length).toBe(0);
    // ...but not for the rest of the session: later overload is handled again.
    const r3 = drive(p, LOCK_MS / 1000, capped, { t0: r2.now });
    expect(r3.changes.some((c) => c.reason === 'slow')).toBe(true);
    // A display change (or resume from a hidden tab) forgets the lock at once.
    const q = new PerfController();
    const s1 = drive(q, 15, capped);
    expect(q.locked).toBe(true);
    q.resetVsync();
    expect(q.locked).toBe(false);
    const s2 = drive(q, 5, capped, { t0: s1.now });
    expect(s2.changes[0]?.reason).toBe('slow');
  });

  it('failed step-ups back off exponentially per level (no endless 30 s flip-flop)', () => {
    const p = new PerfController();
    const r1 = drive(p, 16, loaded);
    const r2 = drive(p, 260, loaded, { t0: r1.now });
    const ups = r2.changes.filter((c) => c.reason === 'recovered').map((c) => c.at);
    expect(ups.length).toBeGreaterThanOrEqual(3);
    expect(ups.length).toBeLessThanOrEqual(4);
    const gap1 = (ups[1] ?? 0) - (ups[0] ?? 0);
    const gap2 = (ups[2] ?? 0) - (ups[1] ?? 0);
    expect(gap1).toBeGreaterThanOrEqual(30000);
    expect(gap2).toBeGreaterThanOrEqual(60000);
    expect(gap2).toBeGreaterThan(gap1 * 1.6);
  });

  it('a slower display with a small GPU cost raises the refresh estimate (GPU timer)', () => {
    const p = new PerfController();
    const r1 = drive(p, 3, (_l, i) => 6.94 + (i % 2 ? 0.2 : -0.2), { gpu: () => 2 });
    expect(p.vsyncMs).toBe(6.94);
    // Moved to a 60 Hz monitor at the same DPR.
    const r2 = drive(p, 5, () => 16.67, { gpu: () => 2, t0: r1.now });
    expect(p.vsyncMs).toBe(16.67);
    expect(p.cadenceMs).toBe(16.67);
    expect(p.missRatio).toBeLessThan(0.05);
    expect(r2.changes.length).toBe(0);
    // A GPU that really is too slow for the display does not raise it.
    const q = new PerfController();
    const s1 = drive(q, 3, () => 16.67, { gpu: () => 5 });
    drive(q, 5, () => 33.33, { gpu: () => 24, t0: s1.now });
    expect(q.vsyncMs).toBe(16.67);
    expect(q.cadenceMs).toBe(33.33);
  });

  it('an OS cap without a GPU timer is learned once locked (misses stop)', () => {
    const p = new PerfController();
    const r1 = drive(p, 2, () => 16.67);
    // Energy saver / low-power mode: rAF drops to 30 Hz for good.
    const r2 = drive(p, 20, () => 33.33, { t0: r1.now });
    expect(r2.changes.map((c) => c.reason)).toEqual(['slow', 'slow', 'locked']);
    expect(p.level).toBe(0);
    expect(p.vsyncMs).toBe(33.33);
    expect(p.missRatio).toBe(0);
    // Even after the lock expires nothing flips: the rate is the display's.
    const r3 = drive(p, LOCK_MS / 1000 + 20, () => 33.33, { t0: r2.now });
    expect(r3.changes.length).toBe(0);
  });

  it('cadenceMs follows the dominant rAF interval', () => {
    const p = new PerfController();
    drive(p, 2, () => 8.33);
    expect(p.cadenceMs).toBe(8.33);
    drive(p, 3, () => 16.67, { t0: 2000 });
    expect(p.cadenceMs).toBe(16.67);
  });
});
