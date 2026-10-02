/**
 * GPU frame timer: a ring of EXT_disjoint_timer_query_webgl2 queries. Results arrive a few frames
 * late; the newest valid one is kept in `ms`.
 *
 * Disjoint handling: reading GPU_DISJOINT_EXT clears it, so it is read once per frame and, when
 * set, every query still in flight is marked tainted (it may span the event) and its result is
 * dropped when it arrives. Results that are not finite or implausibly large are dropped too.
 */

import type { TimerQueryExt } from '../gl/caps';

/** The part of WebGL2 the timer uses (structurally satisfied by WebGL2RenderingContext). */
export interface TimerGL {
  readonly QUERY_RESULT: GLenum;
  readonly QUERY_RESULT_AVAILABLE: GLenum;
  createQuery(): WebGLQuery | null;
  deleteQuery(query: WebGLQuery | null): void;
  beginQuery(target: GLenum, query: WebGLQuery): void;
  endQuery(target: GLenum): void;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the WebGL signature.
  getQueryParameter(query: WebGLQuery, pname: GLenum): any;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the WebGL signature.
  getParameter(pname: GLenum): any;
}

/** No frame takes a second of GPU time: such a reading is a driver reset, not a measurement. */
const MAX_PLAUSIBLE_MS = 1000;

export class GpuTimer {
  readonly #queries: WebGLQuery[] = [];
  readonly #pending: boolean[] = [];
  /** In flight while a disjoint event was reported: the result is dropped on arrival. */
  readonly #tainted: boolean[] = [];
  /** Slot the next query uses; while it is pending it holds the oldest query in flight. */
  #head = 0;
  #active = false;
  /** Newest valid GPU time of a frame in ms, or null before the first result. */
  ms: number | null = null;

  readonly #gl: TimerGL;
  readonly #ext: TimerQueryExt;

  constructor(gl: TimerGL, ext: TimerQueryExt, size = 4) {
    this.#gl = gl;
    this.#ext = ext;
    for (let i = 0; i < size; i++) {
      const q = gl.createQuery();
      if (!q) break;
      this.#queries.push(q);
      this.#pending.push(false);
      this.#tainted.push(false);
    }
  }

  /** Collects finished results, then starts timing this frame (skipped while the ring is full). */
  begin(): void {
    const gl = this.#gl;
    const n = this.#queries.length;
    if (n === 0) return;
    if (gl.getParameter(this.#ext.GPU_DISJOINT_EXT)) {
      for (let i = 0; i < n; i++) if (this.#pending[i]) this.#tainted[i] = true;
    }
    // Oldest (slot head) to newest (head - 1), so the newest valid result is applied last.
    for (let k = 0; k < n; k++) {
      const i = (this.#head + k) % n;
      const q = this.#queries[i];
      if (!q || !this.#pending[i]) continue;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = Number(gl.getQueryParameter(q, gl.QUERY_RESULT));
      this.#pending[i] = false;
      const tainted = this.#tainted[i];
      this.#tainted[i] = false;
      const ms = ns / 1e6;
      if (!tainted && Number.isFinite(ms) && ms >= 0 && ms < MAX_PLAUSIBLE_MS) this.ms = ms;
    }
    const q = this.#queries[this.#head];
    if (!q || this.#pending[this.#head]) return;
    gl.beginQuery(this.#ext.TIME_ELAPSED_EXT, q);
    this.#active = true;
  }

  end(): void {
    if (!this.#active) return;
    this.#gl.endQuery(this.#ext.TIME_ELAPSED_EXT);
    this.#active = false;
    this.#pending[this.#head] = true;
    this.#head = (this.#head + 1) % this.#queries.length;
  }

  dispose(): void {
    if (this.#active) this.#gl.endQuery(this.#ext.TIME_ELAPSED_EXT);
    this.#active = false;
    for (const q of this.#queries) this.#gl.deleteQuery(q);
    this.#queries.length = 0;
  }
}
