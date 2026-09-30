/**
 * The engine split without a GPU: GpuDevice + RenderSlot + Surface on a recording fake WebGL2
 * context. What is checked is the command stream: programs compiled once per device, every slot
 * binding its own buffers and textures before its passes (and only when another slot drew in
 * between), the region / scissor / viewport of each surface, the shared region-pixel GLSL, and
 * per-slot automaton seeds.
 */
import { describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { mulberry32 } from '../src/core/controller/math';
import { GpuDevice } from '../src/core/engine/device';
import { Engine } from '../src/core/engine/engine';
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

type Call = [name: string, ...args: unknown[]];

interface FakeGL {
  gl: WebGL2RenderingContext;
  calls: Call[];
  canvas: HTMLCanvasElement;
  /** Makes createBuffer return null from now on (resource failure). */
  failBuffers(): void;
  /** Loses the context: isContextLost() turns true and 'webglcontextlost' fires. */
  lose(): void;
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
function fakeGL(fixed?: { width: number; height: number }): FakeGL {
  const calls: Call[] = [];
  const constants = new Map<string, number>();
  const names = new Map<number, string>();
  let nextId = 0;
  let buffersFail = false;
  let lost = false;
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
    getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? {} : null),
    getParameter: (p: number) => PARAMS[names.get(p) ?? ''] ?? 0,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'),
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    getUniformBlockIndex: () => 0,
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
    canvas: canvas as unknown as HTMLCanvasElement,
    failBuffers: () => {
      buffersFail = true;
    },
    lose: () => {
      lost = true;
      (listeners.get('webglcontextlost') as (() => void) | undefined)?.();
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
    const programs = named(fake.calls, 'createProgram').length;
    expect(programs).toBe(10);
    const during = record(fake, () => {
      for (let i = 0; i < 4; i++) slotFor(device, c);
    });
    expect(named(during, 'createProgram')).toHaveLength(0);
    expect(named(during, 'compileShader')).toHaveLength(0);
    expect(device.slotCount).toBe(4);
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
