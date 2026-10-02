/**
 * Cold-start probe (dev only): what each pass program costs the first time a context compiles it.
 *
 * Creates one GpuDevice with the real ParamLayout (every pass program is submitted at once, as
 * on a page), records when each program reports COMPLETION_STATUS (the background link), then
 * draws each program once on its own, into a framebuffer with as many color attachments as the
 * shader has outputs (the draw-time variant ANGLE builds for that layout), and times the draw plus
 * a 1x1 readPixels (synchronous: it waits for whatever the GPU process does for that draw). A
 * second draw of the same program gives the baseline.
 *
 * Run it in a fresh browser profile (no program cache) for cold numbers; a reload gives warm ones.
 * Results: window.cold (a promise of the report), also printed in the HUD.
 *
 * ?fp=1: the pixel fingerprint instead (fingerprint.ts); ?bench=<scenario>: per-frame GPU time
 * (bench.ts, with ?fused=1 for the one-program field path on Direct3D).
 */

import { createParamLayout } from '../../src/core/controller/layout';
import { GpuDevice } from '../../src/core/engine/device';
import { ALL_FEATURES, FEATURE_WARP } from '../../src/core/engine/field-variants';
import { FRAME_BYTES } from '../../src/core/engine/frame-block';
import { ENGINE_MODE_IDS } from '../../src/core/engine/glsl/modes/index';
import { getDefaults } from '../../src/schema';
import { type BenchResult, gpuBench, hideDirect3D } from './bench';
import { type FingerprintShot, fingerprint } from './fingerprint';

interface ProgramRecord {
  index: number;
  /** One of the field pass's programs. */
  field: boolean;
  label: string;
  outputs: number;
  submitted: number;
  /** ms from submit to COMPLETION_STATUS (-1 while pending). */
  linkMs: number;
  /** First isolated draw + 1x1 readPixels, ms. */
  firstDrawMs: number;
  /** Second draw + readPixels, ms (baseline). */
  againMs: number;
  handle: WebGLProgram;
  /** Fragment shader source (for offline inspection). */
  fs: string;
  /** Location 0 is an unused pad output (drawn with drawBuffers [NONE, ...]). */
  pad0: boolean;
}

interface ColdReport {
  renderer: string;
  deviceMs: number;
  allLinkedMs: number;
  programs: Omit<ProgramRecord, 'handle' | 'fs' | 'pad0'>[];
}

declare global {
  interface Window {
    cold: Promise<ColdReport>;
    /** Fragment shader sources by program label. */
    coldSources: Record<string, string>;
    /** ?fp=1: the pixel fingerprint (see fingerprint.ts). */
    fingerprint: Promise<FingerprintShot[]>;
    /** ?bench=<scenario>: per-frame GPU time (see bench.ts). */
    gpuBench: Promise<BenchResult>;
  }
}

/**
 * Creation order of the device's programs other than the field's (see GpuDevice.createPasses;
 * the field variant the probe asks for comes first: ?features=<hex mask>|all, default: the
 * reference look, see field-variants.ts).
 */
const LABELS = [
  'life',
  'haze-downsample',
  'bloom-x',
  'bloom-y-combine',
  'haze-x',
  'haze-y',
  'composite',
  'lift',
  'cell-stamp-a',
  'cell-stamp-b',
];
const featuresParam = new URLSearchParams(location.search).get('features');
const FEATURES =
  featuresParam === 'all'
    ? ALL_FEATURES
    : featuresParam
      ? Number.parseInt(featuresParam, 16)
      : (1 << ENGINE_MODE_IDS.indexOf('flow')) |
        (1 << ENGINE_MODE_IDS.indexOf('sphere')) |
        FEATURE_WARP;

const hud = document.getElementById('hud') as HTMLElement;
const records: ProgramRecord[] = [];

// Record every program the device links (labels by creation order, outputs from the source).
/**
 * Color outputs of a fragment shader as compiled: an MRT program declares its outputs twice
 * (with and without the MRT_PAD output, see passes/shared.ts), the header picks one.
 */
function outputCount(src: string): number {
  const decl = /^\s*(?:layout\s*\([^)]*\)\s*)?out\s+vec4\s/gm;
  const mrt = /#if MRT_PAD\n([\s\S]*?)#else\n([\s\S]*?)#endif/.exec(src);
  if (!mrt) return (src.match(decl) ?? []).length;
  const branch = /#define MRT_PAD 1\b/.test(src) ? mrt[1] : mrt[2];
  return (branch?.match(decl) ?? []).length;
}

/** Field programs by their outputs: fused, or the stages (see passes/field.ts). */
function fieldLabel(src: string): string | null {
  if (src.includes('o_stage')) return 'field-modes';
  if (src.includes('o_rest = vec4(base')) return 'field-rest-color';
  if (src.includes('o_rest = vec4(t')) return 'field-rest-scalar';
  if (src.includes('u_restColor')) return 'field-pack';
  if (src.includes('o_fieldA')) return 'field';
  return null;
}

const proto = WebGL2RenderingContext.prototype;
const sources = new WeakMap<WebGLShader, string>();
const outputs = new WeakMap<WebGLProgram, number>();
const fragment = new WeakMap<WebGLProgram, string>();
const origSource = proto.shaderSource;
const origAttach = proto.attachShader;
const origLink = proto.linkProgram;
proto.shaderSource = function (this: WebGL2RenderingContext, s: WebGLShader, src: string) {
  sources.set(s, src);
  origSource.call(this, s, src);
};
proto.attachShader = function (this: WebGL2RenderingContext, p: WebGLProgram, s: WebGLShader) {
  const src = sources.get(s) ?? '';
  if (!src.includes('gl_Position')) {
    outputs.set(p, outputCount(src));
    fragment.set(p, src);
  }
  origAttach.call(this, p, s);
};
/** First record of the device being measured (see run()). */
let base = 0;
let prefix = '';
proto.linkProgram = function (this: WebGL2RenderingContext, p: WebGLProgram) {
  const index = records.length;
  const field = fieldLabel(fragment.get(p) ?? '');
  // Index among the device's other programs (creation order, see LABELS).
  const other = records.slice(base).filter((r) => !r.field).length;
  records.push({
    index,
    field: field !== null,
    label: `${prefix}${field ?? LABELS[other] ?? `program-${other}`}`,
    outputs: outputs.get(p) ?? 1,
    submitted: performance.now(),
    linkMs: -1,
    firstDrawMs: -1,
    againMs: -1,
    handle: p,
    fs: fragment.get(p) ?? '',
    pad0:
      /#define MRT_PAD 1\b/.test(fragment.get(p) ?? '') &&
      (fragment.get(p) ?? '').includes('o_pad'),
  });
  origLink.call(this, p);
};

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

async function run(): Promise<ColdReport> {
  const first = await measure('');
  if (new URLSearchParams(location.search).get('second') !== '1') return first;
  // A second device created after the first one is ready: does it hit the program cache?
  const second = await measure('2:');
  return { ...first, programs: [...first.programs, ...second.programs] };
}

async function measure(label: string): Promise<ColdReport> {
  base = records.length;
  prefix = label;
  const mine = (): ProgramRecord[] => records.slice(base);
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const layout = createParamLayout();
  const t0 = performance.now();
  const device = new GpuDevice(canvas, {
    opaque: true,
    paramsPrelude: layout.glslPrelude,
    warnMissingParams: false,
  });
  // The field program compiles per variant: ask for one (the probe polls and draws it itself).
  device.requestField(FEATURES);
  const deviceMs = performance.now() - t0;
  const gl = device.gl;
  const ext = device.caps.parallelCompile;
  // Background link: COMPLETION_STATUS per program, polled once per frame.
  for (;;) {
    const now = performance.now();
    let pending = 0;
    for (const r of mine()) {
      if (r.linkMs >= 0) continue;
      const done = ext ? gl.getProgramParameter(r.handle, ext.COMPLETION_STATUS_KHR) : true;
      if (done) r.linkMs = now - r.submitted;
      else pending++;
    }
    hud.textContent = `linking: ${pending} pending`;
    if (pending === 0) break;
    await frame();
  }
  const allLinkedMs = performance.now() - t0;
  if (device.error) throw device.error;
  // The block bindings the device sets up after link (GpuDevice.poll() would also warm the
  // programs up, which is what the probe measures without).
  for (const r of mine()) {
    for (const [name, binding] of [
      ['ParamsBlock', 0],
      ['FrameBlock', 1],
    ] as const) {
      const index = gl.getUniformBlockIndex(r.handle, name);
      if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(r.handle, index, binding);
    }
  }

  // Uniform buffers of the right sizes (a draw without them is skipped by WebGL).
  const params = new Float32Array(layout.floatCount);
  layout.writeAll(params, getDefaults());
  const ubo = (data: ArrayBufferView | number) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, b);
    if (typeof data === 'number') gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
    else gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
    return b;
  };
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo(params));
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, ubo(FRAME_BYTES));
  const fbs: (WebGLFramebuffer | null)[] = [null];
  const fbFor = (n: number, pad0 = false): WebGLFramebuffer | null => {
    const key = pad0 ? n + 16 : n;
    if (fbs[key] !== undefined) return fbs[key] ?? null;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const bufs: GLenum[] = [];
    for (let i = 0; i < n; i++) {
      if (pad0 && i === 0) {
        bufs.push(gl.NONE);
        continue;
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
    // readPixels reads the first real attachment (behind the MRT_PAD one).
    if (pad0) gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    fbs[n] = fb;
    return fb;
  };
  const vao = gl.createVertexArray();
  const px = new Uint8Array(4);
  const draw = (r: ProgramRecord): number => {
    const forced = Number(new URLSearchParams(location.search).get('outputs') ?? 0);
    const fb =
      r.label.endsWith('composite') || r.label.endsWith('lift')
        ? null
        : fbFor(forced > 0 ? forced : r.outputs, r.pad0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, 4, 4);
    const s = performance.now();
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
    gl.useProgram(r.handle);
    if (r.label === 'lift') {
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
      gl.bindVertexArray(null);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - s;
  };
  const asyncMode = new URLSearchParams(location.search).get('async') === '1';
  for (const r of mine()) {
    await frame();
    if (asyncMode) {
      // Draw without a synchronous readback: a fence tells when the GPU process is done, polled
      // once per frame; the longest frame gap shows whether compositing stalled meanwhile.
      const fb =
        r.label.endsWith('composite') || r.label.endsWith('lift') ? null : fbFor(r.outputs, r.pad0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, 4, 4);
      const s = performance.now();
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
      gl.useProgram(r.handle);
      if (r.label === 'lift') {
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
        gl.bindVertexArray(null);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      // Probe which calls block while the GPU process compiles: a program polled for
      // COMPLETION_STATUS (submitted now), LINK_STATUS of an old one, a uniform lookup.
      const probeKind = new URLSearchParams(location.search).get('probe');
      let probeProg: WebGLProgram | null = null;
      if (probeKind && r.label === 'field') {
        const vs = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
        const fs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
        gl.shaderSource(vs, '#version 300 es\nvoid main(){gl_Position=vec4(0.0);}');
        gl.shaderSource(
          fs,
          '#version 300 es\nprecision highp float;out vec4 o;uniform float u_x;void main(){o=vec4(u_x);}',
        );
        gl.compileShader(vs);
        gl.compileShader(fs);
        probeProg = gl.createProgram() as WebGLProgram;
        gl.attachShader(probeProg, vs);
        gl.attachShader(probeProg, fs);
        origLink.call(gl, probeProg);
      }
      const probeTimes: number[] = [];
      let last = performance.now();
      let gap = 0;
      let callMax = 0;
      for (;;) {
        const now = await frame();
        gap = Math.max(gap, now - last);
        last = now;
        if (probeProg) {
          const p0 = performance.now();
          if (probeKind === 'completion') {
            gl.getProgramParameter(probeProg, ext?.COMPLETION_STATUS_KHR ?? gl.LINK_STATUS);
          } else if (probeKind === 'fbstatus') {
            gl.checkFramebufferStatus(gl.FRAMEBUFFER);
          } else if (probeKind === 'uniform') {
            gl.getUniformLocation(mine()[0]?.handle as WebGLProgram, `u_nope${probeTimes.length}`);
          } else if (probeKind === 'link') {
            // After the small program completes: LINK_STATUS and a first uniform lookup.
            if (gl.getProgramParameter(probeProg, ext?.COMPLETION_STATUS_KHR ?? gl.LINK_STATUS)) {
              gl.getProgramParameter(probeProg, gl.LINK_STATUS);
              gl.getUniformLocation(probeProg, 'u_x');
              gl.getUniformBlockIndex(probeProg, 'Nope');
            }
          } else if (probeKind === 'context' && probeTimes.length === 3) {
            const c2 = document.createElement('canvas');
            const g2 = c2.getContext('webgl2');
            const t1 = performance.now();
            g2?.getExtension('EXT_color_buffer_float');
            g2?.getExtension('KHR_parallel_shader_compile');
            const t2 = performance.now();
            g2?.getParameter(g2.MAX_TEXTURE_SIZE);
            g2?.getParameter(g2.RENDERER);
            const t3 = performance.now();
            console.info(
              `probe context parts: create ${Math.round(t1 - p0)} ext ${Math.round(t2 - t1)} param ${Math.round(t3 - t2)}`,
            );
          } else if (probeKind === 'texture') {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.deleteTexture(t);
          }
          probeTimes.push(Math.round(performance.now() - p0));
        }
        const c0 = performance.now();
        const st = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
        callMax = Math.max(callMax, performance.now() - c0);
        if (st === gl.SIGNALED) break;
      }
      if (probeProg) console.info(`probe ${probeKind}: ${probeTimes.join(',')}`);
      r.firstDrawMs = performance.now() - s;
      r.againMs = Math.round(gap * 10) / 10;
      (r as ProgramRecord & { callMax?: number }).callMax = Math.round(callMax * 10) / 10;
      gl.deleteSync(sync);
    } else {
      r.firstDrawMs = draw(r);
      const err = gl.getError();
      if (err !== gl.NO_ERROR) console.warn(`probe error ${r.label}: 0x${err.toString(16)}`);
      r.againMs = draw(r);
    }
    hud.textContent = `drew ${r.label}`;
  }
  const report: ColdReport = {
    renderer: device.caps.renderer,
    deviceMs: Math.round(deviceMs),
    allLinkedMs: Math.round(allLinkedMs),
    programs: mine().map(({ handle: _h, fs: _fs, pad0: _p, ...r }) => ({
      ...r,
      submitted: Math.round(r.submitted),
      linkMs: Math.round(r.linkMs),
      firstDrawMs: Math.round(r.firstDrawMs * 10) / 10,
      againMs: Math.round(r.againMs * 10) / 10,
    })),
  };
  hud.textContent = report.programs
    .map((p) => `${p.label}: link ${p.linkMs} ms, first draw ${p.firstDrawMs} ms`)
    .join('\n');
  return report;
}

const query = new URLSearchParams(location.search);
if (query.get('fused') === '1') hideDirect3D();
const benchScenario = query.get('bench');
if (benchScenario) {
  const num = (k: string, d: number) => Number(query.get(k) ?? d);
  window.gpuBench = gpuBench(
    benchScenario,
    { w: num('w', 1920), h: num('h', 1080), pitch: num('pitch', 4) },
    num('frames', 300),
  );
  void window.gpuBench.then((r) => {
    hud.textContent = JSON.stringify(r, null, 1);
  });
} else if (query.get('fp') === '1') {
  window.fingerprint = fingerprint();
  void window.fingerprint.then((shots) => {
    hud.textContent = `fingerprint: ${shots.length} shots`;
  });
} else {
  window.cold = run();
  window.coldSources = {};
  void window.cold.then(() => {
    for (const r of records) window.coldSources[r.label] = r.fs;
  });
}
