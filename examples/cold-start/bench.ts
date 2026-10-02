/**
 * Per-frame GPU time (dev only, `?bench=<scenario>`): renders a fingerprint scenario (see
 * fingerprint.ts) for a number of frames at a large size with small cells, so the cell passes
 * weigh in, and reports the engine's GPU frame times (EXT_disjoint_timer_query_webgl2).
 *
 * `?fused=1` hides Direct3D from the engine (the renderer string it reads), so the field runs as
 * one MRT program as on the other backends: the same build, both field paths, on the same GPU.
 * Optional: `w`, `h`, `pitch`, `frames`. Results: window.gpuBench (a promise).
 */

import { createParamLayout } from '../../src/core/controller/layout';
import { Engine } from '../../src/core/engine/engine';
import { FRAME_FLOATS, MAX_LIFTS } from '../../src/core/engine/frame-block';
import { ENGINE_MODE_IDS } from '../../src/core/engine/glsl/modes/index';
import { type FrameInputs, LIFT_STRIDE } from '../../src/core/engine/types';
import { getDefaults } from '../../src/schema';
import { fill, type Geometry, lutBytes, SCENARIOS } from './fingerprint';

export interface BenchResult {
  scenario: string;
  renderer: string;
  geometry: Geometry;
  /** GPU frame times, ms: median and 10th / 90th percentiles of the distinct results. */
  median: number;
  p10: number;
  p90: number;
  samples: number;
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** Makes the engine see a renderer string without Direct3D in it (call before any context). */
export function hideDirect3D(): void {
  const proto = WebGL2RenderingContext.prototype;
  const get = proto.getParameter;
  proto.getParameter = function (this: WebGL2RenderingContext, pname: GLenum) {
    const v = get.call(this, pname);
    return typeof v === 'string' ? v.replace(/Direct3D\s*\d*|D3D\d+/gi, 'bench') : v;
  };
}

export async function gpuBench(
  name: string,
  g: Geometry = { w: 1920, h: 1080, pitch: 4 },
  frames = 300,
): Promise<BenchResult> {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  const canvas = document.createElement('canvas');
  canvas.width = g.w;
  canvas.height = g.h;
  document.body.appendChild(canvas);
  const layout = createParamLayout();
  const params = new Float32Array(layout.floatCount);
  layout.writeAll(params, getDefaults());
  for (const id of ENGINE_MODE_IDS) {
    const w = s.weights ? (s.weights[id] ?? 0) : undefined;
    if (w !== undefined) layout.write(params, `modes.${id}.weight`, w);
  }
  for (const [path, value] of Object.entries(s.params ?? {})) layout.write(params, path, value);
  const engine = new Engine(canvas, {
    opaque: true,
    paramsPrelude: layout.glslPrelude,
    paramsVec4Count: layout.vec4Count,
  });
  const inputs: FrameInputs = {
    canvasWidth: g.w,
    canvasHeight: g.h,
    cols: 1,
    rows: 1,
    pad: 2,
    pitchPx: g.pitch,
    params,
    paramsDirty: true,
    frame: new Float32Array(FRAME_FLOATS),
    lut: lutBytes(),
    lutDirty: true,
    lifeSteps: 1,
    lifeReset: true,
    lifeSeed: 7,
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
  fill(inputs.frame, inputs.lifts, s, inputs, g);
  while (!engine.prepare(inputs)) {
    if (engine.error) throw engine.error;
    await frame();
  }
  const times: number[] = [];
  let last: number | null = null;
  for (let i = 0; i < frames; i++) {
    inputs.lifeSeed = 7 + i;
    engine.render(inputs);
    inputs.paramsDirty = false;
    inputs.lutDirty = false;
    inputs.lifeReset = false;
    await frame();
    const ms = engine.gpuTimeMs;
    // A new result every frame or so: keep the distinct ones after a short settle.
    if (i > 20 && ms !== null && ms !== last) times.push(ms);
    last = ms;
  }
  engine.dispose();
  canvas.remove();
  times.sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round((times[Math.floor(q * (times.length - 1))] ?? -1) * 1000) / 1000;
  return {
    scenario: name,
    renderer: engine.caps.renderer,
    geometry: g,
    median: at(0.5),
    p10: at(0.1),
    p90: at(0.9),
    samples: times.length,
  };
}
