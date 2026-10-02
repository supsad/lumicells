/**
 * The engine split without a GPU: GpuDevice + RenderSlot + Surface on a recording fake WebGL2
 * context. What is checked is the command stream: programs compiled once per device, every slot
 * binding its own buffers and textures before its passes (and only when another slot drew in
 * between), the region / scissor / viewport of each surface, the shared region-pixel GLSL,
 * per-slot automaton seeds, render targets created with zero texels (never left to lazy
 * initialization), and the lite pipeline (fewer glow passes, the same blur).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { mulberry32 } from '../src/core/controller/math';
import { GpuDevice } from '../src/core/engine/device';
import { Engine } from '../src/core/engine/engine';
import { gaussianTaps, liteHazeSigma, MAX_TAPS } from '../src/core/engine/passes/bloom';
import {
  BIND_FRAME,
  BIND_PARAMS,
  UNIT_FIELD_A,
  UNIT_FIELD_B,
  UNIT_GLOW,
  UNIT_HAZE,
  UNIT_LUT,
  UNIT_STAMP_A,
  UNIT_STAMP_B,
} from '../src/core/engine/passes/shared';
import { REGION_PIXEL_GLSL } from '../src/core/engine/region';
import { declaredParamVec4, paramsFloatCount } from '../src/core/engine/resources';
import type { RenderSlot } from '../src/core/engine/slot';
import { OwnSurface, RegionSurface } from '../src/core/engine/surface';
import { EngineError, type FrameInputs } from '../src/core/engine/types';
import { CACHED_LINK_MS, gpuBusy, resetWarmupForTesting } from '../src/core/engine/warmup';

type Call = [name: string, ...args: unknown[]];

interface FakeGL {
  gl: WebGL2RenderingContext;
  calls: Call[];
  /**
   * Calls that wait for the GPU process in a browser (status queries, program info, framebuffer
   * checks), with the call index they came after.
   */
  syncCalls: string[];
  canvas: HTMLCanvasElement;
  /** Makes createBuffer return null from now on (resource failure). */
  failBuffers(): void;
  /**
   * Loses the context: isContextLost() turns true and 'webglcontextlost' fires (`event` false:
   * not yet, as between a loss and the dispatch of its event).
   */
  lose(event?: boolean): void;
  /** Signals every fence created so far (with `fences`; otherwise fenceSync returns null). */
  signal(): void;
  /** Completes every link (with `linkPending`; otherwise links complete at once). */
  complete(): void;
}

interface FakeOptions {
  /** RENDERER string (caps: 'Direct3D11' turns on the MRT pad and the staged field). */
  renderer?: string;
  /** fenceSync returns fences that signal on signal() only. */
  fences?: boolean;
  /** Links report COMPLETION_STATUS false until complete(). */
  linkPending?: boolean;
  /**
   * Links report COMPLETION_STATUS false until this long after linkProgram (performance.now:
   * fake timers advance it). Without it, links are done at once, as from the program cache.
   */
  linkMs?: number;
}

const PARAMS: Record<string, unknown> = {
  MAX_TEXTURE_SIZE: 8192,
  MAX_RENDERBUFFER_SIZE: 8192,
  MAX_VIEWPORT_DIMS: [8192, 8192],
  MAX_DRAW_BUFFERS: 8,
  MAX_UNIFORM_BLOCK_SIZE: 65536,
  RENDERER: 'Fake GPU',
};

/**
 * A WebGL2 context that accepts every call and records it. Constants are distinct numbers per
 * name; create* return fresh objects; status queries succeed; uniform locations are
 * `{ name }` so uniform uploads can be told apart. The drawing buffer follows the canvas size
 * unless `fixed` is given.
 */
function fakeGL(fixed?: { width: number; height: number }, opts: FakeOptions = {}): FakeGL {
  const calls: Call[] = [];
  const syncCalls: string[] = [];
  const fences: unknown[] = [];
  const signaled = new Set<unknown>();
  const constants = new Map<string, number>();
  const names = new Map<number, string>();
  let nextId = 0;
  let buffersFail = false;
  let lost = false;
  let linksDone = !opts.linkPending;
  const linkedAt = new Map<unknown, number>();
  const constant = (name: string): number => {
    let v = constants.get(name);
    if (v === undefined) {
      v = 0x10000 + constants.size;
      constants.set(name, v);
      names.set(v, name);
    }
    return v;
  };
  const listeners = new Map<string, unknown>();
  const canvas = {
    width: 300,
    height: 150,
    getContext: () => gl,
    addEventListener: (type: string, fn: unknown) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const base: Record<string, unknown> = {
    get drawingBufferWidth() {
      return fixed?.width ?? canvas.width;
    },
    get drawingBufferHeight() {
      return fixed?.height ?? canvas.height;
    },
    isContextLost: () => lost,
    getExtension: (name: string) =>
      name === 'EXT_color_buffer_float'
        ? {}
        : name === 'KHR_parallel_shader_compile'
          ? { COMPLETION_STATUS_KHR: constant('COMPLETION_STATUS_KHR') }
          : null,
    getParameter: (p: number) => {
      const name = names.get(p) ?? '';
      if (name === 'RENDERER' && opts.renderer) return opts.renderer;
      return PARAMS[name] ?? 0;
    },
    checkFramebufferStatus: () => {
      syncCalls.push('checkFramebufferStatus');
      return constant('FRAMEBUFFER_COMPLETE');
    },
    getProgramParameter: (p: unknown, pname: number) => {
      // COMPLETION_STATUS is answered without a round trip; LINK_STATUS waits for the link.
      if (names.get(pname) !== 'COMPLETION_STATUS_KHR') syncCalls.push('getProgramParameter');
      else return linksDone && performance.now() - (linkedAt.get(p) ?? 0) >= (opts.linkMs ?? 0);
      return true;
    },
    linkProgram: (p: unknown) => {
      calls.push(['linkProgram', p]);
      linkedAt.set(p, performance.now());
    },
    getShaderParameter: () => true,
    getUniformLocation: (_p: unknown, name: string) => {
      syncCalls.push('getUniformLocation');
      return { name };
    },
    getUniformBlockIndex: () => {
      syncCalls.push('getUniformBlockIndex');
      return 0;
    },
    fenceSync: () => {
      calls.push(['fenceSync']);
      if (!opts.fences) return null;
      const f = { id: ++nextId, kind: 'sync' };
      fences.push(f);
      return f;
    },
    getSyncParameter: (f: unknown) =>
      signaled.has(f) ? constant('SIGNALED') : constant('UNSIGNALED'),
    createBuffer: () => {
      calls.push(['createBuffer']);
      return buffersFail ? null : { id: ++nextId, kind: 'buffer' };
    },
  };
  const gl = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return constant(prop);
      return (...args: unknown[]) => {
        calls.push([prop, ...args]);
        return prop.startsWith('create') ? { id: ++nextId, kind: prop } : undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    syncCalls,
    canvas: canvas as unknown as HTMLCanvasElement,
    signal: () => {
      for (const f of fences) signaled.add(f);
    },
    complete: () => {
      linksDone = true;
    },
    failBuffers: () => {
      buffersFail = true;
    },
    lose: (event = true) => {
      lost = true;
      if (event) (listeners.get('webglcontextlost') as (() => void) | undefined)?.();
    },
  };
}

const C = (fake: FakeGL, name: string) => (fake.gl as unknown as Record<string, number>)[name];

function controller(seed: number, host: [number, number], preset = 'reference'): Controller {
  const c = new Controller({
    random: mulberry32(seed),
    config: { extends: preset } as never,
  });
  c.setViewport({ hostCssW: host[0], hostCssH: host[1], dpr: 1, deviceW: 0, deviceH: 0 });
  return c;
}

function linkedDevice(fake: FakeGL, prelude: string): GpuDevice {
  const device = new GpuDevice(fake.canvas, { opaque: false, paramsPrelude: prelude });
  expect(device.poll()).toBe(true);
  return device;
}

function slotFor(device: GpuDevice, c: Controller): RenderSlot {
  return device.createSlot({
    paramsPrelude: c.layout.glslPrelude,
    paramsVec4Count: c.layout.vec4Count,
  });
}

/** Calls recorded while `fn` runs. */
function record(fake: FakeGL, fn: () => void): Call[] {
  const start = fake.calls.length;
  fn();
  return fake.calls.slice(start);
}

function frame(c: Controller): FrameInputs {
  const f = c.update(1 / 60, 0);
  return f;
}

/**
 * Compiles and warms up the field variants the slots' looks need (see field-variants.ts), so
 * the calls recorded afterwards are the slots' frames alone.
 */
function warmFields(device: GpuDevice, pairs: [RenderSlot, Controller][]): void {
  for (const [slot, c] of pairs) slot.prepare(c.update(0, 0));
  device.progress();
}

const named = (calls: Call[], name: string) => calls.filter((c) => c[0] === name);
const uniforms = (calls: Call[], uniform: string) =>
  calls.filter((c) => (c[1] as { name?: string } | undefined)?.name === uniform);
/** Distinct u_region values uploaded (by the composite and the lift program). */
const regionUploads = (calls: Call[]) => {
  const seen = new Map<string, unknown[]>();
  for (const c of uniforms(calls, 'u_region')) seen.set(JSON.stringify(c.slice(2)), c.slice(2));
  return [...seen.values()];
};

/** The per-slot texture units every slot rebinds on bind() (see RenderSlot.bind). */
const SLOT_UNITS = {
  lut: UNIT_LUT,
  fieldA: UNIT_FIELD_A,
  fieldB: UNIT_FIELD_B,
  glow: UNIT_GLOW,
  haze: UNIT_HAZE,
  stampA: UNIT_STAMP_A,
  stampB: UNIT_STAMP_B,
} as const;
type SlotUnits = Record<keyof typeof SLOT_UNITS, number | undefined>;

const texId = (t: unknown) => (t as { id?: number } | null)?.id;

/**
 * Replays activeTexture / bindTexture(TEXTURE_2D) over the first `end` recorded calls and
 * returns the texture id bound on each slot unit at that point.
 */
function unitsAt(fake: FakeGL, end: number): SlotUnits {
  const texture0 = C(fake, 'TEXTURE0') ?? 0;
  const bound = new Map<number, number | undefined>();
  let active = 0;
  for (let i = 0; i < end; i++) {
    const c = fake.calls[i] as Call;
    if (c[0] === 'activeTexture') active = (c[1] as number) - texture0;
    else if (c[0] === 'bindTexture') bound.set(active, texId(c[2]));
  }
  const out = {} as SlotUnits;
  for (const [k, unit] of Object.entries(SLOT_UNITS)) {
    out[k as keyof SlotUnits] = bound.get(unit);
  }
  return out;
}

/** The slot's own textures for the same units (read from its private fields). */
function slotTextures(slot: RenderSlot): SlotUnits {
  const s = slot as unknown as {
    lutTex: unknown;
    res: { fieldA: unknown; fieldB: unknown; glow: { tex: unknown }; haze: { tex: unknown } };
    stamp: { texA: unknown; texB: unknown };
  };
  return {
    lut: texId(s.lutTex),
    fieldA: texId(s.res.fieldA),
    fieldB: texId(s.res.fieldB),
    glow: texId(s.res.glow.tex),
    haze: texId(s.res.haze.tex),
    stampA: texId(s.stamp.texA),
    stampB: texId(s.stamp.texB),
  };
}

interface TargetUpload {
  tex: unknown;
  /** The texImage2D call that defined the texture last (undefined: never defined). */
  upload: Call | undefined;
}

/**
 * Every texture attached to a framebuffer from call index `from` on, with the texImage2D that
 * defined it (replaying activeTexture / bindTexture over all recorded calls to know which
 * texture each texImage2D went to).
 */
function attachedTargets(fake: FakeGL, from: number): TargetUpload[] {
  const texture0 = C(fake, 'TEXTURE0') ?? 0;
  const bound = new Map<number, unknown>();
  const defined = new Map<unknown, Call>();
  const attached = new Set<unknown>();
  let active = 0;
  fake.calls.forEach((c, i) => {
    if (c[0] === 'activeTexture') active = (c[1] as number) - texture0;
    else if (c[0] === 'bindTexture') bound.set(active, c[2]);
    else if (c[0] === 'texImage2D') defined.set(bound.get(active), c);
    else if (c[0] === 'framebufferTexture2D' && i >= from && c[4]) attached.add(c[4]);
  });
  return [...attached].map((tex) => ({ tex, upload: defined.get(tex) }));
}

/**
 * Why an upload does not give its texture zero contents of the right shape (null when it does):
 * a typed array matching the component type, one element per component of every texel, all 0.
 */
function zeroUploadProblem(fake: FakeGL, upload: Call | undefined): string | null {
  if (!upload) return 'never defined';
  const [, , , , w, h, , format, type, data] = upload as [string, ...unknown[]];
  if (!ArrayBuffer.isView(data)) return 'no data: left to lazy initialization';
  const channels = format === C(fake, 'RGBA') ? 4 : format === C(fake, 'RGB') ? 3 : 0;
  const ctor =
    type === C(fake, 'HALF_FLOAT')
      ? Uint16Array
      : type === C(fake, 'UNSIGNED_BYTE')
        ? Uint8Array
        : type === C(fake, 'FLOAT')
          ? Float32Array
          : null;
  if (!ctor || !(data instanceof ctor)) return `data ${data.constructor.name} for type ${type}`;
  const view = data as Uint8Array | Uint16Array | Float32Array;
  if (view.length !== (w as number) * (h as number) * channels) {
    return `${view.length} elements for ${w}x${h}x${channels}`;
  }
  return view.every((v) => v === 0) ? null : 'not zero';
}

describe('params buffer sizing', () => {
  it('reads the declared ParamsBlock size from the prelude', () => {
    expect(declaredParamVec4('layout(std140) uniform ParamsBlock { vec4 u_p[ 23 ]; };')).toBe(23);
    expect(declaredParamVec4('#define P_grid_gap 0.3')).toBe(0);
  });

  it('holds at least the declared block, the uploaded floats and one vec4', () => {
    expect(paramsFloatCount(23, 20)).toBe(92);
    expect(paramsFloatCount(0, 20)).toBe(80);
    expect(paramsFloatCount(0, 0)).toBe(4);
    expect(paramsFloatCount(0, Number.NaN)).toBe(4);
    expect(paramsFloatCount(2, 3.7)).toBe(12);
  });
});

describe('GpuDevice', () => {
  it('compiles every program once per device, however many slots it serves', () => {
    const fake = fakeGL();
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    // Every pass but the field, whose variants compile when a slot needs one (the stamp has two
    // single-output programs).
    const programs = named(fake.calls, 'createProgram').length;
    expect(programs).toBe(10);
    const during = record(fake, () => {
      for (let i = 0; i < 4; i++) slotFor(device, c);
    });
    expect(named(during, 'createProgram')).toHaveLength(0);
    expect(named(during, 'compileShader')).toHaveLength(0);
    expect(device.slotCount).toBe(4);
    // The first frame of the look compiles its field variant; other slots of that look reuse it.
    const slots = [slotFor(device, c), slotFor(device, c)];
    const first = record(fake, () => slots[0]?.draw(frame(c), new RegionSurface(device, 0, 0)));
    expect(named(first, 'createProgram')).toHaveLength(1);
    const second = record(fake, () => slots[1]?.draw(frame(c), new RegionSurface(device, 0, 0)));
    expect(named(second, 'createProgram')).toHaveLength(0);
  });

  it('the composite and lift shaders take the region-local pixel from REGION_PIXEL_GLSL', () => {
    const fake = fakeGL();
    const c = controller(1, [200, 120]);
    linkedDevice(fake, c.layout.glslPrelude);
    const sources = named(fake.calls, 'shaderSource').map((x) => x[2] as string);
    // Every fragment shader that places gl_FragCoord inside u_region: composite and lift.
    const regional = sources.filter((src) => /\bu_region\b/.test(src) && /gl_FragCoord/.test(src));
    expect(regional).toHaveLength(2);
    for (const src of regional) {
      expect(src).toContain(`vec2 px = ${REGION_PIXEL_GLSL};`);
      // No other y flip of gl_FragCoord that could disagree with the shared expression.
      expect(src.split(REGION_PIXEL_GLSL).join('')).not.toMatch(/gl_FragCoord\.y/);
    }
  });

  it('every controller of the page shares one ParamLayout, so one prelude serves all slots', () => {
    const a = controller(1, [200, 120]);
    const b = controller(2, [90, 300], 'orb');
    expect(a.layout).toBe(b.layout);
    expect(a.layout.glslPrelude).toBe(b.layout.glslPrelude);
  });

  it('refuses a slot whose params prelude is not the device one', () => {
    const fake = fakeGL();
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    expect(() =>
      device.createSlot({ paramsPrelude: `${c.layout.glslPrelude}\n// other`, paramsVec4Count: 4 }),
    ).toThrow(EngineError);
  });

  it('dispose() disposes the slots still alive', () => {
    const fake = fakeGL();
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    const a = slotFor(device, c);
    slotFor(device, c);
    a.dispose();
    expect(device.slotCount).toBe(1);
    device.dispose();
    expect(device.slotCount).toBe(0);
    expect(device.passes).toBeNull();
    expect(() => slotFor(device, c)).toThrow(EngineError);
    expect(device.poll()).toBe(false);
  });

  it('poll() turns false for good on a context lost after linking, and refuses new slots', () => {
    const fake = fakeGL({ width: 1024, height: 512 });
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    const slot = slotFor(device, c);
    expect(slot.draw(frame(c), new OwnSurface(device))).toBe(true);
    fake.lose();
    expect(device.isLinked).toBe(true);
    expect(device.isContextLost()).toBe(true);
    expect(device.poll()).toBe(false);
    expect(() => slotFor(device, c)).toThrow(EngineError);
    // A lost device never counts a frame as drawn, whatever the surface, and issues no draws.
    const calls = record(fake, () => {
      expect(slot.draw(frame(c), new OwnSurface(device))).toBe(false);
      expect(slot.draw(frame(c), new RegionSurface(device, 0, 0))).toBe(false);
    });
    expect(named(calls, 'drawArrays')).toHaveLength(0);
    expect(named(calls, 'bufferSubData')).toHaveLength(0);
    device.dispose();
    expect(device.poll()).toBe(false);
  });
});

describe('RenderSlot', () => {
  it('binds its own uniform buffers before its passes, only when another slot drew since', () => {
    const fake = fakeGL({ width: 1024, height: 512 });
    const ca = controller(1, [200, 120]);
    const cb = controller(2, [160, 160], 'orb');
    const device = linkedDevice(fake, ca.layout.glslPrelude);
    const a = slotFor(device, ca);
    const b = slotFor(device, cb);
    const sa = new RegionSurface(device, 0, 0);
    const sb = new RegionSurface(device, 400, 0);
    const bases = (calls: Call[]) =>
      named(calls, 'bindBufferBase').map((c) => [c[2], (c[3] as { id: number }).id]);
    warmFields(device, [
      [a, ca],
      [b, cb],
    ]);

    const a1 = record(fake, () => a.draw(frame(ca), sa));
    const b1 = record(fake, () => b.draw(frame(cb), sb));
    const a2 = record(fake, () => a.draw(frame(ca), sa));
    const a3 = record(fake, () => a.draw(frame(ca), sa));

    expect(bases(a1)).toHaveLength(2);
    expect(bases(b1)).toHaveLength(2);
    expect(bases(a2)).toEqual(bases(a1));
    expect(bases(b1)).not.toEqual(bases(a1));
    // The same slot twice in a row: nothing to rebind.
    expect(bases(a3)).toEqual([]);
    expect(bases(a1).map((x) => x[0])).toEqual([BIND_PARAMS, BIND_FRAME]);
    // Bound before the first draw call of the slot.
    const firstDraw = a2.findIndex((c) => c[0] === 'drawArrays');
    const lastBase = a2.map((c) => c[0]).lastIndexOf('bindBufferBase');
    expect(lastBase).toBeGreaterThanOrEqual(0);
    expect(lastBase).toBeLessThan(firstDraw);
  });

  it('binds its own textures to every slot unit before its passes, and back after another slot', () => {
    const fake = fakeGL({ width: 1024, height: 512 });
    const ca = controller(1, [200, 120]);
    const cb = controller(2, [160, 160], 'orb');
    const device = linkedDevice(fake, ca.layout.glslPrelude);
    const a = slotFor(device, ca);
    const b = slotFor(device, cb);
    const sa = new RegionSurface(device, 0, 0);
    const sb = new RegionSurface(device, 400, 0);
    /** Unit contents at the slot's composite draw (the last drawArrays of its frame). */
    const drawAt = (slot: RenderSlot, c: Controller, surface: RegionSurface) => {
      const start = fake.calls.length;
      expect(slot.draw(frame(c), surface)).toBe(true);
      // Committed, so later frames re-upload nothing (no LUT upload rebinding UNIT_LUT for it).
      c.commitFrame();
      const composite = fake.calls.map((x) => x[0]).lastIndexOf('drawArrays');
      expect(composite).toBeGreaterThanOrEqual(start);
      return unitsAt(fake, composite);
    };
    const units = [
      drawAt(a, ca, sa),
      drawAt(b, cb, sb),
      // Second frames: no target (re)allocation and no upload binds anything for them.
      drawAt(a, ca, sa),
      drawAt(b, cb, sb),
    ];
    const ownA = slotTextures(a);
    const ownB = slotTextures(b);
    for (const own of [ownA, ownB]) {
      for (const id of Object.values(own)) expect(id).toBeTypeOf('number');
    }
    // Every unit holds a texture of its own per slot: nothing shared between A and B.
    const idsA = new Set(Object.values(ownA));
    for (const id of Object.values(ownB)) expect(idsA.has(id)).toBe(false);
    expect(units).toEqual([ownA, ownB, ownA, ownB]);
  });

  // Regression (ANGLE/D3D11 on NVIDIA, see createTargetTexture): a framebuffer whose attachments
  // were all lazily initialized by a clear right before its first draw intermittently lost that
  // draw's COLOR_ATTACHMENT1, which left the cell stamp's halo layer empty for good. No render
  // target may rely on lazy initialization: each one is uploaded zero texels when it is created.
  it.each([
    ['float targets', false],
    ['RGBA8 targets', true],
  ])('creates every render target with zero texels (%s), on reallocation too', (_, rgba8) => {
    const fake = fakeGL({ width: 2048, height: 1024 });
    const c = controller(1, [200, 120]);
    const device = new GpuDevice(fake.canvas, {
      opaque: false,
      paramsPrelude: c.layout.glslPrelude,
      forceRgba8: rgba8,
    });
    expect(device.poll()).toBe(true);
    const slot = slotFor(device, c);
    const surface = new RegionSurface(device, 0, 0);
    const from = fake.calls.length;
    expect(slot.draw(frame(c), surface)).toBe(true);
    c.commitFrame();
    // Fields A and B, the bloom source and its scratch, glow, 2 life, haze and its scratch, and
    // the stamp pair.
    const first = attachedTargets(fake, from);
    expect(first.length).toBeGreaterThanOrEqual(11);
    // A host 4x wider has 4x the columns at the same pitch: every cell target and the haze pair
    // outgrow their buckets and are allocated again.
    c.setViewport({ hostCssW: 800, hostCssH: 120, dpr: 1, deviceW: 0, deviceH: 0 });
    const again = fake.calls.length;
    expect(slot.draw(frame(c), surface)).toBe(true);
    const realloc = attachedTargets(fake, again);
    expect(realloc.length).toBeGreaterThanOrEqual(9);
    for (const t of [...first, ...realloc]) {
      expect(zeroUploadProblem(fake, t.upload), `texture ${texId(t.tex)}`).toBeNull();
    }
  });

  it('keeps its own params and LUT uploads: another slot never clears its dirty state', () => {
    const fake = fakeGL({ width: 1024, height: 512 });
    const ca = controller(1, [200, 120]);
    const cb = controller(2, [160, 160], 'orb');
    const device = linkedDevice(fake, ca.layout.glslPrelude);
    const a = slotFor(device, ca);
    const b = slotFor(device, cb);
    const sa = new RegionSurface(device, 0, 0);
    const sb = new RegionSurface(device, 400, 0);
    const texUploads = (calls: Call[]) => named(calls, 'texSubImage2D').length;
    const first = record(fake, () => {
      a.draw(frame(ca), sa);
      ca.commitFrame();
    });
    expect(texUploads(first)).toBe(1);
    // B's first frame uploads B's LUT; A's next frame has nothing new to upload.
    const second = record(fake, () => {
      b.draw(frame(cb), sb);
      cb.commitFrame();
    });
    expect(texUploads(second)).toBe(1);
    const third = record(fake, () => {
      a.draw(frame(ca), sa);
      ca.commitFrame();
    });
    expect(texUploads(third)).toBe(0);
  });

  it('seeds its automaton runs independently of the other slots on the device', () => {
    const seeds = (calls: Call[]) => uniforms(calls, 'u_seed').map((c) => c[2]);
    // A lone slot...
    const lone = fakeGL({ width: 1024, height: 512 });
    const c1 = controller(1, [200, 120], 'life');
    const d1 = linkedDevice(lone, c1.layout.glslPrelude);
    const s1 = slotFor(d1, c1);
    const surf1 = new RegionSurface(d1, 0, 0);
    const alone: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      alone.push(...seeds(record(lone, () => s1.draw(frame(c1), surf1))));
      c1.commitFrame();
    }
    // ...and the same slot interleaved with another one.
    const shared = fakeGL({ width: 1024, height: 512 });
    const c2 = controller(1, [200, 120], 'life');
    const other = controller(9, [120, 200], 'life');
    const d2 = linkedDevice(shared, c2.layout.glslPrelude);
    const s2 = slotFor(d2, c2);
    const so = slotFor(d2, other);
    const surf2 = new RegionSurface(d2, 0, 0);
    const surfO = new RegionSurface(d2, 300, 0);
    const interleaved: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      so.draw(frame(other), surfO);
      other.commitFrame();
      interleaved.push(...seeds(record(shared, () => s2.draw(frame(c2), surf2))));
      c2.commitFrame();
    }
    expect(alone.length).toBeGreaterThan(2);
    expect(interleaved).toEqual(alone);
  });

  it('draws the own surface over the whole drawing buffer without a scissor', () => {
    const fake = fakeGL();
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    const slot = slotFor(device, c);
    const f = frame(c);
    const calls = record(fake, () => slot.draw(f, new OwnSurface(device)));
    expect(fake.canvas.width).toBe(f.canvasWidth);
    expect(fake.canvas.height).toBe(f.canvasHeight);
    const scissor = C(fake, 'SCISSOR_TEST');
    expect(calls.filter((x) => x[0] === 'enable' && x[1] === scissor)).toHaveLength(0);
    // Composite (and lift, when lifts are up) programs: the whole drawing buffer.
    expect(regionUploads(calls)).toEqual([[0, 0, f.canvasWidth, f.canvasHeight]]);
    const vp = named(calls, 'viewport').at(-1);
    expect(vp?.slice(1)).toEqual([0, 0, f.canvasWidth, f.canvasHeight]);
  });

  it('draws a region surface into its rect only: viewport, scissor and u_region', () => {
    const fake = fakeGL({ width: 800, height: 400 });
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    const slot = slotFor(device, c);
    const f = frame(c);
    const left = 37;
    const top = 21;
    const y = 400 - top - f.canvasHeight;
    const rect = [left, y, f.canvasWidth, f.canvasHeight];
    const calls = record(fake, () => slot.draw(f, new RegionSurface(device, left, top)));
    const scissor = C(fake, 'SCISSOR_TEST');
    const on = calls.findIndex((x) => x[0] === 'enable' && x[1] === scissor);
    const off = calls.findIndex((x) => x[0] === 'disable' && x[1] === scissor);
    const composite = calls.map((x) => x[0]).lastIndexOf('drawArrays');
    expect(on).toBeGreaterThanOrEqual(0);
    expect(on).toBeLessThan(composite);
    expect(off).toBeGreaterThan(composite);
    expect(named(calls, 'scissor').map((x) => x.slice(1))).toEqual([rect]);
    expect(named(calls, 'viewport').at(-1)?.slice(1)).toEqual(rect);
    expect(regionUploads(calls)).toEqual([rect]);
    // Clipped to the framebuffer when the region spills over its edge.
    const edge = record(fake, () => slot.draw(frame(c), new RegionSurface(device, 700, -10)));
    const [sx, sy, sw, sh] = (named(edge, 'scissor')[0]?.slice(1) ?? []) as number[];
    expect(sx).toBe(700);
    expect((sx ?? 0) + (sw ?? 0)).toBe(800);
    expect((sy ?? 0) + (sh ?? 0)).toBe(400);
  });

  it('draws nothing into a region that lies outside the canvas', () => {
    const fake = fakeGL({ width: 200, height: 100 });
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    const slot = slotFor(device, c);
    warmFields(device, [[slot, c]]);
    let drawn = true;
    const calls = record(fake, () => {
      drawn = slot.draw(frame(c), new RegionSurface(device, 500, 0));
    });
    expect(drawn).toBe(false);
    expect(named(calls, 'drawArrays')).toHaveLength(0);
  });

  it('rebinds the lift vertex array only when another slot drew lifts', () => {
    const fake = fakeGL({ width: 1024, height: 512 });
    const ca = controller(1, [200, 120]);
    const cb = controller(2, [200, 120]);
    const device = linkedDevice(fake, ca.layout.glslPrelude);
    const a = slotFor(device, ca);
    const b = slotFor(device, cb);
    const sa = new RegionSurface(device, 0, 0);
    const sb = new RegionSurface(device, 300, 0);
    const withLifts = (c: Controller) => {
      const f = frame(c);
      f.liftCount = 2;
      return f;
    };
    const pointers = (calls: Call[]) => named(calls, 'vertexAttribPointer').length;
    expect(pointers(record(fake, () => a.draw(withLifts(ca), sa)))).toBe(3);
    expect(pointers(record(fake, () => a.draw(withLifts(ca), sa)))).toBe(0);
    expect(pointers(record(fake, () => b.draw(withLifts(cb), sb)))).toBe(3);
    // A disposed slot's buffer is forgotten: the next slot re-points the array.
    b.dispose();
    expect(pointers(record(fake, () => a.draw(withLifts(ca), sa)))).toBe(3);
  });
});

describe('Engine (device + one slot + own surface)', () => {
  it('draws once linked, like before the split', () => {
    const fake = fakeGL();
    const c = controller(1, [200, 120]);
    const engine = new Engine(fake.canvas, {
      opaque: true,
      paramsPrelude: c.layout.glslPrelude,
      paramsVec4Count: c.layout.vec4Count,
      warnMissingParams: false,
    });
    expect(engine.ready).toBe(false);
    expect(engine.poll()).toBe(true);
    expect(engine.render(frame(c))).toBe(true);
    expect(engine.ready).toBe(true);
    expect(engine.error).toBeNull();
    engine.dispose();
    expect(engine.ready).toBe(false);
    expect(engine.render(frame(c))).toBe(false);
  });

  it('reports a resource failure through onError once and draws nothing', () => {
    const fake = fakeGL();
    const c = controller(1, [200, 120]);
    fake.failBuffers();
    const onError = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = new Engine(fake.canvas, {
      opaque: true,
      paramsPrelude: c.layout.glslPrelude,
      paramsVec4Count: c.layout.vec4Count,
      warnMissingParams: false,
      onError,
    });
    error.mockRestore();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as EngineError | undefined)?.code).toBe('resource');
    expect(engine.error).toBeInstanceOf(EngineError);
    expect(engine.render(frame(c))).toBe(false);
    engine.dispose();
  });
});

describe('lite pipeline', () => {
  it('runs 2 glow passes instead of 5, with the combine program switched by u_lite', () => {
    const fake = fakeGL({ width: 1024, height: 512 });
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    const slot = slotFor(device, c);
    const surface = new RegionSurface(device, 0, 0);
    const draw = (lite: boolean) =>
      record(fake, () => {
        const f = frame(c);
        f.lite = lite;
        f.lifeSteps = 0;
        slot.draw(f, surface);
      });
    draw(false); // first frame: allocations, life reset, stamp bake
    const full = draw(false);
    const lite = draw(true);
    const again = draw(true);
    const back = draw(false);
    expect(named(full, 'drawArrays').length - named(lite, 'drawArrays').length).toBe(3);
    expect(named(back, 'drawArrays').length).toBe(named(full, 'drawArrays').length);
    // u_lite is uploaded only when it changes.
    const flag = (calls: Call[]) => uniforms(calls, 'u_lite').map((x) => x[2]);
    expect(flag(lite)).toEqual([1]);
    expect(flag(again)).toEqual([]);
    expect(flag(back)).toEqual([0]);
  });

  it('the 2-D kernels: folded taps blur both axes at once exactly like two 1-D passes', () => {
    // A lit cell on a 32 x 32 grid, the bloom kernel of the default radius.
    const N = 32;
    const img = new Float64Array(N * N);
    img[16 * N + 15] = 1;
    img[9 * N + 20] = 0.5;
    const taps = new Float32Array(MAX_TAPS * 2);
    const count = gaussianTaps(1.3, taps);
    const at = (x: number, y: number) => {
      // Bilinear with clamping to texel centers, like texBilinear.
      const cx = Math.min(Math.max(x, 0), N - 1);
      const cy = Math.min(Math.max(y, 0), N - 1);
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const fx = cx - x0;
      const fy = cy - y0;
      const x1 = Math.min(x0 + 1, N - 1);
      const y1 = Math.min(y0 + 1, N - 1);
      const v = (i: number, j: number) => img[j * N + i] as number;
      return (
        (v(x0, y0) * (1 - fx) + v(x1, y0) * fx) * (1 - fy) +
        (v(x0, y1) * (1 - fx) + v(x1, y1) * fx) * fy
      );
    };
    const tap = (k: number): [number, number] => {
      const i = (k + 1) >> 1;
      const o = taps[i * 2] as number;
      return [k & 1 ? o : -o, taps[i * 2 + 1] as number];
    };
    const n = 2 * count - 1;
    // Two passes: x into a temporary grid, then y over it.
    const tmp = new Float64Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let acc = 0;
        for (let k = 0; k < n; k++) {
          const [o, w] = tap(k);
          acc += at(x + o, y) * w;
        }
        tmp[y * N + x] = acc;
      }
    }
    let maxErr = 0;
    let sum = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let twoPass = 0;
        for (let k = 0; k < n; k++) {
          const [o, w] = tap(k);
          const yy = Math.min(Math.max(y + o, 0), N - 1);
          const y0 = Math.floor(yy);
          const f = yy - y0;
          const y1 = Math.min(y0 + 1, N - 1);
          twoPass += ((tmp[y0 * N + x] as number) * (1 - f) + (tmp[y1 * N + x] as number) * f) * w;
        }
        // One pass, as the lite combine does it.
        let onePass = 0;
        for (let j = 0; j < n; j++) {
          const [oy, wy] = tap(j);
          for (let i = 0; i < n; i++) {
            const [ox, wx] = tap(i);
            onePass += at(x + ox, y + oy) * wx * wy;
          }
        }
        maxErr = Math.max(maxErr, Math.abs(onePass - twoPass));
        sum += onePass;
      }
    }
    expect(maxErr).toBeLessThan(1e-6);
    expect(sum).toBeCloseTo(1.5, 4);
  });

  it('widens the lite haze kernel by the difference between B-spline and bilinear sampling', () => {
    // Variance: (sigma/4)^2 + 1/3 (blur, then B-spline) == lite^2 + 1/6 (bilinear, then blur).
    for (const sigma of [2, 4, 12]) {
      const q = sigma / 4;
      expect(liteHazeSigma(sigma) ** 2 + 1 / 6).toBeCloseTo(q * q + 1 / 3, 9);
    }
  });
});

afterEach(() => {
  resetWarmupForTesting();
});

const D3D = 'ANGLE (NVIDIA, NVIDIA GeForce RTX (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)';

describe('start-up warm-ups', () => {
  /** Link time of a compile that does not come from the program cache, ms. */
  const LINK = CACHED_LINK_MS + 100;
  const compiled = () => vi.advanceTimersByTime(LINK);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws every program once into 1x1 scratch targets before reporting the device linked', () => {
    const fake = fakeGL({ width: 640, height: 360 }, { fences: true, linkMs: LINK });
    const c = controller(1, [200, 120]);
    const device = new GpuDevice(fake.canvas, {
      opaque: false,
      paramsPrelude: c.layout.glslPrelude,
    });
    expect(device.poll()).toBe(false);
    compiled();
    const first = record(fake, () => expect(device.poll()).toBe(false));
    // One draw per program (life, 5 glow, composite, 2 stamp, lift), then a fence.
    expect(named(first, 'drawArrays')).toHaveLength(9);
    expect(named(first, 'drawArraysInstanced')).toHaveLength(1);
    expect(named(first, 'fenceSync')).toHaveLength(1);
    expect(named(first, 'viewport').every((v) => v[3] === 1 && v[4] === 1)).toBe(true);
    // Scratch textures are 1x1 and come with their zero texels.
    expect(named(first, 'texImage2D').every((t) => t[4] === 1 && t[5] === 1)).toBe(true);
    expect(gpuBusy()).toBe(true);
    // Until the fence passes: not linked, and nothing waits on the GPU process.
    const sync = fake.syncCalls.length;
    const waiting = record(fake, () => expect(device.poll()).toBe(false));
    expect(fake.syncCalls.length).toBe(sync);
    expect(named(waiting, 'drawArrays')).toHaveLength(0);
    fake.signal();
    expect(device.poll()).toBe(true);
    expect(gpuBusy()).toBe(false);
  });

  it('a slot draws once its look has a field variant: compiled, warmed, then drawn', () => {
    const fake = fakeGL({ width: 640, height: 360 }, { fences: true, linkMs: LINK });
    const c = controller(1, [200, 120]);
    const device = new GpuDevice(fake.canvas, {
      opaque: false,
      paramsPrelude: c.layout.glslPrelude,
    });
    const slot = slotFor(device, c);
    device.poll();
    compiled();
    device.poll();
    fake.signal();
    expect(device.poll()).toBe(true);
    const f = frame(c);
    const surface = new RegionSurface(device, 0, 0);
    // Requested in this call: nothing drawn until it is compiled and warmed up.
    const requested = record(fake, () => expect(slot.draw(f, surface)).toBe(false));
    expect(named(requested, 'createProgram')).toHaveLength(1);
    expect(named(requested, 'drawArrays')).toHaveLength(0);
    compiled();
    // Linked and warmed up in this call; its fence still pending: nothing drawn.
    const linked = record(fake, () => expect(slot.draw(frame(c), surface)).toBe(false));
    expect(named(linked, 'drawArrays')).toHaveLength(1);
    expect(gpuBusy()).toBe(true);
    fake.signal();
    expect(slot.draw(frame(c), surface)).toBe(true);
  });

  it('tells cache hits by a timer: polls held back for a while (a calibration) change nothing', () => {
    // From the cache: linked at once, found by a poll that comes late.
    const warm = fakeGL(undefined, { fences: true });
    const c = controller(1, [200, 120]);
    const a = new GpuDevice(warm.canvas, { opaque: false, paramsPrelude: c.layout.glslPrelude });
    a.requestField(0);
    vi.advanceTimersByTime(LINK + 100);
    expect(a.poll()).toBe(true);
    expect(named(warm.calls, 'fenceSync')).toHaveLength(0);
    // Compiled: still linking when the timer checks, found linked late too: warmed up.
    const cold = fakeGL(undefined, { fences: true, linkMs: LINK });
    // Another program set (another prelude): not held back by the first device's claim.
    const prelude = `${c.layout.glslPrelude}// b`;
    const b = new GpuDevice(cold.canvas, { opaque: false, paramsPrelude: prelude });
    b.requestField(0);
    vi.advanceTimersByTime(LINK + 100);
    expect(b.poll()).toBe(false);
    expect(named(cold.calls, 'fenceSync').length).toBeGreaterThan(0);
    cold.signal();
    expect(b.poll()).toBe(true);
  });

  it('programs from the browser cache (linked at once) need no warm-up', () => {
    const fake = fakeGL({ width: 640, height: 360 }, { fences: true });
    const c = controller(1, [200, 120]);
    const device = new GpuDevice(fake.canvas, {
      opaque: false,
      paramsPrelude: c.layout.glslPrelude,
    });
    const slot = slotFor(device, c);
    const calls = record(fake, () => {
      expect(device.poll()).toBe(true);
      expect(slot.draw(frame(c), new RegionSurface(device, 0, 0))).toBe(true);
    });
    expect(named(calls, 'fenceSync')).toHaveLength(0);
    expect(gpuBusy()).toBe(false);
  });

  it('while a warm-up compiles, a slot that would allocate or resize waits; one that would not draws', () => {
    const fake = fakeGL(undefined, { fences: true, linkMs: LINK });
    const c = controller(1, [200, 120]);
    const device = new GpuDevice(fake.canvas, {
      opaque: false,
      paramsPrelude: c.layout.glslPrelude,
    });
    const a = slotFor(device, c);
    device.poll();
    compiled();
    device.poll();
    fake.signal();
    device.poll();
    warmFields(device, [[a, c]]);
    compiled();
    device.progress();
    fake.signal();
    const own = new OwnSurface(device);
    expect(a.draw(frame(c), own)).toBe(true);
    // Another look starts compiling: a warm-up fence is pending again.
    const cb = controller(2, [160, 160], 'pulse');
    const b = slotFor(device, cb);
    warmFields(device, [[b, cb]]);
    compiled();
    device.progress();
    expect(gpuBusy()).toBe(true);
    // a: same targets, same canvas size: draws. b (targets to allocate): waits.
    const sync = fake.syncCalls.length;
    expect(a.draw(frame(c), own)).toBe(true);
    expect(b.draw(frame(cb), new RegionSurface(device, 0, 0))).toBe(false);
    // a resized: the canvas resize and the reallocation wait too.
    c.setViewport({ hostCssW: 900, hostCssH: 700, dpr: 1, deviceW: 0, deviceH: 0 });
    const width = fake.canvas.width;
    expect(a.draw(frame(c), own)).toBe(false);
    expect(fake.canvas.width).toBe(width);
    expect(fake.syncCalls.length).toBe(sync);
    fake.signal();
    expect(a.draw(frame(c), own)).toBe(true);
    expect(b.draw(frame(cb), new RegionSurface(device, 0, 0))).toBe(true);
  });

  it('a second device waits with its programs while the first compiles the same ones', () => {
    const fa = fakeGL(undefined, { fences: true, linkPending: true, linkMs: LINK });
    const fb = fakeGL(undefined, { fences: true });
    const c = controller(1, [200, 120]);
    const a = new GpuDevice(fa.canvas, { opaque: false, paramsPrelude: c.layout.glslPrelude });
    const b = new GpuDevice(fb.canvas, { opaque: false, paramsPrelude: c.layout.glslPrelude });
    // Nothing is submitted before the first field request or poll.
    expect(named(fa.calls, 'createProgram')).toHaveLength(0);
    a.requestField(0);
    expect(named(fa.calls, 'createProgram').length).toBeGreaterThan(0);
    b.requestField(0);
    expect(named(fb.calls, 'createProgram')).toHaveLength(0);
    expect(b.poll()).toBe(false);
    expect(named(fb.calls, 'createProgram')).toHaveLength(0);
    // a's programs link. Nobody polls a (its instance moved on): b's polls keep its compile
    // going, and once a's programs are linked (the browser's cache holds them), b submits.
    fa.complete();
    compiled();
    b.poll();
    expect(named(fa.calls, 'fenceSync').length).toBeGreaterThan(0);
    expect(named(fb.calls, 'createProgram').length).toBeGreaterThan(0);
    fa.signal();
    expect(a.poll()).toBe(true);
    b.poll();
    fb.signal();
    expect(b.poll()).toBe(true);
  });

  it('a tween turning a mode on waits for its field variant, requested ahead of time', () => {
    const fake = fakeGL(undefined, { fences: true, linkMs: LINK });
    const c = controller(1, [200, 120]);
    c.setConfig({ modes: { vortex: { weight: 0 } } }, { transition: 0 });
    const device = new GpuDevice(fake.canvas, {
      opaque: false,
      paramsPrelude: c.layout.glslPrelude,
    });
    const slot = slotFor(device, c);
    device.poll();
    compiled();
    device.poll();
    fake.signal();
    device.poll();
    warmFields(device, [[slot, c]]);
    compiled();
    device.progress();
    fake.signal();
    const surface = new RegionSurface(device, 0, 0);
    expect(slot.draw(frame(c), surface)).toBe(true);
    c.setFieldGate((pending) => slot.fieldReady(pending));
    c.setConfig({ modes: { vortex: { weight: 1 } } }, { transition: 600 });
    // The variant with vortex is requested by the first frame; meanwhile the slot draws the look
    // as it was, with its previous variant, and the weight stays at 0.
    const first = record(fake, () => expect(slot.draw(frame(c), surface)).toBe(true));
    expect(named(first, 'createProgram')).toHaveLength(1);
    compiled();
    let frames = 0;
    while (c.getEffective('modes.vortex.weight') === 0 && frames < 10) {
      // As Engine.render: the device polls its compiles every frame.
      device.poll();
      expect(slot.draw(frame(c), surface)).toBe(true);
      fake.signal();
      frames++;
    }
    expect(frames).toBeGreaterThan(1);
    expect(frames).toBeLessThan(10);
    // Released with the variant ready: every frame of the tween draws its mode.
    expect(slot.fieldReady(0)).toBe(true);
    expect(c.getEffective('modes.vortex.weight')).toBeLessThan(0.2);
    expect(slot.prepare(c.update(1 / 60))).toBe(true);
  });

  it('a device whose context is lost while it compiles no longer holds the others back', () => {
    for (const event of [true, false]) {
      resetWarmupForTesting();
      const fa = fakeGL(undefined, { fences: true, linkPending: true, linkMs: LINK });
      const fb = fakeGL(undefined, { fences: true, linkMs: LINK });
      const c = controller(1, [200, 120]);
      const a = new GpuDevice(fa.canvas, { opaque: false, paramsPrelude: c.layout.glslPrelude });
      const b = new GpuDevice(fb.canvas, { opaque: false, paramsPrelude: c.layout.glslPrelude });
      a.requestField(0);
      b.requestField(0);
      expect(named(fb.calls, 'createProgram')).toHaveLength(0);
      // a is lost mid-compile; nobody polls it again (its engine returns early on a lost
      // context). With the event: released by its handler. Before the event is dispatched: by
      // its progress(), which b's claim calls. Either way b submits on its next poll, long
      // before the claim would time out.
      fa.lose(event);
      expect(b.poll()).toBe(false);
      expect(named(fb.calls, 'createProgram').length).toBeGreaterThan(0);
      compiled();
      b.poll();
      fb.signal();
      expect(b.poll()).toBe(true);
      a.dispose();
      b.dispose();
    }
  });

  it('a lost context ends its warm-ups: the page does not wait for them', () => {
    const fake = fakeGL(undefined, { fences: true, linkMs: LINK });
    const c = controller(1, [200, 120]);
    const device = new GpuDevice(fake.canvas, {
      opaque: false,
      paramsPrelude: c.layout.glslPrelude,
    });
    device.poll();
    compiled();
    device.poll();
    expect(gpuBusy()).toBe(true);
    fake.lose();
    expect(gpuBusy()).toBe(false);
    expect(device.poll()).toBe(false);
  });
});

describe('Direct3D: MRT pad and staged field', () => {
  it('pads MRT targets behind location 0; the heavy field programs have one output', () => {
    const fake = fakeGL({ width: 640, height: 360 }, { renderer: D3D });
    const c = controller(1, [200, 120]);
    const device = linkedDevice(fake, c.layout.glslPrelude);
    expect(device.caps.d3d).toBe(true);
    expect(device.caps.stageFormat?.internalFormat).toBe(C(fake, 'RGBA32F'));
    const slot = slotFor(device, c);
    warmFields(device, [[slot, c]]);
    const sources = named(fake.calls, 'shaderSource').map((x) => x[2] as string);
    // The field's stages: the modes into one RGBA32F texel, the rest into two (one program
    // each), and the pack (the only MRT program) from those.
    expect(sources.filter((s) => s.includes('out vec4 o_stage;'))).toHaveLength(1);
    expect(sources.filter((s) => s.includes('out vec4 o_rest;'))).toHaveLength(2);
    expect(sources.filter((s) => s.includes('uniform highp sampler2D u_restColor;'))).toHaveLength(
      1,
    );
    const mrt = sources.filter((s) => s.includes('#define MRT_PAD 1') && s.includes('o_pad'));
    expect(mrt.filter((s) => s.includes('o_pad = vec4(0.0);'))).toHaveLength(1);
    const calls = record(fake, () =>
      expect(slot.draw(frame(c), new OwnSurface(device))).toBe(true),
    );
    const NONE = C(fake, 'NONE');
    const A0 = C(fake, 'COLOR_ATTACHMENT0') as number;
    const draws = named(calls, 'drawBuffers').map((d) => d[1] as number[]);
    // Field: [NONE, A1, A2, A3]; every other target (stamp included) single, from A0.
    expect(draws).toContainEqual([NONE, A0 + 1, A0 + 2, A0 + 3]);
    expect(draws.filter((d) => d.length > 1)).toEqual([[NONE, A0 + 1, A0 + 2, A0 + 3]]);
    expect(draws).toContainEqual([A0]);
    // Four field draws per frame (modes, color, scalar, pack) on top of the other passes.
    const fused = fakeGL({ width: 640, height: 360 });
    const d2 = linkedDevice(fused, c.layout.glslPrelude);
    const s2 = slotFor(d2, c);
    warmFields(d2, [[s2, c]]);
    const calls2 = record(fused, () => s2.draw(frame(c), new OwnSurface(d2)));
    expect(named(calls, 'drawArrays').length).toBe(named(calls2, 'drawArrays').length + 3);
  });
});
