/**
 * Engine dev harness: drives the Engine directly with a hand-filled FrameBlock (no controller).
 *
 * Keys: 1-6 debug view (final, field, halo, bloom, haze, cells), q quality, m mode-weight preset,
 * r life reset, l simulate context loss (auto-restore), h HUD, space pause.
 * URL: ?cols=31 &dpr=1 &t=12.5 (freeze the clock) &preset=0 &quality=high &hud=0
 *      &fx=0 (only the title shadow: no wandering light, pulses or lifts; for reference comparisons)
 *      &ldr=1 (force the RGBA8 fallback targets) &overflow=40 (CSS px glow margin, transparent canvas)
 */

import {
  hexToRgb,
  linearToOklab,
  linearToSrgb,
  oklabToLinear,
  srgbToLinear,
} from '../../src/core/color';
import { Engine } from '../../src/core/engine/engine';
import {
  FRAME_FLOATS,
  MAX_LIFTS,
  OFF_CLOCK,
  OFF_COUNTS,
  OFF_GRID,
  OFF_HOST,
  OFF_INF,
  OFF_MISC,
  OFF_ORIGIN,
  OFF_PHASE_A,
  OFF_PHASE_B,
  OFF_PULSE,
  OFF_SOCKET,
  OFF_SPACE,
} from '../../src/core/engine/frame-block';
import { ENGINE_MODE_IDS } from '../../src/core/engine/glsl/modes/index';
import { constantParamsPrelude } from '../../src/core/engine/glsl/params';
import {
  type FrameInputs,
  LIFT_ALPHA,
  LIFT_BLUR,
  LIFT_CELL_X,
  LIFT_CELL_Y,
  LIFT_H,
  LIFT_OFF_X,
  LIFT_OFF_Y,
  LIFT_SCALE_X,
  LIFT_SCALE_Y,
  LIFT_SEED,
  LIFT_STRIDE,
  LIFT_TILT_X,
  LIFT_TILT_Y,
  type RenderQuality,
} from '../../src/core/engine/types';

const TAU = Math.PI * 2;
const url = new URL(location.href);
const COLUMNS = Number(url.searchParams.get('cols') ?? 31);
const FORCED_DPR = url.searchParams.has('dpr') ? Number(url.searchParams.get('dpr')) : null;
const FROZEN_T = url.searchParams.has('t') ? Number(url.searchParams.get('t')) : null;
const FX = url.searchParams.get('fx') !== '0';
const LDR = url.searchParams.get('ldr') === '1';
const OVERFLOW = Math.max(0, Number(url.searchParams.get('overflow') ?? 0));

const DEFAULT_PALETTE = [
  '#7a1d5a',
  '#f21239',
  '#e0267a',
  '#c43db2',
  '#6a3cc8',
  '#1f4fd8',
  '#0476ff',
  '#0a8cf0',
  '#0b3a9a',
  '#041557',
];

// ---------------------------------------------------------------------------------------------
// Params: the real ParamsBlock when schema + layout load, else constants baked into the prelude.

interface ParamsSource {
  prelude: string;
  vec4Count: number;
  params: Float32Array;
  write(path: string, value: unknown): boolean;
  palette: string[];
  real: boolean;
}

async function loadParams(): Promise<ParamsSource> {
  try {
    const [layoutMod, schemaMod] = await Promise.all([
      import('../../src/core/controller/layout'),
      import('../../src/schema'),
    ]);
    const layout = layoutMod.createParamLayout();
    const defaults = schemaMod.getDefaults();
    const params = new Float32Array(layout.floatCount);
    layout.writeAll(params, defaults);
    return {
      prelude: layout.glslPrelude,
      vec4Count: layout.vec4Count,
      params,
      write: (path, value) => layout.write(params, path, value),
      palette: [...(defaults.color.palette as readonly string[])],
      real: true,
    };
  } catch (err) {
    console.warn('[harness] schema/layout unavailable, using constant params', err);
    return {
      prelude: constantParamsPrelude(),
      vec4Count: 1,
      params: new Float32Array(4),
      write: () => false,
      palette: DEFAULT_PALETTE,
      real: false,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Palette LUT: row 0 base palette (OKLab ramp), row 1 hot tint (OKLCh L=0.93, C*0.35).

function bakeLut(palette: readonly string[]): Uint8Array {
  const out = new Uint8Array(256 * 2 * 4);
  const labs = palette.map((hex) =>
    linearToOklab(hexToRgb(hex).map(srgbToLinear) as [number, number, number]),
  );
  const n = labs.length;
  for (let x = 0; x < 256; x++) {
    const t = x / 255;
    let lab: [number, number, number];
    if (n === 1) lab = labs[0] as [number, number, number];
    else {
      const f = t * (n - 1);
      const i = Math.min(n - 2, Math.floor(f));
      const k = f - i;
      const a = labs[i] as [number, number, number];
      const b = labs[i + 1] as [number, number, number];
      lab = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
    const base = oklabToLinear(lab);
    const chroma = Math.hypot(lab[1], lab[2]);
    const hue = Math.atan2(lab[2], lab[1]);
    const hot = oklabToLinear([0.93, Math.cos(hue) * chroma * 0.35, Math.sin(hue) * chroma * 0.35]);
    for (let row = 0; row < 2; row++) {
      const c = row === 0 ? base : hot;
      const o = (row * 256 + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] = Math.round(linearToSrgb(Math.min(1, Math.max(0, c[ch] ?? 0))) * 255);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
if (url.searchParams.get('hud') === '0') hud.classList.add('hidden');
// A light checkerboard under a transparent canvas makes premultiplied-alpha mistakes visible.
if (OVERFLOW > 0) {
  document.body.style.background =
    'repeating-conic-gradient(#d8d8e0 0 25%, #fff 0 50%) 0 0 / 40px 40px';
}

const src = await loadParams();
const lut = bakeLut(src.palette);
const frame = new Float32Array(FRAME_FLOATS);
const lifts = new Float32Array(MAX_LIFTS * LIFT_STRIDE);

const QUALITIES: RenderQuality[] = ['high', 'medium', 'low'];
const inputs: FrameInputs = {
  canvasWidth: 1,
  canvasHeight: 1,
  cols: 1,
  rows: 1,
  pad: 2,
  pitchPx: 8,
  params: src.params,
  paramsDirty: true,
  frame,
  lut,
  lutDirty: true,
  lifeStep: false,
  lifeReset: true,
  lifeSeed: 1,
  lifeRule: 0,
  lifeBirth: 0.004,
  lifeSeedDensity: 0.3,
  lifts,
  liftCount: 0,
  bloomSigma: 1.2,
  hazeSigma: 6,
  quality: (url.searchParams.get('quality') as RenderQuality | null) ?? 'high',
  opaque: OVERFLOW === 0,
  debugView: 0,
};

let engine: Engine | null = null;
function createEngine(): void {
  engine?.dispose();
  engine = new Engine(canvas, {
    opaque: OVERFLOW === 0,
    forceRgba8: LDR,
    paramsPrelude: src.prelude,
    paramsVec4Count: src.vec4Count,
    onError: (e) => {
      hud.textContent = `ОШИБКА: ${e.message}`;
    },
  });
  // A fresh engine needs everything again.
  inputs.paramsDirty = true;
  inputs.lutDirty = true;
  inputs.lifeReset = true;
}
createEngine();

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.info('[harness] context lost');
});
canvas.addEventListener('webglcontextrestored', () => {
  console.info('[harness] context restored, rebuilding engine');
  createEngine();
});

// ---------------------------------------------------------------------------------------------
// Mode-weight presets (m key).

const PRESETS: {
  name: string;
  weights: Partial<Record<(typeof ENGINE_MODE_IDS)[number], number>>;
}[] = [
  { name: 'reference', weights: { flow: 0.2, sphere: 1 } },
  {
    name: 'all modes',
    weights: { flow: 1, sphere: 1, pulse: 1, wave: 1, ripple: 1, vortex: 1, life: 1, rain: 1 },
  },
  ...ENGINE_MODE_IDS.map((id) => ({ name: `solo ${id}`, weights: { [id]: 1 } })),
];
let presetIndex = Number(url.searchParams.get('preset') ?? 0) % PRESETS.length;

function applyPreset(i: number): void {
  presetIndex = ((i % PRESETS.length) + PRESETS.length) % PRESETS.length;
  const preset = PRESETS[presetIndex];
  if (!preset) return;
  for (const id of ENGINE_MODE_IDS) src.write(`modes.${id}.weight`, preset.weights[id] ?? 0);
  inputs.paramsDirty = true;
  if (preset.weights.life) inputs.lifeReset = true;
}
applyPreset(presetIndex);

// ---------------------------------------------------------------------------------------------
// Geometry (what the controller will compute): integer pitch, odd cell counts, snapped origin.

// The host is the canvas inset by the overflow margin (glow-only, transparent).
const geo = {
  cw: 1,
  ch: 1,
  pitch: 8,
  cols: 1,
  rows: 1,
  pad: 2,
  ox: 0,
  oy: 0,
  halfMin: 1,
  margin: 0,
};
function updateGeometry(): void {
  const dpr = FORCED_DPR ?? Math.min(window.devicePixelRatio || 1, 2);
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  geo.cw = Math.max(1, Math.round(cssW * dpr));
  geo.ch = Math.max(1, Math.round(cssH * dpr));
  geo.margin = Math.round(OVERFLOW * dpr);
  const hw = Math.max(1, geo.cw - 2 * geo.margin);
  const hh = Math.max(1, geo.ch - 2 * geo.margin);
  geo.pitch = Math.max(3, Math.round((hw / dpr / COLUMNS) * dpr));
  geo.cols = Math.ceil(hw / geo.pitch) + 1;
  if (geo.cols % 2 === 0) geo.cols++;
  geo.rows = Math.ceil(hh / geo.pitch) + 1;
  if (geo.rows % 2 === 0) geo.rows++;
  geo.pad = Math.min(16, 2 + Math.ceil(geo.margin / geo.pitch));
  geo.ox = Math.round(geo.cw / 2 - (geo.cols / 2 + geo.pad) * geo.pitch);
  geo.oy = Math.round(geo.ch / 2 - (geo.rows / 2 + geo.pad) * geo.pitch);
  geo.halfMin = Math.min(hw, hh) / 2;
}
updateGeometry();
window.addEventListener('resize', updateGeometry);

// ---------------------------------------------------------------------------------------------
// Lifts with a simple spring / hold / fall envelope.

interface Lift {
  cx: number;
  cy: number;
  t0: number;
  hold: number;
  seed: number;
  bokeh: boolean;
}
const LIFT_COUNT = 15;
const RISE = 0.6;
const FALL = 0.45;
const liftState: Lift[] = [];
let rng = 0x12345678;
function rand(): number {
  rng = (Math.imul(rng ^ (rng >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
  return rng / 4294967296;
}

function spawnLift(now: number, l?: Lift): Lift {
  // Prefer the outer band of the ring (mode radius 0.6..1.1), like the reference.
  const ang = rand() * TAU;
  const r = (0.62 + rand() * 0.5) * geo.halfMin;
  const px = geo.cw / 2 + Math.cos(ang) * r;
  const py = geo.ch / 2 + Math.sin(ang) * r;
  const cx = Math.max(
    geo.pad,
    Math.min(geo.cols + geo.pad - 1, Math.floor((px - geo.ox) / geo.pitch)),
  );
  const cy = Math.max(
    geo.pad,
    Math.min(geo.rows + geo.pad - 1, Math.floor((py - geo.oy) / geo.pitch)),
  );
  const out = l ?? { cx, cy, t0: 0, hold: 0, seed: 0, bokeh: false };
  out.cx = cx;
  out.cy = cy;
  out.t0 = now + rand() * 2;
  out.hold = 1.5 + rand() * 2;
  out.seed = rand();
  out.bokeh = rand() < 0.3;
  return out;
}

function liftHeight(age: number, hold: number, seed: number): number {
  if (age < 0) return 0;
  const z = 0.55;
  const w = (TAU / RISE) * 0.9;
  const wd = w * Math.sqrt(1 - z * z);
  if (age < RISE + hold) {
    const spring =
      1 - Math.exp(-z * w * age) * (Math.cos(wd * age) + ((z * w) / wd) * Math.sin(wd * age));
    return spring + 0.03 * Math.sin(TAU * 0.45 * age + seed * TAU) * Math.min(1, age / RISE);
  }
  const k = (age - RISE - hold) / FALL;
  if (k >= 1) return -1;
  return 1 - k * k;
}

// ---------------------------------------------------------------------------------------------
// Frame fill.

const phases = { flow: 0, rot: 0, breathe: 0, pulse: 0, wave: 0, vortex: 0, rain: 0 };
let lifeAcc = 0;
let lastPulse = -10;
const pulses: { x: number; y: number; t0: number }[] = [];
let paused = false;
let simTime = 0;

function fillFrame(t: number, dt: number): void {
  const f = frame;
  phases.flow = (phases.flow + dt * 0.25) % 1024;
  phases.rot = (phases.rot + dt * 0.12) % TAU;
  phases.breathe = (phases.breathe + dt * 0.35 * TAU) % TAU;
  phases.pulse = (phases.pulse + dt * 0.45) % 1024;
  phases.wave = (phases.wave + dt * 0.5) % 1024;
  phases.vortex = (phases.vortex + dt * 0.3) % TAU;
  phases.rain = (phases.rain + dt * 1.0) % 1024;
  lifeAcc += dt * 8;
  let steps = 0;
  while (lifeAcc >= 1 && steps < 2) {
    lifeAcc -= 1;
    steps++;
  }
  if (lifeAcc >= 1) lifeAcc %= 1;
  inputs.lifeStep = steps > 0;
  if (inputs.lifeStep) inputs.lifeSeed = (inputs.lifeSeed + 1) >>> 0;

  f[OFF_PHASE_A] = phases.flow;
  f[OFF_PHASE_A + 1] = phases.rot;
  f[OFF_PHASE_A + 2] = phases.breathe;
  f[OFF_PHASE_A + 3] = phases.pulse;
  f[OFF_PHASE_B] = phases.wave;
  f[OFF_PHASE_B + 1] = phases.vortex;
  f[OFF_PHASE_B + 2] = phases.rain;
  f[OFF_PHASE_B + 3] = 0;
  f[OFF_CLOCK] = t % 4096;
  f[OFF_CLOCK + 1] = lifeAcc;
  f[OFF_CLOCK + 2] = 1;
  f[OFF_CLOCK + 3] = 0;
  f[OFF_GRID] = geo.cols;
  f[OFF_GRID + 1] = geo.rows;
  f[OFF_GRID + 2] = geo.pitch;
  f[OFF_GRID + 3] = geo.pad;
  f[OFF_ORIGIN] = geo.ox;
  f[OFF_ORIGIN + 1] = geo.oy;
  f[OFF_ORIGIN + 2] = geo.cw;
  f[OFF_ORIGIN + 3] = geo.ch;
  f[OFF_HOST] = geo.margin;
  f[OFF_HOST + 1] = geo.margin;
  f[OFF_HOST + 2] = geo.cw - 2 * geo.margin;
  f[OFF_HOST + 3] = geo.ch - 2 * geo.margin;
  f[OFF_SPACE] = geo.cw / 2;
  f[OFF_SPACE + 1] = geo.ch / 2;
  f[OFF_SPACE + 2] = 1 / geo.halfMin;
  f[OFF_SPACE + 3] = geo.pitch / geo.halfMin;
  f[OFF_MISC] = 0;
  f[OFF_MISC + 1] = 1;
  f[OFF_MISC + 2] = engine?.softwareFallback ? 1 : 0;
  f[OFF_MISC + 3] = 0;

  // Influences: a shadow under the "title" in the center and a wandering light.
  const hm = geo.halfMin;
  let n = 0;
  const inf = (
    x: number,
    y: number,
    hw: number,
    hh: number,
    corner: number,
    falloff: number,
    strength: number,
    type: number,
    color: [number, number, number],
    mix: number,
  ) => {
    const o = OFF_INF + n * 12;
    f[o] = x;
    f[o + 1] = y;
    f[o + 2] = hw;
    f[o + 3] = hh;
    f[o + 4] = corner;
    f[o + 5] = falloff;
    f[o + 6] = strength;
    f[o + 7] = type;
    f[o + 8] = color[0];
    f[o + 9] = color[1];
    f[o + 10] = color[2];
    f[o + 11] = mix;
    n++;
  };
  inf(
    geo.cw / 2,
    geo.ch / 2 + 0.03 * hm,
    0.2 * hm,
    0.08 * hm,
    8,
    1.5 * geo.pitch,
    0.7,
    1,
    [0, 0, 0],
    0,
  );
  if (FX) {
    const lx = geo.cw / 2 + Math.cos(t * 0.23) * 0.75 * hm;
    const ly = geo.ch / 2 + Math.sin(t * 0.31) * 0.55 * hm;
    inf(lx, ly, 0, 0, 2.5 * geo.pitch, 2 * geo.pitch, 0.45, 0, [0.9, 0.1, 0.5], 0.25);
  }
  f[OFF_COUNTS] = n;

  // A pulse every 3 s from a random spot.
  if (FX && t - lastPulse > 3) {
    lastPulse = t;
    pulses.push({ x: rand() * geo.cw, y: rand() * geo.ch, t0: t });
    if (pulses.length > 4) pulses.shift();
  }
  let np = 0;
  for (const p of pulses) {
    const age = t - p.t0;
    const life = 2.5;
    if (age < 0 || age > life) continue;
    const o = OFF_PULSE + np * 12;
    f[o] = p.x;
    f[o + 1] = p.y;
    f[o + 2] = age * 18 * geo.pitch;
    f[o + 3] = 1.5 * geo.pitch;
    f[o + 4] = 0.8 * (1 - age / life) ** 2;
    f[o + 5] = 0;
    f[o + 8] = 1;
    f[o + 9] = 1;
    f[o + 10] = 1;
    np++;
  }
  f[OFF_COUNTS + 1] = np;

  // Lifts + their sockets.
  if (FX && liftState.length === 0)
    for (let i = 0; i < LIFT_COUNT; i++) liftState.push(spawnLift(t));
  let nl = 0;
  const cx0 = geo.cw / 2;
  const cy0 = geo.ch / 2;
  for (const l of liftState) {
    let h = liftHeight(t - l.t0, l.hold, l.seed);
    if (h < 0) {
      spawnLift(t, l);
      h = 0;
    }
    if (h <= 0) continue;
    const o = nl * LIFT_STRIDE;
    const px = geo.ox + (l.cx + 0.5) * geo.pitch;
    const py = geo.oy + (l.cy + 0.5) * geo.pitch;
    lifts[o + LIFT_CELL_X] = l.cx;
    lifts[o + LIFT_CELL_Y] = l.cy;
    lifts[o + LIFT_OFF_X] = (px - cx0) * 0.06 * h;
    lifts[o + LIFT_OFF_Y] = (py - cy0) * 0.06 * h - 0.35 * geo.pitch * h;
    lifts[o + LIFT_SCALE_X] = 1 + 0.5 * h;
    lifts[o + LIFT_SCALE_Y] = 1 + 0.5 * h;
    lifts[o + LIFT_TILT_X] = (l.seed - 0.5) * 0.2 * h;
    lifts[o + LIFT_TILT_Y] = (((l.seed * 7.31) % 1) - 0.5) * 0.2 * h;
    lifts[o + LIFT_H] = h;
    lifts[o + LIFT_ALPHA] = Math.min(1, h * 4);
    lifts[o + LIFT_BLUR] = l.bokeh ? 0.25 * geo.pitch * h : 0;
    lifts[o + LIFT_SEED] = l.seed;
    const so = OFF_SOCKET + nl * 4;
    f[so] = l.cx;
    f[so + 1] = l.cy;
    f[so + 2] = 0.6 * Math.min(1, h);
    f[so + 3] = 0;
    nl++;
  }
  inputs.liftCount = nl;
  f[OFF_COUNTS + 2] = nl;
  f[OFF_COUNTS + 3] = inputs.debugView;

  inputs.canvasWidth = geo.cw;
  inputs.canvasHeight = geo.ch;
  inputs.cols = geo.cols;
  inputs.rows = geo.rows;
  inputs.pad = geo.pad;
  inputs.pitchPx = geo.pitch;
}

// ---------------------------------------------------------------------------------------------
// Loop + HUD.

const stats = { fps: 0, frameMs: 0, cpuMs: 0, gpuMs: null as number | null, frames: 0, drawn: 0 };
let last = performance.now();
let acc = 0;
let accFrames = 0;
let accCpu = 0;

function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) simTime += dt;
  const t = FROZEN_T ?? simTime;
  const step = FROZEN_T !== null ? 0 : paused ? 0 : dt;
  fillFrame(t, step);
  const c0 = performance.now();
  const drawn = engine?.render(inputs) ?? false;
  const cpu = performance.now() - c0;
  if (drawn) {
    inputs.paramsDirty = false;
    inputs.lutDirty = false;
    inputs.lifeReset = false;
    stats.drawn++;
  }
  stats.frames++;
  acc += dt;
  accFrames++;
  accCpu += cpu;
  if (acc >= 0.5) {
    stats.fps = accFrames / acc;
    stats.frameMs = (acc * 1000) / accFrames;
    stats.cpuMs = accCpu / accFrames;
    stats.gpuMs = engine?.gpuTimeMs ?? null;
    acc = 0;
    accFrames = 0;
    accCpu = 0;
    renderHud();
  }
}

function renderHud(): void {
  if (hud.classList.contains('hidden') || !engine) return;
  const e = engine;
  const lines = [
    `FPS ${stats.fps.toFixed(1)}  кадр ${stats.frameMs.toFixed(2)} мс  CPU ${stats.cpuMs.toFixed(2)} мс  GPU ${
      stats.gpuMs === null ? 'н/д' : `${stats.gpuMs.toFixed(2)} мс`
    }`,
    `${geo.cw}x${geo.ch}  шаг ${geo.pitch}px  сетка ${geo.cols}x${geo.rows}+${geo.pad}  lifts ${inputs.liftCount}`,
    `вид ${['final', 'field', 'halo', 'bloom', 'haze', 'cells'][inputs.debugView]}  качество ${inputs.quality}  режимы: ${PRESETS[presetIndex]?.name}`,
    `HDR ${e.caps.hdr ? 'RGBA16F' : 'RGBA8'}  ${e.softwareFallback ? 'SOFTWARE ' : ''}${e.ready ? 'ready' : 'compiling'}  params ${src.real ? 'schema' : 'const'}`,
    `${e.caps.renderer}`,
    '1-6 вид  q качество  m режимы  r жизнь  l потеря контекста  h скрыть  пробел пауза',
  ];
  hud.textContent = lines.join('\n');
}

window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '6') inputs.debugView = Number(e.key) - 1;
  else if (e.key === 'q') {
    inputs.quality =
      QUALITIES[(QUALITIES.indexOf(inputs.quality) + 1) % QUALITIES.length] ?? 'high';
  } else if (e.key === 'm') applyPreset(presetIndex + 1);
  else if (e.key === 'M') applyPreset(presetIndex - 1);
  else if (e.key === 'r') inputs.lifeReset = true;
  else if (e.key === 'l') loseContext();
  else if (e.key === 'h') hud.classList.toggle('hidden');
  else if (e.key === ' ') paused = !paused;
  renderHud();
});

function loseContext(): void {
  const e = engine;
  if (!e) return;
  e.loseContextForTesting();
  setTimeout(() => e.restoreContextForTesting(), 800);
}

requestAnimationFrame(tick);

// Hooks for automated checks (Playwright).
Object.assign(window, {
  harness: {
    get engine() {
      return engine;
    },
    stats,
    geo,
    inputs,
    presets: PRESETS.map((p) => p.name),
    setPreset: applyPreset,
    setParam(path: string, value: unknown) {
      const ok = src.write(path, value);
      inputs.paramsDirty = true;
      return ok;
    },
    setDebugView(v: number) {
      inputs.debugView = v;
    },
    setQuality(q: RenderQuality) {
      inputs.quality = q;
    },
    loseContext,
  },
});
