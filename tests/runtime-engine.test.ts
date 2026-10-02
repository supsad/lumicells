// @vitest-environment jsdom
/**
 * The facade with a fake Engine and a manual rAF: lifecycle paths that need a "working" GPU
 * (engine failures, canvas rebuilds, frame pacing, element tracking through the ticker).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerfController } from '../src/core/controller/perf';
import { HostView } from '../src/core/dom/host';
import { OFF_INF } from '../src/core/engine/frame-block';
import type { FrameInputs } from '../src/core/engine/types';
import { LumiCells } from '../src/core/lumi-cells';
import { resetRuntimeForTesting } from '../src/core/runtime/scheduler';
import type { LumiCellsEvents } from '../src/core/types';

const fake = vi.hoisted(() => {
  interface Opts {
    onError?: (e: Error) => void;
  }
  class FakeEngine {
    static instances: FakeEngine[] = [];
    static failInCtor = false;
    static maxDrawableSize = 16384;
    /** 'new N' / 'lose N' in call order (N = index in `instances`). */
    static log: string[] = [];
    /** Engines whose context is alive (created, not released). */
    static alive(): number {
      return FakeEngine.instances.filter((e) => !e.lost).length;
    }
    readonly caps = { maxDrawableSize: FakeEngine.maxDrawableSize, renderer: 'fake' };
    readonly softwareFallback = false;
    readonly gpuTimeMs: number | null = null;
    error: Error | null = null;
    disposed = false;
    lost = false;
    failOnRender = false;
    renders = 0;
    lastFrame: FrameInputs | null = null;
    first: { lifeReset: boolean; paramsDirty: boolean } | null = null;
    constructor(
      readonly canvas: HTMLCanvasElement,
      readonly opts: Opts,
    ) {
      FakeEngine.instances.push(this);
      FakeEngine.log.push(`new ${FakeEngine.instances.length - 1}`);
      if (FakeEngine.failInCtor) this.fail('resource');
    }
    fail(code: string): void {
      this.error = new Error(`fake ${code} failure`);
      this.opts.onError?.(this.error);
    }
    /** Programs still linking: render() draws nothing yet. */
    static compiling = false;
    /** Field variants (Engine.prepare): nothing to compile here. */
    prepare(): boolean {
      return true;
    }
    render(f: FrameInputs): boolean {
      if (this.disposed || this.error || FakeEngine.compiling) return false;
      if (this.failOnRender) {
        this.fail('compile');
        return false;
      }
      // FrameInputs is reused and its one-shot flags are consumed after the draw: keep a copy.
      if (this.renders === 0) {
        this.first = { lifeReset: f.lifeReset, paramsDirty: f.paramsDirty };
        FakeEngine.log.push(`draw ${FakeEngine.instances.indexOf(this)}`);
      }
      this.renders++;
      this.lastFrame = f;
      return true;
    }
    dispose(): void {
      this.disposed = true;
    }
    loseContextForTesting(): void {
      if (!this.lost) FakeEngine.log.push(`lose ${FakeEngine.instances.indexOf(this)}`);
      this.lost = true;
    }
    isContextLost(): boolean {
      return this.lost;
    }
    restoreContextForTesting(): void {}
  }
  return { FakeEngine };
});

vi.mock('../src/core/engine/engine', () => ({ Engine: fake.FakeEngine }));
const { FakeEngine } = fake;

// Manual rAF driving the shared ticker.
let rafQueue: FrameRequestCallback[] = [];
let now = 1000;
function frame(ms = 16.67): void {
  now += ms;
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(now);
}
function frames(n: number, ms = 16.67): void {
  for (let i = 0; i < n; i++) frame(ms);
}

/**
 * Fake IntersectionObserver recording its options. Like a real one it reports every target once
 * after observe() (here synchronously, as intersecting, unless `autoEnter` is off); tests move
 * hosts in and out with `report()`.
 */
class FakeIO {
  static all: FakeIO[] = [];
  static autoEnter = true;
  observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly opts: IntersectionObserverInit = {},
  ) {
    FakeIO.all.push(this);
  }
  /** The creation-zone observer (one viewport margin) vs the view observer (px margin). */
  get zone(): boolean {
    return this.opts.rootMargin === '100%';
  }
  observe(el: Element): void {
    this.observed.push(el);
    if (FakeIO.autoEnter) this.report(true);
  }
  report(isIntersecting: boolean, w = 400, h = 300): void {
    const target = this.observed[0] as Element;
    const boundingClientRect = { width: w, height: h } as DOMRectReadOnly;
    this.cb(
      [{ isIntersecting, target, boundingClientRect } as IntersectionObserverEntry],
      this as never,
    );
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

let canvasSize = { w: 400, h: 300 };

beforeAll(() => {
  // WebGL2 "available" for LumiCells.isSupported(); the fake engine never touches it.
  HTMLCanvasElement.prototype.getContext = (() => ({
    getExtension: () => null,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
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
    get: () => canvasSize.w,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => canvasSize.h,
  });
});

const live: LumiCells[] = [];
const hosts: HTMLElement[] = [];
function create(opts: ConstructorParameters<typeof LumiCells>[1] = {}): LumiCells {
  const el = document.createElement('div');
  document.body.appendChild(el);
  hosts.push(el);
  const pl = new LumiCells(el, opts);
  live.push(pl);
  return pl;
}

beforeEach(() => {
  FakeEngine.instances = [];
  FakeEngine.log = [];
  FakeEngine.compiling = false;
  FakeEngine.failInCtor = false;
  FakeEngine.maxDrawableSize = 16384;
  FakeIO.all = [];
  FakeIO.autoEnter = true;
  canvasSize = { w: 400, h: 300 };
  resetRuntimeForTesting();
  // These tests cover the own path: the page default is 'auto' (see runtime-auto.test.ts).
  LumiCells.configure({ renderer: 'own' });
});

afterEach(() => {
  for (const pl of live.splice(0)) pl.destroy();
  for (const h of hosts.splice(0)) h.remove();
  rafQueue = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe('engine failures release the context at once', () => {
  it('synchronous failure inside the Engine constructor', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    FakeEngine.failInCtor = true;
    const pl = create({ autoStart: false });
    const errors: Error[] = [];
    const fallbacks: LumiCellsEvents['fallback'][] = [];
    pl.on('error', (e) => errors.push(e));
    pl.on('fallback', (e) => fallbacks.push(e));
    pl.start();
    // The engine is created by the scheduler at the end of the next frame, not in start().
    expect(FakeEngine.instances.length).toBe(0);
    frame();
    const eng = FakeEngine.instances[0];
    expect(eng?.disposed).toBe(true);
    expect(eng?.lost).toBe(true);
    expect(pl.canvas).toBeNull();
    expect(pl.host.querySelector('canvas')).toBeNull();
    await tick();
    expect(errors.length).toBe(1);
    expect(fallbacks).toEqual([{ reason: 'compile' }]);
    // Nothing renders or re-creates it later.
    frames(3);
    pl.set('render.overflow', 40);
    frames(3);
    expect(FakeEngine.instances.length).toBe(1);
    err.mockRestore();
  });

  it('failure detected while rendering (compile/link)', async () => {
    const pl = create();
    const fallbacks: LumiCellsEvents['fallback'][] = [];
    pl.on('fallback', (e) => fallbacks.push(e));
    frames(2); // created at the end of the first frame, drawn in the second
    const eng = FakeEngine.instances[0];
    expect(eng?.renders).toBe(1);
    if (eng) eng.failOnRender = true;
    frame();
    expect(eng?.disposed).toBe(true);
    expect(eng?.lost).toBe(true);
    expect(pl.canvas).toBeNull();
    frames(3);
    expect(eng?.renders).toBe(1);
    expect(rafQueue.length).toBe(0); // unsubscribed from the ticker
    await tick();
    expect(fallbacks).toEqual([{ reason: 'compile' }]);
  });
});

describe('canvas rebuilds', () => {
  it('drops the context listeners of a discarded canvas (overflow 0 <-> > 0)', () => {
    const pl = create();
    frame();
    const old = pl.canvas as HTMLCanvasElement;
    expect(old).toBeTruthy();
    const probe = () => {
      const e = new Event('webglcontextlost', { cancelable: true });
      old.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // The live canvas is listened to (the loss handler calls preventDefault)...
    expect(probe()).toBe(true);
    frame();
    pl.set('render.overflow', 40);
    expect(pl.canvas).not.toBe(old);
    expect(FakeEngine.instances[0]?.disposed).toBe(true);
    // ...the discarded one is not any more (its listeners were aborted).
    expect(probe()).toBe(false);
    pl.destroy();
  });
});

describe('mounting', () => {
  it('reads the canvas size in the measure phase, not while mounting', () => {
    LumiCells.configure({ createPerFrame: 3 });
    const read = vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get');
    create();
    create();
    create();
    expect(read).not.toHaveBeenCalled();
    frame(); // canvases mounted at the end of this frame
    expect(read).not.toHaveBeenCalled();
    frame();
    expect(read).toHaveBeenCalledTimes(3);
    read.mockRestore();
  });

  it('clamps the drawing buffer to the engine caps (max drawable size)', () => {
    FakeEngine.maxDrawableSize = 256;
    canvasSize = { w: 2000, h: 1000 };
    const pl = create();
    frames(2);
    const f = FakeEngine.instances[0]?.lastFrame;
    expect(f?.canvasWidth).toBe(256);
    expect(f?.canvasHeight).toBe(128);
    pl.destroy();
  });
});

describe('offscreen pause', () => {
  it('the IntersectionObserver margin covers the overflow and follows it', () => {
    const pl = create();
    const views = () => FakeIO.all.filter((io) => !io.zone);
    const io0 = views().at(-1);
    expect(io0?.opts.rootMargin).toBe('64px');
    expect(io0?.observed).toEqual([pl.host]);
    pl.set('render.overflow', 200);
    const io1 = views().at(-1);
    expect(io1).not.toBe(io0);
    expect(io0?.disconnected).toBe(true);
    expect(io1?.opts.rootMargin).toBe('264px');
    // Stale callbacks of the old observer are ignored...
    io0?.cb([{ isIntersecting: false } as IntersectionObserverEntry], io0 as never);
    frame();
    expect(rafQueue.length).toBe(1);
    // ...the current one pauses the instance.
    io1?.cb([{ isIntersecting: false } as IntersectionObserverEntry], io1 as never);
    expect(rafQueue.length).toBe(0);
  });
});

describe('config events', () => {
  it('one event per source batch, in order, at the frame flush', () => {
    const pl = create();
    frame();
    const events: LumiCellsEvents['config'][] = [];
    pl.on('config', (e) => events.push(e));
    pl.set('grid.gap', 0.3, { source: 'api' });
    pl.set('background.color', '#ff0000', { source: 'attribute' });
    pl.set('grid.count', 40, { source: 'attribute' });
    expect(events.length).toBe(0);
    frame();
    expect(events.map((e) => [e.source, e.changed])).toEqual([
      ['api', ['grid.gap']],
      ['attribute', ['background.color', 'grid.count']],
    ]);
  });
});

describe('frame pacing and refresh changes', () => {
  it('maxFps follows the observed cadence after the display gets slower', () => {
    const pl = create({ config: { render: { maxFps: 60 } } });
    frames(240, 6.94); // 144 Hz: every 2nd rAF renders
    const eng = FakeEngine.instances[0];
    const r0 = eng?.renders ?? 0;
    frames(60, 6.94);
    expect((eng?.renders ?? 0) - r0).toBeGreaterThanOrEqual(29);
    expect((eng?.renders ?? 0) - r0).toBeLessThanOrEqual(31);
    // Moved to a 60 Hz display (same DPR): 60 fps means every rAF now, not every 2nd.
    frames(180, 16.67);
    const r1 = eng?.renders ?? 0;
    frames(60, 16.67);
    expect((eng?.renders ?? 0) - r1).toBeGreaterThanOrEqual(58);
    pl.destroy();
  });

  it('re-learns the refresh rate when the page becomes visible again', () => {
    const reset = vi.spyOn(PerfController.prototype, 'resetVsync');
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    create();
    state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reset).not.toHaveBeenCalled();
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reset).toHaveBeenCalledTimes(1);
    reset.mockRestore();
    Reflect.deleteProperty(document, 'visibilityState');
  });
});

describe('bindElement', () => {
  function boxedChild(pl: LumiCells): HTMLElement {
    const el = document.createElement('div');
    pl.host.appendChild(el);
    // jsdom does not compute border-radius: a 12px corner for this element.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((t, p) =>
      t === el ? ({ borderTopLeftRadius: '12px' } as CSSStyleDeclaration) : real(t, p),
    );
    const rect = { left: 100, top: 50, width: 100, height: 50, right: 200, bottom: 100 };
    el.getBoundingClientRect = () => ({ ...rect, x: 100, y: 50, toJSON() {} }) as DOMRect;
    el.getClientRects = () => [el.getBoundingClientRect()] as unknown as DOMRectList;
    return el;
  }
  const corner = () => FakeEngine.instances[0]?.lastFrame?.frame[OFF_INF + 4];

  it('handle.update({ cornerRadius }) sticks; null follows the border-radius again', () => {
    const pl = create();
    const el = boxedChild(pl);
    const h = pl.bindElement(el, { track: 'frame' });
    frames(2);
    expect(corner()).toBeCloseTo(12, 3);
    h.update({ cornerRadius: 0 });
    frames(2);
    expect(corner()).toBe(0);
    h.update({ cornerRadius: 4 });
    frames(2);
    expect(corner()).toBeCloseTo(4, 3);
    h.update({ cornerRadius: null });
    frames(2);
    expect(corner()).toBeCloseTo(12, 3);
  });

  it('an influence that expires by ttlMs releases its element binding', () => {
    const pl = create();
    const el = boxedChild(pl);
    const read = vi.spyOn(el, 'getBoundingClientRect');
    pl.bindElement(el, { track: 'frame', ttlMs: 100, fadeOutMs: 0 });
    frames(3);
    expect(read).toHaveBeenCalled();
    frames(20);
    read.mockClear();
    frames(5);
    expect(read).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------------------
// Context budget: lazy creation, creation queue, waiting, parking, eviction

const zoneIo = (pl: LumiCells) =>
  FakeIO.all.filter((io) => io.zone && io.observed.includes(pl.host)).at(-1) as FakeIO;
const viewIo = (pl: LumiCells) =>
  FakeIO.all.filter((io) => !io.zone && io.observed.includes(pl.host)).at(-1) as FakeIO;

/** Moves a host: on screen, near it (inside the creation zone) or away (outside it). */
function place(pl: LumiCells, where: 'visible' | 'near' | 'away', w = 400, h = 300): void {
  viewIo(pl).report(where === 'visible', w, h);
  zoneIo(pl).report(where !== 'away', w, h);
}

const lostEvents = () => FakeEngine.log.filter((l) => l.startsWith('lose'));

describe('lazy creation and the creation queue', () => {
  it('creates no canvas or context before the host comes near the viewport', () => {
    FakeIO.autoEnter = false;
    const pl = create();
    frames(3);
    expect(FakeEngine.instances.length).toBe(0);
    expect(pl.canvas).toBeNull();
    expect(pl.host.querySelector('canvas')).toBeNull();
    expect(pl.getStats().state).toBe('pending');
    place(pl, 'near');
    // Queued: served at the end of the next frame, never inside the observer callback.
    expect(FakeEngine.instances.length).toBe(0);
    expect(pl.getStats().state).toBe('pending');
    frame();
    expect(FakeEngine.instances.length).toBe(1);
    expect(pl.canvas).not.toBeNull();
    expect(pl.getStats().state).toBe('live');
  });

  it('creates at most createPerFrame engines per frame, visible instances first', () => {
    FakeIO.autoEnter = false;
    LumiCells.configure({ maxContexts: 8 });
    const list = [create(), create(), create(), create(), create()];
    for (const pl of list.slice(0, 4)) place(pl, 'near');
    const shown = list[4] as LumiCells;
    place(shown, 'visible');
    frame();
    expect(FakeEngine.instances.length).toBe(1);
    expect(FakeEngine.instances[0]?.canvas).toBe(shown.canvas);
    frame(); // its first draw: nothing is created in this frame
    expect(FakeEngine.instances.length).toBe(1);
    frame(); // the others are paused offscreen (no first draw yet)
    expect(FakeEngine.instances.length).toBe(2);
    LumiCells.configure({ createPerFrame: 2 });
    frame();
    expect(FakeEngine.instances.length).toBe(4);
    frame();
    expect(FakeEngine.instances.length).toBe(5);
    expect(list.every((pl) => pl.getStats().state === 'live')).toBe(true);
  });

  it('mounting many instances creates nothing synchronously', () => {
    LumiCells.configure({ maxContexts: 100 });
    const list = Array.from({ length: 50 }, () => create());
    expect(FakeEngine.instances.length).toBe(0);
    expect(document.querySelectorAll('canvas').length).toBe(0);
    frame();
    expect(FakeEngine.instances.length).toBe(1);
    // Every engine draws its first frame in the frame after its creation, and such a frame
    // creates nothing: one creation every other frame while they are all on screen.
    frames(9);
    expect(FakeEngine.instances.length).toBe(5);
    expect(list.filter((pl) => pl.getStats().state === 'live').length).toBe(5);
  });

  it("a creation never shares a frame with an engine's first draw", () => {
    LumiCells.configure({ maxContexts: 100 });
    FakeEngine.compiling = true;
    for (let i = 0; i < 6; i++) create();
    frames(3); // three engines created, all still compiling
    expect(FakeEngine.instances.length).toBe(3);
    FakeEngine.compiling = false;
    const perFrame: string[][] = [];
    for (let i = 0; i < 6; i++) {
      FakeEngine.log.length = 0;
      frame();
      perFrame.push([...FakeEngine.log]);
    }
    for (const log of perFrame) {
      const created = log.some((l) => l.startsWith('new'));
      const drew = log.some((l) => l.startsWith('draw'));
      expect(created && drew).toBe(false);
    }
    // The three linked at once draw together; creation resumes in the next frame.
    expect(perFrame[0]).toEqual(['draw 0', 'draw 1', 'draw 2']);
    expect(perFrame[1]).toEqual(['new 3']);
    expect(FakeEngine.instances.length).toBe(6);
  });

  it('stop() withdraws a queued request; start() queues it again', () => {
    const pl = create();
    pl.stop();
    frame();
    expect(FakeEngine.instances.length).toBe(0);
    expect(rafQueue.length).toBe(0);
    pl.start();
    frame();
    expect(FakeEngine.instances.length).toBe(1);
  });

  it('past the budget visible instances wait on the poster: one warning, no context lost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = Array.from({ length: 12 }, () => create());
    const fallbacks: string[] = [];
    const warns: string[] = [];
    for (const pl of list) {
      pl.on('fallback', (e) => fallbacks.push(e.reason));
      pl.on('warn', (e) => warns.push(e.code));
    }
    frames(12);
    await tick();
    // Default budget (desktop): 4 contexts.
    expect(FakeEngine.instances.length).toBe(4);
    expect(FakeEngine.alive()).toBe(4);
    const states = list.map((pl) => pl.getStats().state);
    expect(states.filter((st) => st === 'live').length).toBe(4);
    expect(states.filter((st) => st === 'waiting').length).toBe(8);
    expect(fallbacks).toEqual(Array(8).fill('budget'));
    expect(warns).toEqual(['context-budget']);
    expect(warn).toHaveBeenCalledTimes(1);
    // Equal ranks never take a context from each other; waiting ones have no canvas at all.
    expect(lostEvents()).toEqual([]);
    expect((list[11] as LumiCells).canvas).toBeNull();
    // A destroyed instance hands its slot to the first waiting one.
    (list[0] as LumiCells).destroy();
    frame();
    expect(FakeEngine.alive()).toBe(4);
    expect((list[4] as LumiCells).getStats().state).toBe('live');
  });
});

describe('parking', () => {
  it('out of the zone for parkAfterMs: GPU released, state kept, rebuilt like a restore', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    LumiCells.configure({ maxContexts: 1 });
    const poster = vi.spyOn(HostView.prototype, 'showPoster');
    const a = create();
    const states: string[] = [a.getStats().state];
    frames(2);
    states.push(a.getStats().state);
    const e0 = FakeEngine.instances[0];
    expect(e0?.renders).toBeGreaterThan(0);
    a.set('grid.count', 40);
    place(a, 'away');
    vi.advanceTimersByTime(9999);
    expect(a.getStats().state).toBe('live');
    poster.mockClear();
    vi.advanceTimersByTime(1);
    states.push(a.getStats().state);
    expect(e0?.disposed).toBe(true);
    expect(e0?.lost).toBe(true);
    expect(a.canvas).toBeNull();
    expect(a.host.querySelector('canvas')).toBeNull();
    expect(poster).toHaveBeenCalled();
    // The slot is free: another instance gets it right away.
    const b = create();
    frame();
    expect(b.getStats().state).toBe('live');
    frame(); // b draws its first frame
    // Back in view while b holds the only slot (equal rank): it waits.
    place(a, 'visible');
    states.push(a.getStats().state);
    frame();
    states.push(a.getStats().state);
    b.destroy();
    frame();
    states.push(a.getStats().state);
    frame(); // first draw of the rebuilt engine
    const e1 = FakeEngine.instances.at(-1);
    expect(e1).not.toBe(e0);
    expect(e1?.canvas).toBe(a.canvas);
    // Same path as a context restore: every GPU input is re-sent and Life reseeds.
    expect(e1?.first).toEqual({ lifeReset: true, paramsDirty: true });
    expect(a.get('grid.count')).toBe(40);
    expect(states).toEqual(['pending', 'live', 'parked', 'pending', 'waiting', 'live']);
  });

  it('coming back before the timeout keeps the engine; parkAfterMs is configurable', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = create();
    frame();
    place(a, 'away');
    vi.advanceTimersByTime(5000);
    place(a, 'near');
    vi.advanceTimersByTime(60_000);
    expect(a.getStats().state).toBe('live');
    expect(FakeEngine.instances.length).toBe(1);
    LumiCells.configure({ parkAfterMs: 200 });
    place(a, 'away');
    vi.advanceTimersByTime(200);
    expect(a.getStats().state).toBe('parked');
  });

  it('instances that never pause offscreen are never parked', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = create({ config: { render: { pauseOffscreen: false } } });
    frames(2);
    place(a, 'away');
    vi.advanceTimersByTime(60_000);
    expect(a.getStats().state).toBe('live');
    // ...and they are created without being near the viewport.
    FakeIO.autoEnter = false;
    const b = create({ config: { render: { pauseOffscreen: false } } });
    frame();
    expect(b.getStats().state).toBe('live');
  });
});

describe('eviction', () => {
  it('takes the slot of an offscreen instance first, releasing it before the new context', () => {
    LumiCells.configure({ maxContexts: 2, createPerFrame: 2 });
    const vis = create();
    const off = create();
    frames(2);
    expect(FakeEngine.alive()).toBe(2);
    place(off, 'near'); // scrolled off screen, still inside the zone
    FakeEngine.log.length = 0;
    const next = create();
    frame();
    expect(FakeEngine.log).toEqual(['lose 1', 'new 2']);
    expect(FakeEngine.alive()).toBe(2);
    expect(vis.getStats().state).toBe('live');
    expect(next.getStats().state).toBe('live');
    // The victim parks like an instance out of the zone; still near, it waits for a slot.
    expect(off.canvas).toBeNull();
    frames(2);
    expect(off.getStats().state).toBe('waiting');
  });

  it('an evicted visible instance waits with the budget fallback and returns when a slot frees', async () => {
    LumiCells.configure({ maxContexts: 1 });
    const a = create();
    frames(2);
    const fallbacks: string[] = [];
    a.on('fallback', (e) => fallbacks.push(e.reason));
    const hero = create({ priority: 'high' });
    frame();
    expect(FakeEngine.instances[0]?.lost).toBe(true);
    expect(a.canvas).toBeNull();
    expect(hero.getStats().state).toBe('live');
    frames(2);
    await tick();
    expect(a.getStats().state).toBe('waiting');
    expect(fallbacks).toEqual(['budget']);
    // The hero dropping to a low priority hands the context back.
    hero.setPriority('low');
    frame();
    expect(a.getStats().state).toBe('live');
    expect(hero.getStats().state).not.toBe('live');
    expect(FakeEngine.alive()).toBe(1);
  });

  it('lowering maxContexts evicts the lowest ranked instances at once', () => {
    LumiCells.configure({ maxContexts: 2, createPerFrame: 2 });
    const a = create();
    const b = create();
    frame();
    place(b, 'away');
    LumiCells.configure({ maxContexts: 1 });
    expect(b.canvas).toBeNull();
    expect(b.getStats().state).toBe('parked');
    expect(a.getStats().state).toBe('live');
    expect(FakeEngine.alive()).toBe(1);
  });
});

describe('context loss', () => {
  it('the canvas is hidden until drawn, and hidden again while its context is lost', () => {
    LumiCells.configure({ maxContexts: 1 });
    FakeEngine.compiling = true;
    const pl = create();
    frame();
    const canvas = pl.canvas as HTMLCanvasElement;
    expect(canvas.style.visibility).toBe('hidden');
    FakeEngine.compiling = false;
    frame();
    expect(canvas.style.visibility).toBe('');
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(canvas.style.visibility).toBe('hidden');
    expect(pl.getStats().state).toBe('lost');
    // A lost context keeps its slot: the browser is expected to restore it.
    const other = create();
    frame();
    expect(other.getStats().state).toBe('waiting');
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(pl.getStats().state).toBe('live');
    expect(FakeEngine.instances.length).toBe(2);
    expect(canvas.style.visibility).toBe('hidden');
    frame();
    expect(canvas.style.visibility).toBe('');
  });

  it('hides the canvas in the first frame after a loss, before the loss event arrives', () => {
    const pl = create();
    frames(2);
    const canvas = pl.canvas as HTMLCanvasElement;
    expect(canvas.style.visibility).toBe('');
    const ev: string[] = [];
    pl.on('contextlost', () => ev.push('contextlost'));
    pl.on('fallback', (e) => ev.push(`fallback:${e.reason}`));
    // The browser lost the context (eviction, GPU reset); its event is still queued.
    (FakeEngine.instances[0] as InstanceType<typeof FakeEngine>).lost = true;
    frame();
    expect(canvas.style.visibility).toBe('hidden');
    expect(pl.getStats().state).toBe('lost');
    expect(ev).toEqual(['contextlost', 'fallback:context-lost']);
    // The event, when it comes, only keeps the context restorable: nothing is reported twice.
    const lost = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(ev).toEqual(['contextlost', 'fallback:context-lost']);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    frame();
    expect(pl.getStats().state).toBe('live');
    expect(canvas.style.visibility).toBe('');
  });
});

describe('context budget edge cases', () => {
  /** Records the events that drive the React/element fallback node. */
  function track(pl: LumiCells): string[] {
    const ev: string[] = [];
    pl.on('contextlost', () => ev.push('contextlost'));
    pl.on('contextrestored', () => ev.push('contextrestored'));
    pl.on('fallback', (e) => ev.push(`fallback:${e.reason}`));
    return ev;
  }
  const lose = (pl: LumiCells) =>
    (pl.canvas as HTMLCanvasElement).dispatchEvent(
      new Event('webglcontextlost', { cancelable: true }),
    );

  it('a lost context that is parked ends with contextrestored once rebuilt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    LumiCells.configure({ parkAfterMs: 100 });
    const a = create();
    frames(3);
    const ev = track(a);
    lose(a);
    place(a, 'away');
    vi.advanceTimersByTime(100);
    expect(a.getStats().state).toBe('parked');
    await tick();
    expect(ev).toEqual(['contextlost', 'fallback:context-lost']);
    place(a, 'visible');
    frames(3);
    await tick();
    expect(a.getStats().state).toBe('live');
    expect(ev).toEqual(['contextlost', 'fallback:context-lost', 'contextrestored']);
  });

  it('a lost context that is evicted ends with contextrestored once it gets a slot again', async () => {
    LumiCells.configure({ maxContexts: 1 });
    const a = create();
    frames(2);
    const ev = track(a);
    lose(a);
    const hero = create({ priority: 'high' });
    frames(3);
    expect(hero.getStats().state).toBe('live');
    expect(a.getStats().state).toBe('waiting');
    hero.destroy();
    frames(2);
    await tick();
    expect(a.getStats().state).toBe('live');
    expect(ev.filter((e) => e === 'contextrestored')).toEqual(['contextrestored']);
  });

  it('a lost context whose canvas is rebuilt (overflow) ends with contextrestored', async () => {
    const a = create();
    frames(2);
    const ev = track(a);
    lose(a);
    a.set('render.overflow', 40);
    await tick();
    expect(a.getStats().state).toBe('live');
    expect(ev).toEqual(['contextlost', 'fallback:context-lost', 'contextrestored']);
  });

  it('a waiter scrolled into view is not reported when the next pass serves it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    LumiCells.configure({ maxContexts: 1 });
    const a = create();
    frames(2);
    FakeIO.autoEnter = false;
    const b = create();
    const ev = track(b);
    place(b, 'near');
    frames(2);
    await tick();
    expect(b.getStats().state).toBe('waiting');
    // Scroll: a leaves the screen (still near), b enters it.
    place(a, 'near');
    place(b, 'visible');
    await tick();
    frame();
    await tick();
    expect(b.getStats().state).toBe('live');
    expect(ev).toEqual([]);
    // Only the library's own warnings count (jsdom's CSS parser may warn about the poster).
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[lumicells]'))).toEqual([]);
  });

  it('a waiter scrolled into view and still refused is reported after the pass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    LumiCells.configure({ maxContexts: 1 });
    const a = create({ priority: 'high' });
    frames(2);
    FakeIO.autoEnter = false;
    const b = create();
    const ev = track(b);
    place(b, 'near');
    frames(2);
    place(b, 'visible');
    await tick();
    expect(ev).toEqual([]); // nothing before the scheduler decided again
    frame();
    await tick();
    expect(b.getStats().state).toBe('waiting');
    expect(ev).toEqual(['fallback:budget']);
    expect(a.getStats().state).toBe('live');
  });

  it('every new visible wait reports the budget fallback again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    LumiCells.configure({ maxContexts: 1 });
    const a = create();
    frames(2);
    const b = create();
    const ev = track(b);
    frames(2);
    await tick();
    expect(ev).toEqual(['fallback:budget']);
    place(b, 'away'); // the request is withdrawn: this wait is over
    frames(2);
    place(b, 'visible');
    frames(3);
    await tick();
    expect(b.getStats().state).toBe('waiting');
    expect(ev).toEqual(['fallback:budget', 'fallback:budget']);
    expect(a.getStats().state).toBe('live');
  });

  it('configure({ parkAfterMs }) reaches instances that are already away', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    LumiCells.configure({ parkAfterMs: Number.POSITIVE_INFINITY });
    const a = create();
    const b = create();
    frames(4);
    place(a, 'away');
    vi.advanceTimersByTime(60_000);
    expect(a.getStats().state).toBe('live');
    // Infinity -> finite: the away instance parks after the new delay.
    LumiCells.configure({ parkAfterMs: 100 });
    vi.advanceTimersByTime(100);
    expect(a.getStats().state).toBe('parked');
    // A shorter delay also shortens a timer that is already running.
    LumiCells.configure({ parkAfterMs: 10_000 });
    place(b, 'away');
    vi.advanceTimersByTime(50);
    LumiCells.configure({ parkAfterMs: 200 });
    vi.advanceTimersByTime(200);
    expect(b.getStats().state).toBe('parked');
  });

  it('a waiter never evicts a live instance of the same size after a resize', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    LumiCells.configure({ maxContexts: 1 });
    const size = new Map<HTMLElement, { w: number; h: number }>();
    const sized = (pl: LumiCells, w: number, h: number) => {
      size.set(pl.host, { w, h });
      pl.host.getBoundingClientRect = () => {
        const s = size.get(pl.host) ?? { w: 0, h: 0 };
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: s.w,
          bottom: s.h,
          width: s.w,
          height: s.h,
          toJSON() {},
        } as DOMRect;
      };
    };
    const a = create();
    sized(a, 400, 300);
    frames(3);
    const b = create();
    sized(b, 400, 300);
    frames(3);
    expect([a.getStats().state, b.getStats().state]).toEqual(['live', 'waiting']);
    // The page shrinks: no observer reports it (both stay on screen).
    size.set(a.host, { w: 200, h: 150 });
    size.set(b.host, { w: 200, h: 150 });
    canvasSize = { w: 200, h: 150 };
    window.dispatchEvent(new Event('resize'));
    frames(12);
    // An unrelated instance moves: the scheduler ranks again, on fresh sizes.
    FakeIO.autoEnter = false;
    const c = create();
    place(c, 'away');
    frames(2);
    expect([a.getStats().state, b.getStats().state]).toEqual(['live', 'waiting']);
    expect(lostEvents()).toEqual([]);
    // A clearly larger waiter still takes the slot (sizes are read, not cached).
    size.set(b.host, { w: 400, h: 300 });
    b.setPriority('high');
    b.setPriority('normal');
    frames(3);
    expect([a.getStats().state, b.getStats().state]).toEqual(['waiting', 'live']);
  });
});

describe('context budget: lifecycle edges', () => {
  const states = (...list: LumiCells[]) => list.map((pl) => pl.getStats().state);

  /** Stubs a host's layout size (jsdom has no layout); returns a setter. */
  function sized(pl: LumiCells, w: number, h: number): (w: number, h: number) => void {
    let size = { w, h };
    pl.host.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: size.w,
        bottom: size.h,
        width: size.w,
        height: size.h,
        toJSON() {},
      }) as DOMRect;
    return (nw, nh) => {
      size = { w: nw, h: nh };
    };
  }

  it('getStats().state is destroyed after destroy(), whatever it was before', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    LumiCells.configure({ maxContexts: 1 });
    const a = create();
    frames(2);
    const b = create();
    frames(2);
    FakeIO.autoEnter = false;
    const c = create();
    expect(states(a, b, c)).toEqual(['live', 'waiting', 'pending']);
    for (const pl of [a, b, c]) pl.destroy();
    expect(states(a, b, c)).toEqual(['destroyed', 'destroyed', 'destroyed']);
    a.stop();
    a.start();
    frames(2);
    expect(states(a)).toEqual(['destroyed']);
  });

  it('an instance that never pauses offscreen ranks as visible: not the first victim', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    LumiCells.configure({ maxContexts: 2 });
    FakeIO.autoEnter = false;
    // A capture/copy source placed off screen on purpose (e.g. left: -2000px).
    const source = create({ config: { render: { pauseOffscreen: false } } });
    place(source, 'away');
    frames(2);
    expect(states(source)).toEqual(['live']);
    FakeIO.autoEnter = true;
    const cards = [create(), create(), create()];
    frames(8);
    // The visible cards of the same priority do not take its context.
    expect(states(source, ...cards)).toEqual(['live', 'live', 'waiting', 'waiting']);
    expect(source.canvas).not.toBeNull();
    expect(lostEvents()).toEqual([]);
    // A visible card with a higher priority does; the source then waits like a visible one
    // (reported) and gets a context back as soon as one frees up.
    const fallbacks: string[] = [];
    source.on('fallback', (e) => fallbacks.push(e.reason));
    const hero = create({ priority: 'high' });
    frames(3);
    await tick();
    expect(states(hero, source)).toEqual(['live', 'waiting']);
    expect(fallbacks).toEqual(['budget']);
    hero.destroy();
    frames(3);
    expect(states(source)).toEqual(['live']);
    // Switching pauseOffscreen back on makes it an ordinary offscreen instance again.
    source.set('render.pauseOffscreen', true);
    (cards[2] as LumiCells).setPriority('high');
    frames(3);
    expect(states(source)).not.toContain('live');
  });

  it('parkAfterMs beyond the longest timer delay never parks (no setTimeout overflow)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    LumiCells.configure({ parkAfterMs: 30 * 24 * 3600 * 1000 });
    const a = create();
    frames(2);
    place(a, 'away');
    vi.advanceTimersByTime(60_000);
    expect(states(a)).toEqual(['live']);
    LumiCells.configure({ parkAfterMs: Number.MAX_SAFE_INTEGER });
    vi.advanceTimersByTime(60_000);
    expect(states(a)).toEqual(['live']);
  });

  describe('a resized host is ranked again', () => {
    class FakeRO {
      static all: FakeRO[] = [];
      readonly targets = new Set<Element>();
      constructor(readonly cb: ResizeObserverCallback) {
        FakeRO.all.push(this);
      }
      observe(el: Element): void {
        this.targets.add(el);
      }
      unobserve(el: Element): void {
        this.targets.delete(el);
      }
      disconnect(): void {
        this.targets.clear();
      }
    }
    /** Reports a host size to the observers watching it (as a real one does after layout). */
    function resize(pl: LumiCells, set: (w: number, h: number) => void, w: number, h: number) {
      set(w, h);
      const entry = {
        target: pl.host,
        contentRect: { width: w, height: h },
        borderBoxSize: [{ inlineSize: w, blockSize: h }],
      } as unknown as ResizeObserverEntry;
      for (const ro of FakeRO.all) if (ro.targets.has(pl.host)) ro.cb([entry], ro as never);
    }
    const watched = (pl: LumiCells) => FakeRO.all.some((ro) => ro.targets.has(pl.host));

    beforeEach(() => {
      FakeRO.all = [];
      Object.defineProperty(window, 'ResizeObserver', { value: FakeRO, configurable: true });
    });
    afterEach(() => {
      Reflect.deleteProperty(window, 'ResizeObserver');
    });

    it('a waiting card that grows takes the slot; a holder that shrinks gives it back', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      LumiCells.configure({ maxContexts: 1 });
      const a = create();
      const setA = sized(a, 200, 120);
      frames(3);
      const b = create();
      const setB = sized(b, 200, 120);
      frames(3);
      expect(states(a, b)).toEqual(['live', 'waiting']);
      // The observers' first reports (the sizes the last pass ranked on).
      resize(a, setA, 200, 120);
      resize(b, setB, 200, 120);
      frames(3);
      expect(states(a, b)).toEqual(['live', 'waiting']);
      // b grows about 19 times while both stay on screen: no intersection callback fires.
      resize(b, setB, 900, 500);
      frames(3);
      expect(states(a, b)).toEqual(['waiting', 'live']);
      expect(lostEvents()).toEqual(['lose 0']);
      // A resize within the same size bucket changes nothing.
      resize(b, setB, 910, 505);
      frames(3);
      expect(states(a, b)).toEqual(['waiting', 'live']);
      // The holder shrinks below the waiter: it hands the slot back.
      resize(b, setB, 100, 60);
      frames(3);
      expect(states(a, b)).toEqual(['live', 'waiting']);
    });

    it('only instances that hold or want a slot are watched', () => {
      FakeIO.autoEnter = false;
      const a = create();
      frames(2);
      expect(watched(a)).toBe(false); // far away: no request, nothing to rank
      place(a, 'near');
      expect(watched(a)).toBe(true);
      frame();
      expect(states(a)).toEqual(['live']);
      expect(watched(a)).toBe(true);
      a.destroy();
      expect(watched(a)).toBe(false);
    });
  });

  it('both observers extend their margin into scroll containers (scrollMargin)', () => {
    const pl = create();
    expect(zoneIo(pl).opts).toEqual({ rootMargin: '100%', scrollMargin: '100%' });
    expect(viewIo(pl).opts).toEqual({ rootMargin: '64px', scrollMargin: '64px' });
    pl.set('render.overflow', 20);
    expect(viewIo(pl).opts).toEqual({ rootMargin: '84px', scrollMargin: '84px' });
  });

  it('an engine that rejects the scrollMargin value still gets the viewport margin', () => {
    class StrictIO extends FakeIO {
      constructor(cb: IntersectionObserverCallback, opts: IntersectionObserverInit = {}) {
        if (opts.scrollMargin !== undefined) throw new SyntaxError('scrollMargin: px only');
        super(cb, opts);
      }
    }
    Object.defineProperty(window, 'IntersectionObserver', { value: StrictIO, configurable: true });
    try {
      const pl = create();
      expect(zoneIo(pl).opts).toEqual({ rootMargin: '100%' });
      expect(viewIo(pl).opts).toEqual({ rootMargin: '64px' });
      frame();
      expect(states(pl)).toEqual(['live']);
    } finally {
      Object.defineProperty(window, 'IntersectionObserver', { value: FakeIO, configurable: true });
    }
  });
});
