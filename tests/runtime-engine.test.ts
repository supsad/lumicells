// @vitest-environment jsdom
/**
 * The facade with a fake Engine and a manual rAF: lifecycle paths that need a "working" GPU
 * (engine failures, canvas rebuilds, frame pacing, element tracking through the ticker).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerfController } from '../src/core/controller/perf';
import { OFF_INF } from '../src/core/engine/frame-block';
import type { FrameInputs } from '../src/core/engine/types';
import { PixelLife } from '../src/core/pixel-life';
import type { PixelLifeEvents } from '../src/core/types';

const fake = vi.hoisted(() => {
  interface Opts {
    onError?: (e: Error) => void;
  }
  class FakeEngine {
    static instances: FakeEngine[] = [];
    static failInCtor = false;
    static maxDrawableSize = 16384;
    readonly caps = { maxDrawableSize: FakeEngine.maxDrawableSize, renderer: 'fake' };
    readonly softwareFallback = false;
    readonly gpuTimeMs: number | null = null;
    error: Error | null = null;
    disposed = false;
    lost = false;
    failOnRender = false;
    renders = 0;
    lastFrame: FrameInputs | null = null;
    constructor(
      readonly canvas: HTMLCanvasElement,
      readonly opts: Opts,
    ) {
      FakeEngine.instances.push(this);
      if (FakeEngine.failInCtor) this.fail('resource');
    }
    fail(code: string): void {
      this.error = new Error(`fake ${code} failure`);
      this.opts.onError?.(this.error);
    }
    render(f: FrameInputs): boolean {
      if (this.disposed || this.error) return false;
      if (this.failOnRender) {
        this.fail('compile');
        return false;
      }
      this.renders++;
      this.lastFrame = f;
      return true;
    }
    dispose(): void {
      this.disposed = true;
    }
    loseContextForTesting(): void {
      this.lost = true;
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

/** Fake IntersectionObserver recording its options. */
class FakeIO {
  static all: FakeIO[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly opts: IntersectionObserverInit = {},
  ) {
    FakeIO.all.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

let canvasSize = { w: 400, h: 300 };

beforeAll(() => {
  // WebGL2 "available" for PixelLife.isSupported(); the fake engine never touches it.
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

const live: PixelLife[] = [];
const hosts: HTMLElement[] = [];
function create(opts: ConstructorParameters<typeof PixelLife>[1] = {}): PixelLife {
  const el = document.createElement('div');
  document.body.appendChild(el);
  hosts.push(el);
  const pl = new PixelLife(el, opts);
  live.push(pl);
  return pl;
}

beforeEach(() => {
  FakeEngine.instances = [];
  FakeEngine.failInCtor = false;
  FakeEngine.maxDrawableSize = 16384;
  FakeIO.all = [];
  canvasSize = { w: 400, h: 300 };
});

afterEach(() => {
  for (const pl of live.splice(0)) pl.destroy();
  for (const h of hosts.splice(0)) h.remove();
  rafQueue = [];
  vi.restoreAllMocks();
});

const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe('engine failures release the context at once', () => {
  it('synchronous failure inside the Engine constructor', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    FakeEngine.failInCtor = true;
    const pl = create({ autoStart: false });
    const errors: Error[] = [];
    const fallbacks: PixelLifeEvents['fallback'][] = [];
    pl.on('error', (e) => errors.push(e));
    pl.on('fallback', (e) => fallbacks.push(e));
    pl.start();
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
    const fallbacks: PixelLifeEvents['fallback'][] = [];
    pl.on('fallback', (e) => fallbacks.push(e));
    frame();
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
    const read = vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get');
    create();
    create();
    create();
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
    const io0 = FakeIO.all.at(-1);
    expect(io0?.opts.rootMargin).toBe('64px');
    expect(io0?.observed).toEqual([pl.host]);
    pl.set('render.overflow', 200);
    const io1 = FakeIO.all.at(-1);
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
    const events: PixelLifeEvents['config'][] = [];
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
  function boxedChild(pl: PixelLife): HTMLElement {
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
