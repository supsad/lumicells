/**
 * Life pass: Conway-family automaton on the cell grid (incl. pad), run only on step ticks.
 *
 * State texel: r alive (0/1), g steps since the last change (saturating), b age in steps,
 * a the displayed level at the last change (fades continue from it, see modes/life.ts).
 * The field pass turns g + stepFrac into an analytic fade, so nothing here runs per frame.
 * Modes: 0 step, 1 reset (random fill), 2 remap (grid resized: keep cells aligned to the center).
 */

import { FULLSCREEN_VS } from '../glsl/common';
import { INFLUENCE_GLSL } from '../glsl/influence';
import { LIFE_LEVEL_GLSL } from '../glsl/modes/life';
import type { FrameInputs } from '../types';
import {
  bindTexture,
  discardTargets,
  LazyProgram,
  type PassContext,
  setSampler,
  UNIT_SRC,
} from './shared';

export const LIFE_MODE_STEP = 0;
export const LIFE_MODE_RESET = 1;
export const LIFE_MODE_REMAP = 2;

function lifeFs(header: string): string {
  return `${header}
${INFLUENCE_GLSL}
${LIFE_LEVEL_GLSL}
uniform sampler2D u_prev;
uniform ivec4 u_size;   // xy current logical size, zw previous logical size (remap)
uniform int u_mode;
uniform uint u_seed;
uniform int u_rule;
uniform float u_birth;
uniform float u_density;
out vec4 o_state;

float aliveAt(ivec2 c) {
  return texelFetch(u_prev, (c + u_size.xy) % u_size.xy, 0).r;
}

vec4 seeded(uvec2 key) {
  float a = step(u01(hash3(uvec3(key, u_seed ^ 0x5bd1e995u))), u_density);
  return vec4(a, 0.0, 0.0, 0.0);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  uvec2 key = uvec2(c + 4096);
  if (u_mode == 1) { o_state = seeded(key); return; }
  if (u_mode == 2) {
    ivec2 src = c + (u_size.zw - u_size.xy) / 2;
    bool inside = all(greaterThanEqual(src, ivec2(0))) && all(lessThan(src, u_size.zw));
    o_state = inside ? texelFetch(u_prev, src, 0) : seeded(key);
    return;
  }
  vec4 self = texelFetch(u_prev, c, 0);
  int n = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      n += aliveAt(c + ivec2(dx, dy)) > 0.5 ? 1 : 0;
    }
  }
  // Birth / survival masks: bit k set = rule applies with k live neighbours.
  int bm = 8;    int sm = 12;            // conway    B3/S23
  if (u_rule == 1) { bm = 72; sm = 12; } // highlife  B36/S23
  if (u_rule == 2) { bm = 456; sm = 472; } // daynight B3678/S34678
  if (u_rule == 3) { bm = 4; sm = 0; }   // seeds     B2/S
  bool alive = self.r > 0.5;
  bool next = alive ? ((sm >> n) & 1) == 1 : ((bm >> n) & 1) == 1;
  if (!next && u01(hash3(uvec3(key, u_seed))) < u_birth) next = true;
  if (!next) {
    float pitch = f_grid.z;
    vec2 px = f_origin.xy + (vec2(c) + 0.5) * pitch;
    int nInf = int(f_counts.x + 0.5);
    float seedP = 0.0;
    for (int i = 0; i < MAX_INFLUENCES; i++) {
      if (i >= nInf) break;
      vec4 b = f_inf[i * 3 + 1];
      if (abs(b.w - 3.0) < 0.5) seedP = max(seedP, influenceK(i, px, pitch) * sat(b.z) * 0.5);
    }
    if (seedP > 0.0 && u01(hash3(uvec3(key, u_seed ^ 0x27d4eb2du))) < seedP) next = true;
  }
  float g = next == alive ? min(self.g * 255.0 + 1.0, 255.0) : 0.0;
  float age = next ? min(self.b * 255.0 + 1.0, 255.0) : 0.0;
  // On a change, remember the level shown at the end of the previous step.
  float lvl = next == alive ? self.a : lifeLevel(self, 1.0);
  o_state = vec4(next ? 1.0 : 0.0, g / 255.0, age / 255.0, lvl);
}
`;
}

export class LifePass {
  private readonly prog: LazyProgram;
  private stepCounter = 0;

  constructor(private readonly ctx: PassContext) {
    this.prog = new LazyProgram(ctx, FULLSCREEN_VS, lifeFs(ctx.header), 'life', (p) => {
      setSampler(ctx.gl, p, 'u_prev', UNIT_SRC);
    });
  }

  poll(): boolean {
    return this.prog.poll();
  }

  /** Renders the next state of `src` into `dst` (viewport must be set to w x h by the caller). */
  run(
    mode: number,
    src: WebGLTexture,
    dst: WebGLFramebuffer,
    w: number,
    h: number,
    prevW: number,
    prevH: number,
    f: FrameInputs,
  ): void {
    const gl = this.ctx.gl;
    const p = this.prog.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst);
    // Every texel of the logical rect is rewritten: tiled GPUs need not load the old contents.
    discardTargets(this.ctx);
    gl.viewport(0, 0, w, h);
    bindTexture(gl, UNIT_SRC, src);
    gl.uniform4i(p.uniform('u_size'), w, h, Math.max(1, prevW), Math.max(1, prevH));
    gl.uniform1i(p.uniform('u_mode'), mode);
    // Mix a local counter in so a producer that never changes lifeSeed still gets fresh births.
    this.stepCounter = (this.stepCounter + 1) >>> 0;
    gl.uniform1ui(
      p.uniform('u_seed'),
      ((f.lifeSeed >>> 0) ^ Math.imul(this.stepCounter, 0x9e3779b1)) >>> 0,
    );
    gl.uniform1i(p.uniform('u_rule'), f.lifeRule | 0);
    gl.uniform1f(p.uniform('u_birth'), f.lifeBirth);
    gl.uniform1f(p.uniform('u_density'), f.lifeSeedDensity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.prog.dispose();
  }
}
