/**
 * Pixel fingerprint (dev only): renders fixed scenarios through an Engine with hand-filled,
 * deterministic FrameInputs and reads back the canvas and the field targets, so a shader change
 * can be checked for identical output (before / after, same machine).
 *
 * Scenarios cover every mode (alone and together), the color mappings with a crossfade and
 * drift, the blend modes, the debug views and qualities, the lite pipeline, many influences of
 * every type, pulses, lift sockets and lifts, on the float and the RGBA8 targets.
 * Results: window.fingerprint (a promise of { name, canvas, fieldA, fieldB } with base64 data).
 */

import { createParamLayout } from '../../src/core/controller/layout';
import { Engine } from '../../src/core/engine/engine';
import {
  EPOCH_WRAP,
  FRAME_FLOATS,
  MAX_LIFTS,
  OFF_CLOCK,
  OFF_COUNTS,
  OFF_EPOCH_A,
  OFF_EPOCH_B,
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
  writeEpochPhase,
} from '../../src/core/engine/frame-block';
import { ENGINE_MODE_IDS } from '../../src/core/engine/glsl/modes/index';
import {
  type FrameInputs,
  LIFT_ALPHA,
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
import { getDefaults } from '../../src/schema';

export interface FingerprintShot {
  name: string;
  /** base64 of the canvas RGBA8 (bottom-up rows). */
  canvas: string;
  /** base64 of fieldA as float32 (decoded), and of fieldB bytes. */
  fieldA: string;
  fieldB: string;
}

export interface Scenario {
  name: string;
  params?: Record<string, unknown>;
  weights?: Partial<Record<(typeof ENGINE_MODE_IDS)[number], number>>;
  t: number;
  debugView?: number;
  quality?: RenderQuality;
  lite?: boolean;
  /** f_misc: previous mapping, crossfade, drift on. */
  crossfade?: [number, number];
  drift?: number;
  fx?: boolean;
}

const W = 360;
const H = 232;
const PITCH = 8;

/** Canvas size and cell pitch of a scenario run, device px. */
export interface Geometry {
  w: number;
  h: number;
  pitch: number;
}

const FINGERPRINT: Geometry = { w: W, h: H, pitch: PITCH };

export const SCENARIOS: Scenario[] = [
  { name: 'reference', t: 3.7, fx: true },
  { name: 'reference-calm', t: 9.1, fx: false },
  {
    name: 'all-modes',
    t: 12.3,
    fx: true,
    weights: { flow: 1, sphere: 1, pulse: 1, wave: 1, ripple: 1, vortex: 1, life: 1, rain: 1 },
    params: { 'color.mapping': 4, 'color.warp': 0.5 },
    crossfade: [2, 0.4],
    drift: 0.7,
  },
  ...ENGINE_MODE_IDS.map(
    (id, i): Scenario => ({
      name: `solo-${id}`,
      t: 5 + i * 1.37,
      fx: i % 2 === 0,
      weights: { [id]: 1 },
      params: { 'color.mapping': i % 5, 'animation.blend': i % 3 },
    }),
  ),
  { name: 'debug-field', t: 4.2, fx: true, debugView: 1 },
  { name: 'debug-halo', t: 4.2, fx: true, debugView: 2 },
  { name: 'debug-bloom', t: 4.2, fx: true, debugView: 3 },
  { name: 'debug-haze', t: 4.2, fx: true, debugView: 4 },
  { name: 'debug-cells', t: 4.2, fx: true, debugView: 5 },
  { name: 'medium', t: 6.6, fx: true, quality: 'medium' },
  { name: 'low', t: 6.6, fx: true, quality: 'low' },
  { name: 'lite', t: 6.6, fx: true, lite: true },
];

export function lutBytes(): Uint8Array {
  const out = new Uint8Array(256 * 2 * 4);
  for (let x = 0; x < 256; x++) {
    const t = x / 255;
    const base = [0.9 * (1 - t) + 0.05, 0.1 + 0.3 * Math.sin(t * 3.1), 0.2 + 0.75 * t];
    for (let row = 0; row < 2; row++) {
      const o = (row * 256 + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = row === 0 ? (base[c] as number) : 0.85 + 0.15 * (base[c] as number);
        out[o + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** Fills the frame block of scenario `s` (deterministic: only `s` and the geometry). */
export function fill(
  f: Float32Array,
  lifts: Float32Array,
  s: Scenario,
  inputs: FrameInputs,
  g: Geometry = FINGERPRINT,
): void {
  const { w: W, h: H, pitch: PITCH } = g;
  f.fill(0);
  lifts.fill(0);
  const cols = Math.ceil(W / PITCH) | 1;
  const rows = Math.ceil(H / PITCH) | 1;
  const pad = 2;
  const ox = Math.round(W / 2 - (cols / 2 + pad) * PITCH);
  const oy = Math.round(H / 2 - (rows / 2 + pad) * PITCH);
  const hm = Math.min(W, H) / 2;
  const t = s.t;
  f[OFF_PHASE_A] = (t * 0.25) % 1024;
  f[OFF_PHASE_A + 1] = (t * 0.12) % (Math.PI * 2);
  f[OFF_PHASE_A + 2] = (t * 0.35 * Math.PI * 2) % (Math.PI * 2);
  f[OFF_PHASE_A + 3] = (t * 0.45) % 1024;
  f[OFF_PHASE_B] = (t * 0.5) % 1024;
  f[OFF_PHASE_B + 1] = (t * 0.3) % (Math.PI * 2);
  f[OFF_PHASE_B + 2] = t % 1024;
  f[OFF_PHASE_B + 3] = s.drift ?? 0;
  f[OFF_CLOCK] = t;
  f[OFF_CLOCK + 1] = 0.37;
  f[OFF_CLOCK + 2] = 1;
  f[OFF_GRID] = cols;
  f[OFF_GRID + 1] = rows;
  f[OFF_GRID + 2] = PITCH;
  f[OFF_GRID + 3] = pad;
  f[OFF_ORIGIN] = ox;
  f[OFF_ORIGIN + 1] = oy;
  f[OFF_ORIGIN + 2] = W;
  f[OFF_ORIGIN + 3] = H;
  f[OFF_HOST + 2] = W;
  f[OFF_HOST + 3] = H;
  f[OFF_SPACE] = W / 2;
  f[OFF_SPACE + 1] = H / 2;
  f[OFF_SPACE + 2] = 1 / hm;
  f[OFF_SPACE + 3] = PITCH / hm;
  f[OFF_MISC] = s.crossfade?.[0] ?? 0;
  f[OFF_MISC + 1] = s.crossfade?.[1] ?? 1;
  f[OFF_MISC + 3] = s.drift ? 1 : 0;
  writeEpochPhase(f, OFF_EPOCH_A, (t / 3) % EPOCH_WRAP);
  writeEpochPhase(f, OFF_EPOCH_A + 2, (t / 0.5) % EPOCH_WRAP);
  writeEpochPhase(f, OFF_EPOCH_B, (t * 0.3) % EPOCH_WRAP);
  writeEpochPhase(f, OFF_EPOCH_B + 2, (t / 2.5) % EPOCH_WRAP);
  let nInf = 0;
  let nPulse = 0;
  let nLift = 0;
  if (s.fx) {
    // Every influence type, several of each, spread over the host.
    for (let i = 0; i < 22; i++) {
      const o = OFF_INF + nInf * 12;
      const a = i * 2.39996 + t * 0.1;
      const r = (0.15 + 0.8 * ((i * 0.618) % 1)) * hm;
      f[o] = W / 2 + Math.cos(a) * r * 1.4;
      f[o + 1] = H / 2 + Math.sin(a) * r;
      f[o + 2] = i % 3 === 0 ? 0 : (6 + (i % 5) * 4) * (1 + (i % 2));
      f[o + 3] = i % 3 === 0 ? 0 : 5 + (i % 4) * 3;
      f[o + 4] = i % 3 === 0 ? 10 + (i % 7) * 3 : 4;
      f[o + 5] = (1 + (i % 3)) * PITCH;
      f[o + 6] = 0.3 + 0.1 * (i % 6);
      f[o + 7] = i % 5;
      f[o + 8] = (i * 0.37) % 1;
      f[o + 9] = (i * 0.61) % 1;
      f[o + 10] = (i * 0.83) % 1;
      f[o + 11] = 0.2 + 0.1 * (i % 5);
      nInf++;
    }
    for (let i = 0; i < 5; i++) {
      const o = OFF_PULSE + nPulse * 12;
      f[o] = W * ((i * 0.37 + 0.1) % 1);
      f[o + 1] = H * ((i * 0.53 + 0.2) % 1);
      f[o + 2] = (8 + i * 9) * PITCH * 0.5;
      f[o + 3] = 1.5 * PITCH;
      f[o + 4] = 0.2 + 0.15 * i;
      f[o + 5] = 0.1 * i;
      f[o + 8] = 1;
      f[o + 9] = 0.5 + 0.1 * i;
      f[o + 10] = 0.3;
      nPulse++;
    }
    for (let i = 0; i < 24; i++) {
      const cx = pad + ((i * 7) % cols);
      const cy = pad + ((i * 11) % rows);
      const h = 0.2 + 0.04 * i;
      const o = nLift * LIFT_STRIDE;
      lifts[o + LIFT_CELL_X] = cx;
      lifts[o + LIFT_CELL_Y] = cy;
      lifts[o + LIFT_OFF_X] = (i % 5) - 2;
      lifts[o + LIFT_OFF_Y] = -0.35 * PITCH * h;
      lifts[o + LIFT_SCALE_X] = 1 + 0.5 * h;
      lifts[o + LIFT_SCALE_Y] = 1 + 0.4 * h;
      lifts[o + LIFT_TILT_X] = 0.05 * ((i % 3) - 1);
      lifts[o + LIFT_TILT_Y] = 0.04 * ((i % 4) - 1.5);
      lifts[o + LIFT_H] = h;
      lifts[o + LIFT_ALPHA] = Math.min(1, h * 4);
      lifts[o + 10] = i % 4 === 0 ? 2 : 0;
      lifts[o + LIFT_SEED] = (i * 0.29) % 1;
      const so = OFF_SOCKET + nLift * 4;
      f[so] = cx;
      f[so + 1] = cy;
      f[so + 2] = 0.6 * Math.min(1, h);
      nLift++;
    }
  }
  f[OFF_COUNTS] = nInf;
  f[OFF_COUNTS + 1] = nPulse;
  f[OFF_COUNTS + 2] = nLift;
  f[OFF_COUNTS + 3] = s.debugView ?? 0;
  inputs.liftCount = nLift;
  inputs.canvasWidth = W;
  inputs.canvasHeight = H;
  inputs.cols = cols;
  inputs.rows = rows;
  inputs.pad = pad;
  inputs.pitchPx = PITCH;
  inputs.quality = s.quality ?? 'high';
  inputs.debugView = s.debugView ?? 0;
  inputs.lite = s.lite ?? false;
}

async function shoot(forceRgba8: boolean): Promise<FingerprintShot[]> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  document.body.appendChild(canvas);
  const layout = createParamLayout();
  const defaults = getDefaults();
  const params = new Float32Array(layout.floatCount);
  const engine = new Engine(canvas, {
    opaque: true,
    forceRgba8,
    paramsPrelude: layout.glslPrelude,
    paramsVec4Count: layout.vec4Count,
  });
  while (!engine.poll()) {
    if (engine.error) throw engine.error;
    await frame();
  }
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  const inputs: FrameInputs = {
    canvasWidth: W,
    canvasHeight: H,
    cols: 1,
    rows: 1,
    pad: 2,
    pitchPx: PITCH,
    params,
    paramsDirty: true,
    frame: new Float32Array(FRAME_FLOATS),
    lut: lutBytes(),
    lutDirty: true,
    lifeSteps: 0,
    lifeReset: true,
    lifeSeed: 1,
    lifeRule: 0,
    lifeBirth: 0.004,
    lifeSeedDensity: 0.3,
    lifts: new Float32Array(MAX_LIFTS * LIFT_STRIDE),
    liftCount: 0,
    bloomSigma: 1.2,
    hazeSigma: 6,
    quality: 'high',
    opaque: true,
    debugView: 0,
  };
  const shots: FingerprintShot[] = [];
  for (const s of SCENARIOS) {
    layout.writeAll(params, defaults);
    for (const id of ENGINE_MODE_IDS) {
      const w = s.weights ? (s.weights[id] ?? 0) : undefined;
      if (w !== undefined) layout.write(params, `modes.${id}.weight`, w);
    }
    for (const [path, value] of Object.entries(s.params ?? {})) layout.write(params, path, value);
    inputs.paramsDirty = true;
    inputs.lutDirty = true;
    inputs.lifeReset = true;
    inputs.lifeSeed = 7;
    fill(inputs.frame, inputs.lifts, s, inputs);
    // Three frames: a reset, then two automaton steps (the field reads the stepped state).
    for (let i = 0; i < 3; i++) {
      inputs.lifeSteps = i === 0 ? 0 : 1;
      inputs.lifeSeed = 7 + i;
      // A new look may need a field variant that is still compiling: until it is ready, frames
      // are drawn without it (see field-variants.ts). Wait for it without drawing.
      while (!engine.prepare(inputs)) {
        if (engine.error) throw engine.error;
        await frame();
      }
      engine.render(inputs);
      inputs.paramsDirty = false;
      inputs.lutDirty = false;
      inputs.lifeReset = false;
    }
    const px = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const field = engine.readFieldForTesting();
    shots.push({
      name: `${forceRgba8 ? 'rgba8' : 'hdr'}/${s.name}`,
      canvas: b64(px),
      fieldA: field ? b64(new Uint8Array(field.a.buffer)) : '',
      fieldB: field ? b64(field.b) : '',
    });
    await frame();
  }
  engine.dispose();
  canvas.remove();
  return shots;
}

export async function fingerprint(): Promise<FingerprintShot[]> {
  return [...(await shoot(false)), ...(await shoot(true))];
}
