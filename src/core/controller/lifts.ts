/**
 * Lifted ("popped out") cells: a short explicit list instead of one instance per grid cell.
 *
 * Random lifts are spawned by a Poisson process sized so that about `amount * cells` are up at
 * any time (Little's law: rate = expected / mean lifetime), preferring the outer band of the
 * composition. Envelopes run on the CPU: an underdamped spring rise, a gentle bob while held, an
 * ease-in fall, then a short landing squash with a small ripple. The 'float' style instead drifts
 * upward and fades out, leaving the canvas (useful with render.overflow).
 *
 * Output per frame: LIFT_STRIDE floats per visible instance and one f_socket record per lift so
 * the source cell dims while its copy hovers.
 */

import { MAX_LIFTS, OFF_SOCKET } from '../engine/frame-block';
import {
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
} from '../engine/types';
import type { Geometry } from './geometry';
import { SPACE_CELLS } from './influences';
import { mix, smoothstep, TAU } from './math';
import type { PulseInit, PulseList } from './pulses';

/** Lift settings for one frame (a persistent object the controller refills). */
export interface LiftParams {
  /** Random spawning on (lift.enabled and not reduced motion). */
  enabled: boolean;
  /** 0 pop, 1 float. */
  style: number;
  amount: number;
  max: number;
  scale: number;
  /** Cells. */
  height: number;
  parallax: number;
  /** Degrees. */
  tilt: number;
  holdMin: number;
  holdMax: number;
  rise: number;
  fall: number;
  bokeh: number;
  socket: number;
  outerBias: number;
  cluster: number;
  landing: number;
  /** Cells per second. */
  floatSpeed: number;
  floatDrift: number;
  /** Composition center (mode units) and zoom, for the outer-band spawn bias. */
  sceneX: number;
  sceneY: number;
  zoom: number;
}

export function createLiftParams(): LiftParams {
  return {
    enabled: true,
    style: 0,
    amount: 0.016,
    max: 96,
    scale: 1.5,
    height: 0.35,
    parallax: 0.06,
    tilt: 6,
    holdMin: 1.5,
    holdMax: 3.5,
    rise: 0.6,
    fall: 0.45,
    bokeh: 0.3,
    socket: 0.6,
    outerBias: 0.85,
    cluster: 0.15,
    landing: 0.25,
    floatSpeed: 0.9,
    floatDrift: 0.4,
    sceneX: 0,
    sceneY: 0,
    zoom: 1,
  };
}

/** Landing squash duration, seconds. */
export const LANDING = 0.09;
const SPRING_ZETA = 0.55;
const SPRING_DAMPED = Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);

/** Underdamped spring step response (0 -> ~1.13 peak -> 1). */
export function springRise(t: number, rise: number): number {
  if (t <= 0) return 0;
  const w = (TAU / Math.max(0.05, rise)) * 0.9;
  const zw = SPRING_ZETA * w;
  const wd = w * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
  return 1 - Math.exp(-zw * t) * (Math.cos(wd * t) + (zw / wd) * Math.sin(wd * t));
}

function bob(t: number, rise: number, seed: number): number {
  return 0.03 * Math.sin(TAU * 0.45 * t + seed * TAU) * Math.min(1, t / Math.max(0.05, rise));
}

// Record layout (Float64Array, F floats per lift).
const F = 19;
const CI = 0; // cell column relative to the center column
const CJ = 1;
const AGE = 2;
const HOLD = 3;
const SEED = 4;
const DEPTH = 5;
const RISE = 6;
const FALL = 7;
const H0 = 8; // height when the fall started
const T0 = 9; // start time of the current phase
const PHASE = 10; // 0 up (rise + hold), 1 fall, 2 landing
const STYLE = 11;
const FORCED = 12;
const TILT_A = 13;
const TILT_B = 14;
const F1 = 15;
const F2 = 16;
const P1 = 17;
const P2 = 18;

const DEG = Math.PI / 180;
/** The 8 neighbour offsets (dx, dy) for cluster spawns. */
const NEIGHBOURS = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1] as const;

export class LiftScheduler {
  readonly instances = new Float32Array(MAX_LIFTS * LIFT_STRIDE);
  /** Records alive (including ones still waiting for a cluster delay). */
  count = 0;
  /** Instances written by the last step(). */
  written = 0;
  /**
   * Expected-event mass left before the next random spawn. Spawns form a Poisson process
   * with exponential inter-arrival masses, so random numbers are drawn only when something
   * spawns (not every frame) and a varying rate needs no special handling.
   */
  private budget = -1;
  private readonly rec = new Float64Array(MAX_LIFTS * F);
  private readonly landingPulse: PulseInit = {
    space: SPACE_CELLS,
    x: 0,
    y: 0,
    strength: 0,
    speed: 6,
    width: 1,
    r: 1,
    g: 1,
    b: 1,
    colorMix: 0,
    duration: 0.5,
    minor: true,
  };

  constructor(
    private readonly random: () => number,
    private readonly pulses: PulseList | null,
  ) {}

  clear(): void {
    this.count = 0;
    this.written = 0;
  }

  /** Forced lifts (lift() calls, pointer hover) still in the air. */
  get forcedAlive(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.rec[i * F + FORCED] === 1) n++;
    return n;
  }

  /**
   * Replaces every lift with those of `from`, moved by (-dx, -dy) cells: the same cells of a
   * picture whose center cell sits (dx, dy) cells from `from`'s (a card leaving or joining a
   * shared look, see Controller.adoptLook). Lifts that land outside the grid are dropped by the
   * next step. Keeps the spawn process going where `from` was.
   */
  adopt(from: LiftScheduler, dx: number, dy: number): void {
    const n = from.count;
    this.rec.set(from.rec.subarray(0, n * F));
    for (let i = 0; i < n; i++) {
      this.rec[i * F + CI] = (this.rec[i * F + CI] as number) - dx;
      this.rec[i * F + CJ] = (this.rec[i * F + CJ] as number) - dy;
    }
    this.count = n;
    this.written = 0;
    this.budget = from.budget;
  }

  /** Expected lifetime of one random lift, seconds. */
  static meanLifetime(p: LiftParams): number {
    const lo = Math.min(p.holdMin, p.holdMax);
    const hi = Math.max(p.holdMin, p.holdMax);
    return p.rise + (lo + hi) / 2 + p.fall + (p.style === 0 ? LANDING : 0);
  }

  /**
   * Lifts `count` cells around the cell (ci, cj) (relative to the center cell), the first one
   * exactly there, the others within `radius` cells. Returns how many were added.
   */
  force(
    ci: number,
    cj: number,
    count: number,
    radius: number,
    p: LiftParams,
    geo: Geometry,
  ): number {
    const hx = (geo.cols - 1) / 2;
    const hy = (geo.rows - 1) / 2;
    let added = 0;
    const n = Math.max(1, Math.floor(count));
    for (let k = 0, tries = 0; k < n && tries < n * 6 && this.count < MAX_LIFTS; tries++) {
      let x = Math.round(ci);
      let y = Math.round(cj);
      if (k > 0 || tries > 0) {
        const a = this.random() * TAU;
        const r = Math.sqrt(this.random()) * Math.max(1, radius);
        x = Math.round(ci + Math.cos(a) * r);
        y = Math.round(cj + Math.sin(a) * r);
      }
      if (Math.abs(x) > hx || Math.abs(y) > hy || this.has(x, y)) continue;
      this.spawn(x, y, k === 0 ? 0 : -this.random() * 0.12, p, true);
      added++;
      k++;
    }
    return added;
  }

  /**
   * Spawns, ages and evaluates lifts; writes instances and sockets.
   * Returns the number of sockets (= instances) written.
   */
  step(dt: number, p: LiftParams, geo: Geometry, frame: Float32Array): number {
    this.spawnRandom(dt, p, geo);
    const rec = this.rec;
    const out = this.instances;
    const hx = (geo.cols - 1) / 2;
    const hy = (geo.rows - 1) / 2;
    const pitch = geo.pitchPx;
    const tiltRad = p.tilt * DEG;
    let w = 0;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const o = i * F;
      const ci = rec[o + CI] as number;
      const cj = rec[o + CJ] as number;
      if (Math.abs(ci) > hx || Math.abs(cj) > hy) continue; // grid shrank under it
      const age = (rec[o + AGE] as number) + dt;
      rec[o + AGE] = age;
      let keep = true;
      let h = 0;
      let alpha = 0;
      let sx = 1;
      let sy = 1;
      let dx = 0;
      let dy = 0;
      let sock = 0;
      if (age >= 0) {
        const rise = rec[o + RISE] as number;
        const seed = rec[o + SEED] as number;
        // Spring rise + bob, inlined: a helper returning a double would box it every frame.
        const sw = (TAU / rise) * 0.9;
        const zw = SPRING_ZETA * sw;
        const wd = sw * SPRING_DAMPED;
        const up =
          1 -
          Math.exp(-zw * age) * (Math.cos(wd * age) + (zw / wd) * Math.sin(wd * age)) +
          0.03 * Math.sin(TAU * 0.45 * age + seed * TAU) * Math.min(1, age / rise);
        if (rec[o + STYLE] === 1) {
          // Float: rise, then keep drifting upward and fade out over the last 30%.
          const life = rise + (rec[o + HOLD] as number) + (rec[o + FALL] as number);
          if (age >= life) keep = false;
          else {
            h = up;
            const u = age / life;
            alpha = Math.min(1, h * 4) * (1 - smoothstep(0.7, 1, u));
            const s = mix(1, 0.8, u);
            sx = s;
            sy = s;
            const ramp = Math.min(1, age);
            const drift = p.floatDrift * pitch * ramp;
            dx =
              drift *
              (Math.sin(TAU * (rec[o + F1] as number) * age + (rec[o + P1] as number)) +
                0.5 * Math.sin(TAU * (rec[o + F2] as number) * age + (rec[o + P2] as number)));
            dy =
              -p.floatSpeed * pitch * age +
              0.3 * drift * Math.sin(TAU * (rec[o + F2] as number) * age + (rec[o + P1] as number));
            sock = p.socket * Math.min(1, Math.max(0, h)) * (1 - smoothstep(0.15, 0.5, u));
          }
        } else {
          const hold = rec[o + HOLD] as number;
          const fall = Math.max(0.05, rec[o + FALL] as number);
          let phase = rec[o + PHASE] as number;
          if (phase === 0 && age >= rise + hold) {
            phase = 1;
            rec[o + PHASE] = 1;
            rec[o + T0] = rise + hold;
            rec[o + H0] = springRise(rise + hold, rise) + bob(rise + hold, rise, seed);
          }
          if (phase === 1) {
            const k = (age - (rec[o + T0] as number)) / fall;
            if (k >= 1) {
              phase = 2;
              rec[o + PHASE] = 2;
              rec[o + T0] = age;
              this.land(ci + hx, cj + hy, p);
            } else {
              h = (rec[o + H0] as number) * (1 - k * k);
            }
          }
          if (phase === 0) {
            h = up;
          } else if (phase === 2) {
            const u = (age - (rec[o + T0] as number)) / LANDING;
            if (u >= 1) keep = false;
            else {
              const q = Math.sin(Math.PI * u);
              sx = 1 + 0.06 * q;
              sy = 1 - 0.06 * q;
              h = 0;
              alpha = 1 - u;
            }
          }
          if (phase !== 2) alpha = Math.min(1, Math.max(0, h) * 4);
          sock = p.socket * Math.min(1, Math.max(0, h));
        }
      }
      if (!keep) continue;
      if (w !== i) rec.copyWithin(w * F, o, o + F);
      w++;
      if (age < 0 || n >= MAX_LIFTS) continue;

      const hp = Math.max(0, h);
      const tx = ci + hx + geo.pad;
      const ty = cj + hy + geo.pad;
      const cx = geo.originX + (tx + 0.5) * pitch;
      const cy = geo.originY + (ty + 0.5) * pitch;
      const lo = n * LIFT_STRIDE;
      const sc = 1 + (p.scale - 1) * hp;
      out[lo + LIFT_CELL_X] = tx;
      out[lo + LIFT_CELL_Y] = ty;
      out[lo + LIFT_OFF_X] = (cx - geo.centerX) * p.parallax * hp + dx;
      out[lo + LIFT_OFF_Y] = (cy - geo.centerY) * p.parallax * hp - p.height * pitch * hp + dy;
      out[lo + LIFT_SCALE_X] = sc * sx;
      out[lo + LIFT_SCALE_Y] = sc * sy;
      out[lo + LIFT_TILT_X] = (rec[o + TILT_A] as number) * tiltRad * hp;
      out[lo + LIFT_TILT_Y] = (rec[o + TILT_B] as number) * tiltRad * hp;
      out[lo + LIFT_H] = h;
      out[lo + LIFT_ALPHA] = alpha;
      // Bokeh: only a `bokeh` share of lifts is out of focus (soft over 0.12-0.3 pitch); the
      // rest stay crisp like the grid.
      const depth = rec[o + DEPTH] as number;
      out[lo + LIFT_BLUR] =
        depth < p.bokeh ? (0.12 + (0.18 * depth) / Math.max(p.bokeh, 1e-3)) * pitch * hp : 0;
      out[lo + LIFT_SEED] = rec[o + SEED] as number;
      const so = OFF_SOCKET + n * 4;
      frame[so] = tx;
      frame[so + 1] = ty;
      frame[so + 2] = sock;
      frame[so + 3] = 0;
      n++;
    }
    this.count = w;
    this.written = n;
    return n;
  }

  // -------------------------------------------------------------------------------------------

  private has(ci: number, cj: number): boolean {
    const rec = this.rec;
    for (let i = 0; i < this.count; i++) {
      if (rec[i * F + CI] === ci && rec[i * F + CJ] === cj) return true;
    }
    return false;
  }

  private spawnRandom(dt: number, p: LiftParams, geo: Geometry): void {
    if (!p.enabled || !(p.amount > 0) || !(p.max >= 1) || dt <= 0) return;
    const pitch = geo.pitchPx;
    // Only cells whose centers lie inside the host rect (odd counts: symmetric around center).
    const mx = Math.floor(geo.hostW / 2 / pitch);
    const my = Math.floor(geo.hostH / 2 / pitch);
    const cells = (2 * mx + 1) * (2 * my + 1);
    const lo = p.holdMin < p.holdMax ? p.holdMin : p.holdMax;
    const hi = p.holdMin < p.holdMax ? p.holdMax : p.holdMin;
    const life = p.rise + (lo + hi) / 2 + p.fall + (p.style === 0 ? LANDING : 0);
    // Little's law (active = rate x lifetime); clusters add ~2 neighbours with probability
    // `cluster`, so the seed rate is lowered to keep the expected total.
    const rate = (p.amount * cells) / life / (1 + 2 * Math.max(0, p.cluster));
    if (this.budget < 0) this.budget = -Math.log(1 - this.random());
    this.budget -= rate * dt;
    if (this.budget > 0) return;
    const cap = Math.min(MAX_LIFTS, Math.floor(p.max));
    const inv = 1 / Math.max(1, geo.halfMin);
    const zoom = Math.max(0.05, p.zoom);
    for (let guard = 0; this.budget <= 0 && guard < 64; guard++) {
      this.budget += -Math.log(1 - this.random());
      if (this.count >= cap) continue; // dropped at the cap
      for (let tries = 0; tries < 24; tries++) {
        const ci = Math.floor(this.random() * (2 * mx + 1)) - mx;
        const cj = Math.floor(this.random() * (2 * my + 1)) - my;
        // Outer-band bias in mode units (field intensity is only known on the GPU, which gates
        // lifts over dark cells itself).
        const px = (ci * pitch * inv - p.sceneX) / zoom;
        const py = (cj * pitch * inv - p.sceneY) / zoom;
        const r = Math.sqrt(px * px + py * py);
        // Outer band of the ring, not the far corners (those cells are mostly dropped anyway).
        const weight = mix(
          1,
          smoothstep(0.6, 0.85, r) * (1 - 0.6 * smoothstep(1.15, 1.45, r)),
          p.outerBias,
        );
        if (this.random() >= weight || this.has(ci, cj)) continue;
        this.spawn(ci, cj, 0, p, false);
        if (this.random() < p.cluster) this.spawnCluster(ci, cj, mx, my, cap, p);
        break;
      }
    }
    if (this.budget < 0) this.budget = 0;
  }

  private spawnCluster(
    ci: number,
    cj: number,
    mx: number,
    my: number,
    cap: number,
    p: LiftParams,
  ): void {
    const extra = 1 + Math.floor(this.random() * 3);
    for (let e = 0; e < extra && this.count < cap; e++) {
      const dir = Math.floor(this.random() * 8) * 2;
      const x = ci + (NEIGHBOURS[dir] as number);
      const y = cj + (NEIGHBOURS[dir + 1] as number);
      if (Math.abs(x) > mx || Math.abs(y) > my || this.has(x, y)) continue;
      this.spawn(x, y, -(0.04 + this.random() * 0.14), p, false);
    }
  }

  private spawn(ci: number, cj: number, age: number, p: LiftParams, forced: boolean): void {
    if (this.count >= MAX_LIFTS) return;
    const rnd = this.random;
    const o = this.count * F;
    const rec = this.rec;
    const lo = Math.min(p.holdMin, p.holdMax);
    const hi = Math.max(p.holdMin, p.holdMax);
    rec[o + CI] = ci;
    rec[o + CJ] = cj;
    rec[o + AGE] = age;
    rec[o + HOLD] = lo + rnd() * (hi - lo);
    rec[o + SEED] = rnd();
    rec[o + DEPTH] = rnd();
    rec[o + RISE] = Math.max(0.05, p.rise);
    rec[o + FALL] = Math.max(0.05, p.fall);
    rec[o + H0] = 1;
    rec[o + T0] = 0;
    rec[o + PHASE] = 0;
    rec[o + STYLE] = p.style;
    rec[o + FORCED] = forced ? 1 : 0;
    rec[o + TILT_A] = rnd() * 2 - 1;
    rec[o + TILT_B] = rnd() * 2 - 1;
    rec[o + F1] = 0.2 + 0.3 * rnd();
    rec[o + F2] = 0.5 + 0.6 * rnd();
    rec[o + P1] = rnd() * TAU;
    rec[o + P2] = rnd() * TAU;
    this.count++;
  }

  /** Landing ripple at the cell (visible-cell coordinates). */
  private land(cellX: number, cellY: number, p: LiftParams): void {
    if (!this.pulses || !(p.landing > 0)) return;
    const lp = this.landingPulse;
    lp.x = cellX;
    lp.y = cellY;
    lp.strength = p.landing;
    this.pulses.add(lp);
  }
}
