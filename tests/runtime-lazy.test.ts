// @vitest-environment jsdom
/**
 * The GPU side as a chunk of its own (runtime/loader.ts, shell.ts, runtime/live.ts): what an
 * instance does before it has loaded (synchronous API, events, stats, queued calls), what happens
 * when it arrives (the calls are applied in call order), when the instance is destroyed first and
 * when the load fails. The import is controlled by the test (setLiveImporterForTesting); the
 * engine is a fake and frames are driven by hand.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { InfluenceRegistry } from '../src/core/controller/influences';
import { HostView } from '../src/core/dom/host';
import { DEBUG_VIEW, type FrameInputs } from '../src/core/engine/types';
import { LumiCells } from '../src/core/lumi-cells';
import {
  type LiveModule,
  liveLoadState,
  setLiveImporterForTesting,
} from '../src/core/runtime/loader';
import { resetRuntimeForTesting } from '../src/core/runtime/scheduler';
import type { LumiCellsEvents } from '../src/core/types';

const fake = vi.hoisted(() => {
  class FakeEngine {
    static instances: FakeEngine[] = [];
    readonly caps = { maxDrawableSize: 16384, renderer: 'fake' };
    readonly softwareFallback = false;
    readonly gpuTimeMs: number | null = null;
    error: Error | null = null;
    lastFrame: FrameInputs | null = null;
    constructor(readonly canvas: HTMLCanvasElement) {
      FakeEngine.instances.push(this);
    }
    prepare(): boolean {
      return true;
    }
    fieldReady(): boolean {
      return true;
    }
    render(f: FrameInputs): boolean {
      this.lastFrame = f;
      return true;
    }
    dispose(): void {}
    loseContextForTesting(): void {}
    isContextLost(): boolean {
      return false;
    }
  }
  return { FakeEngine };
});

vi.mock('../src/core/engine/engine', () => ({ Engine: fake.FakeEngine }));
const { FakeEngine } = fake;

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

/** Reports every observed host as intersecting at once (like a host in view). */
class FakeIO {
  constructor(readonly cb: IntersectionObserverCallback) {}
  observe(target: Element): void {
    const boundingClientRect = { width: 400, height: 300 } as DOMRectReadOnly;
    this.cb(
      [{ isIntersecting: true, target, boundingClientRect } as IntersectionObserverEntry],
      this as never,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
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
    get: () => 400,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 300,
  });
});

/** The real GPU side's module, with its instances counted. */
let real: LiveModule;
let built: number;
let counted: LiveModule;
beforeAll(async () => {
  real = await import('../src/core/runtime/live');
  class Counting extends real.LiveInstance {
    constructor(...args: ConstructorParameters<typeof real.LiveInstance>) {
      super(...args);
      built++;
    }
  }
  counted = { ...real, LiveInstance: Counting };
});

interface Deferred {
  promise: Promise<LiveModule>;
  resolve(m: LiveModule): void;
  reject(err: unknown): void;
}
function deferred(): Deferred {
  let resolve!: (m: LiveModule) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<LiveModule>((a, b) => {
    resolve = a;
    reject = b;
  });
  // A rejection nobody waits for (every instance destroyed) is not a test failure.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Lets the import's promise reactions run (the loader's, then each instance's). */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

let load: Deferred;
let importer: Mock<() => Promise<LiveModule>>;
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
  built = 0;
  load = deferred();
  importer = vi.fn(() => load.promise);
  setLiveImporterForTesting(importer);
  resetRuntimeForTesting();
  LumiCells.configure({ renderer: 'own' });
});

afterEach(() => {
  for (const pl of live.splice(0)) pl.destroy();
  for (const h of hosts.splice(0)) h.remove();
  rafQueue = [];
  setLiveImporterForTesting(null);
  vi.restoreAllMocks();
});

describe('before the GPU side has loaded', () => {
  // First in this file: the support probe is not memoized yet.
  it('the first instance starts the import before the support probe (it waits for the GPU)', () => {
    const order: string[] = [];
    importer.mockImplementation(() => {
      order.push('import');
      return load.promise;
    });
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      order.push('probe');
      return getContext.apply(this, args as never);
    } as typeof getContext;
    try {
      create();
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
    expect(order).toEqual(['import', 'probe']);
  });

  it('the first instance starts the import, once; configure() and isSupported() do not', () => {
    expect(liveLoadState()).toBe('idle');
    LumiCells.configure({ parkAfterMs: 5000 });
    expect(LumiCells.isSupported()).toBe(true);
    expect(importer).not.toHaveBeenCalled();
    create();
    create({ autoStart: false });
    create();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(liveLoadState()).toBe('loading');
  });

  it('the API is synchronous: config, events, stats, getters', async () => {
    const pl = create({ preset: 'orb', renderer: 'auto', priority: 'high', look: 'shared' });
    const events: LumiCellsEvents['config'][] = [];
    pl.on('config', (e) => events.push(e));
    pl.set('grid.count', 40);
    pl.setConfig({ glow: { bloom: { strength: 1.2 } } }, { source: 'stand' });
    expect(pl.get('grid.count')).toBe(40);
    expect(pl.getConfig().glow.bloom.strength).toBe(1.2);
    expect(pl.exportConfig({ mode: 'diff', base: 'orb' })).toHaveProperty('grid');
    await Promise.resolve();
    expect(events.map((e) => [e.source, e.changed])).toEqual([
      ['api', ['grid.count']],
      ['stand', ['glow.bloom.strength']],
    ]);
    const s = pl.getStats();
    expect(s.state).toBe('pending');
    expect(s.fps).toBe(0);
    expect(s.renderer).toBe('shared');
    expect(s.rendererMode).toBe('auto');
    expect(s.look).toBe('own');
    expect(s.groupSize).toBe(1);
    expect(pl.canvas).toBeNull();
    expect(pl.priority).toBe('high');
    expect(pl.look).toBe('shared');
    // Nothing runs before the GPU side is there.
    frames(3);
    expect(FakeEngine.instances).toHaveLength(0);
    expect(rafQueue).toHaveLength(0);
  });

  it('calls made before are applied in call order when it arrives, then draw', async () => {
    const proto = Controller.prototype;
    const pl = create();
    pl.setConfig({ grid: { count: 20 } });
    const radius = pl.modulate('modes.sphere.radius', 0.2, { blend: 'override' });
    const inf = pl.addInfluence({ x: 10, y: 10, radius: 3 });
    const el = document.createElement('div');
    pl.host.appendChild(el);
    const bound = pl.bindElement(el, { track: 'manual', type: 'shadow' });
    bound.update({ x: 50, y: 60, w: 20, h: 10 });
    pl.pulse({ x: 0.5, y: 0.5, space: 'norm' });
    pl.setConfig({ grid: { count: 24 } });
    pl.lift({ x: 3, y: 3, space: 'cells', count: 2 });
    pl.setDebugView('bloom');
    pl.setEnergy(1.5);
    expect(inf.id).toBe(1);
    expect(bound.id).toBe(2);
    expect(inf.active).toBe(false);
    expect(built).toBe(0);

    const calls = {
      applyCommit: vi.spyOn(proto, 'applyCommit'),
      modulate: vi.spyOn(proto, 'modulate'),
      createInfluence: vi.spyOn(proto, 'createInfluence'),
      pulse: vi.spyOn(proto, 'pulse'),
      lift: vi.spyOn(proto, 'lift'),
      setDebugView: vi.spyOn(proto, 'setDebugView'),
    };
    load.resolve(counted);
    await settle();
    expect(built).toBe(1);
    // Every call reached the controller, in the order it was made.
    const seq = (m: { mock: { invocationCallOrder: number[] } }, i = 0) =>
      m.mock.invocationCallOrder[i] as number;
    expect(calls.applyCommit.mock.calls.map((c) => c[0].next.grid.count)).toEqual([20, 24]);
    expect(seq(calls.applyCommit)).toBeLessThan(seq(calls.modulate));
    expect(seq(calls.pulse)).toBeLessThan(seq(calls.applyCommit, 1));
    expect(seq(calls.applyCommit, 1)).toBeLessThan(seq(calls.lift));
    expect(calls.modulate.mock.calls.map((c) => c[0])).toEqual([
      'modes.sphere.radius',
      'animation.energy',
    ]);
    expect(calls.createInfluence.mock.calls.map((c) => c[1])).toEqual([1, 2]);
    expect(seq(calls.modulate)).toBeLessThan(seq(calls.createInfluence));
    expect(seq(calls.createInfluence, 1)).toBeLessThan(seq(calls.pulse));
    expect(seq(calls.pulse)).toBeLessThan(seq(calls.lift));
    expect(seq(calls.lift)).toBeLessThan(seq(calls.setDebugView));
    expect(seq(calls.setDebugView)).toBeLessThan(seq(calls.modulate, 1));
    // Ids continue above the ones handed out before.
    expect(pl.addInfluence({ x: 1, y: 1 }).id).toBe(3);

    // It draws them: the context comes at the end of the next frame, then frames are drawn.
    frames(4);
    const engine = FakeEngine.instances[0];
    expect(engine).toBeDefined();
    expect(engine?.lastFrame?.debugView).toBe(DEBUG_VIEW.bloom);
    expect(pl.getEffective('modes.sphere.radius')).toBeCloseTo(0.2, 5);
    expect(pl.getEffective('animation.energy')).toBeCloseTo(1.5, 5);
    // The handles made before forward to the real ones.
    radius.set(0.3);
    pl.setEnergy(0.5);
    frames(2);
    expect(pl.getEffective('modes.sphere.radius')).toBeCloseTo(0.3, 5);
    expect(pl.getEffective('animation.energy')).toBeCloseTo(0.5, 5);
    inf.dispose();
    bound.dispose();
    radius.dispose();
    frames(2);
    expect(pl.getEffective('modes.sphere.radius')).toBeCloseTo(pl.get('modes.sphere.radius'), 5);
  });

  it('getEffective() before agrees with the GPU side when it arrives (no frame drawn yet)', async () => {
    const pl = create();
    const speed = pl.get('animation.speed');
    pl.setConfig({ animation: { speed: speed + 1 } }, { transition: 500 });
    pl.setConfig({ grid: { gap: 0.3 } }, { transition: 0 });
    // A tween moves only on frames; an instant change applies at once.
    expect(pl.getEffective('animation.speed')).toBe(speed);
    expect(pl.getEffective('grid.gap')).toBeCloseTo(0.3, 5);
    load.resolve(counted);
    await settle();
    expect(built).toBe(1);
    expect(pl.getEffective('animation.speed')).toBe(speed);
    expect(pl.getEffective('grid.gap')).toBeCloseTo(0.3, 5);
  });

  it('handles disposed or aborted before it arrives are never created, their ids not reused', async () => {
    const create1 = vi.spyOn(Controller.prototype, 'createInfluence');
    const modulate = vi.spyOn(Controller.prototype, 'modulate');
    const pl = create();
    pl.addInfluence({ x: 1, y: 1 }).dispose();
    const ac = new AbortController();
    const aborted = pl.addInfluence({ x: 1, y: 1, signal: ac.signal });
    ac.abort();
    pl.modulate('animation.speed', 2, { signal: AbortSignal.abort() });
    const kept = pl.addInfluence({ x: 2, y: 2 });
    expect(aborted.id).toBe(2);
    load.resolve(counted);
    await settle();
    expect(create1.mock.calls.map((c) => c[1])).toEqual([3]);
    expect(kept.id).toBe(3);
    expect(modulate).not.toHaveBeenCalled();
    expect(pl.addInfluence({ x: 3, y: 3 }).id).toBe(4);
  });

  it('updates made before are folded into one patch per handle, as applied in turn', async () => {
    const update = vi.spyOn(InfluenceRegistry.prototype, 'update');
    const pl = create();
    const h = pl.addInfluence({ x: 1, y: 1, colorMix: 0.4 });
    // A pointer-following influence during a slow load: one pending patch, not one per call.
    for (let i = 0; i < 500; i++) h.update({ x: i, y: i + 1 });
    h.update({ strength: 2, x: undefined });
    // A zero mix, then a color without one: the color makes the mix visible again (0.5).
    h.update({ colorMix: 0 });
    h.update({ color: '#ff0000' });
    const el = document.createElement('div');
    pl.host.appendChild(el);
    const bound = pl.bindElement(el, { track: 'manual' });
    bound.update({ x: 5, y: 6, w: 7, h: 8 });
    bound.update({ cornerRadius: 4 });
    bound.update({ cornerRadius: null, w: 9 });
    load.resolve(counted);
    await settle();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0]?.[1]).toEqual({
      x: 499,
      y: 500,
      strength: 2,
      colorMix: 0.5,
      color: '#ff0000',
    });
    // The bound handle strips cornerRadius before the registry (null: follow the element again).
    expect(update.mock.calls[1]?.[1]).toEqual({ x: 5, y: 6, w: 9, h: 8 });
    const entry = update.mock.calls[0]?.[0];
    expect(entry?.colorMix).toBe(0.5);
    expect(entry?.x).toBe(499);
  });

  it('setRenderer() before it arrives switches now and reports it; the GPU side follows', async () => {
    const pl = create({ renderer: 'auto' });
    const seen: LumiCellsEvents['renderer'][] = [];
    pl.on('renderer', (e) => seen.push(e));
    expect(pl.renderer).toBe('shared');
    pl.setRenderer('own');
    expect(pl.renderer).toBe('own');
    expect(pl.rendererMode).toBe('own');
    expect(pl.getStats().renderer).toBe('own');
    await Promise.resolve();
    expect(seen).toEqual([{ renderer: 'own', previous: 'shared', reason: 'explicit' }]);
    load.resolve(counted);
    await settle();
    frames(2);
    expect(FakeEngine.instances).toHaveLength(1);
    expect(pl.getStats().state).toBe('live');
    expect(seen).toHaveLength(1);
  });

  it('the random seed is drawn at construction: a seeded Math.random still gives twins', async () => {
    const seeded = () => {
      const orig = Math.random;
      Math.random = () => 0.25;
      try {
        return create();
      } finally {
        Math.random = orig;
      }
    };
    seeded();
    seeded();
    load.resolve(counted);
    await settle();
    frames(6);
    const [a, b] = FakeEngine.instances;
    expect(a?.lastFrame?.lifeSeed).toBeDefined();
    expect(a?.lastFrame?.lifeSeed).toBe(b?.lastFrame?.lifeSeed);
  });

  it('instances created after it arrived get it at construction', async () => {
    create();
    load.resolve(counted);
    await settle();
    expect(built).toBe(1);
    const later = create();
    expect(built).toBe(2);
    expect(importer).toHaveBeenCalledTimes(1);
    // One context per frame (createPerFrame): the first instance's, then this one's.
    frames(3);
    expect(later.getStats().state).toBe('live');
  });
});

describe('destroy() before the GPU side has loaded', () => {
  it('never builds it, runs nothing and reports nothing afterwards', async () => {
    const pl = create();
    const other = create();
    const events: string[] = [];
    for (const type of ['ready', 'error', 'fallback', 'config', 'renderer'] as const) {
      pl.on(type, () => events.push(type));
    }
    pl.setConfig({ grid: { count: 30 } });
    const h = pl.addInfluence({ x: 1, y: 1 });
    pl.pulse({ x: 1, y: 1 });
    pl.destroy();
    expect(pl.getStats().state).toBe('destroyed');
    load.resolve(counted);
    await settle();
    // Only the other instance got a GPU side.
    expect(built).toBe(1);
    frames(4);
    expect(FakeEngine.instances.map((e) => e.canvas.parentElement)).toEqual([other.host]);
    expect(pl.host.querySelector('canvas')).toBeNull();
    h.update({ x: 2 });
    h.dispose();
    expect(events).toEqual([]);
  });
});

describe('the GPU side fails to load', () => {
  it("reports 'error' and the 'load' fallback, keeps the poster, and stays usable", async () => {
    const hide = vi.spyOn(HostView.prototype, 'hidePoster');
    const pl = create();
    const errors: Error[] = [];
    const fallbacks: LumiCellsEvents['fallback'][] = [];
    pl.on('error', (e) => errors.push(e));
    pl.on('fallback', (e) => fallbacks.push(e));
    const h = pl.addInfluence({ x: 1, y: 1 });
    const m = pl.modulate('animation.speed', 2);
    load.reject(new TypeError('Failed to fetch dynamically imported module'));
    await settle();
    expect(errors.map((e) => e.message)).toEqual(['Failed to fetch dynamically imported module']);
    expect(fallbacks).toEqual([{ reason: 'load' }]);
    expect(pl.getStats().state).toBe('failed');
    expect(built).toBe(0);
    frames(3);
    expect(pl.canvas).toBeNull();
    expect(hide).not.toHaveBeenCalled();
    // Handles stay inert, the config API keeps working.
    h.update({ x: 3 });
    m.set(1);
    h.dispose();
    pl.set('grid.count', 33);
    expect(pl.get('grid.count')).toBe(33);
    expect(pl.getEffective('grid.count')).toBe(33);
  });

  it('lasts for the page: later instances fall back too, without importing again', async () => {
    // Browsers keep a failed dynamic import in their module map: import() again rejects at once
    // without a request, so a retry could only promise what it cannot do.
    const failed = create();
    load.reject(new Error('offline'));
    await settle();
    expect(liveLoadState()).toBe('failed');
    const next = create();
    const paused = create({ autoStart: false });
    const errors: string[] = [];
    const fallbacks: LumiCellsEvents['fallback'][] = [];
    for (const pl of [next, paused]) {
      pl.on('error', (e) => errors.push(e.message));
      pl.on('fallback', (e) => fallbacks.push(e));
    }
    LumiCells.preload();
    paused.start();
    await settle();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['offline', 'offline']);
    expect(fallbacks).toEqual([{ reason: 'load' }, { reason: 'load' }]);
    expect(built).toBe(0);
    frames(3);
    for (const pl of [failed, next, paused]) expect(pl.getStats().state).toBe('failed');
  });

  it('handles made before stay inert once it has failed (their updates are dropped)', async () => {
    const update = vi.spyOn(InfluenceRegistry.prototype, 'update');
    const pl = create();
    const h = pl.addInfluence({ x: 1, y: 1 });
    h.update({ x: 2 });
    load.reject(new Error('offline'));
    await settle();
    for (let i = 0; i < 1000; i++) h.update({ x: i, strength: i });
    expect(pl.getStats().state).toBe('failed');
    expect(h.active).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('LumiCells.preload()', () => {
  it('starts the import once, before any instance; instances then share it', async () => {
    expect(liveLoadState()).toBe('idle');
    LumiCells.preload();
    LumiCells.preload();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(liveLoadState()).toBe('loading');
    const pl = create();
    expect(importer).toHaveBeenCalledTimes(1);
    load.resolve(counted);
    await settle();
    expect(built).toBe(1);
    LumiCells.preload();
    expect(importer).toHaveBeenCalledTimes(1);
    frames(3);
    expect(pl.getStats().state).toBe('live');
  });

  it('importing lumicells/element/define starts it (the page is about to render one)', async () => {
    expect(liveLoadState()).toBe('idle');
    await import('../src/element/define');
    expect(customElements.get('lumi-cells')).toBeDefined();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(liveLoadState()).toBe('loading');
  });
});
