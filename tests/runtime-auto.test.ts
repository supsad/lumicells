// @vitest-environment jsdom
/**
 * `renderer: 'auto'`: the pure policy (score, hysteresis, dwell) and the facade driving it with a
 * fake Engine (own), a fake GpuDevice (shared), fake 2D contexts, a manual rAF, a fake
 * IntersectionObserver that reports host rects and a fake ResizeObserver the tests drive.
 * jsdom's viewport is 1024x768 at DPR 1: a quarter of it is 196608 CSS px^2, and 0.5 Mpx
 * `promoteArea` is 500000 device px.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { LumiCells } from '../src/core/lumi-cells';
import {
  AUTO_DWELL_MS,
  AutoDwell,
  type AutoSize,
  autoScore,
  autoWants,
  DEMOTE_RATIO,
  PROMOTE_VIEWPORT_SHARE,
} from '../src/core/runtime/auto-renderer';
import { contextsInUse, resetRuntimeForTesting } from '../src/core/runtime/scheduler';
import { peekSharedRenderer, resetSharedForTesting } from '../src/core/runtime/shared-renderer';
import type { LumiCellsEvents } from '../src/core/types';

// -------------------------------------------------------------------------------------------
// The pure policy

function size(p: Partial<AutoSize> = {}): AutoSize {
  return {
    cssW: 0,
    cssH: 0,
    overflow: 0,
    dpr: 1,
    maxPixels: 4.2e6,
    viewportW: 1920,
    viewportH: 1080,
    ...p,
  };
}

describe('auto policy: score', () => {
  const PX = 0.5e6;

  it('is 1 at promoteArea device pixels (overflow margin and DPR included)', () => {
    expect(autoScore(size({ cssW: 1000, cssH: 500 }), PX)).toBeCloseTo(1);
    // 400x300 CSS at DPR 2 is 0.48 Mpx; a 10 px margin brings it past 0.5.
    expect(autoScore(size({ cssW: 400, cssH: 300, dpr: 2 }), PX)).toBeCloseTo(0.96);
    expect(autoScore(size({ cssW: 400, cssH: 300, dpr: 2, overflow: 10 }), PX)).toBeGreaterThan(1);
  });

  it('is 1 at a quarter of the viewport, whatever the pixels', () => {
    const vp = size({ viewportW: 800, viewportH: 600 });
    const quarter = 800 * 600 * PROMOTE_VIEWPORT_SHARE;
    expect(autoScore({ ...vp, cssW: quarter / 100, cssH: 100, dpr: 0.5 }, PX)).toBeCloseTo(1);
    // The margin does not count for the viewport share.
    expect(autoScore({ ...vp, cssW: 100, cssH: 100, overflow: 50 }, 1e12)).toBeCloseTo(
      (100 * 100) / quarter,
    );
  });

  it('caps the pixels by the pixel budget; an unknown size scores 0', () => {
    const big = size({ cssW: 4000, cssH: 3000, dpr: 2, viewportW: 1e5, viewportH: 1e5 });
    expect(autoScore({ ...big, maxPixels: 1e6 }, PX)).toBeCloseTo(2);
    expect(autoScore(size(), PX)).toBe(0);
    expect(autoScore(size({ cssW: 100, cssH: 0 }), PX)).toBe(0);
    expect(autoScore(size({ cssW: Number.NaN, cssH: 10 }), PX)).toBe(0);
  });
});

describe('auto policy: hysteresis and dwell', () => {
  it('shared goes own from 1x the threshold, own goes shared below the demotion ratio', () => {
    expect(autoWants(0.99, 'shared')).toBe('shared');
    expect(autoWants(1, 'shared')).toBe('own');
    expect(autoWants(0.99, 'own')).toBe('own');
    expect(autoWants(DEMOTE_RATIO, 'own')).toBe('own');
    expect(autoWants(DEMOTE_RATIO - 0.01, 'own')).toBe('shared');
    expect(autoWants(Number.NaN, 'own')).toBe('shared');
  });

  it('a switch is due a dwell after the last size change and after the last switch', () => {
    const d = new AutoDwell();
    expect(d.score).toBeNaN();
    d.note(0.5, 1000);
    expect(d.dueAt()).toBe(1000 + AUTO_DWELL_MS);
    // The same score (a spurious resize report) does not restart the dwell.
    d.note(0.5, 1400);
    expect(d.dueAt()).toBe(1000 + AUTO_DWELL_MS);
    d.note(0.6, 1500);
    expect(d.dueAt()).toBe(1500 + AUTO_DWELL_MS);
    d.switched(2000);
    expect(d.dueAt()).toBe(2000 + AUTO_DWELL_MS);
    expect(d.dueAt(10)).toBe(2010);
  });
});

// -------------------------------------------------------------------------------------------
// The facade

const fake = vi.hoisted(() => {
  class FakeSlot {
    disposed = false;
    draws = 0;
    constructor(readonly device: FakeDevice) {}
    draw(): boolean {
      if (this.disposed || this.device.lost) return false;
      this.draws++;
      return true;
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
      const s = new FakeSlot(this);
      this.slots.push(s);
      return s;
    }
    dispose(): void {
      this.disposed = true;
    }
    loseContextForTesting(): void {
      this.lost = true;
    }
    restoreContextForTesting(): void {}
  }
  class FakeEngine {
    static instances: FakeEngine[] = [];
    readonly caps = { maxDrawableSize: 4096, renderer: 'fake' };
    readonly softwareFallback = false;
    readonly gpuTimeMs = null;
    error = null;
    lost = false;
    disposed = false;
    renders = 0;
    constructor(readonly canvas: HTMLCanvasElement) {
      FakeEngine.instances.push(this);
    }
    render(): boolean {
      if (this.lost || this.disposed) return false;
      this.renders++;
      return true;
    }
    dispose(): void {
      this.disposed = true;
    }
    loseContextForTesting(): void {
      this.lost = true;
    }
    isContextLost(): boolean {
      return this.lost;
    }
    restoreContextForTesting(): void {}
  }
  return { FakeDevice, FakeEngine };
});

vi.mock('../src/core/engine/device', () => ({
  GpuDevice: fake.FakeDevice,
  toEngineError: (err: unknown) => err,
}));
vi.mock('../src/core/engine/engine', () => ({ Engine: fake.FakeEngine }));

const { FakeDevice, FakeEngine } = fake;

/** Copies drawn into each 2D canvas (by the shared renderer, or into a stand-in). */
const copies = new WeakMap<HTMLCanvasElement, HTMLCanvasElement[]>();
/** Canvases that were given a 2D context (a browser never gives them a WebGL one afterwards). */
const with2d = new WeakSet<HTMLCanvasElement>();

// Manual rAF driving the shared ticker.
let rafQueue: FrameRequestCallback[] = [];
let now = 1000;
function frame(): void {
  now += 16.67;
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(now);
}
function frames(n: number): void {
  for (let i = 0; i < n; i++) frame();
}
/** Moves the clock (timers and performance.now()) and runs a frame. */
function wait(ms: number): void {
  vi.advanceTimersByTime(ms);
  frame();
}

/** Host sizes the observers report (CSS px). */
const hostSize = new WeakMap<Element, { w: number; h: number }>();

class FakeIO {
  static all: FakeIO[] = [];
  /** A browser reports after the next frame, not inside observe(): tests that need it set this. */
  static deferFirst = false;
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
    if (!FakeIO.deferFirst) this.report(true);
  }
  report(isIntersecting: boolean): void {
    const target = this.observed[0] as Element;
    const s = hostSize.get(target) ?? { w: 0, h: 0 };
    const boundingClientRect = { width: s.w, height: s.h } as DOMRectReadOnly;
    this.cb(
      [{ isIntersecting, target, boundingClientRect } as IntersectionObserverEntry],
      this as never,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** Fake ResizeObserver: reports only when a test resizes a host. */
class FakeRO {
  static all: FakeRO[] = [];
  observed = new Set<Element>();
  constructor(readonly cb: ResizeObserverCallback) {
    FakeRO.all.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
}

/** Resizes a host: its ResizeObservers report the new border box. */
function resize(pl: LumiCells, w: number, h: number): void {
  hostSize.set(pl.host, { w, h });
  for (const ro of FakeRO.all) {
    if (!ro.observed.has(pl.host)) continue;
    const entry = {
      target: pl.host,
      borderBoxSize: [{ inlineSize: w, blockSize: h }],
      contentRect: { width: w, height: h },
    } as unknown as ResizeObserverEntry;
    ro.cb([entry], ro as never);
  }
}

/** Moves an instance's host out of (or back into) the view and the creation zone. */
function place(pl: LumiCells, inView: boolean, inZone = inView): void {
  for (const io of FakeIO.all) {
    if (io.observed[0] !== pl.host) continue;
    io.report(io.zone ? inZone : inView);
  }
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
    if (type === 'webgl2') return { getExtension: () => null };
    if (type !== '2d') return null;
    const canvas = this;
    with2d.add(canvas);
    return {
      canvas,
      globalCompositeOperation: 'source-over',
      imageSmoothingEnabled: true,
      drawImage(src: HTMLCanvasElement) {
        const list = copies.get(canvas) ?? [];
        list.push(src);
        copies.set(canvas, list);
      },
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafQueue = [];
  });
  Object.defineProperty(window, 'IntersectionObserver', { value: FakeIO, configurable: true });
  Object.defineProperty(window, 'ResizeObserver', { value: FakeRO, configurable: true });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 200,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 100,
  });
});

const live: LumiCells[] = [];
/** An instance on a host of `w` x `h` CSS px (jsdom viewport: 1024x768). */
function create(
  w: number,
  h: number,
  opts: ConstructorParameters<typeof LumiCells>[1] = {},
): LumiCells {
  const el = document.createElement('div');
  document.body.appendChild(el);
  hostSize.set(el, { w, h });
  const pl = new LumiCells(el, opts);
  live.push(pl);
  return pl;
}
const HERO = [1024, 768] as const; // score 4 (the whole viewport)
const CARD = [200, 100] as const; // score 0.1
const BETWEEN = [400, 400] as const; // score 0.81: between the demotion ratio and 1
const LARGE = [500, 400] as const; // score 1.02

function events(pl: LumiCells): LumiCellsEvents['renderer'][] {
  const list: LumiCellsEvents['renderer'][] = [];
  pl.on('renderer', (e) => list.push(e));
  return list;
}

const tick = () => new Promise<void>((r) => queueMicrotask(r));
/** Canvases in the host: the current one plus a stand-in holding the last frame, if any. */
const canvases = (pl: LumiCells) => pl.host.querySelectorAll('canvas').length;

beforeEach(() => {
  FakeDevice.instances = [];
  FakeEngine.instances = [];
  FakeIO.all = [];
  FakeIO.deferFirst = false;
  FakeRO.all = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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

describe("LumiCells renderer: 'auto'", () => {
  it('is the default: a hero gets its own context, cards share one (two contexts in all)', async () => {
    const hero = create(...HERO);
    const cards = Array.from({ length: 12 }, () => create(...CARD));
    const heroEvents = events(hero);
    expect(hero.rendererMode).toBe('auto');
    frames(12);
    await tick();
    expect(hero.getStats()).toMatchObject({ renderer: 'own', rendererMode: 'auto', state: 'live' });
    for (const c of cards) {
      expect(c.getStats()).toMatchObject({
        renderer: 'shared',
        rendererMode: 'auto',
        state: 'live',
      });
    }
    expect(FakeEngine.instances).toHaveLength(1);
    expect(FakeDevice.instances).toHaveLength(1);
    expect(contextsInUse()).toBe(2);
    // The first choice is not a switch.
    expect(heroEvents).toEqual([]);
  });

  it('LumiCells.configure({ renderer }) sets the default of instances created afterwards', () => {
    const before = create(...HERO);
    LumiCells.configure({ renderer: 'shared' });
    const after = create(...HERO);
    const explicit = create(...CARD, { renderer: 'auto' });
    frames(6);
    expect(before.getStats()).toMatchObject({ renderer: 'own', rendererMode: 'auto' });
    expect(after.getStats()).toMatchObject({ renderer: 'shared', rendererMode: 'shared' });
    expect(explicit.rendererMode).toBe('auto');
  });

  it('a hero resized small is demoted only after the size held still for the dwell', async () => {
    const hero = create(...HERO);
    frames(4);
    const seen = events(hero);
    const own = hero.canvas as HTMLCanvasElement;
    resize(hero, ...CARD);
    wait(AUTO_DWELL_MS - 50);
    expect(hero.renderer).toBe('own');
    // Due: the switch runs right after the next drawn frame, which stays on screen as a copy.
    wait(50);
    expect(hero.renderer).toBe('shared');
    expect(own.isConnected).toBe(false);
    expect(canvases(hero)).toBe(2); // the stand-in and the new (hidden) 2D canvas
    const standIn = [...hero.host.querySelectorAll('canvas')].find(
      (c) => c !== hero.canvas,
    ) as HTMLCanvasElement;
    expect(copies.get(standIn)).toEqual([own]);
    expect(standIn.style.visibility).toBe('');
    frames(3);
    // The shared renderer drew and copied: the stand-in is gone, the 2D canvas is shown.
    expect(canvases(hero)).toBe(1);
    expect(hero.canvas?.style.visibility).toBe('');
    expect(hero.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    expect(FakeEngine.instances[0]?.disposed).toBe(true);
    await tick();
    expect(seen).toEqual([{ renderer: 'shared', previous: 'own', reason: 'demote' }]);
  });

  it('does not flip while a resize handle is dragged across the threshold', async () => {
    const hero = create(...HERO);
    frames(4);
    const seen = events(hero);
    // Two seconds of dragging back and forth, a size every 100 ms.
    for (let i = 0; i < 20; i++) {
      const [w, h] = i % 2 ? HERO : CARD;
      resize(hero, w, h);
      wait(100);
    }
    expect(hero.renderer).toBe('own');
    // The drag ends small: one demotion, a dwell later.
    resize(hero, ...CARD);
    wait(AUTO_DWELL_MS);
    frames(3);
    await tick();
    expect(seen.map((e) => e.reason)).toEqual(['demote']);
  });

  it('keeps its renderer for sizes between the demotion ratio and the threshold', () => {
    const hero = create(...HERO);
    const card = create(...CARD);
    frames(6);
    resize(hero, ...BETWEEN);
    resize(card, ...BETWEEN);
    wait(AUTO_DWELL_MS * 3);
    frames(3);
    expect(hero.renderer).toBe('own');
    expect(card.renderer).toBe('shared');
    expect(contextsInUse()).toBe(2);
  });

  it('a card enlarged past the threshold is promoted; its last frame stays until the new one', async () => {
    const card = create(...CARD);
    frames(4);
    const seen = events(card);
    const shared = card.canvas as HTMLCanvasElement;
    expect(card.renderer).toBe('shared');
    resize(card, ...LARGE);
    wait(AUTO_DWELL_MS - 50);
    expect(card.renderer).toBe('shared');
    // Due: a standby request for a context of its own, granted at the end of the frame.
    wait(50);
    expect(card.renderer).toBe('own');
    expect(FakeEngine.instances).toHaveLength(1);
    // The 2D canvas stays in the host with its last frame until the engine drew.
    expect(shared.isConnected).toBe(true);
    expect(card.canvas).not.toBe(shared);
    frame();
    expect(shared.isConnected).toBe(false);
    expect([shared.width, shared.height]).toEqual([0, 0]); // its memory freed
    expect(card.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    // The last shared member left: the shared context is released.
    expect(peekSharedRenderer()?.active).toBe(false);
    await tick();
    expect(seen).toEqual([{ renderer: 'own', previous: 'shared', reason: 'promote' }]);
  });

  it('a full budget sends large instances to the shared renderer instead of waiting', async () => {
    LumiCells.configure({ maxContexts: 1 });
    const a = create(...HERO);
    frames(2);
    const b = create(...HERO);
    const seenB = events(b);
    const fallbacks: unknown[] = [];
    b.on('fallback', (e) => fallbacks.push(e));
    frames(6);
    await tick();
    expect(a.renderer).toBe('own');
    // b asked for its own context, was refused, and draws shared: no poster wait, no warning.
    expect(b.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    expect(seenB).toEqual([{ renderer: 'shared', previous: 'own', reason: 'budget' }]);
    expect(fallbacks).toEqual([]);
    // It stays a candidate (after the dwell): no churn while the budget is full.
    wait(AUTO_DWELL_MS * 3);
    frames(5);
    await tick();
    expect(seenB).toHaveLength(1);
    expect(FakeEngine.instances).toHaveLength(1);
    // A slot frees up: promoted.
    a.destroy();
    frames(3);
    await tick();
    expect(b.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    expect(seenB.map((e) => e.reason)).toEqual(['budget', 'promote']);
    expect(contextsInUse()).toBe(1);
  });

  it("priority 'high' takes the own context of a normal auto instance, which goes shared", async () => {
    LumiCells.configure({ maxContexts: 1 });
    const normal = create(...HERO);
    frames(3);
    const seen = events(normal);
    const high = create(...HERO, { priority: 'high' });
    frames(5);
    await tick();
    expect(high.renderer).toBe('own');
    expect(normal.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    expect(seen).toEqual([{ renderer: 'shared', previous: 'own', reason: 'budget' }]);
    // Evicted right after it drew: its last frame was held through the switch.
    expect(normal.host.querySelectorAll('canvas').length).toBe(1);
  });

  it("an explicit 'own' instance takes an auto one's context; auto never takes an explicit one's", async () => {
    LumiCells.configure({ maxContexts: 1 });
    const hero = create(...HERO);
    frames(3);
    const card = create(...CARD, { renderer: 'own' });
    frames(4);
    await tick();
    expect(card.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    expect(hero.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    // The hero waits on the shared renderer for a slot; the card is never evicted by it.
    wait(AUTO_DWELL_MS * 2);
    frames(4);
    expect(card.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    expect(hero.renderer).toBe('shared');
  });

  it('lowering maxContexts moves auto instances to the shared renderer, not to the poster', () => {
    LumiCells.configure({ createPerFrame: 4 });
    const heroes = [create(...HERO), create(...HERO)];
    frames(3);
    expect(heroes.map((h) => h.renderer)).toEqual(['own', 'own']);
    LumiCells.configure({ maxContexts: 1 });
    frames(3);
    expect(heroes.map((h) => h.getStats().state)).toEqual(['live', 'live']);
    expect(heroes.map((h) => h.renderer).sort()).toEqual(['own', 'shared']);
    expect(contextsInUse()).toBe(2);
  });

  it('setRenderer: explicit switches emit explicit; back to auto waits the dwell', async () => {
    const card = create(...CARD);
    frames(4);
    const seen = events(card);
    card.setRenderer('own');
    expect(card.getStats()).toMatchObject({ renderer: 'own', rendererMode: 'own' });
    frames(3);
    card.setRenderer('auto');
    expect(card.getStats()).toMatchObject({ renderer: 'own', rendererMode: 'auto' });
    wait(AUTO_DWELL_MS - 50);
    expect(card.renderer).toBe('own');
    wait(50);
    frames(2);
    expect(card.renderer).toBe('shared');
    // Same renderer, other mode: no switch.
    card.setRenderer('shared');
    expect(card.getStats()).toMatchObject({ renderer: 'shared', rendererMode: 'shared' });
    await tick();
    expect(seen.map((e) => e.reason)).toEqual(['explicit', 'demote']);
  });

  it('explicit modes never switch on resize', () => {
    const own = create(...CARD, { renderer: 'own' });
    const shared = create(...HERO, { renderer: 'shared' });
    frames(4);
    resize(own, ...CARD);
    resize(shared, ...HERO);
    wait(AUTO_DWELL_MS * 3);
    frames(3);
    expect(own.renderer).toBe('own');
    expect(shared.renderer).toBe('shared');
  });

  it('LumiCells.configure({ promoteArea }) re-evaluates existing auto instances', () => {
    const card = create(...CARD); // 20000 device px
    frames(4);
    LumiCells.configure({ promoteArea: 0.01 });
    wait(AUTO_DWELL_MS);
    frames(2);
    expect(card.renderer).toBe('own');
  });

  it('a viewport resize re-evaluates: the same host becomes a quarter of a smaller viewport', () => {
    const panel = create(...BETWEEN); // 160000 CSS px^2: 0.81 of a quarter of 1024x768
    frames(4);
    expect(panel.renderer).toBe('shared');
    const w = window.innerWidth;
    const h = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
      window.dispatchEvent(new Event('resize'));
      wait(AUTO_DWELL_MS);
      frames(2);
      expect(panel.renderer).toBe('own');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
      window.dispatchEvent(new Event('resize'));
    }
  });

  it('a large instance picks again when it comes back from parking, reported once it draws', async () => {
    LumiCells.configure({ parkAfterMs: 500 });
    const hero = create(...HERO);
    const other = create(...CARD);
    frames(4);
    const seen = events(hero);
    place(hero, false, false);
    vi.advanceTimersByTime(500);
    expect(hero.getStats().state).toBe('parked');
    // Away it shrank: back near the viewport it asks the shared renderer right away (no dwell),
    // and the switch is reported once the shared renderer seats it.
    hostSize.set(hero.host, { w: CARD[0], h: CARD[1] });
    place(hero, true);
    await tick();
    expect(hero.renderer).toBe('shared');
    expect(seen).toEqual([]);
    frames(4);
    await tick();
    expect(hero.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    expect(other.renderer).toBe('shared');
    expect(seen).toEqual([{ renderer: 'shared', previous: 'own', reason: 'demote' }]);
  });

  it('a parked shared instance back larger gets its engine on a new canvas, at full resolution', async () => {
    // A tiny shared budget: the shared renderer draws the panel below full resolution.
    LumiCells.configure({ parkAfterMs: 500, sharedBudget: 0.01 });
    const shareScale = vi.spyOn(Controller.prototype, 'setShareScale');
    const panel = create(...BETWEEN);
    frames(4);
    expect(panel.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    const target = panel.canvas as HTMLCanvasElement;
    expect(with2d.has(target)).toBe(true);
    expect(shareScale.mock.calls.some(([s]) => s < 1)).toBe(true);
    const seen = events(panel);
    const errors: unknown[] = [];
    panel.on('error', (e) => errors.push(e));
    panel.on('fallback', (e) => errors.push(e));
    place(panel, false, false);
    vi.advanceTimersByTime(600);
    frames(2);
    // Parked: its emptied 2D canvas stays in the host.
    expect(panel.getStats().state).toBe('parked');
    expect(panel.canvas).toBe(target);
    // Away it grew: back near the viewport it asks for a context of its own.
    hostSize.set(panel.host, { w: HERO[0], h: HERO[1] });
    place(panel, true);
    frames(4);
    await tick();
    expect(errors).toEqual([]);
    expect(panel.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    const engine = FakeEngine.instances.at(-1);
    expect(engine?.canvas).toBe(panel.canvas);
    // A new canvas that never had a 2D context (the old one could never get a WebGL one).
    expect(engine?.canvas).not.toBe(target);
    expect(with2d.has(engine?.canvas as HTMLCanvasElement)).toBe(false);
    expect(target.isConnected).toBe(false);
    expect(canvases(panel)).toBe(1);
    // The shared budget's factor is gone: the own canvas draws at full resolution.
    expect(shareScale.mock.calls.at(-1)?.[0]).toBe(1);
    expect(seen).toEqual([{ renderer: 'own', previous: 'shared', reason: 'promote' }]);
  });

  it('back from parking larger with the budget full: no event for a promotion never served', async () => {
    LumiCells.configure({ parkAfterMs: 500, maxContexts: 1 });
    const hero = create(...HERO, { renderer: 'own' });
    const panel = create(...BETWEEN);
    frames(4);
    expect(hero.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    expect(panel.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    const seen = events(panel);
    place(panel, false, false);
    vi.advanceTimersByTime(600);
    frames(2);
    expect(panel.getStats().state).toBe('parked');
    hostSize.set(panel.host, { w: HERO[0], h: HERO[1] });
    place(panel, true);
    frames(4);
    await tick();
    // It asked for a context of its own, was refused, and draws shared as before: nothing to tell.
    expect(panel.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    expect(seen).toEqual([]);
    // It stays a candidate without churn while the explicit hero holds the only slot.
    wait(AUTO_DWELL_MS * 3);
    frames(4);
    await tick();
    expect(seen).toEqual([]);
    expect(hero.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    // A slot frees up: the promotion is served and reported.
    hero.destroy();
    frames(4);
    await tick();
    expect(panel.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    expect(seen).toEqual([{ renderer: 'own', previous: 'shared', reason: 'promote' }]);
  });

  it('large instances past the creation cap that could never get a slot go shared at once', async () => {
    LumiCells.configure({ maxContexts: 2, createPerFrame: 1 });
    const heroes = [create(...HERO), create(...HERO), create(...HERO), create(...HERO)];
    const seen = heroes.map(events);
    frame();
    // One engine created this frame; the next request still has a free slot ahead; the other
    // two could never get one and are sent to the shared renderer now, not after the queue.
    expect(heroes.map((h) => h.renderer)).toEqual(['own', 'own', 'shared', 'shared']);
    expect(heroes[1]?.getStats().state).toBe('pending');
    // The shared device, refused the creation allowance in that frame, gets the next one before
    // the second own engine: one context serves every shared instance.
    frames(2);
    expect(heroes.map((h) => h.getStats().state)).toEqual(['live', 'pending', 'live', 'live']);
    frames(5);
    await tick();
    expect(heroes.map((h) => h.getStats().state)).toEqual(['live', 'live', 'live', 'live']);
    expect(heroes.map((h) => h.renderer)).toEqual(['own', 'own', 'shared', 'shared']);
    expect(seen[2]).toEqual([{ renderer: 'shared', previous: 'own', reason: 'budget' }]);
    expect(FakeEngine.instances).toHaveLength(2);
  });

  it('a shrunk request for its own context that is not served yet goes shared at once', () => {
    LumiCells.configure({ createPerFrame: 1 });
    const a = create(...HERO);
    const b = create(...HERO);
    frame(); // a is served, b still queued
    expect(b.getStats().state).toBe('pending');
    resize(b, ...CARD);
    frames(4);
    expect(b.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    expect(a.renderer).toBe('own');
  });

  it('an always-on instance reads no layout while mounting: it asks once the observers report', async () => {
    FakeIO.deferFirst = true;
    const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const config = { render: { pauseOffscreen: false } };
    const hero = create(...HERO, { config });
    const cards = Array.from({ length: 4 }, () => create(...CARD, { config }));
    expect(rects).not.toHaveBeenCalled();
    // Nothing asked yet: no context, no event, still the poster.
    frames(3);
    expect(FakeEngine.instances).toHaveLength(0);
    expect(FakeDevice.instances).toHaveLength(0);
    expect(hero.getStats().state).toBe('pending');
    const heroEvents = events(hero);
    // The first reports pick the renderer by size and ask, with no dwell to wait out.
    for (const pl of [hero, ...cards]) place(pl, true);
    frames(6);
    await tick();
    expect(hero.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
    for (const c of cards)
      expect(c.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    expect(heroEvents).toEqual([]);
    expect(contextsInUse()).toBe(2);
  });

  it('without IntersectionObserver the first choice reads the host size once', async () => {
    const io = Object.getOwnPropertyDescriptor(window, 'IntersectionObserver');
    Object.defineProperty(window, 'IntersectionObserver', { value: undefined, configurable: true });
    try {
      const rects = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          const s = hostSize.get(this) ?? { w: 0, h: 0 };
          return { width: s.w, height: s.h } as DOMRect;
        });
      const hero = create(...HERO);
      const card = create(...CARD);
      expect(rects).toHaveBeenCalledTimes(2);
      frames(6);
      await tick();
      expect(hero.getStats()).toMatchObject({ renderer: 'own', state: 'live' });
      expect(card.getStats()).toMatchObject({ renderer: 'shared', state: 'live' });
    } finally {
      if (io) Object.defineProperty(window, 'IntersectionObserver', io);
    }
  });
});
