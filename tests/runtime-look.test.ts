// @vitest-environment jsdom
/**
 * Shared look (`look: 'shared'`): the group key, the crop arithmetic and the picture state that
 * moves between a card and its group (pure parts), then the facade on the shared renderer without
 * a GPU (a fake GpuDevice / RenderSlot recording draws and their frame blocks, fake 2D contexts
 * recording copies, a manual rAF): one draw per frame for N identical cards, leaving and rejoining
 * with the picture's phase, sizes and lattices, the reducers, parking, context loss and the
 * 'auto' policy.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller, lookKeyOf } from '../src/core/controller/controller';
import { computeGeometry, createGeometry } from '../src/core/controller/geometry';
import { OFF_CLOCK } from '../src/core/engine/frame-block';
import type { FrameInputs } from '../src/core/engine/types';
import { LumiCells } from '../src/core/lumi-cells';
import {
  LookGroup,
  type LookSpec,
  lookOffset,
  lookPitch,
  lookShift,
} from '../src/core/runtime/look';
import { resetRuntimeForTesting } from '../src/core/runtime/scheduler';
import {
  CROWD,
  LITE_CROWD,
  LOOK_GRANTS_PER_FRAME,
  peekSharedRenderer,
  resetSharedForTesting,
  type SharedSeat,
  SPARE_SLOT_MS,
} from '../src/core/runtime/shared-renderer';
import type { LumiCellsEvents } from '../src/core/types';
import { normalizeConfig } from '../src/schema';

const fake = vi.hoisted(() => {
  /** Draws and copies in call order: 'draw <slot>', 'copy <canvas>'. */
  const log: string[] = [];
  class FakeSlot {
    disposed = false;
    draws = 0;
    /** Frame block headers of every draw (the controller refills its block in place). */
    blocks: Float32Array[] = [];
    last: { x: number; y: number; w: number; h: number } | null = null;
    constructor(
      readonly device: FakeDevice,
      readonly tag: number,
    ) {}
    draw(f: FrameInputs, surface: { left: number; top: number }): boolean {
      if (this.disposed || this.device.lost) return false;
      this.draws++;
      this.blocks.push(f.frame.slice(0, 48));
      this.last = { x: surface.left, y: surface.top, w: f.canvasWidth, h: f.canvasHeight };
      this.grid = { w: f.cols + 2 * f.pad, h: f.rows + 2 * f.pad };
      log.push(`draw ${this.tag}`);
      return true;
    }
    recycled = 0;
    /** Cell size of the targets of its last draw (a recycled slot reused at it allocates nothing). */
    grid: { w: number; h: number } | null = null;
    get allocatedCells(): number {
      return this.grid ? this.grid.w * this.grid.h : 0;
    }
    holds(cols: number, rows: number, pad: number): boolean {
      const c = this.grid;
      return !this.disposed && !!c && c.w === cols + 2 * pad && c.h === rows + 2 * pad;
    }
    recycle(): void {
      this.recycled++;
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  class FakeDevice {
    static instances: FakeDevice[] = [];
    readonly caps = { maxDrawableSize: 4096, renderer: 'fake' };
    readonly softwareFallback = false;
    readonly timer = null;
    error: Error | null = null;
    lost = false;
    disposed = false;
    slots: FakeSlot[] = [];
    constructor(readonly canvas: HTMLCanvasElement) {
      FakeDevice.instances.push(this);
    }
    get gl() {
      return {
        drawingBufferWidth: this.canvas.width,
        drawingBufferHeight: this.canvas.height,
      };
    }
    poll(): boolean {
      return !this.disposed && !this.lost;
    }
    isContextLost(): boolean {
      return this.lost;
    }
    createSlot(): FakeSlot {
      if (this.lost) throw new Error('lost');
      const s = new FakeSlot(this, this.slots.length);
      this.slots.push(s);
      return s;
    }
    dispose(): void {
      this.disposed = true;
    }
    loseContextForTesting(): void {
      if (this.lost) return;
      this.lost = true;
      this.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    }
    restoreContextForTesting(): void {
      this.canvas.dispatchEvent(new Event('webglcontextrestored'));
    }
  }
  /** Own engines ('auto' tests): an engine that draws as soon as it exists. */
  class FakeEngine {
    static instances: FakeEngine[] = [];
    readonly caps = { maxDrawableSize: 4096, renderer: 'fake' };
    readonly softwareFallback = false;
    readonly gpuTimeMs = null;
    error = null;
    disposed = false;
    constructor(readonly canvas: HTMLCanvasElement) {
      FakeEngine.instances.push(this);
    }
    render(): boolean {
      return !this.disposed;
    }
    dispose(): void {
      this.disposed = true;
    }
    loseContextForTesting(): void {}
    isContextLost(): boolean {
      return false;
    }
    restoreContextForTesting(): void {}
  }
  return { FakeDevice, FakeSlot, FakeEngine, log };
});

vi.mock('../src/core/engine/device', () => ({
  GpuDevice: fake.FakeDevice,
  toEngineError: (err: unknown) => err,
}));
vi.mock('../src/core/engine/engine', () => ({ Engine: fake.FakeEngine }));

const { FakeDevice, FakeEngine, log } = fake;
type Slot = InstanceType<typeof fake.FakeSlot>;

/** Fake 2D contexts: every copy's source rectangle, per canvas. */
interface Fake2d {
  copies: number[][];
}
const contexts2d = new WeakMap<HTMLCanvasElement, Fake2d>();
const copiesOf = (pl: LumiCells): number[][] =>
  (pl.canvas ? contexts2d.get(pl.canvas)?.copies : undefined) ?? [];
const lastCopy = (pl: LumiCells): number[] | undefined => copiesOf(pl).at(-1);

// Manual rAF driving the shared ticker.
let rafQueue: FrameRequestCallback[] = [];
let now = 1000;
function frame(ms = 16.67): void {
  now += ms;
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(now);
}
function frames(n: number): void {
  for (let i = 0; i < n; i++) frame();
}

/** Host sizes (CSS px): the observers and the canvas boxes report them. */
const hostSize = new WeakMap<Element, { w: number; h: number }>();

class FakeIO {
  static all: FakeIO[] = [];
  observed: Element[] = [];
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly opts: IntersectionObserverInit = {},
  ) {
    FakeIO.all.push(this);
  }
  get zone(): boolean {
    return this.opts.rootMargin === '100%';
  }
  observe(el: Element): void {
    this.observed.push(el);
    this.report(true);
  }
  report(isIntersecting: boolean): void {
    const target = this.observed[0] as Element;
    const s = hostSize.get(target) ?? { w: 200, h: 100 };
    const boundingClientRect = { width: s.w, height: s.h } as DOMRectReadOnly;
    this.cb(
      [{ isIntersecting, target, boundingClientRect } as IntersectionObserverEntry],
      this as never,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

function place(pl: LumiCells, inView: boolean, inZone = inView): void {
  for (const io of FakeIO.all) {
    if (io.observed[0] !== pl.host) continue;
    io.report(io.zone ? inZone : inView);
  }
}

/** The canvas box: the host's size plus the overflow margin the facade set on it. */
function canvasBox(c: HTMLCanvasElement, axis: 'w' | 'h'): number {
  const host = c.parentElement;
  const s = (host && hostSize.get(host)) ?? { w: 200, h: 100 };
  const o = -Number.parseFloat(c.style.left || '0') || 0;
  return s[axis] + 2 * o;
}

beforeAll(() => {
  const ctxs = new WeakMap<HTMLCanvasElement, object>();
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
    if (type === 'webgl2') return { getExtension: () => null };
    if (type !== '2d') return null;
    let ctx = ctxs.get(this);
    if (!ctx) {
      const rec: Fake2d = { copies: [] };
      contexts2d.set(this, rec);
      ctx = {
        canvas: this,
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: true,
        drawImage(_src: HTMLCanvasElement, ...args: number[]) {
          rec.copies.push(args);
          log.push('copy');
        },
      };
      ctxs.set(this, ctx);
    }
    return ctx;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafQueue = [];
  });
  Object.defineProperty(window, 'IntersectionObserver', { value: FakeIO, configurable: true });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLCanvasElement) {
      return canvasBox(this, 'w');
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLCanvasElement) {
      return canvasBox(this, 'h');
    },
  });
});

const live: LumiCells[] = [];
/** A shared-look card of `w` x `h` CSS px on the shared renderer. */
function create(
  w = 200,
  h = 100,
  opts: ConstructorParameters<typeof LumiCells>[1] = {},
): LumiCells {
  const el = document.createElement('div');
  document.body.appendChild(el);
  hostSize.set(el, { w, h });
  const pl = new LumiCells(el, { renderer: 'shared', look: 'shared', ...opts });
  live.push(pl);
  return pl;
}

/** Resizes a host: the canvas box follows (read again on the window's resize event). */
function resizeHost(pl: LumiCells, w: number, h: number): void {
  hostSize.set(pl.host, { w, h });
  window.dispatchEvent(new Event('resize'));
}

function lookEvents(pl: LumiCells): LumiCellsEvents['look'][] {
  const list: LumiCellsEvents['look'][] = [];
  pl.on('look', (e) => list.push(e));
  return list;
}

const tick = () => new Promise<void>((r) => queueMicrotask(r));
const slots = (): Slot[] => (FakeDevice.instances.at(-1)?.slots ?? []) as Slot[];
/** Slot draws in the next frame (slot tags). */
function drawsIn(fn: () => void = frame): number[] {
  const start = log.length;
  fn();
  return log
    .slice(start)
    .filter((l) => l.startsWith('draw '))
    .map((l) => Number(l.slice(5)));
}
const PITCH = { grid: { sizing: 'pitch' as const, pitch: 10 } };
/** Frames until the start-up activity of an instance is over and a rejoin delay has passed. */
const CALM = Math.ceil(2200 / 16.67);

beforeEach(() => {
  FakeDevice.instances = [];
  FakeEngine.instances = [];
  FakeIO.all = [];
  log.length = 0;
  resetRuntimeForTesting();
  resetSharedForTesting();
});

afterEach(() => {
  for (const pl of live.splice(0)) {
    pl.host.remove();
    pl.destroy();
  }
  rafQueue = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// -------------------------------------------------------------------------------------------
// Pure parts

function spec(controller: Controller, w: number, h: number, extra: Partial<LookSpec> = {}) {
  return {
    hostW: w,
    hostH: h,
    dpr: 1,
    pixelCap: Number.POSITIVE_INFINITY,
    reducedMotion: false,
    offset: 0,
    shiftX: 0,
    shiftY: 0,
    controller,
    stateAt: -1,
    ...extra,
  } satisfies LookSpec;
}

/** A seeded PRNG (mulberry32): reproducible random lifts. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A controller measured at `w` x `h` CSS px (DPR 1). */
function measured(config: object, w: number, h: number): Controller {
  const c = new Controller({ config, random: seeded(w * 7 + h) });
  c.setViewport({ hostCssW: w, hostCssH: h, dpr: 1, deviceW: 0, deviceH: 0 });
  return c;
}

/** A group with a fake seat that only records submits (the renderer is not involved). */
function group(c: Controller, w: number, h: number, extra: Partial<LookSpec> = {}): LookGroup {
  return new LookGroup(lookKeyOf(c.getConfig()), spec(c, w, h, extra), 4096, false);
}

function member(s: LookSpec): SharedSeat {
  return {
    spec: s,
    cropX: 0,
    cropY: 0,
    cropW: 0,
    cropH: 0,
    cellDX: 0,
    cellDY: 0,
  } as unknown as SharedSeat;
}

describe('look key', () => {
  it('equal pictures share a key; interaction, pauseOffscreen and transition do not count', () => {
    const base = normalizeConfig({}).config;
    const same = normalizeConfig({
      interaction: { pointer: true, click: false, rippleStrength: 2 },
      render: { pauseOffscreen: false },
      transition: 0,
    }).config;
    expect(lookKeyOf(same)).toBe(lookKeyOf(base));
    expect(lookKeyOf(normalizeConfig({ animation: { speed: 2 } }).config)).not.toBe(
      lookKeyOf(base),
    );
    expect(lookKeyOf(normalizeConfig({ render: { overflow: 8 } }).config)).not.toBe(
      lookKeyOf(base),
    );
    expect(lookKeyOf(normalizeConfig({ extends: 'orb' }).config)).not.toBe(lookKeyOf(base));
  });

  it('a controller keeps one key object per config; cards from one input share it', () => {
    const a = new Controller({ config: { animation: { speed: 1.5 } } });
    const b = new Controller({ config: { animation: { speed: 1.5 } } });
    const k = a.lookKey;
    expect(a.lookKey).toBe(k);
    expect(b.lookKey).toBe(k);
    a.setConfig({ animation: { speed: 2 } });
    expect(a.lookKey).not.toBe(k);
    a.setConfig({ interaction: { pointer: true } });
    expect(a.lookKey).toBe(lookKeyOf(a.getConfig()));
  });
});

describe('look: layers and picture state', () => {
  it('hasLayers: anything of the instance own is a layer, the ambient animation is not', () => {
    const c = measured({}, 200, 100);
    c.update(0.5);
    expect(c.hasLayers).toBe(false);
    const inf = c.addInfluence({ x: 10, y: 10, radius: 4 });
    expect(c.hasLayers).toBe(true);
    inf.dispose();
    // An influence without a GPU slot is freed at once.
    expect(c.hasLayers).toBe(false);
    c.pulse({ x: 10, y: 10 });
    expect(c.hasLayers).toBe(true);
    for (let i = 0; i < 300; i++) c.update(1 / 60);
    expect(c.hasLayers).toBe(false);
    c.lift({ x: 50, y: 50 });
    expect(c.hasLayers).toBe(true);
    for (let i = 0; i < 600; i++) c.update(1 / 60);
    expect(c.hasLayers).toBe(false);
    const m = c.modulate('animation.energy', 1.5);
    expect(c.hasLayers).toBe(true);
    m.dispose();
    expect(c.hasLayers).toBe(false);
    c.setDebugView(1);
    expect(c.hasLayers).toBe(true);
    c.setDebugView(0);
    c.setConfig({ animation: { speed: 2 } }, { transition: 300 });
    expect(c.hasLayers).toBe(true);
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    expect(c.hasLayers).toBe(false);
  });

  it('a hidden pointer light counts until it has faded out', () => {
    const c = measured({}, 200, 100);
    const light = c.createInfluence({ x: 10, y: 10, radius: 4, fadeOutMs: 100 });
    c.update(1 / 60);
    light.hidden = true;
    expect(c.hasLayers).toBe(true);
    for (let i = 0; i < 12; i++) c.update(1 / 60);
    // Still registered (the pointer interaction keeps its light), but out of the picture.
    expect(c.influences.size).toBe(1);
    expect(c.hasLayers).toBe(false);
  });

  it('adoptLook takes the clock, the lifts (moved to the new center) and their ripples', () => {
    const cfg = { ...PITCH, lift: { amount: 0.08, holdMin: 5, holdMax: 5 } };
    const g = measured(cfg, 300, 200);
    for (let i = 0; i < 90; i++) g.update(1 / 60);
    expect(g.lifts.count).toBeGreaterThan(0);
    const m = measured(cfg, 200, 100);
    m.adoptLook(g, 2, -1);
    expect(m.clock.seconds).toBe(g.clock.seconds);
    expect(m.clock.flow).toBe(g.clock.flow);
    expect(m.clock.sparkle).toBe(g.clock.sparkle);
    expect(m.lifts.count).toBe(g.lifts.count);
    // The next frames of both continue the same phase.
    g.update(1 / 60);
    m.update(1 / 60);
    expect(m.frame.frame[OFF_CLOCK]).toBe(g.frame.frame[OFF_CLOCK]);
    // Lifted cells keep their place in the picture: moved by (-2, +1) cells (those that still
    // fit the smaller grid), written with the member's own geometry.
    expect(m.lifts.written).toBeGreaterThan(0);
    expect(m.lifts.written).toBeLessThanOrEqual(g.lifts.written);
  });
});

describe('look: crops and groups', () => {
  it('lookOffset and lookShift: clamped, seeded and spread', () => {
    expect(lookOffset(-1)).toBe(0);
    expect(lookOffset('0.2')).toBe(0);
    expect(lookOffset(0.2)).toBe(0.2);
    expect(lookOffset(3)).toBe(0.5);
    const a = { shiftX: 0, shiftY: 0 };
    const b = { shiftX: 0, shiftY: 0 };
    lookShift(7, a);
    lookShift(7, b);
    expect(a).toEqual(b);
    const xs = new Set<number>();
    for (let i = 1; i <= 50; i++) {
      lookShift(i, a);
      expect(Math.abs(a.shiftX)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.shiftY)).toBeLessThanOrEqual(1);
      xs.add(Math.round(a.shiftX * 4));
    }
    expect(xs.size).toBeGreaterThan(5);
  });

  it('a member of the group size shows all of it; a smaller one a centered crop on its own lattice', () => {
    const big = measured(PITCH, 305, 165);
    const g = group(big, 305, 165);
    const same = member(spec(measured(PITCH, 305, 165), 305, 165));
    g.cropOf(same);
    const gg = g.controller.geo;
    expect([same.cropX, same.cropY, same.cropW, same.cropH]).toEqual([
      0,
      0,
      gg.canvasW,
      gg.canvasH,
    ]);
    expect([same.cellDX, same.cellDY]).toEqual([0, 0]);
    for (const [w, h] of [
      [200, 100],
      [201, 99],
      [117, 64],
    ] as const) {
      const m = member(spec(measured(PITCH, w, h), w, h));
      g.cropOf(m);
      // Crop, never scale: the member's own canvas size.
      const solo = createGeometry();
      computeGeometry(
        {
          hostCssW: w,
          hostCssH: h,
          overflowCss: 0,
          dpr: 1,
          deviceW: 0,
          deviceH: 0,
          maxDpr: 2,
          maxPixels: 4.2,
          scale: 1,
          cssPitch: 10,
        },
        solo,
      );
      expect([m.cropW, m.cropH]).toEqual([solo.canvasW, solo.canvasH]);
      expect(solo.pitchPx).toBe(gg.pitchPx);
      // The group's cell boundaries inside the crop are the member's own.
      const p = gg.pitchPx;
      const mod = (v: number) => ((v % p) + p) % p;
      expect(mod(gg.originX - m.cropX)).toBe(mod(solo.originX));
      expect(mod(gg.originY - m.cropY)).toBe(mod(solo.originY));
      // Centered within a cell, inside the frame.
      expect(Math.abs(m.cropX - (gg.canvasW - m.cropW) / 2)).toBeLessThanOrEqual(p / 2);
      expect(Math.abs(m.cropY - (gg.canvasH - m.cropH) / 2)).toBeLessThanOrEqual(p / 2);
      expect(m.cropX + m.cropW).toBeLessThanOrEqual(gg.canvasW);
      expect(m.cropY + m.cropH).toBeLessThanOrEqual(gg.canvasH);
      expect([m.cellDX, m.cellDY]).toEqual([0, 0]);
    }
  });

  it('fits: covers the member with cells of its size (pitch: any size; count: same shorter side)', () => {
    const c = measured(PITCH, 300, 200);
    const g = group(c, 300, 200);
    expect(g.fits(spec(c, 200, 100), 4096)).toBe(true);
    expect(g.fits(spec(c, 300, 200), 4096)).toBe(true);
    expect(g.fits(spec(c, 301, 200), 4096)).toBe(false);
    expect(g.fits(spec(c, 200, 100, { dpr: 2 }), 4096)).toBe(false);
    // The shift margin needs room too.
    expect(g.fits(spec(c, 200, 100, { offset: 0.25 }), 4096)).toBe(true);
    expect(g.fits(spec(c, 200, 150, { offset: 0.25 }), 4096)).toBe(false);
    const count = measured({}, 300, 200);
    const gc = group(count, 300, 200);
    expect(gc.fits(spec(count, 250, 200), 4096)).toBe(true);
    // Another shorter side: other cells.
    expect(gc.fits(spec(count, 200, 100), 4096)).toBe(false);
    expect(lookPitch(spec(count, 1, 1), 200, 100, 4096)).not.toBe(gc.pitch);
  });

  it('grows to fit a joining card only before it has drawn, and only with cells of the same size', () => {
    const c = measured(PITCH, 200, 100);
    const g = group(c, 200, 100);
    expect(g.grow(spec(c, 260, 90), 4096)).toBe(true);
    expect([g.hostW, g.hostH]).toEqual([260, 100]);
    expect(g.controller.geo.canvasW).toBe(260);
    g.presented(true);
    expect(g.shown).toBe(true);
    expect(g.grow(spec(c, 300, 100), 4096)).toBe(false);
    const count = measured({}, 200, 100);
    const gc = group(count, 200, 100);
    expect(gc.grow(spec(count, 200, 160), 4096)).toBe(false);
  });

  it("'count' with a window shift: the group keeps the starter's cells, not its larger host's", () => {
    // 200x100 with lookOffset 0.25: a 300x150 picture, but cells of 100 / 31 CSS px (as solo).
    const c = measured({}, 200, 100);
    const g = group(c, 200, 100, { offset: 0.25 });
    expect([g.hostW, g.hostH]).toEqual([300, 150]);
    expect(g.pitch).toBe(c.geo.pitchPx);
    expect(g.controller.geo.pitchPx).toBe(c.geo.pitchPx);
    const s = spec(c, 200, 100, { offset: 0.25 });
    lookShift(3, s);
    expect(g.fits(s, 4096)).toBe(true);
    const m = member(s);
    g.cropOf(m);
    const gg = g.controller.geo;
    const p = gg.pitchPx;
    const mod = (v: number) => ((v % p) + p) % p;
    expect([m.cropW, m.cropH]).toEqual([c.geo.canvasW, c.geo.canvasH]);
    expect(mod(gg.originX - m.cropX)).toBe(mod(c.geo.originX));
    expect(mod(gg.originY - m.cropY)).toBe(mod(c.geo.originY));
    // A card with another shorter side still has cells of another size.
    expect(g.fits(spec(measured({}, 200, 140), 200, 140), 4096)).toBe(false);
  });

  it('fractional DPR: the crop is the member canvas exactly, on its own lattice', () => {
    const dpr = 1.75;
    const at = (w: number, h: number) => {
      const c = new Controller({ config: PITCH, random: seeded(w * 7 + h) });
      c.setViewport({ hostCssW: w, hostCssH: h, dpr, deviceW: 0, deviceH: 0 });
      return c;
    };
    const g = group(at(333, 211), 333, 211, { dpr });
    const gg = g.controller.geo;
    const p = gg.pitchPx;
    const mod = (v: number) => ((v % p) + p) % p;
    for (const [w, h] of [
      [100, 90],
      [114, 150],
      [128, 90],
      [60, 78],
      [201, 133],
    ] as const) {
      const c = at(w, h);
      const s = spec(c, w, h, { dpr });
      expect(g.fits(s, 4096)).toBe(true);
      const m = member(s);
      g.cropOf(m);
      const solo = c.geo;
      expect(solo.pitchPx).toBe(p);
      expect([m.cropW, m.cropH]).toEqual([solo.canvasW, solo.canvasH]);
      expect(mod(gg.originX - m.cropX)).toBe(mod(solo.originX));
      expect(mod(gg.originY - m.cropY)).toBe(mod(solo.originY));
      expect(m.cropX + m.cropW).toBeLessThanOrEqual(gg.canvasW);
      expect(m.cropY + m.cropH).toBeLessThanOrEqual(gg.canvasH);
    }
  });

  it('a group advances by the real time however rarely its members present', () => {
    const c = measured(PITCH, 200, 100);
    const g = group(c, 200, 100);
    g.seat = { released: false, submit() {}, stats: { gpuMs: null } } as unknown as SharedSeat;
    // Members run every 60 Hz frame and present every 30th (render.maxFps 2).
    let t = 1000;
    g.beginFrame(t);
    g.update(t, 500);
    const start = g.controller.clock.seconds;
    for (let i = 1; i <= 600; i++) {
      t += 1000 / 60;
      g.beginFrame(t);
      if (i % 30 === 0) g.update(t, 500);
    }
    expect(g.controller.clock.seconds - start).toBeCloseTo(10, 1);
    // A pause (no member ran for a while) is not a frame to catch up.
    const before = g.controller.clock.seconds;
    t += 5000;
    g.beginFrame(t);
    g.update(t, 500);
    expect(g.controller.clock.seconds - before).toBeLessThan(0.05);
  });

  it('window shifts move by whole cells inside a larger picture', () => {
    const c = measured(PITCH, 200, 100);
    const g = group(c, 200, 100, { offset: 0.25 });
    expect([g.hostW, g.hostH]).toEqual([300, 150]);
    const gg = g.controller.geo;
    const crops = new Set<string>();
    for (let order = 1; order <= 12; order++) {
      const s = spec(c, 200, 100, { offset: 0.25 });
      lookShift(order, s);
      const m = member(s);
      g.cropOf(m);
      expect(m.cropX).toBeGreaterThanOrEqual(0);
      expect(m.cropY).toBeGreaterThanOrEqual(0);
      expect(m.cropX + m.cropW).toBeLessThanOrEqual(gg.canvasW);
      expect(m.cropY + m.cropH).toBeLessThanOrEqual(gg.canvasH);
      // Whole cells from the centered window.
      const cx = (gg.canvasW - m.cropW) / 2;
      expect(Math.abs((m.cropX - cx) % 10)).toBe(0);
      expect(m.cellDX).toBe((m.cropX - cx) / 10);
      crops.add(`${m.cropX},${m.cropY}`);
    }
    expect(crops.size).toBeGreaterThan(4);
  });
});

// -------------------------------------------------------------------------------------------
// The facade

describe('LumiCells look: shared', () => {
  it('N identical cards: one slot, one draw per frame, a copy per card, stats and events', async () => {
    const list = Array.from({ length: 12 }, () => create());
    const events = list.map(lookEvents);
    frames(4);
    // No slot per card: only the group's.
    expect(slots()).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      const start = log.length;
      frame();
      const f = log.slice(start);
      expect(f.filter((l) => l.startsWith('draw'))).toEqual(['draw 0']);
      expect(f.filter((l) => l === 'copy')).toHaveLength(12);
    }
    for (const pl of list) {
      expect(pl.canvas?.width).toBe(200);
      expect(pl.canvas?.height).toBe(100);
      expect(pl.canvas?.style.visibility).toBe('');
      expect(lastCopy(pl)?.slice(2)).toEqual([200, 100, 0, 0, 200, 100]);
    }
    frames(20);
    const st = list[3]?.getStats();
    expect(st).toMatchObject({ look: 'group', groupSize: 12, renderer: 'shared', state: 'live' });
    expect(st?.shared).toMatchObject({ groups: 1, draws: 1, regions: 1, members: 12 });
    await tick();
    for (const ev of events) {
      expect(ev).toEqual([{ look: 'group', previous: 'own', reason: 'join', groupSize: 12 }]);
    }
  });

  it('a card asking for its own look is not grouped; nor is one created with a layer', () => {
    const a = create();
    const b = create(200, 100, { look: 'own' });
    const c = create();
    c.setDebugView('field');
    frames(4);
    expect(a.getStats().look).toBe('group');
    expect(b.getStats().look).toBe('own');
    expect(c.getStats().look).toBe('own');
    expect(a.getStats().shared?.groups).toBe(1);
    expect(drawsIn()).toHaveLength(3);
  });

  it('only interaction differs: one group; another picture: another group', () => {
    const a = create();
    const b = create(200, 100, { interactive: true });
    const c = create(200, 100, { config: { color: { palette: ['#000000', '#ffffff'] } } });
    frames(4);
    expect(a.getStats().groupSize).toBe(2);
    expect(b.getStats().groupSize).toBe(2);
    expect(c.getStats().groupSize).toBe(1);
    expect(a.getStats().shared?.groups).toBe(2);
  });

  it('a member that gets an influence leaves and continues the group clock without a jump', async () => {
    const list = [create(), create(), create()];
    frames(5);
    await tick();
    const pl = list[1] as LumiCells;
    const events = lookEvents(pl);
    const groupSlot = slots()[0] as Slot;
    pl.addInfluence({ x: 50, y: 50, radius: 3 });
    frame();
    // Its own slot drew in the same frame as the group's, at exactly the group's phase.
    expect(slots()).toHaveLength(2);
    const own = slots()[1] as Slot;
    expect(own.draws).toBe(1);
    const gc = groupSlot.blocks.at(-1)?.[OFF_CLOCK] as number;
    expect(own.blocks[0]?.[OFF_CLOCK]).toBeCloseTo(gc, 6);
    frames(5);
    expect(own.blocks.at(-1)?.[OFF_CLOCK]).toBeCloseTo(
      groupSlot.blocks.at(-1)?.[OFF_CLOCK] as number,
      6,
    );
    // Copied from its own region now; the others still from the group's.
    expect(lastCopy(pl)?.slice(0, 2)).toEqual([own.last?.x, own.last?.y]);
    expect(lastCopy(list[0] as LumiCells)?.slice(0, 2)).toEqual([
      groupSlot.last?.x,
      groupSlot.last?.y,
    ]);
    const st = pl.getStats();
    expect(st.look).toBe('own');
    expect(st.groupSize).toBe(1);
    expect(list[0]?.getStats().groupSize).toBe(2);
    await tick();
    expect(events).toEqual([{ look: 'own', previous: 'group', reason: 'layers', groupSize: 1 }]);
  });

  it.each<[string, (pl: LumiCells) => unknown]>([
    ['pulse', (pl) => pl.pulse({ x: 10, y: 10 })],
    ['lift', (pl) => pl.lift({ x: 10, y: 10 })],
    ['modulate', (pl) => pl.modulate('animation.speed', () => 1.2)],
    ['setEnergy', (pl) => pl.setEnergy(2)],
    ['setDebugView', (pl) => pl.setDebugView('halo')],
    [
      'bindElement',
      // A bound element shows from its first placement.
      (pl) =>
        pl.bindElement(document.body, { track: 'manual' }).update({ x: 10, y: 10, w: 20, h: 20 }),
    ],
  ])('leaves on %s', async (_name, act) => {
    const list = [create(), create()];
    frames(5);
    await tick();
    const pl = list[0] as LumiCells;
    const events = lookEvents(pl);
    act(pl);
    frame();
    expect(pl.getStats().look).toBe('own');
    await tick();
    expect(events.map((e) => e.reason)).toEqual(['layers']);
  });

  it('a config change leaves the group (reason config); an interaction-only change does not', async () => {
    const list = [create(), create()];
    frames(5);
    await tick();
    const pl = list[0] as LumiCells;
    const events = lookEvents(pl);
    pl.set('interaction.pointer', true);
    frame();
    expect(pl.getStats().look).toBe('group');
    pl.set('animation.speed', 2, { transition: 0 });
    frame();
    expect(pl.getStats().look).toBe('own');
    await tick();
    expect(events.map((e) => e.reason)).toEqual(['config']);
  });

  it('rejoins about 2 s after its last layer is gone; the hysteresis keeps a hovered card out', async () => {
    const list = [create(), create()];
    frames(5);
    await tick();
    const pl = list[1] as LumiCells;
    const events = lookEvents(pl);
    const inf = pl.addInfluence({ x: 50, y: 50, radius: 3, fadeOutMs: 100 });
    frame();
    expect(pl.getStats().look).toBe('own');
    frames(30);
    inf.dispose();
    // Fading out, then calm: still on its own well into the delay.
    frames(60);
    expect(pl.getStats().look).toBe('own');
    // The pointer over the card keeps it out whatever its layers.
    pl.host.dispatchEvent(new Event('pointerenter'));
    frames(CALM);
    expect(pl.getStats().look).toBe('own');
    pl.host.dispatchEvent(new Event('pointerleave'));
    frames(CALM);
    expect(pl.getStats().look).toBe('group');
    expect(pl.getStats().groupSize).toBe(2);
    // Its own slot went back: kept as a spare (it draws nothing), freed when nobody takes it.
    const own = slots()[1] as Slot;
    const draws = own.draws;
    frames(3);
    expect(own.draws).toBe(draws);
    expect(own.disposed).toBe(false);
    frames(Math.ceil(SPARE_SLOT_MS / 16.67) + 2);
    expect(own.disposed).toBe(true);
    await tick();
    expect(events.map((e) => e.reason)).toEqual(['layers', 'join']);
  });

  it.each<[string, (pl: LumiCells) => (() => void) | undefined]>([
    [
      'a debug view',
      (pl) => {
        pl.setDebugView('halo');
        return () => pl.setDebugView('final');
      },
    ],
    ['a long pulse', (pl) => void pl.pulse({ x: 10, y: 10, duration: 3 })],
  ])('rejoins about 2 s after %s ends, not after its activity', (_name, act) => {
    const list = [create(), create()];
    frames(5);
    const pl = list[0] as LumiCells;
    const end = act(pl);
    frame();
    expect(pl.getStats().look).toBe('own');
    // The layer lasts 3 s (well past the rejoin delay counted from its one activity mark).
    frames(180);
    end?.();
    // The layer is gone within a few frames; the card stays on its own for the delay after it.
    frames(10);
    expect(pl.getStats().look).toBe('own');
    frames(Math.ceil(1700 / 16.67));
    expect(pl.getStats().look).toBe('own');
    frames(30);
    expect(pl.getStats().look).toBe('group');
  });

  it('render.maxFps below 4: the shared picture runs at the real speed (as an own card)', () => {
    const config = { ...PITCH, render: { maxFps: 2 } };
    const a = create(200, 100, { config });
    create(200, 100, { config });
    const own = create(200, 100, { config, look: 'own' });
    frames(5);
    expect(a.getStats().look).toBe('group');
    expect(own.getStats().look).toBe('own');
    const clockOf = (s: Slot) => s.blocks.at(-1)?.[OFF_CLOCK] as number;
    frames(60);
    const start = slots().map(clockOf);
    frames(600);
    const advanced = slots().map((s, i) => clockOf(s) - (start[i] as number));
    expect(advanced).toHaveLength(2);
    // Both pictures (the group's and the own card's) went on by about 10 s.
    for (const v of advanced) expect(v).toBeGreaterThan(9.3);
    expect(Math.abs((advanced[0] as number) - (advanced[1] as number))).toBeLessThan(0.6);
  });

  it('a low secondary frame rate: the shared picture keeps the real time', () => {
    LumiCells.configure({ secondaryMaxFps: 3 });
    create(400, 300, { look: 'own', config: PITCH });
    const pl = create(200, 100, { config: PITCH });
    frames(5 + CALM);
    expect(pl.getStats().look).toBe('group');
    expect(pl.getStats().reducers.frameDivisor).toBe(20);
    let dt = 0;
    pl.on('frame', (e) => {
      dt += e.dt;
    });
    const groupSlot = () => slots().find((s) => s.last?.w === 200) as Slot;
    const before = groupSlot().blocks.at(-1)?.[OFF_CLOCK] as number;
    frames(600);
    const after = groupSlot().blocks.at(-1)?.[OFF_CLOCK] as number;
    expect(dt).toBeGreaterThan(9.3);
    expect(after - before).toBeGreaterThan(9.3);
    expect(Math.abs(after - before - dt)).toBeLessThan(0.6);
  });

  it('setLook: own leaves at once (explicit), shared joins at the next frame', async () => {
    const list = [create(), create()];
    frames(5);
    await tick();
    const pl = list[0] as LumiCells;
    const events = lookEvents(pl);
    pl.setLook('own');
    expect(pl.look).toBe('own');
    expect(pl.getStats().look).toBe('own');
    frames(3);
    expect(pl.getStats().look).toBe('own');
    pl.setLook('shared');
    frame();
    expect(pl.getStats().look).toBe('group');
    await tick();
    expect(events.map((e) => e.reason)).toEqual(['explicit', 'join']);
  });

  it('the group keeps its size when its largest member leaves; a larger card later gets its own', () => {
    const big = create(300, 160, { config: PITCH });
    const small = create(200, 100, { config: PITCH });
    frames(4);
    expect(small.getStats().groupSize).toBe(2);
    const g = slots()[0] as Slot;
    expect(g.last).toMatchObject({ w: 300, h: 160 });
    // The small card: the centered 200x100 of the 300x160 picture, on its own lattice.
    const crop = lastCopy(small) as number[];
    expect(crop.slice(0, 4)).toEqual([(g.last?.x ?? 0) + 50, (g.last?.y ?? 0) + 30, 200, 100]);
    const clock = () => g.blocks.at(-1)?.[OFF_CLOCK] as number;
    const before = clock();
    big.destroy();
    frame();
    // The picture keeps its size and phase: the small card's window does not move.
    expect(small.getStats().groupSize).toBe(1);
    expect(g.last).toMatchObject({ w: 300, h: 160 });
    expect(lastCopy(small)?.slice(0, 4)).toEqual([
      (g.last?.x ?? 0) + 50,
      (g.last?.y ?? 0) + 30,
      200,
      100,
    ]);
    expect(clock() - before).toBeCloseTo(1 / 60, 3);
    frames(2);
    // A card of the old size fits; a larger one starts its own group.
    const again = create(300, 160, { config: PITCH });
    const larger = create(400, 200, { config: PITCH });
    frames(4);
    expect(again.getStats().groupSize).toBe(2);
    expect(larger.getStats().groupSize).toBe(1);
    expect(larger.getStats().look).toBe('group');
    expect(peekSharedRenderer()?.groupCount).toBe(2);
    expect(g.last).toMatchObject({ w: 300, h: 160 });
  });

  it("grid.sizing 'count': cards with another shorter side keep pictures of their own", () => {
    const a = create(200, 100);
    const b = create(260, 100);
    const c = create(200, 160);
    frames(4);
    expect(a.getStats().groupSize).toBe(2);
    expect(b.getStats().groupSize).toBe(2);
    expect(c.getStats().groupSize).toBe(1);
  });

  it('a card that grows out of its group moves to a new one that continues its picture', () => {
    const a = create(200, 100, { config: PITCH });
    const b = create(200, 100, { config: PITCH });
    frames(5);
    const old = slots()[0] as Slot;
    resizeHost(b, 260, 120);
    // The new size applies within the resize throttle (100 ms).
    for (let i = 0; i < 10 && peekSharedRenderer()?.groupCount !== 2; i++) frame();
    expect(b.getStats().look).toBe('group');
    expect(peekSharedRenderer()?.groupCount).toBe(2);
    expect(a.getStats().groupSize).toBe(1);
    const next = slots()[1] as Slot;
    expect(next.last).toMatchObject({ w: 260, h: 120 });
    // Same phase as the group it came from, in the same frame.
    expect(next.blocks[0]?.[OFF_CLOCK]).toBeCloseTo(old.blocks.at(-1)?.[OFF_CLOCK] as number, 6);
    expect(lastCopy(b)?.slice(2, 4)).toEqual([260, 120]);
  });

  it('a crowd of identical cards: one draw per frame, the copies paced and staggered per card', () => {
    const list = Array.from({ length: CROWD + 12 }, () => create());
    frames(4 + CALM);
    const copiesBefore = list.map((pl) => copiesOf(pl).length);
    const per = Array.from({ length: 8 }, () => drawsIn());
    // The picture is drawn in every frame (some card presents in each), once.
    for (const f of per) expect(f).toEqual([0]);
    // The largest card (the first, all being equal) every frame, the others every 2nd, half of
    // them on even frames, half on odd ones.
    const presented = list.map((pl, i) => copiesOf(pl).length - (copiesBefore[i] as number));
    expect(presented[0]).toBe(8);
    for (const n of presented.slice(1)) expect(n).toBe(4);
    const st = list[7]?.getStats();
    expect(st?.reducers.frameDivisor).toBe(2);
    expect(list[0]?.getStats().reducers.frameDivisor).toBe(1);
    expect(st?.shared?.reducers.secondary).toBe(list.length - 1);
    // Small and inactive: the picture draws lite, the members say so.
    expect(st?.reducers.lite).toBe(true);
    expect(st?.shared?.reducers.lite).toBe(1);
    expect(st?.shared?.draws).toBe(1);
  });

  it('a member keeps its animation time at a lower rate (frames carry the skipped ones)', () => {
    const list = Array.from({ length: CROWD + 4 }, () => create());
    frames(4 + CALM);
    let time = 0;
    let events = 0;
    list[5]?.on('frame', (e) => {
      time += e.dt;
      events++;
    });
    frames(60);
    expect(events).toBe(30);
    expect(time).toBeGreaterThan(0.98);
    expect(time).toBeLessThan(1.02);
  });

  it('look candidates are seated without a slot, many per frame', () => {
    const n = LOOK_GRANTS_PER_FRAME + 20;
    const list = Array.from({ length: n }, () => create());
    frame();
    expect(peekSharedRenderer()?.seatCount).toBe(LOOK_GRANTS_PER_FRAME);
    expect(slots()).toHaveLength(0);
    frames(3);
    expect(peekSharedRenderer()?.seatCount).toBe(n);
    expect(slots()).toHaveLength(1);
    expect(list.every((pl) => pl.getStats().look === 'group')).toBe(true);
  });

  it('the budget plan counts a group once', () => {
    LumiCells.configure({ sharedBudget: 0.05 });
    const list = Array.from({ length: 30 }, () => create());
    frames(6);
    // 30 cards of 0.02 Mpx would need 0.6 Mpx: one picture of 0.02 Mpx fits.
    expect(list[0]?.getStats().shared?.scale).toBe(1);
    expect(list[0]?.canvas?.width).toBe(200);
  });

  it('parking gives the seat back; the group goes with its last member', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    LumiCells.configure({ parkAfterMs: 1000 });
    const a = create();
    const b = create();
    frames(4);
    await tick();
    const events = lookEvents(a);
    const g = slots()[0] as Slot;
    place(a, false, false);
    vi.advanceTimersByTime(1000);
    expect(a.getStats().state).toBe('parked');
    expect(a.getStats().look).toBe('own');
    expect(b.getStats().groupSize).toBe(1);
    expect(g.disposed).toBe(false);
    place(b, false, false);
    vi.advanceTimersByTime(1000);
    expect(g.disposed).toBe(true);
    expect(peekSharedRenderer()?.active).toBe(false);
    // Back: a fresh seat joins at once (nothing of its own on screen).
    place(a, true);
    place(b, true);
    frames(4);
    expect(a.getStats().look).toBe('group');
    expect(a.getStats().groupSize).toBe(2);
    await tick();
    expect(events.map((e) => [e.look, e.reason])).toEqual([
      ['own', 'renderer'],
      ['group', 'join'],
    ]);
  });

  it('a lost context keeps every member on its last frame; the group is rebuilt', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const list = [create(), create(), create()];
    frames(4);
    const copies = list.map((pl) => copiesOf(pl).length);
    list[0]?.loseContextForTesting();
    frames(3);
    expect(list.every((pl) => pl.getStats().state === 'lost')).toBe(true);
    // Nothing copied: the canvases keep their frame (no poster).
    expect(list.map((pl) => copiesOf(pl).length)).toEqual(copies);
    expect(list.every((pl) => pl.canvas?.style.visibility === '')).toBe(true);
    vi.advanceTimersByTime(500);
    frames(3);
    expect(list.every((pl) => pl.getStats().state === 'live')).toBe(true);
    expect(list.every((pl) => pl.getStats().look === 'group')).toBe(true);
    // One new slot: the group's.
    const dev = FakeDevice.instances.at(-1);
    expect(dev?.slots.filter((s) => !s.disposed)).toHaveLength(1);
    expect(list.map((pl) => copiesOf(pl).length > (copies[0] as number))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("'auto': look shared keeps a large card on the shared renderer; setLook moves an own one", async () => {
    const large = create(900, 700, { renderer: 'auto' });
    frames(4);
    expect(large.renderer).toBe('shared');
    expect(large.getStats().look).toBe('group');
    expect(FakeEngine.instances).toHaveLength(0);
    const hero = create(900, 700, { renderer: 'auto', look: 'own' });
    frames(4);
    expect(hero.renderer).toBe('own');
    const switches: LumiCellsEvents['renderer'][] = [];
    hero.on('renderer', (e) => switches.push(e));
    hero.setLook('shared');
    frames(4);
    expect(hero.renderer).toBe('shared');
    expect(hero.getStats().look).toBe('group');
    expect(hero.getStats().groupSize).toBe(2);
    await tick();
    expect(switches).toEqual([{ renderer: 'shared', previous: 'own', reason: 'explicit' }]);
  });

  it('a hover sweep reuses the slots of cards that rejoined: no new targets per hovered card', () => {
    const list = Array.from({ length: 8 }, () => create(200, 100, { interactive: true }));
    frames(4 + CALM);
    expect(slots()).toHaveLength(1);
    // The pointer passes over one card after the other, each rejoining before the next.
    for (const pl of list) {
      pl.host.dispatchEvent(new Event('pointerenter'));
      frames(5);
      expect(pl.getStats().look).toBe('own');
      pl.host.dispatchEvent(new Event('pointerleave'));
      for (let i = 0; i < 4 * CALM && pl.getStats().look !== 'group'; i++) frame();
      expect(pl.getStats().look).toBe('group');
    }
    // The group's slot and one slot the cards passed on (recycled for each but the first).
    const all = slots();
    expect(all).toHaveLength(2);
    const spare = all[1] as Slot;
    expect(spare.recycled).toBe(list.length - 1);
    expect(spare.draws).toBeGreaterThan(list.length * 5 - 1);
    expect(spare.disposed).toBe(false);
  });

  it('a hover sweep with several cards out at once keeps a bounded number of slots', () => {
    const list = Array.from({ length: 16 }, () => create(200, 100, { interactive: true }));
    frames(4 + CALM);
    // A new card every 60 frames, each out for a few seconds: several cards out at any time.
    let peak = 0;
    const out = () => list.filter((pl) => pl.getStats().look === 'own').length;
    for (const pl of list) {
      pl.host.dispatchEvent(new Event('pointerenter'));
      frames(2);
      pl.host.dispatchEvent(new Event('pointerleave'));
      for (let i = 0; i < 58; i++) {
        frame();
        peak = Math.max(peak, out());
      }
    }
    frames(4 * CALM);
    expect(out()).toBe(0);
    // No more slots than cards out at the same time (plus the group's): each card that left
    // took a slot another one had given back.
    expect(peak).toBeLessThan(list.length / 2);
    expect(slots().length).toBeLessThanOrEqual(peak + 1);
  });

  it('crowded lite counts a group once: identical large members keep the full pipeline', () => {
    const list = Array.from({ length: LITE_CROWD + 2 }, () => create(500, 400));
    frames(4 + CALM);
    const st = list[3]?.getStats();
    expect(st?.groupSize).toBe(list.length);
    expect(st?.shared?.draws).toBe(1);
    expect(st?.shared?.reducers.lite).toBe(0);
    expect(st?.reducers.lite).toBe(false);
  });

  it("a member's stats describe the picture it shows; a tier change on joining is reported", async () => {
    const a = create(200, 100, { config: PITCH });
    frames(4);
    expect(a.getStats().look).toBe('group');
    // The group renders at another tier than a fresh card (as if its frames had been slow).
    const r = peekSharedRenderer() as unknown as { looks: Map<string, LookGroup[]> };
    const g = [...r.looks.values()][0]?.[0] as LookGroup;
    const gc = g.controller;
    expect(gc.perf.adoptLevel({ mode: 'auto', level: 2, locked: false } as never)).toBe(true);
    (gc as unknown as { updateGeometry(): void }).updateGeometry();
    const b = create(200, 100, { config: PITCH });
    const quality: LumiCellsEvents['quality'][] = [];
    b.on('quality', (e) => quality.push({ ...e }));
    // The group's lifted cells when the stats were taken (random lifts come and go).
    const lifts: number[][] = [];
    b.on('stats', (e) => lifts.push([e.lifts, gc.lifts.written]));
    frames(30);
    expect(b.getStats().look).toBe('group');
    expect(quality).toEqual([{ quality: 'medium', scale: 0.85, reason: 'look' }]);
    const st = b.getStats();
    expect(st.quality).toBe('medium');
    expect(st.scale).toBe(0.85);
    // Its crop of the group's frame (smaller than its own canvas at the group's scale).
    const copy = lastCopy(b) as number[];
    const [cw, ch] = [copy[2] as number, copy[3] as number];
    expect(cw * ch).toBeLessThan(200 * 100);
    expect(st.pixels).toBe(cw * ch);
    const gg = gc.geo;
    expect(st.dpr).toBe(gg.effDpr);
    expect(st.cols).toBe(Math.round(cw / gg.pitchPx));
    expect(st.rows).toBe(Math.round(ch / gg.pitchPx));
    expect(lifts.length).toBeGreaterThan(0);
    for (const [shown, group] of lifts) expect(shown).toBe(group);
    // Leaving at the group's tier: nothing new to report.
    b.addInfluence({ x: 50, y: 50, radius: 3 });
    frames(2);
    expect(b.getStats().look).toBe('own');
    expect(quality).toHaveLength(1);
    await tick();
  });

  it('a member reports the frame time and its share of the group cost', () => {
    const list = [create(), create()];
    frames(4);
    let time = 0;
    list[0]?.on('frame', (e) => {
      time += e.dt;
    });
    frames(60);
    expect(time).toBeGreaterThan(0.98);
    expect(time).toBeLessThan(1.02);
  });
});
