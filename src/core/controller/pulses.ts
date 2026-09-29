/**
 * Expanding ring pulses (clicks, lift landings, API calls). At most MAX_PULSES live; when full,
 * the oldest minor pulse (landing ripple) is replaced first, then the oldest overall.
 */

import { MAX_PULSES, OFF_PULSE } from '../engine/frame-block';
import type { Geometry } from './geometry';
import { SPACE_CELLS, SPACE_CLIENT, SPACE_NORM } from './influences';
import { smoothstep } from './math';

export interface PulseInit {
  space: number;
  x: number;
  y: number;
  strength: number;
  /** Cells per second. */
  speed: number;
  /** Ring width, cells. */
  width: number;
  /** Linear RGB tint and its mix (0 = palette color). */
  r: number;
  g: number;
  b: number;
  colorMix: number;
  /** Lifetime, seconds. */
  duration: number;
  /** Landing ripples: replaced first when the list is full. */
  minor: boolean;
}

/** Attack time of a pulse, seconds (avoids a hard pop at spawn). */
const ATTACK = 0.06;

export class PulseList {
  private readonly space = new Uint8Array(MAX_PULSES);
  private readonly minor = new Uint8Array(MAX_PULSES);
  /** x, y, strength, speed, width, r, g, b, colorMix, age, duration */
  private readonly data = new Float64Array(MAX_PULSES * 11);
  count = 0;

  add(p: PulseInit): void {
    let i = this.count;
    if (i >= MAX_PULSES) {
      i = this.oldest(true);
      if (i < 0) i = this.oldest(false);
    } else {
      this.count++;
    }
    const d = this.data;
    const o = i * 11;
    this.space[i] = p.space;
    this.minor[i] = p.minor ? 1 : 0;
    d[o] = p.x;
    d[o + 1] = p.y;
    d[o + 2] = p.strength;
    d[o + 3] = p.speed;
    d[o + 4] = p.width;
    d[o + 5] = p.r;
    d[o + 6] = p.g;
    d[o + 7] = p.b;
    d[o + 8] = p.colorMix;
    d[o + 9] = 0;
    d[o + 10] = Math.max(0.05, p.duration);
  }

  clear(): void {
    this.count = 0;
  }

  get needsClientOrigin(): boolean {
    for (let i = 0; i < this.count; i++) if (this.space[i] === SPACE_CLIENT) return true;
    return false;
  }

  /** Current strength of pulse `i` (tests). */
  strengthAt(i: number): number {
    const o = i * 11;
    const d = this.data;
    return (d[o + 2] as number) * envelope(d[o + 9] as number, d[o + 10] as number);
  }

  /** Current radius of pulse `i` in cells (tests). */
  radiusCells(i: number): number {
    const o = i * 11;
    return (this.data[o + 3] as number) * (this.data[o + 9] as number);
  }

  /** Ages pulses, drops expired ones and writes f_pulse. Returns the count written. */
  step(dt: number, geo: Geometry, clientX: number, clientY: number, frame: Float32Array): number {
    const d = this.data;
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      const o = i * 11;
      const age = (d[o + 9] as number) + dt;
      if (age >= (d[o + 10] as number)) continue;
      d[o + 9] = age;
      if (w !== i) {
        d.copyWithin(w * 11, o, o + 11);
        this.space[w] = this.space[i] as number;
        this.minor[w] = this.minor[i] as number;
      }
      w++;
    }
    this.count = w;
    const pitch = geo.pitchPx;
    for (let i = 0; i < w; i++) {
      const o = i * 11;
      const x = d[o] as number;
      const y = d[o + 1] as number;
      let px: number;
      let py: number;
      switch (this.space[i]) {
        case SPACE_NORM:
          px = geo.hostX + x * geo.hostW;
          py = geo.hostY + y * geo.hostH;
          break;
        case SPACE_CELLS:
          px = geo.originX + (geo.pad + x + 0.5) * pitch;
          py = geo.originY + (geo.pad + y + 0.5) * pitch;
          break;
        case SPACE_CLIENT:
          px = geo.hostX + (x - clientX) * geo.sx;
          py = geo.hostY + (y - clientY) * geo.sy;
          break;
        default:
          px = geo.hostX + x * geo.sx;
          py = geo.hostY + y * geo.sy;
      }
      const age = d[o + 9] as number;
      const f = OFF_PULSE + i * 12;
      frame[f] = px;
      frame[f + 1] = py;
      frame[f + 2] = (d[o + 3] as number) * age * pitch;
      frame[f + 3] = (d[o + 4] as number) * pitch;
      frame[f + 4] = (d[o + 2] as number) * envelope(age, d[o + 10] as number);
      frame[f + 5] = d[o + 8] as number;
      frame[f + 6] = 0;
      frame[f + 7] = 0;
      frame[f + 8] = d[o + 5] as number;
      frame[f + 9] = d[o + 6] as number;
      frame[f + 10] = d[o + 7] as number;
      frame[f + 11] = 0;
    }
    return w;
  }

  private oldest(minorOnly: boolean): number {
    let best = -1;
    let bestAge = -1;
    for (let i = 0; i < this.count; i++) {
      if (minorOnly && this.minor[i] !== 1) continue;
      const age = (this.data[i * 11 + 9] as number) / (this.data[i * 11 + 10] as number);
      if (age > bestAge) {
        bestAge = age;
        best = i;
      }
    }
    return best;
  }
}

/** Quick attack, smooth fade over the rest of the life. */
function envelope(age: number, duration: number): number {
  const a = age < ATTACK ? age / ATTACK : 1;
  return a * (1 - smoothstep(0, 1, age / duration));
}
