/**
 * Multi-slot check (see multi-slot.html): a GpuDevice draws several RenderSlots into regions of
 * one canvas, and every slot's FrameInputs also drive an Engine with a context of its own. Time
 * is virtual (1/60 s per frame) and every controller has a seeded generator, so a scenario is
 * reproducible frame for frame.
 *
 * - parity({ frames, perRaf }): runs three scenarios. 'base' just animates three slots;
 *   'changed' (same device) also changes slot B's params and palette at frame 61, and shrinks it
 *   (texture reallocation) and moves its region at frame 121; 'rgba8+debug' builds a device and
 *   engines with RGBA8 targets and draws slots in every debug view plus one at the 'low' quality
 *   tier. The slots draw in reverse order on every other frame, so a slot leaking into a region
 *   drawn before it is caught either way. At every checkpoint the whole device canvas is read
 *   back once, after ALL slots drew:
 *   - each region is compared with its own-context engine (region vs own, per slot);
 *   - every pixel outside the regions must be 0 (the drawing buffer is cleared at every
 *     presentation and nothing but the slots draws into it);
 *   - slots A and C are compared between 'base' and 'changed' (they must not notice B).
 *   The result carries a verdict (PASS / FAIL with the reasons), see TOLERANCE.
 * - startup({ n, cold }): main-thread and compile cost of n own-context Engines against one
 *   device with n slots: synchronous creation, time until every program is linked and warmed up
 *   (with the field variant of the look), first frame.
 *   `cold` makes the shader sources unique per run (and per engine), so the browser's program
 *   cache cannot serve them. It releases the parity devices first (a page gets ~16 contexts).
 */

import type { LumiCellsConfigInput } from 'lumicells';
import { Controller, getSharedLayout } from '../../src/core/controller/controller';
import { mulberry32 } from '../../src/core/controller/math';
import { GpuDevice } from '../../src/core/engine/device';
import { Engine } from '../../src/core/engine/engine';
import { createRegion, placeRegion, type Region } from '../../src/core/engine/region';
import type { RenderSlot } from '../../src/core/engine/slot';
import { RegionSurface } from '../../src/core/engine/surface';
import type { FrameInputs } from '../../src/core/engine/types';

// Programs created per context: the device must compile once for all of its slots.
const programCount = new WeakMap<WebGL2RenderingContext, number>();
const proto = WebGL2RenderingContext.prototype;
const createProgram = proto.createProgram;
proto.createProgram = function (this: WebGL2RenderingContext) {
  programCount.set(this, (programCount.get(this) ?? 0) + 1);
  return createProgram.call(this);
};

const qs = new URLSearchParams(location.search);
const FRAMES = Math.max(2, Number(qs.get('frames') ?? 240) || 240);
const PER_RAF = Math.max(1, Number(qs.get('perRaf') ?? 4) || 4);
const STEP_S = 1 / 60;
/** lifts=0: no lifted pixels anywhere (isolates the lift pass when a region differs). */
const LIFTS = qs.get('lifts') !== '0';
/**
 * waive=<scenario>/<slot letter> (repeatable, e.g. waive=rgba8%2Bdebug%2FD2): a known library
 * bug. That slot's region-vs-own mismatches in that scenario are listed under `waived` instead
 * of failing the verdict; every other check of the slot still counts, and a waiver that matches
 * no slot fails the verdict (a stale waiver must not linger). Used by the end-to-end suite only
 * on the renderer where the bug shows (tests/e2e/support/known-issues.ts); none by default.
 */
const WAIVE = new Set(qs.getAll('waive').filter((w) => w !== ''));

/**
 * Region vs own tolerance. A region at the origin runs the own path's arithmetic; under an
 * offset the rasterizer snaps and interpolates from other window coordinates, so a few pixels
 * may differ by 1 LSB per channel (see region.ts). The same tolerance applies to A/C between
 * scenarios: on ANGLE/D3D11 (NVIDIA) a replay of identical inputs on the same device was seen to
 * differ by 1 LSB on up to ~20 pixels in its first frames after the page sat idle, with no GL
 * state involved (a slot on its own does not show it). A leak or a stale binding shows up as far
 * more than that.
 */
const TOLERANCE = {
  /** Largest channel difference allowed in a region. */
  maxLsb: 1,
  /** Pixels allowed to differ at all, as a share of the region (and at least `minPixels`). */
  share: 0.002,
  minPixels: 16,
};

interface SlotSpec {
  name: string;
  config: LumiCellsConfigInput;
  /** Host size, CSS px. */
  host: readonly [number, number];
  dpr: number;
  seed: number;
  /** Queue a few forced lifts every 20 frames. */
  forcedLifts?: boolean;
  /** DEBUG_VIEW value (0 = final image). */
  debugView?: number;
}

const SPECS: readonly SlotSpec[] = [
  { name: 'A reference', config: { extends: 'reference' }, host: [300, 200], dpr: 1, seed: 11 },
  {
    name: 'B orb + overflow + lifts',
    config: { extends: 'orb', render: { overflow: 24 }, lift: { amount: 0.04 } },
    host: [220, 240],
    dpr: 1,
    seed: 22,
    forcedLifts: true,
  },
  {
    name: 'C rain @2x medium',
    config: { extends: 'rain', render: { quality: 'medium' } },
    host: [180, 130],
    dpr: 2,
    seed: 33,
  },
];

/** RGBA8 targets: every debug view, fractional pixel ratios, and the 'low' tier with lifts. */
const DEBUG_SPECS: readonly SlotSpec[] = [
  {
    name: 'D1 field',
    config: { extends: 'reference' },
    host: [150, 100],
    dpr: 1,
    seed: 41,
    debugView: 1,
  },
  {
    name: 'D2 halo @1.25x',
    config: { extends: 'orb', render: { overflow: 14 } },
    host: [130, 120],
    dpr: 1.25,
    seed: 42,
    debugView: 2,
  },
  {
    name: 'D3 bloom @1.5x',
    config: { extends: 'rain' },
    host: [120, 110],
    dpr: 1.5,
    seed: 43,
    debugView: 3,
  },
  {
    name: 'D4 haze',
    config: { extends: 'reference', grid: { pitch: 14 } },
    host: [140, 90],
    dpr: 1,
    seed: 44,
    debugView: 4,
  },
  {
    name: 'D5 cells @2x',
    config: { extends: 'orb', grid: { pitch: 5 } },
    host: [90, 80],
    dpr: 2,
    seed: 45,
    debugView: 5,
  },
  {
    name: 'L low + overflow + lifts @1.5x',
    config: {
      extends: 'reference',
      render: { quality: 'low', overflow: 30 },
      lift: { amount: 0.04 },
    },
    host: [160, 120],
    dpr: 1.5,
    seed: 46,
    forcedLifts: true,
  },
];

/** Slot B in the 'changed' scenario. */
const B_PATCH: LumiCellsConfigInput = {
  grid: { gap: 0.45, roundness: 1 },
  color: { palette: ['#00ffcc', '#0044ff', '#ff00aa'] },
};
const B_SMALL_HOST: readonly [number, number] = [110, 100];
const B_MOVE: readonly [number, number] = [30, 40];

const GAP = 12;
const TOPS = [0, 20, 8, 3, 15, 6];

const devicesEl = document.getElementById('devices') as HTMLElement;
const ownRow = document.getElementById('own') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const layout = getSharedLayout();

function nextFrame(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r));
}

function makeController(spec: SlotSpec): Controller {
  const config = LIFTS ? spec.config : { ...spec.config, lift: { enabled: false } };
  const c = new Controller({ config, random: mulberry32(spec.seed) });
  c.setViewport({
    hostCssW: spec.host[0],
    hostCssH: spec.host[1],
    dpr: spec.dpr,
    deviceW: 0,
    deviceH: 0,
  });
  if (spec.debugView) c.setDebugView(spec.debugView);
  return c;
}

function readPixels(gl: WebGL2RenderingContext, x: number, y: number, w: number, h: number) {
  const out = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

/** The pixels of `r` (GL bottom-left origin) out of a whole-framebuffer readback `fbW` wide. */
function crop(all: Uint8Array, fbW: number, r: Region): Uint8Array {
  const out = new Uint8Array(r.width * r.height * 4);
  for (let row = 0; row < r.height; row++) {
    const src = ((r.y + row) * fbW + r.x) * 4;
    out.set(all.subarray(src, src + r.width * 4), row * r.width * 4);
  }
  return out;
}

/** Largest channel value outside every region (the regions must lie inside the framebuffer). */
function outsideMax(all: Uint8Array, fbW: number, fbH: number, regions: Region[]): number {
  let max = 0;
  for (let y = 0; y < fbH; y++) {
    for (let x = 0; x < fbW; x++) {
      let inside = false;
      for (const r of regions) {
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      const i = (y * fbW + x) * 4;
      for (let c = 0; c < 4; c++) max = Math.max(max, all[i + c] as number);
    }
  }
  return max;
}

interface Diff {
  max: number;
  mean: number;
  /** Pixels with any channel differing / differing by more than 1. */
  n1: number;
  n2: number;
  pixels: number;
}

function diff(a: Uint8Array, b: Uint8Array): Diff {
  let max = 0;
  let sum = 0;
  let n1 = 0;
  let n2 = 0;
  if (a.length !== b.length) return { max: 255, mean: 255, n1: -1, n2: -1, pixels: 0 };
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs((a[i + c] as number) - (b[i + c] as number));
      sum += d;
      if (d > m) m = d;
    }
    if (m > 0) n1++;
    if (m > 1) n2++;
    if (m > max) max = m;
  }
  return { max, mean: sum / a.length, n1, n2, pixels: a.length / 4 };
}

function withinTolerance(d: Diff): boolean {
  const allowed = Math.max(TOLERANCE.minPixels, Math.floor(d.pixels * TOLERANCE.share));
  return d.n1 >= 0 && d.max <= TOLERANCE.maxLsb && d.n1 <= allowed;
}

function releaseEngine(e: Engine): void {
  e.dispose();
  e.loseContextForTesting();
}

/** Region boxes (top-left, device px) for the specs, and the device canvas size. */
function planLayout(ctls: Controller[]) {
  const at: [number, number][] = [];
  let x = 0;
  let height = 0;
  ctls.forEach((c, i) => {
    const top = TOPS[i] ?? 0;
    at.push([x, top]);
    x += c.geo.canvasW + GAP;
    height = Math.max(height, top + c.geo.canvasH);
  });
  return { at, width: x - GAP, height };
}

type DeviceKind = 'float' | 'rgba8';

/** One device per target kind, reused by the scenarios until its context is lost. */
const devices = new Map<DeviceKind, GpuDevice>();
const ownCanvases: HTMLCanvasElement[] = [];
/** The last scenario's own-context engines stay alive (their canvases show the last frame). */
let liveEngines: Engine[] = [];

function releaseDevice(kind: DeviceKind): void {
  const dev = devices.get(kind);
  if (!dev) return;
  devices.delete(kind);
  dev.dispose();
  dev.loseContextForTesting();
}

/**
 * The device for `kind` with its canvas sized to `width x height`. A device whose context was
 * lost (the browser evicts the oldest context past its limit) is dropped for a fresh one on a
 * new canvas: a canvas keeps its context for good, and a lost device never draws again.
 */
function getDevice(kind: DeviceKind, width: number, height: number): GpuDevice {
  let dev = devices.get(kind);
  if (dev?.isContextLost()) {
    releaseDevice(kind);
    dev = undefined;
  }
  if (!dev) {
    const old = devicesEl.querySelector<HTMLCanvasElement>(`canvas[data-kind="${kind}"]`);
    const canvas = document.createElement('canvas');
    canvas.dataset.kind = kind;
    canvas.title = `GpuDevice (${kind} targets)`;
    if (old) old.replaceWith(canvas);
    else devicesEl.append(canvas);
    canvas.width = width;
    canvas.height = height;
    dev = new GpuDevice(canvas, {
      opaque: false,
      paramsPrelude: layout.glslPrelude,
      warnMissingParams: false,
      forceRgba8: kind === 'rgba8',
      onError: (e) => console.error('[multi-slot] device', e),
    });
    devices.set(kind, dev);
  }
  const canvas = dev.canvas;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${width / devicePixelRatio}px`;
  return dev;
}

interface Checkpoint {
  frame: number;
  /** Per slot: region (shared device) vs own-context engine. */
  vsOwn: Diff[];
  /** Largest channel value outside every region (must be 0). */
  outside: number;
  sizes: string[];
}

interface ScenarioResult {
  name: string;
  specs: readonly SlotSpec[];
  checkpoints: Checkpoint[];
  /** Region pixels of every slot per checkpoint frame (for the cross-scenario check). */
  regions: Map<number, Uint8Array[]>;
  drawn: number[];
  frames: number;
  /** Programs the device created in total, and while this scenario created its slots. */
  programsOnDevice: number;
  programsForSlots: number;
  programsPerOwnEngine: number[];
  /** Contexts lost during the run (device or own engines): the run proves nothing then. */
  lost: string[];
}

async function runScenario(
  name: string,
  specs: readonly SlotSpec[],
  kind: DeviceKind,
  changed: boolean,
  frames: number,
): Promise<ScenarioResult> {
  const ctls = specs.map(makeController);
  // One ParamLayout per page: every controller hands the engine the very same prelude.
  if (!ctls.every((c) => c.layout === layout && c.layout.glslPrelude === layout.glslPrelude)) {
    throw new Error('controllers do not share the page ParamLayout');
  }
  const plan = planLayout(ctls);
  for (const e of liveEngines) releaseEngine(e);
  liveEngines = [];
  // Room below for B's move in 'changed' (every scenario on a device keeps one canvas size).
  const dev = getDevice(kind, plan.width, plan.height + B_MOVE[1]);
  for (const c of ctls) c.setMaxDrawableSize(dev.caps.maxDrawableSize);
  const programsBefore = programCount.get(dev.gl) ?? 0;
  const slots: RenderSlot[] = ctls.map((c) =>
    dev.createSlot({ paramsPrelude: c.layout.glslPrelude, paramsVec4Count: c.layout.vec4Count }),
  );
  const surfaces = plan.at.map(([x, y]) => new RegionSurface(dev, x, y));
  for (let i = specs.length; i < ownCanvases.length; i++) ownCanvases[i]?.remove();
  ownCanvases.length = Math.min(ownCanvases.length, specs.length);
  const engines = ctls.map((c, i) => {
    // A new canvas per scenario: a canvas keeps its (released) context for good.
    const canvas = document.createElement('canvas');
    const old = ownCanvases[i];
    if (old) old.replaceWith(canvas);
    else ownRow.append(canvas);
    ownCanvases[i] = canvas;
    canvas.title = specs[i]?.name ?? '';
    return new Engine(canvas, {
      opaque: c.getConfig().render.overflow <= 0,
      paramsPrelude: c.layout.glslPrelude,
      paramsVec4Count: c.layout.vec4Count,
      warnMissingParams: false,
      forceRgba8: kind === 'rgba8',
      onError: (e) => console.error('[multi-slot] engine', e),
    });
  });
  const programsOnDevice = programCount.get(dev.gl) ?? 0;
  const programsForSlots = programsOnDevice - programsBefore;
  const ownGl = engines.map((e) => e.canvas.getContext('webgl2') as WebGL2RenderingContext);
  const programsPerOwnEngine = ownGl.map((gl) => programCount.get(gl) ?? 0);
  const lost = () => [
    ...(dev.isContextLost() ? ['device'] : []),
    ...engines.flatMap((e, i) => (e.isContextLost() ? [specs[i]?.name ?? `own ${i}`] : [])),
  ];
  while (!dev.poll() || !engines.every((e) => e.poll())) {
    if (lost().length > 0) break;
    await nextFrame();
  }

  // Frame 120 ends an animation frame (PER_RAF divides it by default), so the checkpoint right
  // after B moves reads a buffer the browser cleared: B's old spot must be 0 again.
  const checks = new Set([1, 2, 30, 60, 61, 62, 90, 120, 121, 122, 180, frames]);
  const checkpoints: Checkpoint[] = [];
  const regions = new Map<number, Uint8Array[]>();
  const drawn = specs.map(() => 0);
  const boxes = specs.map(() => createRegion());
  let now = 1000;
  for (let frame = 1; frame <= frames && lost().length === 0; frame++) {
    now += STEP_S * 1000;
    const b = ctls[1] as Controller;
    if (changed && frame === 61) b.setConfig(B_PATCH, { transition: 0 });
    if (changed && frame === 121) {
      b.setViewport({
        hostCssW: B_SMALL_HOST[0],
        hostCssH: B_SMALL_HOST[1],
        dpr: 1,
        deviceW: 0,
        deviceH: 0,
      });
      const at = plan.at[1] as [number, number];
      surfaces[1]?.moveTo(at[0] + B_MOVE[0], at[1] + B_MOVE[1]);
    }
    if (frame % 20 === 0) {
      specs.forEach((s, i) => {
        if (s.forcedLifts && LIFTS)
          ctls[i]?.lift({ x: s.host[0] * 0.9, y: s.host[1] * 0.1, count: 3 });
      });
    }
    // Reverse order on odd frames: a leak into a region drawn earlier survives either way.
    const reverse = frame % 2 === 1;
    const inputs = ctls.map((c) => c.update(STEP_S, now));
    // A look that needs a field variant not compiled yet (the first frame, B's patch) would draw
    // without it until it is (see engine/field-variants.ts), each side on its own schedule:
    // wait until both sides have it, so they draw the very same frame.
    while (
      lost().length === 0 &&
      !inputs.every(
        (f, i) =>
          (slots[i] as RenderSlot).prepare(f) && (engines[i] as Engine).prepare(f) && dev.poll(),
      )
    ) {
      dev.poll();
      await nextFrame();
    }
    for (let k = 0; k < ctls.length; k++) {
      const i = reverse ? ctls.length - 1 - k : k;
      const c = ctls[i] as Controller;
      const f = inputs[i] as FrameInputs;
      const a = (slots[i] as RenderSlot).draw(f, surfaces[i] as RegionSurface);
      const o = (engines[i] as Engine).render(f);
      if (a && o) drawn[i] = (drawn[i] ?? 0) + 1;
      c.commitFrame();
    }
    if (checks.has(frame)) {
      const vsOwn: Diff[] = [];
      const sizes: string[] = [];
      const shots: Uint8Array[] = [];
      const fbW = dev.gl.drawingBufferWidth;
      const fbH = dev.gl.drawingBufferHeight;
      const all = readPixels(dev.gl, 0, 0, fbW, fbH);
      for (let i = 0; i < ctls.length; i++) {
        const f = (ctls[i] as Controller).frame;
        const w = Math.floor(f.canvasWidth);
        const h = Math.floor(f.canvasHeight);
        const s = surfaces[i] as RegionSurface;
        const r = placeRegion(boxes[i] as Region, s.left, s.top, w, h, fbH);
        if (r.x < 0 || r.y < 0 || r.x + r.width > fbW || r.y + r.height > fbH) {
          throw new Error(`region of ${specs[i]?.name} does not fit the device canvas`);
        }
        const mine = crop(all, fbW, r);
        const own = readPixels(ownGl[i] as WebGL2RenderingContext, 0, 0, w, h);
        vsOwn.push(diff(mine, own));
        sizes.push(`${w}x${h}@${r.x},${r.y} lifts ${f.liftCount}`);
        shots.push(mine);
      }
      checkpoints.push({ frame, vsOwn, outside: outsideMax(all, fbW, fbH, boxes), sizes });
      regions.set(frame, shots);
    }
    if (frame % PER_RAF === 0) await nextFrame();
  }
  const lostNow = lost();
  for (const s of slots) s.dispose();
  liveEngines = engines;
  for (const c of ctls) c.destroy();
  return {
    name,
    specs,
    checkpoints,
    regions,
    drawn,
    frames,
    programsOnDevice,
    programsForSlots,
    programsPerOwnEngine,
    lost: lostNow,
  };
}

function fmt(d: Diff): string {
  return `max ${d.max} mean ${d.mean.toFixed(5)} >0 ${d.n1} >1 ${d.n2}`;
}

const slotLetter = (s: SlotSpec) => s.name.split(' ')[0] ?? '?';

async function parity(opts: { frames?: number } = {}) {
  const frames = opts.frames ?? FRAMES;
  const base = await runScenario('base', SPECS, 'float', false, frames);
  const changed = await runScenario('changed', SPECS, 'float', true, frames);
  const debug = await runScenario('rgba8+debug', DEBUG_SPECS, 'rgba8', false, frames);
  const scenarios = [base, changed, debug];
  // Slots A and C must not notice B's changes (same tolerance as region vs own: the device
  // replays identical inputs, but on some drivers a replay itself can differ by 1 LSB on a few
  // pixels, see the note on TOLERANCE); B must differ after frame 61.
  const cross = [...base.regions.keys()].map((frame) => {
    const a = base.regions.get(frame) ?? [];
    const b = changed.regions.get(frame) ?? [];
    return {
      frame,
      perSlot: SPECS.map((_, i) => {
        const x = a[i];
        const y = b[i];
        return x && y ? diff(x, y) : null;
      }),
    };
  });
  // A slot with another params prelude is refused (programs are shared).
  let preludeGuard = 'not thrown';
  try {
    devices
      .get('float')
      ?.createSlot({ paramsPrelude: `${layout.glslPrelude}\n// other`, paramsVec4Count: 1 });
  } catch (err) {
    preludeGuard = `thrown: ${(err as Error).message}`;
  }
  const worst = (s: ScenarioResult) =>
    Math.max(0, ...s.checkpoints.flatMap((c) => c.vsOwn.map((d) => d.max)));
  const summary = {
    frames,
    tolerance: TOLERANCE,
    worstVsOwn: Object.fromEntries(scenarios.map((s) => [s.name, worst(s)])),
    outsideRegionsMax: Math.max(
      0,
      ...scenarios.flatMap((s) => s.checkpoints.map((c) => c.outside)),
    ),
    crossScenarioUnchangedSlotsMax: Math.max(
      0,
      ...cross.flatMap((c) => [c.perSlot[0]?.max ?? 255, c.perSlot[2]?.max ?? 255]),
    ),
    crossScenarioSlotBMaxAfterChange: Math.max(
      0,
      ...cross.filter((c) => c.frame > 61).map((c) => c.perSlot[1]?.max ?? 0),
    ),
    programsOnDevice: Object.fromEntries(scenarios.map((s) => [s.name, s.programsOnDevice])),
    programsForSlots: scenarios.map((s) => s.programsForSlots),
    programsPerOwnEngine: base.programsPerOwnEngine,
    drawn: Object.fromEntries(scenarios.map((s) => [s.name, s.drawn])),
    lost: scenarios.flatMap((s) => s.lost.map((l) => `${s.name}: ${l}`)),
    preludeGuard,
    waivers: [...WAIVE],
  };

  // Verdict: every condition below must hold (waived region-vs-own mismatches aside).
  const failures: string[] = [];
  const waived: string[] = [];
  const waiverKey = (s: ScenarioResult, i: number) =>
    `${s.name}/${slotLetter(s.specs[i] as SlotSpec)}`;
  for (const w of WAIVE) {
    if (!scenarios.some((s) => s.specs.some((_, i) => waiverKey(s, i) === w))) {
      failures.push(`waiver ${w} matches no slot`);
    }
  }
  for (const l of summary.lost) failures.push(`context lost (${l})`);
  for (const s of scenarios) {
    if (s.checkpoints.length === 0) failures.push(`${s.name}: no checkpoint reached`);
    for (const c of s.checkpoints) {
      c.vsOwn.forEach((d, i) => {
        if (!withinTolerance(d)) {
          const text = `${s.name} f${c.frame} ${s.specs[i]?.name}: region vs own ${fmt(d)}`;
          (WAIVE.has(waiverKey(s, i)) ? waived : failures).push(text);
        }
      });
      if (c.outside !== 0) failures.push(`${s.name} f${c.frame}: ${c.outside} outside the regions`);
    }
    s.drawn.forEach((n, i) => {
      if (n !== s.frames) failures.push(`${s.name} ${s.specs[i]?.name}: drew ${n}/${s.frames}`);
    });
    if (s.programsForSlots !== 0) {
      failures.push(`${s.name}: ${s.programsForSlots} programs created for slots`);
    }
  }
  for (const c of cross) {
    for (const i of [0, 2]) {
      const d = c.perSlot[i];
      if (!d || !withinTolerance(d)) {
        failures.push(`${'ABC'[i]} changed with B at f${c.frame}: ${d ? fmt(d) : 'missing'}`);
      }
    }
  }
  if (summary.crossScenarioSlotBMaxAfterChange === 0) failures.push('B did not change');
  if (!preludeGuard.startsWith('thrown')) failures.push('foreign prelude accepted');
  const verdict = failures.length === 0 ? 'PASS' : 'FAIL';

  const lines = [
    `${verdict}${failures.length ? `: ${failures.length} problem(s)` : ''}`,
    ...failures.slice(0, 20).map((f) => `  - ${f}`),
    ...(WAIVE.size > 0
      ? [
          `waived (known issues, outside the verdict): ${[...WAIVE].join(', ')}; ${waived.length} mismatch(es)`,
          ...waived.slice(0, 10).map((f) => `  ~ ${f}`),
        ]
      : []),
    `\nparity: ${frames} frames per scenario, virtual 1/60 s, seeded controllers, draw order reversed on odd frames`,
    `tolerance: region vs own max <= ${TOLERANCE.maxLsb} LSB on <= max(${TOLERANCE.minPixels}, ${TOLERANCE.share * 100}%) of a region's pixels; outside the regions 0; A/C base vs changed: same as region vs own`,
    `programs: while creating slots ${summary.programsForSlots.join(' + ')}; per own-context engine: ${summary.programsPerOwnEngine.join(', ')}`,
  ];
  for (const s of scenarios) {
    lines.push(`\n[${s.name}] region vs own-context engine, max outside the regions`);
    for (const c of s.checkpoints) {
      lines.push(
        `  f${String(c.frame).padStart(3)}  ${c.vsOwn.map((d, i) => `${slotLetter(s.specs[i] as SlotSpec)} ${fmt(d)}`).join(' | ')} | out ${c.outside}`,
      );
    }
    lines.push(`  sizes at the end: ${s.checkpoints.at(-1)?.sizes.join(' ; ')}`);
  }
  lines.push('\n[base vs changed] same slot, same frame (B changed at f61 / f121)');
  for (const c of cross) {
    lines.push(
      `  f${String(c.frame).padStart(3)}  ${c.perSlot.map((d, i) => `${'ABC'[i]} ${!d ? '-' : d.n1 < 0 ? 'resized' : `max ${d.max} >0 ${d.n1}`}`).join(' | ')}`,
    );
  }
  lines.push(`\nprelude guard: ${preludeGuard}`);
  statusEl.textContent = lines.join('\n');
  const result = {
    verdict,
    failures,
    waived,
    summary,
    base: base.checkpoints,
    changed: changed.checkpoints,
    debug: debug.checkpoints,
    cross,
  };
  api.last = result;
  return result;
}

/** Busy-polls until `done()` (compiles run off the main thread) or the timeout. */
/**
 * Milliseconds until `done()` holds, checked once per frame (the warm-up fences that end a
 * start-up pass only between tasks: see engine/warmup.ts). NaN past `timeoutMs`.
 */
async function until(done: () => boolean, timeoutMs = 30_000): Promise<number> {
  const t0 = performance.now();
  while (!done()) {
    if (performance.now() - t0 > timeoutMs) return Number.NaN;
    await nextFrame();
  }
  return performance.now() - t0;
}

let nonce = 0;

async function startup(opts: { n?: number; cold?: boolean } = {}) {
  const n = opts.n ?? 3;
  const cold = opts.cold ?? true;
  // Measure with as few other contexts alive as possible: the next parity() builds new devices.
  for (const e of liveEngines) releaseEngine(e);
  liveEngines = [];
  releaseDevice('float');
  releaseDevice('rgba8');
  const spec = {
    name: 'startup',
    config: { extends: 'reference' },
    host: [180, 100],
    dpr: 1,
    seed: 5,
  } as const;
  const ctl = makeController(spec as SlotSpec);
  const f = ctl.update(STEP_S, 1000);
  const w = f.canvasWidth;
  const h = f.canvasHeight;
  const prelude = (k: number) =>
    cold
      ? `${layout.glslPrelude}\n// startup ${++nonce} ${k} ${performance.now()}`
      : layout.glslPrelude;
  const pixel = new Uint8Array(4);
  await nextFrame();

  // n own-context engines.
  let t0 = performance.now();
  const engines: Engine[] = [];
  for (let i = 0; i < n; i++) {
    const canvas = document.createElement('canvas');
    engines.push(
      new Engine(canvas, {
        opaque: true,
        paramsPrelude: prelude(i),
        paramsVec4Count: layout.vec4Count,
        warnMissingParams: false,
      }),
    );
  }
  const ownSync = performance.now() - t0;
  // Linked, warmed up and the look's field variant ready.
  const ownLink = await until(() => engines.every((e) => e.prepare(f)));
  t0 = performance.now();
  for (const e of engines) {
    e.render(f);
    const gl = e.canvas.getContext('webgl2') as WebGL2RenderingContext;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  }
  const ownFirst = performance.now() - t0;
  const ownLost = engines.filter((e) => e.isContextLost()).length;
  for (const e of engines) releaseEngine(e);
  await nextFrame();

  // One device, n slots in regions of one canvas.
  t0 = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = w * n;
  canvas.height = h;
  const dev = new GpuDevice(canvas, {
    opaque: false,
    paramsPrelude: prelude(0),
    warnMissingParams: false,
  });
  const deviceSync = performance.now() - t0;
  const tSlots = performance.now();
  const slots = Array.from({ length: n }, () =>
    dev.createSlot({ paramsPrelude: dev.paramsPrelude, paramsVec4Count: layout.vec4Count }),
  );
  const slotsSync = performance.now() - tSlots;
  const devLink = await until(
    () => (slots.every((s) => s.prepare(f)) && dev.poll()) || dev.isContextLost(),
  );
  t0 = performance.now();
  slots.forEach((s, i) => {
    s.draw(f, new RegionSurface(dev, i * w, 0));
  });
  dev.gl.readPixels(0, 0, 1, 1, dev.gl.RGBA, dev.gl.UNSIGNED_BYTE, pixel);
  const devFirst = performance.now() - t0;
  const programs = programCount.get(dev.gl) ?? 0;
  const devLost = dev.isContextLost();
  dev.dispose();
  dev.loseContextForTesting();
  ctl.destroy();
  const r = (v: number) => Math.round(v * 100) / 100;
  const result = {
    n,
    cold,
    /** Contexts the browser took away during the run (the timings are void then). */
    lost: { own: ownLost, device: devLost },
    own: {
      syncMs: r(ownSync),
      linkMs: r(ownLink),
      firstFrameMs: r(ownFirst),
      totalMs: r(ownSync + ownLink + ownFirst),
    },
    device: {
      syncMs: r(deviceSync + slotsSync),
      deviceSyncMs: r(deviceSync),
      slotsSyncMs: r(slotsSync),
      linkMs: r(devLink),
      firstFrameMs: r(devFirst),
      totalMs: r(deviceSync + slotsSync + devLink + devFirst),
      programs,
    },
  };
  api.last = result;
  return result;
}

const api: {
  parity: typeof parity;
  startup: typeof startup;
  last: unknown;
  done: boolean;
} = { parity, startup, last: null, done: false };
(window as unknown as { multi: typeof api }).multi = api;

if (qs.get('auto') !== '0') {
  parity()
    .then(() => {
      api.done = true;
      document.body.dataset.done = '1';
    })
    .catch((err) => {
      statusEl.textContent = `failed: ${err instanceof Error ? err.stack : String(err)}`;
      console.error(err);
    });
}
