// @vitest-environment jsdom
/**
 * The shared renderer without a GPU: a fake GpuDevice / RenderSlot (recording draws), fake 2D
 * contexts (recording copies), a fake readPixels and a manual rAF driving the shared ticker.
 * Covers the device lifecycle (lazy creation, release with the last member, the context budget
 * reservation), the frame structure (all draws before all copies), rate limits, the pixel
 * budget, context loss and the facade's shared path (2D canvas, 'ready' after the first copy,
 * parking, loss, renderer switches).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFF_CLOCK } from '../src/core/engine/frame-block';
import type { FrameInputs } from '../src/core/engine/types';
import { EngineError } from '../src/core/engine/types';
import { LumiCells } from '../src/core/lumi-cells';
import {
  CADENCE_MIN_SAMPLES,
  displayIntervalMs,
  HOLD_MAX_FRAMES,
  requestDisplayCalibration,
} from '../src/core/runtime/display';
import { loadLive } from '../src/core/runtime/loader';
import {
  claimContextCreation,
  contextsInUse,
  noteFirstDraw,
  resetRuntimeForTesting,
} from '../src/core/runtime/scheduler';
import {
  CHEAP_COPY_MS,
  CROWD,
  FIRST_DRAWS_PER_FRAME,
  GRANTS_PER_FRAME,
  getSharedRenderer,
  IDLE_SEATS_MIN,
  IDLE_SEATS_PER_REGION,
  PROBE_FRAMES,
  peekSharedRenderer,
  RESTORE_TIMEOUT_MS,
  resetSharedForTesting,
  type SharedClient,
  type SharedSeat,
} from '../src/core/runtime/shared-renderer';
import type { LumiCellsEvents } from '../src/core/types';

const fake = vi.hoisted(() => {
  /** Draws and copies in call order: 'draw <order>', 'copy <order>'. */
  const log: string[] = [];
  class FakeSlot {
    disposed = false;
    draws = 0;
    last: { x: number; y: number; w: number; h: number } | null = null;
    /** FrameInputs.lite of the last draw. */
    lite = false;
    /** The frame block of the last draw (the controller's, updated in place). */
    block: Float32Array | null = null;
    constructor(
      readonly device: FakeDevice,
      readonly tag: number,
    ) {}
    /** Field variants (RenderSlot.prepare): nothing to compile here. */
    prepare(): void {}
    draw(f: FrameInputs, surface: { left: number; top: number }): boolean {
      if (this.disposed || this.device.lost) return false;
      if (FakeDevice.failDraw) throw new Error('fake draw failure');
      this.draws++;
      this.lite = f.lite === true;
      this.block = f.frame;
      this.last = { x: surface.left, y: surface.top, w: f.canvasWidth, h: f.canvasHeight };
      log.push(`draw ${this.tag}`);
      return true;
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  class FakeDevice {
    static instances: FakeDevice[] = [];
    static linked = true;
    static failInCtor: Error | null = null;
    /** Thrown by the constructor (no WebGL2: getContext returned null). */
    static throwInCtor: Error | null = null;
    static failDraw = false;
    static maxDrawableSize = 4096;
    readonly caps = { maxDrawableSize: FakeDevice.maxDrawableSize, renderer: 'fake' };
    readonly softwareFallback = false;
    readonly timer = null;
    error: Error | null = null;
    lost = false;
    disposed = false;
    /** loseContext() after dispose(): the context was released on purpose. */
    released = false;
    slots: FakeSlot[] = [];
    constructor(
      readonly canvas: HTMLCanvasElement,
      readonly opts: { opaque: boolean; onError?: (e: Error) => void },
    ) {
      if (FakeDevice.throwInCtor) throw FakeDevice.throwInCtor;
      FakeDevice.instances.push(this);
      if (FakeDevice.failInCtor) this.error = FakeDevice.failInCtor;
    }
    /** readPixels calls: [x, y, w, h, PACK_ROW_LENGTH]. */
    reads: number[][] = [];
    /** Texel a readPixels returns at column x, row r of the rectangle (bottom-up); else zeros. */
    static texel: ((x: number, y: number) => readonly number[]) | null = null;
    /** Called by every readPixels (a test can make it cost virtual time, or lose the context). */
    static onRead: ((w: number, h: number, device: FakeDevice) => void) | null = null;
    #gl: Record<string, unknown> | null = null;
    get gl() {
      if (this.#gl) return this.#gl;
      const dev = this;
      let rowLength = 0;
      this.#gl = {
        FRAMEBUFFER: 0x8d40,
        PACK_ROW_LENGTH: 0x0d02,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        get drawingBufferWidth() {
          return dev.canvas.width;
        },
        get drawingBufferHeight() {
          return dev.canvas.height;
        },
        bindFramebuffer() {},
        pixelStorei(pname: number, v: number) {
          if (pname === 0x0d02) rowLength = v;
        },
        readPixels(
          x: number,
          y: number,
          w: number,
          h: number,
          _f: number,
          _t: number,
          px: Uint8ClampedArray,
        ) {
          dev.reads.push([x, y, w, h, rowLength]);
          const stride = rowLength || w;
          const texel = FakeDevice.texel;
          if (texel) {
            // GL rows bottom-up: the first row written is the lowest of the rectangle.
            for (let r = 0; r < h; r++) {
              for (let c = 0; c < w; c++) px.set(texel(x + c, r), (r * stride + c) * 4);
            }
          }
          FakeDevice.onRead?.(w, h, dev);
        },
        isContextLost: () => dev.lost,
      };
      return this.#gl;
    }
    poll(): boolean {
      return !this.disposed && !this.lost && !this.error && FakeDevice.linked;
    }
    isContextLost(): boolean {
      return this.lost;
    }
    createSlot(_o: unknown): FakeSlot {
      if (this.lost) throw new Error('lost');
      const s = new FakeSlot(this, this.slots.length);
      this.slots.push(s);
      return s;
    }
    dispose(): void {
      this.disposed = true;
    }
    /** Real browsers report the loss as an event (here synchronously). */
    loseContextForTesting(): void {
      if (this.lost) return;
      this.lost = true;
      if (this.disposed) this.released = true;
      this.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    }
    restoreContextForTesting(): void {
      this.canvas.dispatchEvent(new Event('webglcontextrestored'));
    }
  }
  return { FakeDevice, FakeSlot, log };
});

vi.mock('../src/core/engine/device', () => ({
  GpuDevice: fake.FakeDevice,
  toEngineError: (err: unknown) => err,
}));

// Own instances in the mixed tests: an engine that draws as soon as it exists.
vi.mock('../src/core/engine/engine', () => ({
  Engine: class {
    readonly caps = { maxDrawableSize: 4096, renderer: 'fake' };
    readonly softwareFallback = false;
    readonly gpuTimeMs = null;
    error = null;
    lost = false;
    constructor(readonly canvas: HTMLCanvasElement) {}
    /** Field variants (Engine.prepare): nothing to compile here. */
    prepare(): boolean {
      return true;
    }
    render(): boolean {
      return !this.lost;
    }
    dispose(): void {}
    loseContextForTesting(): void {
      this.lost = true;
    }
    isContextLost(): boolean {
      return this.lost;
    }
    restoreContextForTesting(): void {}
  },
}));

const { FakeDevice, log } = fake;

interface Fake2d {
  canvas: HTMLCanvasElement;
  alpha: boolean;
  globalCompositeOperation: string;
  imageSmoothingEnabled: boolean;
  copies: number;
  drawImage(src: HTMLCanvasElement, ...args: number[]): void;
  lastArgs: number[];
  /** putImageData calls, the last call's arguments and a copy of what it put (row-major). */
  puts: number;
  putArgs: number[];
  put: { width: number; data: Uint8ClampedArray } | null;
  putImageData(img: ImageData, ...args: number[]): void;
}
const contexts2d = new WeakMap<HTMLCanvasElement, Fake2d>();
function ctx2d(canvas: HTMLCanvasElement | null): Fake2d | undefined {
  return canvas ? contexts2d.get(canvas) : undefined;
}
let copyTag = new WeakMap<HTMLCanvasElement, number>();
/** Called by every fake drawImage (a test can make copies cost virtual time). */
let copyCost: ((src: HTMLCanvasElement, args: number[], dst: Fake2d) => void) | null = null;
/** Called when a fake 2D context is created (a test can make the set-up cost virtual time). */
let ctxCost: (() => void) | null = null;
/** Called by every fake putImageData (a test can make it cost virtual time). */
let putCost: ((args: number[]) => void) | null = null;
/** Every fake 2D context of the test, in creation order. */
let all2d: Fake2d[] = [];

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

/** Fake IntersectionObserver: reports every target as intersecting at observe(). */
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
    this.cb([{ isIntersecting, target } as IntersectionObserverEntry], this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** Moves an instance's host out of (or back into) the view and the creation zone. */
function place(pl: LumiCells, inView: boolean, inZone = inView): void {
  for (const io of FakeIO.all) {
    if (io.observed[0] !== pl.host) continue;
    io.report(io.zone ? inZone : inView);
  }
}

// The GPU side is a chunk the facade loads on demand: loaded first, every instance gets it at
// construction (as on a page where it has arrived; tests/runtime-lazy.test.ts covers the wait).
beforeAll(async () => {
  await loadLive();
});

beforeAll(() => {
  // jsdom has no canvas, and no ImageData (the read snapshot fills one).
  if (typeof ImageData === 'undefined') {
    vi.stubGlobal(
      'ImageData',
      class {
        readonly data: Uint8ClampedArray;
        constructor(
          readonly width: number,
          readonly height: number,
        ) {
          this.data = new Uint8ClampedArray(width * height * 4);
        }
      },
    );
  }
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    attrs?: { alpha?: boolean },
  ) {
    if (type === 'webgl2') return { getExtension: () => null };
    if (type !== '2d') return null;
    let c = contexts2d.get(this);
    if (!c) {
      ctxCost?.();
      const canvas = this;
      c = {
        canvas,
        alpha: attrs?.alpha ?? true,
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: true,
        copies: 0,
        lastArgs: [],
        drawImage(src: HTMLCanvasElement, ...args: number[]) {
          this.copies++;
          this.lastArgs = args;
          log.push(`copy ${copyTag.get(canvas) ?? '?'}`);
          copyCost?.(src, args, this);
        },
        puts: 0,
        putArgs: [],
        put: null,
        putImageData(img: ImageData, ...args: number[]) {
          this.puts++;
          this.putArgs = args;
          this.put = { width: img.width, data: img.data.slice() };
          putCost?.(args);
        },
      };
      contexts2d.set(this, c);
      all2d.push(c);
    }
    return c;
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
    get: () => 200,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 100,
  });
});

const live: LumiCells[] = [];
function create(opts: ConstructorParameters<typeof LumiCells>[1] = {}): LumiCells {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const pl = new LumiCells(el, { renderer: 'shared', ...opts });
  live.push(pl);
  return pl;
}

beforeEach(() => {
  FakeDevice.instances = [];
  FakeDevice.linked = true;
  FakeDevice.failInCtor = null;
  FakeDevice.throwInCtor = null;
  FakeDevice.failDraw = false;
  FakeIO.all = [];
  log.length = 0;
  copyTag = new WeakMap();
  copyCost = null;
  ctxCost = null;
  putCost = null;
  all2d = [];
  FakeDevice.texel = null;
  FakeDevice.onRead = null;
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

const tick = () => new Promise<void>((r) => queueMicrotask(r));

// -------------------------------------------------------------------------------------------
// The renderer with fake clients

interface TestClient extends SharedClient {
  seat: SharedSeat | null;
  events: string[];
  scale: number;
  frame: FrameInputs;
}

let clientSeq = 0;
function client(w = 200, h = 100, visible = true): TestClient {
  const order = ++clientSeq;
  const frameInputs = { canvasWidth: w, canvasHeight: h } as FrameInputs;
  const c: TestClient = {
    order,
    visible,
    inZone: true,
    priority: 'normal',
    area: w * h,
    lastVisible: 0,
    active: false,
    layout: { glslPrelude: 'prelude', vec4Count: 1 } as never,
    frame: frameInputs,
    get naturalWidth() {
      return w;
    },
    get naturalHeight() {
      return h;
    },
    get expectedWidth() {
      return w;
    },
    get expectedHeight() {
      return h;
    },
    seat: null,
    events: [],
    scale: 1,
    setShareScale(s) {
      c.scale = s;
      frameInputs.canvasWidth = Math.floor(w * s);
      frameInputs.canvasHeight = Math.floor(h * s);
    },
    attached(seat, restored) {
      c.seat = seat;
      c.events.push(restored ? 'restored' : 'attached');
      const canvas = document.createElement('canvas');
      copyTag.set(canvas, order);
      seat.setTarget(canvas, false);
      seat.setRendering(true);
    },
    detached() {
      c.events.push('detached');
    },
    evict() {
      c.events.push('evicted');
      c.seat?.release();
      c.seat = null;
    },
    failed(err) {
      c.events.push(`failed ${err.message}`);
      c.seat = null;
    },
    presented(drawn, shown) {
      c.events.push(`presented ${drawn ? 1 : 0}${shown ? 1 : 0}`);
    },
  };
  return c;
}

/** One frame in which every seated client submits (like instances in their render phase). */
function drive(clients: TestClient[], n = 1): void {
  for (let i = 0; i < n; i++) {
    now += 16.67;
    const t = now;
    const q = rafQueue;
    rafQueue = [];
    // Render phase first: the renderer's present phase (a ticker subscriber) runs after it.
    for (const c of clients) {
      if (!c.seat?.slot) continue;
      c.seat.beginFrame(t);
      c.seat.submit();
    }
    for (const cb of q) cb(t);
  }
}

describe('shared renderer: device lifecycle', () => {
  it('creates the device lazily at the end of a frame, releases it with the last member', () => {
    const r = getSharedRenderer();
    const a = client();
    const b = client();
    r.request(a);
    expect(FakeDevice.instances).toHaveLength(0);
    expect(contextsInUse()).toBe(0);
    frame();
    expect(FakeDevice.instances).toHaveLength(1);
    const dev = FakeDevice.instances[0];
    // The device is created with an alpha channel (overflow margins are transparent).
    expect(dev?.opts.opaque).toBe(false);
    expect(a.events).toEqual(['attached']);
    // One context, reserved on top of the own-context budget.
    expect(contextsInUse()).toBe(1);
    r.request(b);
    frame();
    expect(FakeDevice.instances).toHaveLength(1);
    expect(b.events).toEqual(['attached']);
    a.seat?.release();
    expect(dev?.disposed).toBe(false);
    b.seat?.release();
    // The last member left: GPU objects freed and the context released on purpose, at once.
    expect(dev?.disposed).toBe(true);
    expect(dev?.released).toBe(true);
    expect(contextsInUse()).toBe(0);
    expect(r.active).toBe(false);
  });

  it('a withdrawn request before the device exists creates nothing', () => {
    const r = getSharedRenderer();
    const a = client();
    r.request(a);
    r.cancel(a);
    frames(3);
    expect(FakeDevice.instances).toHaveLength(0);
  });

  it('shares the per-frame creation allowance with own contexts', () => {
    // createPerFrame 1: an own context created in this frame leaves the device for the next.
    expect(claimContextCreation(500)).toBe(true);
    expect(claimContextCreation(500)).toBe(false);
    expect(claimContextCreation(501)).toBe(true);
    // Never in a frame in which an engine drew its first frame.
    noteFirstDraw(502);
    expect(claimContextCreation(502)).toBe(false);
  });

  it('grants at most GRANTS_PER_FRAME seats per frame, visible instances first', () => {
    const r = getSharedRenderer();
    const hidden = client(200, 100, false);
    const list = Array.from({ length: GRANTS_PER_FRAME + 3 }, () => client());
    r.request(hidden);
    for (const c of list) r.request(c);
    frame();
    const seated = () => [hidden, ...list].filter((c) => c.seat).length;
    expect(seated()).toBe(GRANTS_PER_FRAME);
    expect(hidden.seat).toBeNull();
    frame();
    expect(seated()).toBe(list.length + 1);
  });

  it('a device that fails fails every member, and later requests too', async () => {
    const r = getSharedRenderer();
    FakeDevice.failInCtor = new EngineError('compile', 'fake compile failure');
    const a = client();
    r.request(a);
    frame();
    expect(a.events).toEqual(['failed fake compile failure']);
    expect(contextsInUse()).toBe(0);
    FakeDevice.failInCtor = null;
    const b = client();
    r.request(b);
    frame();
    expect(b.events).toEqual(['failed fake compile failure']);
    expect(FakeDevice.instances).toHaveLength(1);
  });

  it('no WebGL2 fails the current members only: a later request tries a new device', () => {
    const r = getSharedRenderer();
    FakeDevice.throwInCtor = new EngineError('no-webgl2', 'fake no webgl2');
    const a = client();
    r.request(a);
    frame();
    expect(a.events).toEqual(['failed fake no webgl2']);
    expect(r.active).toBe(false);
    expect(contextsInUse()).toBe(0);
    // WebGL is back (e.g. after the browser's block following GPU resets).
    FakeDevice.throwInCtor = null;
    const b = client();
    r.request(b);
    frame();
    expect(b.events).toEqual(['attached']);
    expect(FakeDevice.instances).toHaveLength(1);
  });

  it('a resource failure while building the device is not sticky either', () => {
    const r = getSharedRenderer();
    FakeDevice.failInCtor = new EngineError('resource', 'fake program creation failure');
    const a = client();
    r.request(a);
    frame();
    expect(a.events).toEqual(['failed fake program creation failure']);
    FakeDevice.failInCtor = null;
    const b = client();
    r.request(b);
    frame();
    expect(b.events).toEqual(['attached']);
  });

  it('no WebGL2 on the fresh-canvas rebuild after a loss fails the members, not the page', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = getSharedRenderer();
    const a = client();
    r.request(a);
    frame();
    (FakeDevice.instances[0] as InstanceType<typeof FakeDevice>).loseContextForTesting();
    FakeDevice.throwInCtor = new EngineError('no-webgl2', 'fake blocked');
    vi.advanceTimersByTime(RESTORE_TIMEOUT_MS);
    expect(a.events).toEqual(['attached', 'detached', 'failed fake blocked']);
    expect(r.active).toBe(false);
    expect(contextsInUse()).toBe(0);
    FakeDevice.throwInCtor = null;
    const b = client();
    r.request(b);
    frame();
    expect(b.events).toEqual(['attached']);
  });

  it('the last seat failing while drawing releases the device without a bogus loss', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = getSharedRenderer();
    const a = client();
    r.request(a);
    frame();
    drive([a]);
    expect(a.events.at(-1)).toBe('presented 11');
    const dev = FakeDevice.instances[0] as InstanceType<typeof FakeDevice>;
    FakeDevice.failDraw = true;
    drive([a]);
    expect(a.events).toContain('failed fake draw failure');
    // Released (its context lost on purpose), not waiting for a restore.
    expect(dev.released).toBe(true);
    expect(r.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(contextsInUse()).toBe(0);
    // A new shared instance is served at the end of the next frame, not after the restore timeout.
    FakeDevice.failDraw = false;
    const b = client();
    r.request(b);
    frame();
    expect(b.events).toEqual(['attached']);
    drive([b]);
    expect(b.events.at(-1)).toBe('presented 11');
  });
});

describe('shared renderer: frames', () => {
  it('draws every due member, then copies them all (never interleaved)', () => {
    const r = getSharedRenderer();
    const list = [client(200, 100), client(120, 80), client(300, 60)];
    for (const c of list) r.request(c);
    frame();
    drive(list, 2);
    const last = log.slice(-6);
    expect(last.slice(0, 3).every((e) => e.startsWith('draw'))).toBe(true);
    expect(last.slice(3).every((e) => e.startsWith('copy'))).toBe(true);
    for (const c of list) expect(c.events.at(-1)).toBe('presented 11');
  });

  it('copies 1:1 from the region into a 2D canvas of the frame size, replacing its content', () => {
    const r = getSharedRenderer();
    const a = client(210, 90);
    r.request(a);
    frame();
    drive([a]);
    const target = a.seat?.target as HTMLCanvasElement;
    const ctx = ctx2d(target) as Fake2d;
    expect([target.width, target.height]).toEqual([210, 90]);
    expect(ctx.alpha).toBe(false);
    expect(ctx.globalCompositeOperation).toBe('copy');
    expect(ctx.imageSmoothingEnabled).toBe(false);
    const slot = FakeDevice.instances[0]?.slots[0];
    const [sx, sy, sw, sh, dx, dy, dw, dh] = ctx.lastArgs;
    expect([sx, sy]).toEqual([slot?.last?.x, slot?.last?.y]);
    expect([sw, sh, dx, dy, dw, dh]).toEqual([210, 90, 0, 0, 210, 90]);
    // The atlas holds the region.
    const atlas = (FakeDevice.instances[0] as InstanceType<typeof FakeDevice>).canvas;
    expect(atlas.width).toBeGreaterThanOrEqual((sx ?? 0) + 210);
    expect(atlas.height).toBeGreaterThanOrEqual((sy ?? 0) + 90);
    expect(atlas.isConnected).toBe(false);
  });

  it('regions of all drawing members are disjoint and inside the atlas', () => {
    const r = getSharedRenderer();
    const list = Array.from({ length: 12 }, (_, i) => client(100 + i * 13, 60 + ((i * 7) % 50)));
    for (const c of list) r.request(c);
    frames(2);
    drive(list, 1 + Math.ceil(list.length / FIRST_DRAWS_PER_FRAME));
    const atlas = (FakeDevice.instances[0] as InstanceType<typeof FakeDevice>).canvas;
    const boxes = list.map((c) => {
      const it = c.seat?.item;
      return { x: it?.x ?? -1, y: it?.y ?? -1, w: c.frame.canvasWidth, h: c.frame.canvasHeight };
    });
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(atlas.width);
      expect(b.y + b.h).toBeLessThanOrEqual(atlas.height);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i] as (typeof boxes)[0];
        const b = boxes[j] as (typeof boxes)[0];
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(
          true,
        );
      }
    }
  });

  it('limits first draws per frame; members not drawn yet are presented as not drawn', () => {
    const r = getSharedRenderer();
    const list = Array.from({ length: FIRST_DRAWS_PER_FRAME * 2 + 1 }, () => client());
    for (const c of list) r.request(c);
    frames(2);
    drive(list);
    const drawn = () => list.filter((c) => c.events.includes('presented 11')).length;
    expect(drawn()).toBe(FIRST_DRAWS_PER_FRAME);
    expect(list.filter((c) => c.events.at(-1) === 'presented 00')).toHaveLength(
      list.length - FIRST_DRAWS_PER_FRAME,
    );
    drive(list, 2);
    expect(drawn()).toBe(list.length);
  });

  it('draws nothing (and copies nothing) until the programs are linked', () => {
    FakeDevice.linked = false;
    const r = getSharedRenderer();
    const a = client();
    r.request(a);
    frame();
    drive([a], 3);
    expect(log).toEqual([]);
    expect(a.events.slice(-1)).toEqual(['presented 00']);
    FakeDevice.linked = true;
    drive([a]);
    expect(a.events.at(-1)).toBe('presented 11');
  });

  it('the atlas is not resized while members come and go within its bucket', () => {
    const r = getSharedRenderer();
    const list = Array.from({ length: 16 }, () => client(180, 100));
    for (const c of list) r.request(c);
    frames(2);
    drive(list, 5);
    const resizes = r.resizes;
    // Scrolling: a few members stop and start drawing.
    for (let k = 0; k < 6; k++) {
      list[k]?.seat?.setRendering(false);
      drive(list.slice(6), 1);
      list[k]?.seat?.setRendering(true);
      drive(list, 1);
    }
    expect(r.resizes).toBe(resizes);
  });

  it('sizes the atlas ahead for members about to draw: a mounting list resizes it once', () => {
    const r = getSharedRenderer();
    const list = Array.from({ length: GRANTS_PER_FRAME * 3 }, () => client(130, 80));
    for (const c of list) r.request(c);
    frame(); // the first GRANTS_PER_FRAME are seated, the rest still queued
    expect(list.filter((c) => c.seat)).toHaveLength(GRANTS_PER_FRAME);
    drive(list, 8);
    expect(list.every((c) => c.events.includes('presented 11'))).toBe(true);
    expect(r.resizes).toBe(1);
  });

  it('scales every member uniformly when the drawing members exceed the pixel budget', () => {
    LumiCells.configure({ sharedBudget: 0.05 }); // 50 000 px
    const r = getSharedRenderer();
    const list = Array.from({ length: 6 }, () => client(200, 100)); // 120 000 px at full size
    for (const c of list) r.request(c);
    frame();
    drive(list, 2);
    const scale = list[0]?.scale ?? 1;
    expect(scale).toBeLessThan(1);
    expect(list.every((c) => c.scale === scale)).toBe(true);
    expect(r.stats.scale).toBe(scale);
    const area = list.reduce((a, c) => a + c.frame.canvasWidth * c.frame.canvasHeight, 0);
    expect(area).toBeLessThanOrEqual(50_000);
    // Nobody was dropped.
    drive(list, 3);
    expect(list.every((c) => c.events.includes('presented 11'))).toBe(true);
  });

  it('a list mounting over the pixel budget takes its final scale once, not a step per grant batch', () => {
    LumiCells.configure({ sharedBudget: 0.05 }); // 50 000 px
    const r = getSharedRenderer();
    // 480 000 px at full size, granted in three batches.
    const list = Array.from({ length: GRANTS_PER_FRAME * 3 }, () => client(200, 100));
    const history = new Map<TestClient, number[]>();
    for (const c of list) {
      const seen: number[] = [];
      history.set(c, seen);
      const set = c.setShareScale.bind(c);
      c.setShareScale = (v) => {
        if (v !== c.scale) seen.push(v);
        set(v);
      };
    }
    for (const c of list) r.request(c);
    frame(); // the first GRANTS_PER_FRAME are seated, the rest still queued
    const scales: number[] = [];
    for (let k = 0; k < 8; k++) {
      drive(list);
      if (scales.at(-1) !== r.stats.scale) scales.push(r.stats.scale);
    }
    expect(list.every((c) => c.events.includes('presented 11'))).toBe(true);
    // One plan for the whole list: the scale dropped once, to its final step.
    expect(scales).toHaveLength(1);
    expect(scales[0]).toBeLessThan(1);
    const area = list.reduce((a, c) => a + c.frame.canvasWidth * c.frame.canvasHeight, 0);
    expect(area).toBeLessThanOrEqual(50_000);
    // Every member's canvas was resized for the budget at most once.
    for (const c of list) expect(history.get(c)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('calibrates the copy cost per megapixel once, after about 60 copy frames', () => {
    const r = getSharedRenderer();
    const a = client();
    r.request(a);
    frame();
    drive([a], 30);
    expect(r.stats.copyMsPerMpx).toBeNull();
    drive([a], 50);
    expect(r.stats.copyMsPerMpx).not.toBeNull();
    expect(r.stats.copyMsPerMpx).toBeGreaterThanOrEqual(0);
  });
});

describe('shared renderer: idle seats', () => {
  it('keeps at most IDLE_SEATS_MIN (or 2 per drawing member) idle seats, parking the longest away', () => {
    const r = getSharedRenderer();
    const list = Array.from({ length: 30 }, () => client());
    for (const c of list) r.request(c);
    frames(5);
    expect(r.seatCount).toBe(30);
    // Scrolled away one after another (the first ones longest ago), 4 still drawing.
    const away = list.slice(0, 26);
    away.forEach((c, i) => {
      (c as { lastVisible: number }).lastVisible = 100 + i;
      c.seat?.setRendering(false);
      c.seat?.setIdle(true);
    });
    // Trimmed at the end of the frame, not inside the caller.
    expect(r.seatCount).toBe(30);
    frame();
    const cap = Math.max(IDLE_SEATS_MIN, IDLE_SEATS_PER_REGION * 4);
    expect(r.seatCount).toBe(4 + cap);
    const evicted = away.filter((c) => c.events.includes('evicted'));
    expect(evicted).toEqual(away.slice(0, 26 - cap));
    // Back in the zone: no longer idle, nothing more is taken.
    for (const c of away.slice(26 - cap)) c.seat?.setIdle(false);
    frame();
    expect(r.seatCount).toBe(4 + cap);
  });
});

describe('shared renderer: copy path', () => {
  /**
   * Copies cost virtual time: a drawImage from the WebGL atlas `perAtlasPx` ms per pixel of the
   * WHOLE atlas (a browser that snapshots the drawing buffer for every call) plus `perPx` per
   * pixel copied; from a 2D canvas `perPx` per pixel copied only. A readPixels costs `perReadPx`
   * per pixel read (default: a stall far above any snapshot), a putImageData `perPx` per pixel.
   */
  function costModel(
    perAtlasPx: number,
    perPx: number,
    perReadPx = 1e-3,
  ): { atlasReads: () => number } {
    let clock = 0;
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    copyCost = (src, args) => {
      const atlas = FakeDevice.instances.at(-1)?.canvas;
      if (src === atlas) {
        reads++;
        clock += src.width * src.height * perAtlasPx;
      }
      clock += (args[2] ?? 0) * (args[3] ?? 0) * perPx;
    };
    FakeDevice.onRead = (w, h) => {
      clock += w * h * perReadPx;
    };
    putCost = (args) => {
      clock += (args[4] ?? 0) * (args[5] ?? 0) * perPx;
    };
    return { atlasReads: () => reads };
  }

  function copyMsPerFrame(r: ReturnType<typeof getSharedRenderer>, list: TestClient[]): number {
    // copyMs is an EMA: run enough frames for it to settle.
    drive(list, 60);
    return r.stats.copyMs;
  }

  it('a full readback per drawImage switches to one snapshot per frame: cost follows pixels', () => {
    // 1e-5 ms per atlas pixel: about 10 ms per call from a 1 Mpx atlas (Firefox measured 9.4).
    const cost = costModel(1e-5, 1e-8);
    const r = getSharedRenderer();
    const list = Array.from({ length: 16 }, () => client(180, 100));
    for (const c of list) r.request(c);
    frames(3);
    drive(list, 6); // every member drew once
    const atlasPx =
      (FakeDevice.instances[0]?.canvas.width ?? 0) * (FakeDevice.instances[0]?.canvas.height ?? 0);
    drive(list, 3 * PROBE_FRAMES + 4);
    expect(r.stats.copyStaged).toBe(true);
    // readPixels was timed too (a stall here): the snapshot is drawn from the WebGL canvas.
    expect(FakeDevice.instances[0]?.reads.length).toBe(PROBE_FRAMES);
    expect(r.stats.copyReadback).toBe(false);
    // One read of the atlas per frame now, not one per member.
    const reads = cost.atlasReads();
    drive(list, 5);
    expect(cost.atlasReads() - reads).toBe(5);
    // The copy series costs about one readback of the used part of the atlas, not 16.
    const perFrame = copyMsPerFrame(r, list);
    expect(perFrame).toBeLessThan(2 * atlasPx * 1e-5);
    // Every member is still copied every frame, from its own region.
    for (const c of list) expect(c.events.at(-1)).toBe('presented 11');
    const ctx = ctx2d(list[3]?.seat?.target ?? null) as Fake2d;
    expect(ctx.lastArgs.slice(0, 4)).toEqual([
      list[3]?.seat?.item.x,
      list[3]?.seat?.item.y,
      180,
      100,
    ]);
    // More members: the cost grows with the pixels copied, not with a readback per member.
    const more = Array.from({ length: 16 }, () => client(180, 100));
    for (const c of more) r.request(c);
    frames(3);
    const all = [...list, ...more];
    drive(all, 10);
    const perFrame32 = copyMsPerFrame(r, all);
    expect(perFrame32).toBeLessThan(2.5 * perFrame);
  });

  it('cheap copies (a GPU-backed 2D canvas) keep the direct path and never snapshot', () => {
    const cost = costModel(0, 1e-9); // a few microseconds per copy at most
    const r = getSharedRenderer();
    const list = Array.from({ length: 12 }, () => client(180, 100));
    for (const c of list) r.request(c);
    frames(3);
    drive(list, 6 + 3 * PROBE_FRAMES);
    expect(r.stats.copyStaged).toBe(false);
    // Nothing but the direct path was timed: no readPixels either.
    expect(FakeDevice.instances[0]?.reads).toEqual([]);
    // One atlas read per member and frame, and no staging canvas ever filled.
    const reads = cost.atlasReads();
    drive(list, 2);
    expect(cost.atlasReads() - reads).toBe(24);
    // Far below the threshold: 18 000 px per copy.
    expect(r.stats.copyMs / 12).toBeLessThan(CHEAP_COPY_MS);
  });

  it('where readPixels of the used part beats a drawn snapshot of the whole atlas, it is read', () => {
    // A drawn snapshot reads the whole atlas (1e-5 ms per atlas pixel); readPixels reads only
    // the used part at 1e-6 ms per pixel (Firefox measured about 2-3x apart per pixel, and the
    // used part is often a fraction of the atlas).
    costModel(1e-5, 1e-8, 1e-6);
    const r = getSharedRenderer();
    const list = Array.from({ length: 16 }, () => client(180, 100));
    for (const c of list) r.request(c);
    frames(3);
    drive(list, 6);
    drive(list, 3 * PROBE_FRAMES + 4);
    expect(r.stats.copyStaged).toBe(true);
    expect(r.stats.copyReadback).toBe(true);
    const dev = FakeDevice.instances[0] as InstanceType<typeof FakeDevice>;
    const reads = dev.reads.length;
    drive(list, 3);
    // One read per frame, of the used part only, into rows as wide as the staging canvas.
    expect(dev.reads.length - reads).toBe(3);
    const used = list.reduce(
      (m, c) => ({
        w: Math.max(m.w, (c.seat?.item.x ?? 0) + 180),
        h: Math.max(m.h, (c.seat?.item.y ?? 0) + 100),
      }),
      { w: 0, h: 0 },
    );
    const [x, y, w, h, rowLength] = dev.reads.at(-1) as number[];
    expect([x, w, h]).toEqual([0, used.w, used.h]);
    // GL rows bottom-up: the used part is the top of the drawing buffer.
    expect(y).toBe(dev.canvas.height - used.h);
    expect(rowLength).toBeGreaterThanOrEqual(used.w);
    // Every member is still copied every frame, from its region of the staging canvas.
    for (const c of list) expect(c.events.at(-1)).toBe('presented 11');
    const ctx = ctx2d(list[3]?.seat?.target ?? null) as Fake2d;
    expect(ctx.lastArgs.slice(0, 4)).toEqual([
      list[3]?.seat?.item.x,
      list[3]?.seat?.item.y,
      180,
      100,
    ]);
  });

  it('a read snapshot is flipped to canvas rows, and unpremultiplied only where alpha is kept', () => {
    costModel(1e-5, 1e-8, 1e-6);
    // Texels by row of the rectangle read (GL order, bottom-up): red = the row; the bottom row
    // half transparent (green 64 premultiplied at alpha 128), the others opaque.
    FakeDevice.texel = (_x, y) => (y === 0 ? [0, 64, 0, 128] : [y % 256, 64, 0, 255]);
    const r = getSharedRenderer();
    const list = Array.from({ length: 4 }, () => client(100, 50));
    for (const c of list) r.request(c);
    frames(3);
    drive(list, 6 + 3 * PROBE_FRAMES + 4);
    expect(r.stats.copyReadback).toBe(true);
    const dev = FakeDevice.instances[0] as InstanceType<typeof FakeDevice>;
    const h = (dev.reads.at(-1) as number[])[3] as number;
    // The staging canvas: the one context putImageData went to.
    const staging = all2d.filter((c) => c.puts > 0);
    expect(staging).toHaveLength(1);
    const row = (canvasRow: number) => {
      const img = staging[0]?.put as { width: number; data: Uint8ClampedArray };
      const i = canvasRow * img.width * 4;
      return [...img.data.slice(i, i + 4)];
    };
    // Top canvas row = the highest row read; the bottom one = the lowest.
    expect(row(0)).toEqual([h - 1, 64, 0, 255]);
    // Opaque targets only: the half-transparent texel stays premultiplied (what drawImage would
    // give an opaque canvas).
    expect(row(h - 1)).toEqual([0, 64, 0, 128]);
    // A target with alpha: unpremultiplied (64 * 255 / 128 = 127.5, rounded to even).
    const glass = list[0] as TestClient;
    glass.seat?.setTarget(glass.seat.target as HTMLCanvasElement, true);
    drive(list, 2);
    expect(row(h - 1)).toEqual([0, 128, 0, 128]);
    expect(row(0)).toEqual([h - 1, 64, 0, 255]);
  });

  it('a context lost while the snapshot is read copies nothing: the members keep their frame', () => {
    costModel(1e-5, 1e-8, 1e-6);
    const r = getSharedRenderer();
    const list = Array.from({ length: 4 }, () => client(100, 50));
    for (const c of list) r.request(c);
    frames(3);
    drive(list, 6 + 3 * PROBE_FRAMES + 4);
    expect(r.stats.copyReadback).toBe(true);
    const copies = list.map((c) => ctx2d(c.seat?.target ?? null)?.copies ?? 0);
    FakeDevice.onRead = (_w, _h, dev) => {
      dev.lost = true;
    };
    drive(list, 1);
    expect(list.map((c) => ctx2d(c.seat?.target ?? null)?.copies ?? 0)).toEqual(copies);
  });

  it('a single member copies directly (a snapshot would only add a copy)', () => {
    costModel(1e-5, 1e-8);
    const r = getSharedRenderer();
    const a = client(180, 100);
    r.request(a);
    frame();
    drive([a], 30);
    expect(r.stats.copyStaged).toBe(false);
  });
});

describe('shared renderer: copy cost accounting', () => {
  /** A virtual clock only drawImage (and 2D context creation) advance. */
  function virtualClock(): { advance: (ms: number) => void } {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    return {
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  it('calibrates on settled frames only: members joining (canvas set-up) do not count', () => {
    const clock = virtualClock();
    // 0.01 ms per copy, whatever its size; setting up a 2D context costs 5 ms, and so does the
    // first copy into a new canvas (browsers allocate its backing store then).
    copyCost = (_src, _args, dst) => clock.advance(dst.copies === 1 ? 5.01 : 0.01);
    ctxCost = () => clock.advance(5);
    const r = getSharedRenderer();
    const list = [client(100, 50), client(100, 50)];
    for (const c of list) r.request(c);
    frame();
    // A member joins every 8 frames while the calibration runs.
    for (let k = 0; k < 6; k++) {
      drive(list, 8);
      const c = client(100, 50);
      list.push(c);
      r.request(c);
    }
    drive(list, 120);
    // 0.01 ms per 5000 px copy: 2 ms/Mpx. The 5 ms set-ups would have multiplied it.
    expect(r.stats.copyMsPerMpx).not.toBeNull();
    expect(r.stats.copyMsPerMpx as number).toBeCloseTo(2, 6);
  });

  it('a new budget scale re-arms the calibration', () => {
    const clock = virtualClock();
    copyCost = () => clock.advance(0.01);
    const r = getSharedRenderer();
    const list = Array.from({ length: 4 }, () => client(200, 100));
    for (const c of list) r.request(c);
    frame();
    drive(list, 90);
    expect(r.stats.copyMsPerMpx as number).toBeCloseTo(0.01 / 0.02, 6);
    LumiCells.configure({ sharedBudget: 0.02 }); // 20 000 px: every member renders smaller
    drive(list, 2);
    expect(r.stats.scale).toBeLessThan(1);
    expect(r.stats.copyMsPerMpx).toBeNull();
    drive(list, 90);
    // The same cost per call over fewer pixels.
    const px = list[0] ? list[0].frame.canvasWidth * list[0].frame.canvasHeight : 0;
    expect(r.stats.copyMsPerMpx as number).toBeCloseTo(0.01 / (px / 1e6), 6);
  });

  it("the first copy's flush is shared by pixels, not charged to the first member", () => {
    const clock = virtualClock();
    let flushedAt = -1;
    // The first drawImage from the WebGL canvas in a frame flushes (1 ms); a copy costs 1e-6 ms
    // per pixel on top.
    copyCost = (src, args) => {
      if (src === FakeDevice.instances.at(-1)?.canvas && flushedAt !== now) {
        flushedAt = now;
        clock.advance(1);
      }
      clock.advance((args[2] ?? 0) * (args[3] ?? 0) * 1e-6);
    };
    const r = getSharedRenderer();
    const list = [
      ...Array.from({ length: 4 }, () => client(200, 100)),
      ...Array.from({ length: 4 }, () => client(100, 50)),
    ];
    for (const c of list) r.request(c);
    frame();
    drive(list, 80);
    expect(r.stats.copyStaged).toBe(false);
    const totalPx = list.reduce((a, c) => a + c.frame.canvasWidth * c.frame.canvasHeight, 0);
    let sum = 0;
    for (const c of list) {
      const seat = c.seat as SharedSeat;
      const px = c.frame.canvasWidth * c.frame.canvasHeight;
      // Its own copy plus its share of the flush, whichever member was copied first.
      expect(seat.copyMs).toBeCloseTo(px * 1e-6 + (px / totalPx) * 1, 1);
      // Every member pays about the same per pixel.
      expect((seat.copyMs / px) * (totalPx / (1 + totalPx * 1e-6))).toBeCloseTo(1, 1);
      sum += seat.copyMs;
    }
    // Nothing lost or counted twice: the members' shares add up to the series.
    expect(sum).toBeCloseTo(1 + totalPx * 1e-6, 9);
    expect(r.stats.snapshotMs).toBeGreaterThan(0.95);
    expect(r.stats.snapshotMs).toBeLessThan(1.05);
  });
});

describe('shared renderer: context loss', () => {
  it('members keep their target, are detached, and rebuilt on the restored context', () => {
    const r = getSharedRenderer();
    const list = [client(), client()];
    for (const c of list) r.request(c);
    frame();
    drive(list, 2);
    const target = list[0]?.seat?.target;
    const copies = ctx2d(target ?? null)?.copies ?? 0;
    r.loseForTesting();
    expect(list.map((c) => c.events.at(-1))).toEqual(['detached', 'detached']);
    expect(list[0]?.seat?.slot).toBeNull();
    // The 2D canvas is untouched: it keeps the last frame.
    expect(list[0]?.seat?.target).toBe(target);
    expect(ctx2d(target ?? null)?.copies).toBe(copies);
    // Still one context in use (awaiting the restore).
    expect(contextsInUse()).toBe(1);
    drive(list, 2);
    expect(log.filter((e) => e.startsWith('draw')).length).toBe(4);
    (FakeDevice.instances[0] as InstanceType<typeof FakeDevice>).restoreContextForTesting();
    expect(FakeDevice.instances).toHaveLength(2);
    expect(list.map((c) => c.events.at(-1))).toEqual(['restored', 'restored']);
    drive(list, 2);
    expect(list.every((c) => c.events.at(-1) === 'presented 11')).toBe(true);
    // Same atlas canvas (the restored context).
    expect(FakeDevice.instances[1]?.canvas).toBe(FakeDevice.instances[0]?.canvas);
  });

  it('rebuilds on a fresh canvas when the browser does not restore in time', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = getSharedRenderer();
    const a = client();
    r.request(a);
    frame();
    const dev = FakeDevice.instances[0] as InstanceType<typeof FakeDevice>;
    dev.loseContextForTesting();
    vi.advanceTimersByTime(RESTORE_TIMEOUT_MS - 1);
    expect(FakeDevice.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeDevice.instances).toHaveLength(2);
    expect(FakeDevice.instances[1]?.canvas).not.toBe(dev.canvas);
    expect(a.events).toEqual(['attached', 'detached', 'restored']);
    // A late restore of the abandoned canvas is ignored.
    dev.restoreContextForTesting();
    expect(FakeDevice.instances).toHaveLength(2);
  });
});

// -------------------------------------------------------------------------------------------
// The facade

describe('LumiCells with renderer: shared', () => {
  it('mounts a 2D canvas placed like the WebGL canvas; ready after the first copy', async () => {
    const pl = create();
    const ready = vi.fn();
    pl.on('ready', ready);
    expect(pl.renderer).toBe('shared');
    expect(pl.canvas).toBeNull();
    frame(); // seat granted at the end of this frame, canvas mounted
    const canvas = pl.canvas as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    expect(canvas.parentElement).toBe(pl.host);
    expect(canvas.style.position).toBe('absolute');
    expect(canvas.style.width).toBe('100%');
    expect(canvas.style.visibility).toBe('hidden');
    expect(pl.getStats().state).toBe('live');
    expect(ready).not.toHaveBeenCalled();
    frame(); // drawn and copied
    expect(ready).toHaveBeenCalledTimes(1);
    expect(canvas.style.visibility).toBe('');
    expect(ctx2d(canvas)?.copies).toBe(1);
    // Opaque without an overflow margin.
    expect(ctx2d(canvas)?.alpha).toBe(false);
    frames(20);
    const s = pl.getStats();
    expect(s.renderer).toBe('shared');
    expect(s.presentMs).not.toBeNull();
    expect(s.shared?.members).toBe(1);
    expect(s.shared?.regions).toBe(1);
    expect(s.shared?.atlasWidth).toBeGreaterThan(0);
    expect(s.gpuMs).toBeNull(); // the fake device has no GPU timer
    // A snapshot, not the live object.
    expect(pl.getStats().shared).not.toBe(s.shared);
    await tick();
  });

  it('with an overflow margin the 2D canvas has alpha and reaches beyond the host', () => {
    const pl = create({ config: { render: { overflow: 24 } } });
    frames(2);
    const canvas = pl.canvas as HTMLCanvasElement;
    expect(ctx2d(canvas)?.alpha).toBe(true);
    expect(canvas.style.left).toBe('-24px');
    expect(canvas.style.width).toBe('calc(100% + 48px)');
  });

  it('overflow changes resize the region without touching the shared context', () => {
    const pl = create({ config: { render: { overflow: 10 } } });
    frames(3);
    const first = pl.canvas as HTMLCanvasElement;
    const w0 = first.width;
    pl.set('render.overflow', 30);
    frames(2);
    expect(pl.canvas).toBe(first);
    expect(first.width).toBeGreaterThan(w0);
    // Opaque again: a 2D canvas without alpha (a new element), same device.
    pl.set('render.overflow', 0);
    frames(2);
    expect(pl.canvas).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(ctx2d(pl.canvas)?.alpha).toBe(false);
    expect(pl.canvas?.style.visibility).toBe('');
    expect(FakeDevice.instances).toHaveLength(1);
    expect(FakeDevice.instances[0]?.lost).toBe(false);
  });

  it('many shared instances cost one context', () => {
    LumiCells.configure({ maxContexts: 2 });
    const list = Array.from({ length: 30 }, () => create());
    frames(4 + Math.ceil(30 / FIRST_DRAWS_PER_FRAME));
    expect(list.every((pl) => pl.getStats().state === 'live')).toBe(true);
    expect(list.every((pl) => pl.canvas?.style.visibility === '')).toBe(true);
    expect(FakeDevice.instances).toHaveLength(1);
    expect(contextsInUse()).toBe(1);
  });

  it('parking releases the slot and region and empties the 2D canvas; coming back rebuilds', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    LumiCells.configure({ parkAfterMs: 1000 });
    const pl = create();
    const other = create();
    frames(3);
    const canvas = pl.canvas as HTMLCanvasElement;
    expect(canvas.width).toBe(200);
    const slot = FakeDevice.instances[0]?.slots[0];
    place(pl, false, false);
    vi.advanceTimersByTime(1000);
    expect(pl.getStats().state).toBe('parked');
    expect(slot?.disposed).toBe(true);
    // Kept in the host, but with no pixels (browsers cap canvas memory per page).
    expect(pl.canvas).toBe(canvas);
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(canvas.style.visibility).toBe('hidden');
    expect(peekSharedRenderer()?.seatCount).toBe(1);
    // The last member parks: the device goes away.
    place(other, false, false);
    vi.advanceTimersByTime(1000);
    expect(peekSharedRenderer()?.active).toBe(false);
    expect(contextsInUse()).toBe(0);
    // Back: a new device, a new slot, the canvas refilled and shown again.
    place(pl, true);
    frames(3);
    expect(pl.getStats().state).toBe('live');
    expect(FakeDevice.instances).toHaveLength(2);
    expect(canvas.width).toBe(200);
    expect(canvas.style.visibility).toBe('');
  });

  it('out of the zone the 2D canvas empties at once but the seat stays for a quick return', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pl = create();
    const other = create();
    frames(3);
    const canvas = pl.canvas as HTMLCanvasElement;
    expect(canvas.width).toBe(200);
    const slot = FakeDevice.instances[0]?.slots[0];
    place(pl, false, false);
    // No wait for parkAfterMs: the memory is freed now, the slot is kept.
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(canvas.style.visibility).toBe('hidden');
    expect(pl.getStats().state).toBe('live');
    expect(slot?.disposed).toBe(false);
    frames(3);
    expect(canvas.width).toBe(0);
    // Back on screen: the same slot redraws within a frame, no new grant.
    place(pl, true);
    frames(1);
    expect(canvas.width).toBe(200);
    expect(canvas.style.visibility).toBe('');
    expect(slot?.disposed).toBe(false);
    expect(peekSharedRenderer()?.seatCount).toBe(2);
    expect(other.getStats().state).toBe('live');
  });

  it('a fast scroll through a long list does not keep a seat for every card it passed', () => {
    const list = Array.from({ length: 40 }, () => create());
    frames(10);
    expect(peekSharedRenderer()?.seatCount).toBe(40);
    // All but 3 scrolled out of the zone.
    for (const pl of list.slice(3)) place(pl, false, false);
    frames(2);
    const cap = Math.max(IDLE_SEATS_MIN, IDLE_SEATS_PER_REGION * 3);
    expect(peekSharedRenderer()?.seatCount).toBe(3 + cap);
    expect(list.filter((pl) => pl.getStats().state === 'parked')).toHaveLength(37 - cap);
    // Every card away holds an empty 2D canvas, parked or not.
    for (const pl of list.slice(3)) expect(pl.canvas?.width ?? 0).toBe(0);
  });

  it('a lost shared context keeps every canvas on its last frame and recovers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const list = [create(), create(), create()];
    const lost = vi.fn();
    const restored = vi.fn();
    const fallback: LumiCellsEvents['fallback'][] = [];
    for (const pl of list) {
      pl.on('contextlost', lost);
      pl.on('contextrestored', restored);
      pl.on('fallback', (e) => fallback.push(e));
    }
    frames(3);
    const copies = list.map((pl) => ctx2d(pl.canvas)?.copies ?? 0);
    const posterBefore = list.map((pl) => pl.host.style.backgroundImage);
    // One instance simulates the loss: the shared device (all of them) is affected.
    list[1]?.loseContextForTesting();
    expect(lost).toHaveBeenCalledTimes(3);
    expect(list.every((pl) => pl.getStats().state === 'lost')).toBe(true);
    expect(fallback).toEqual([
      { reason: 'context-lost' },
      { reason: 'context-lost' },
      { reason: 'context-lost' },
    ]);
    frames(5);
    // Still visible, not repainted, no poster brought back.
    for (const pl of list) expect(pl.canvas?.style.visibility).toBe('');
    expect(list.map((pl) => ctx2d(pl.canvas)?.copies ?? 0)).toEqual(copies);
    expect(list.map((pl) => pl.host.style.backgroundImage)).toEqual(posterBefore);
    vi.advanceTimersByTime(500); // the simulated restore
    expect(restored).toHaveBeenCalledTimes(3);
    expect(list.every((pl) => pl.getStats().state === 'live')).toBe(true);
    frames(3);
    expect(list.every((pl, i) => (ctx2d(pl.canvas)?.copies ?? 0) > (copies[i] ?? 0))).toBe(true);
    expect(FakeDevice.instances).toHaveLength(2);
  });

  it('switches between own and shared at runtime', async () => {
    const pl = create({ renderer: 'own' });
    // Granted, drawn once, shown with its second frame ('ready').
    frames(3);
    const own = pl.canvas as HTMLCanvasElement;
    expect(pl.getStats()).toMatchObject({ renderer: 'own', state: 'live', presentMs: null });
    expect(contextsInUse()).toBe(1);
    const ready = vi.fn();
    pl.on('ready', ready);
    pl.setRenderer('shared');
    expect(own.isConnected).toBe(false);
    expect(pl.getStats().renderer).toBe('shared');
    frames(3);
    expect(pl.getStats().state).toBe('live');
    expect(pl.canvas).not.toBe(own);
    expect(ctx2d(pl.canvas)?.copies).toBeGreaterThan(0);
    // Own context given back, the shared one in use.
    expect(contextsInUse()).toBe(1);
    expect(peekSharedRenderer()?.seatCount).toBe(1);
    pl.setRenderer('own');
    expect(peekSharedRenderer()?.active).toBe(false);
    frames(3);
    expect(pl.getStats()).toMatchObject({ renderer: 'own', state: 'live', shared: null });
    expect(contextsInUse()).toBe(1);
    // 'ready' is once per instance.
    expect(ready).not.toHaveBeenCalled();
  });

  it('an instance switched to own leaves the shared budget scale behind', () => {
    LumiCells.configure({ sharedBudget: 0.005 }); // 5000 px: 200x100 needs a lower scale
    // 10 px cells: room below the 3 px minimum pitch for the budget to lower the resolution.
    const pl = create({ config: { grid: { sizing: 'pitch', pitch: 10 } } });
    frames(20); // stats refresh every 250 ms
    const shared = pl.getStats();
    expect(shared.shared?.scale).toBeLessThan(1);
    expect(shared.pixels).toBeLessThanOrEqual(5000);
    expect(ctx2d(pl.canvas)?.canvas.width).toBeLessThan(200);
    pl.setRenderer('own');
    frames(20);
    const own = pl.getStats();
    expect(own).toMatchObject({ renderer: 'own', state: 'live', pixels: 200 * 100 });
    // Lower resolution, same grid.
    expect([own.cols, own.rows]).toEqual([shared.cols, shared.rows]);
  });

  it('own and shared instances side by side: own contexts keep their budget', () => {
    LumiCells.configure({ maxContexts: 2, createPerFrame: 4 });
    const own = [create({ renderer: 'own' }), create({ renderer: 'own' })];
    const shared = Array.from({ length: 10 }, () => create());
    frames(8);
    expect(own.every((pl) => pl.getStats().state === 'live')).toBe(true);
    expect(shared.every((pl) => pl.getStats().state === 'live')).toBe(true);
    expect(contextsInUse()).toBe(3);
  });

  it('a failed shared device shows the poster and reports compile', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    FakeDevice.failInCtor = new EngineError('compile', 'fake compile failure');
    const pl = create();
    const errors: Error[] = [];
    const fallbacks: LumiCellsEvents['fallback'][] = [];
    pl.on('error', (e) => errors.push(e));
    pl.on('fallback', (e) => fallbacks.push(e));
    frames(2);
    await tick();
    expect(pl.getStats().state).toBe('failed');
    expect(pl.canvas).toBeNull();
    expect(errors.map((e) => e.message)).toEqual(['fake compile failure']);
    expect(fallbacks).toEqual([{ reason: 'compile' }]);
    err.mockRestore();
  });

  it('destroy() gives the seat back at once', () => {
    const pl = create();
    frames(2);
    pl.destroy();
    expect(peekSharedRenderer()?.active).toBe(false);
    expect(pl.host.querySelector('canvas')).toBeNull();
  });
});

describe('LumiCells shared: cost reducers', () => {
  /** Frames to wait after the instances came alive until their start-up activity is over. */
  const SETTLE = Math.ceil(1100 / 16.67);

  /** The slots (by tag) that drew in each of the next `n` frames. */
  function drawsPerFrame(n: number): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      const start = log.length;
      frame();
      out.push(
        log
          .slice(start)
          .filter((l) => l.startsWith('draw '))
          .map((l) => Number(l.slice(5))),
      );
    }
    return out;
  }

  function slotsOf(): InstanceType<typeof fake.FakeSlot>[] {
    return (FakeDevice.instances[0]?.slots ?? []) as InstanceType<typeof fake.FakeSlot>[];
  }

  function crowd(n: number, opts: ConstructorParameters<typeof LumiCells>[1] = {}): LumiCells[] {
    const list = Array.from({ length: n }, () => create(opts));
    frames(4 + Math.ceil(n / FIRST_DRAWS_PER_FRAME) + SETTLE);
    return list;
  }

  it('more than CROWD drawing instances: the inactive ones present every 2nd frame, staggered', () => {
    const list = crowd(CROWD + 4);
    const per = drawsPerFrame(8);
    // The largest (the first, all being equal) at the full rate, the others half each frame.
    const others = list.length - 1;
    for (const f of per) {
      expect(f).toContain(0);
      expect(f.length).toBeGreaterThanOrEqual(1 + Math.floor(others / 2));
      expect(f.length).toBeLessThanOrEqual(1 + Math.ceil(others / 2));
    }
    // Every secondary instance presents on every other frame exactly.
    for (let tag = 1; tag < list.length; tag++) {
      const seen = per.map((f) => f.includes(tag));
      expect(seen.filter(Boolean).length).toBe(4);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    }
    const st = list[3]?.getStats();
    expect(st?.reducers.frameDivisor).toBe(2);
    expect(st?.shared?.reducers).toMatchObject({ frameDivisor: 2, level: 1, reason: 'crowd' });
    expect(st?.shared?.reducers.secondary).toBe(list.length - 1);
    expect(list[0]?.getStats().reducers.frameDivisor).toBe(1);
  });

  it('a secondary instance keeps its animation time: presented frames carry the skipped ones', () => {
    const list = crowd(CROWD + 2);
    const pl = list[5] as LumiCells;
    let time = 0;
    let events = 0;
    pl.on('frame', (e) => {
      time += e.dt;
      events++;
    });
    frames(60);
    expect(events).toBe(30);
    // 60 frames of 16.67 ms passed: so did (within one present) the instance's time.
    expect(time).toBeGreaterThan(0.98);
    expect(time).toBeLessThan(1.02);
  });

  it('a low secondaryMaxFps keeps the animation clock in step (present periods over 100 ms)', () => {
    // 5 fps on a 60 Hz display: one present every 200 ms, above the 100 ms default step bound.
    LumiCells.configure({ secondaryMaxFps: 5 });
    crowd(CROWD + 2);
    frames(24);
    expect(slotsOf()[5]?.block).not.toBeNull();
    const clock = (tag: number) => slotsOf()[tag]?.block?.[OFF_CLOCK] ?? Number.NaN;
    const p0 = clock(0);
    const s0 = clock(5);
    frames(240);
    const primary = clock(0) - p0;
    const secondary = clock(5) - s0;
    expect(primary).toBeGreaterThan(0);
    // Within one present of the full-rate instance (the controller clock, not the event dt).
    expect(Math.abs(secondary - primary)).toBeLessThan(0.21 * (primary / 4));
  });

  it('hover and recent changes keep an instance at the full rate and the full pipeline', () => {
    const list = crowd(CROWD + 2);
    const pl = list[4] as LumiCells;
    const tag = 4;
    expect(drawsPerFrame(4).filter((f) => f.includes(tag)).length).toBe(2);
    expect(slotsOf()[tag]?.lite).toBe(true);
    pl.host.dispatchEvent(new Event('pointerenter'));
    frame();
    expect(drawsPerFrame(4).filter((f) => f.includes(tag)).length).toBe(4);
    expect(slotsOf()[tag]?.lite).toBe(false);
    expect(pl.getStats().reducers).toEqual({ lite: false, frameDivisor: 1 });
    // Left: still active for about a second, then back to the lower rate.
    pl.host.dispatchEvent(new Event('pointerleave'));
    expect(drawsPerFrame(30).filter((f) => f.includes(tag)).length).toBe(30);
    frames(SETTLE);
    expect(drawsPerFrame(4).filter((f) => f.includes(tag)).length).toBe(2);
    // A pulse (or a lift, an influence, a config transition) does the same.
    pl.pulse({ x: 10, y: 10 });
    expect(drawsPerFrame(10).filter((f) => f.includes(tag)).length).toBe(10);
  });

  it('secondaryMaxFps: 0 turns it off; a number caps every inactive instance', () => {
    LumiCells.configure({ secondaryMaxFps: 0 });
    const list = crowd(CROWD + 2);
    for (const f of drawsPerFrame(4)) expect(f.length).toBe(list.length);
    expect(list[2]?.getStats().shared?.reducers.reason).toBe('off');
    // 20 fps on a 60 Hz display: every 3rd frame, even for a few instances.
    LumiCells.configure({ secondaryMaxFps: 20 });
    // Page-wide figures are sampled with the stats (about 4 times a second).
    frames(20);
    const per = drawsPerFrame(6);
    expect(per.filter((f) => f.includes(2)).length).toBe(2);
    expect(list[2]?.getStats().reducers.frameDivisor).toBe(3);
    expect(list[2]?.getStats().shared?.reducers.reason).toBe('fixed');
  });

  it('a few instances are left alone: every frame (no crowd, budget kept)', () => {
    const list = crowd(3);
    for (const f of drawsPerFrame(6)) expect(f.length).toBe(list.length);
    expect(list[1]?.getStats().shared?.reducers).toMatchObject({ frameDivisor: 1, reason: 'off' });
  });

  it('lite: small inactive instances draw lite; lite: false never, lite: true always', () => {
    const list = crowd(2);
    // 200 x 100 px canvases: small.
    expect(slotsOf().map((s) => s.lite)).toEqual([true, true]);
    expect(list[1]?.getStats().reducers.lite).toBe(true);
    expect(list[1]?.getStats().shared?.reducers.lite).toBe(2);
    LumiCells.configure({ lite: false });
    frames(2);
    expect(slotsOf().map((s) => s.lite)).toEqual([false, false]);
    expect(list[1]?.getStats().reducers.lite).toBe(false);
    LumiCells.configure({ lite: true });
    list[0]?.host.dispatchEvent(new Event('pointerenter'));
    frames(2);
    // Hovered: the full pipeline whatever the setting.
    expect(slotsOf().map((s) => s.lite)).toEqual([false, true]);
  });

  it('lite goes by activity: the largest instance keeps the full rate but draws lite', () => {
    const list = crowd(CROWD + 4);
    // Page-wide figures are sampled with the stats (about 4 times a second).
    frames(20);
    // The largest (the first, all being equal) presents every frame, the others every 2nd one.
    expect(list[0]?.getStats().reducers).toEqual({ lite: true, frameDivisor: 1 });
    expect(list[1]?.getStats().reducers).toEqual({ lite: true, frameDivisor: 2 });
    expect(list[0]?.getStats().shared?.reducers).toMatchObject({
      secondary: list.length - 1,
      lite: list.length,
    });
  });

  /** Copies cost virtual time: `msPerMpx` per copied megapixel (a software 2D canvas). */
  function slowCopies(msPerMpx: number): void {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    copyCost = (_src, args) => {
      clock += ((args[2] ?? 0) * (args[3] ?? 0) * msPerMpx) / 1e6;
    };
  }

  it('expensive copies raise the secondary level until a frame copies a quarter of a frame', () => {
    slowCopies(40);
    const list = crowd(6);
    frames(200);
    const s = list[1]?.getStats().shared;
    expect(s?.copyMsPerMpx).toBeCloseTo(40, 3);
    // 6 x 0.02 Mpx at 40 ms/Mpx is 4.8 ms of copies per frame, a quarter of the frame is 4.2:
    // every other frame for the five secondary ones fits.
    expect(s?.reducers).toMatchObject({
      reason: 'copy',
      level: 1,
      frameDivisor: 2,
      copyBudget: null,
    });
    expect(s?.scale).toBe(1);
  });

  it('copies too slow even at the lowest rate lower the atlas budget', () => {
    slowCopies(400);
    const list = crowd(6);
    frames(400);
    const s = list[1]?.getStats().shared;
    expect(s?.reducers.level).toBe(3);
    expect(s?.reducers.copyBudget).not.toBeNull();
    expect(s?.scale).toBeLessThan(1);
    // Never below a quarter of what the members need at full resolution.
    expect(s?.reducers.copyBudget ?? 0).toBeGreaterThanOrEqual(0.25 * 6 * 200 * 100 * 1e-6 - 1e-9);
    // Stable: the copy cost measured again at the new scale does not undo the cap.
    frames(600);
    const t = list[1]?.getStats().shared;
    expect(t?.scale).toBe(s?.scale);
    expect(t?.reducers.copyBudget).toBe(s?.reducers.copyBudget);
  });

  it('a per-call copy cost (worse per pixel on smaller regions) still settles', () => {
    // 1.5 ms per drawImage whatever its size.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    copyCost = () => {
      clock += 1.5;
    };
    const list = crowd(6);
    frames(500);
    const a = list[1]?.getStats().shared;
    frames(600);
    const b = list[1]?.getStats().shared;
    expect(b?.reducers.level).toBe(a?.reducers.level);
    expect(b?.scale).toBe(a?.scale);
    expect(b?.reducers.copyBudget).toBe(a?.reducers.copyBudget);
  });
});

describe('display refresh calibration (hold)', () => {
  beforeEach(() => {
    resetRuntimeForTesting(true);
  });

  it('the first draws of the page wait for a few quiet frames, then the refresh is known', () => {
    const pl = create();
    let n = 0;
    while (!log.some((l) => l.startsWith('draw')) && n < 40) {
      frame();
      n++;
    }
    // The context is created at once (its frame is busy); the frames after it are quiet until
    // CADENCE_MIN_SAMPLES clean deltas are in (at most HOLD_MAX_FRAMES).
    expect(FakeDevice.instances).toHaveLength(1);
    expect(n).toBeGreaterThanOrEqual(CADENCE_MIN_SAMPLES + 2);
    expect(n).toBeLessThanOrEqual(HOLD_MAX_FRAMES + 3);
    expect(displayIntervalMs()).toBe(16.67);
    frames(4);
    expect(pl.getStats().state).toBe('live');
    expect(pl.getStats().vsyncMs).toBe(16.67);
  });

  it('a recalibration (resume, display change) holds every instance for a few frames', () => {
    const list = [create(), create()];
    frames(30);
    expect(list.every((pl) => pl.getStats().state === 'live')).toBe(true);
    requestDisplayCalibration();
    const start = log.length;
    frame();
    frame();
    // Held: nothing drawn, nothing copied; the canvases keep their frame.
    expect(log.slice(start)).toEqual([]);
    frames(HOLD_MAX_FRAMES + 2);
    const after = log.length;
    frame();
    expect(log.slice(after).filter((l) => l.startsWith('draw')).length).toBe(2);
  });
});
