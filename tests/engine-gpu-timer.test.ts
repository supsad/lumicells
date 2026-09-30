import { describe, expect, it } from 'vitest';
import { GpuTimer, type TimerGL } from '../src/core/engine/gpu-timer';
import type { TimerQueryExt } from '../src/core/gl/caps';

interface FakeQuery {
  id: number;
  available: boolean;
  ns: number;
}

const EXT: TimerQueryExt = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };

/** Minimal EXT_disjoint_timer_query_webgl2 model: reading the disjoint flag clears it. */
class FakeGL implements TimerGL {
  readonly QUERY_RESULT = 0x8866;
  readonly QUERY_RESULT_AVAILABLE = 0x8867;
  readonly queries: FakeQuery[] = [];
  /** Queries in the order they were ended (oldest first). */
  readonly ended: FakeQuery[] = [];
  disjoint = false;
  private current: FakeQuery | null = null;

  createQuery(): WebGLQuery | null {
    const q: FakeQuery = { id: this.queries.length, available: false, ns: 0 };
    this.queries.push(q);
    return q as unknown as WebGLQuery;
  }
  deleteQuery(): void {}
  beginQuery(_target: GLenum, query: WebGLQuery): void {
    const q = query as unknown as FakeQuery;
    q.available = false;
    this.current = q;
  }
  endQuery(): void {
    if (this.current) this.ended.push(this.current);
    this.current = null;
  }
  getQueryParameter(query: WebGLQuery, pname: GLenum): unknown {
    const q = query as unknown as FakeQuery;
    return pname === this.QUERY_RESULT_AVAILABLE ? q.available : q.ns;
  }
  getParameter(pname: GLenum): unknown {
    if (pname !== EXT.GPU_DISJOINT_EXT) return null;
    const d = this.disjoint;
    this.disjoint = false;
    return d;
  }
  /** Resolves the oldest `n` unresolved ended queries with the given times (ms). */
  resolve(...ms: number[]): void {
    for (const t of ms) {
      const q = this.ended.shift();
      if (!q) throw new Error('nothing in flight');
      q.ns = t * 1e6;
      q.available = true;
    }
  }
}

function frame(t: GpuTimer): void {
  t.begin();
  t.end();
}

describe('GpuTimer', () => {
  it('keeps the newest result when several resolve in the same frame', () => {
    const gl = new FakeGL();
    const t = new GpuTimer(gl, EXT);
    // Fill the ring: four queries in flight, the slot to reuse holds the oldest one.
    for (let i = 0; i < 4; i++) frame(t);
    gl.resolve(4, 5, 6, 7);
    t.begin();
    expect(t.ms).toBe(7);
  });

  it('drops every query in flight during a disjoint event, including late ones', () => {
    const gl = new FakeGL();
    const t = new GpuTimer(gl, EXT);
    frame(t);
    gl.resolve(3);
    frame(t);
    expect(t.ms).toBe(3);
    frame(t);
    frame(t);
    // Three queries in flight, then the GPU reports a disjoint (a power-state change).
    gl.disjoint = true;
    gl.resolve(500);
    frame(t); // reads (and clears) the flag: all three are tainted, the first result is dropped
    expect(t.ms).toBe(3);
    gl.resolve(800, 900);
    frame(t); // flag already cleared, but these spanned the event too
    expect(t.ms).toBe(3);
    // Queries started after the event are valid again.
    gl.resolve(4.5);
    t.begin();
    expect(t.ms).toBe(4.5);
  });

  it('ignores implausible readings', () => {
    const gl = new FakeGL();
    const t = new GpuTimer(gl, EXT);
    frame(t);
    gl.resolve(2);
    frame(t);
    gl.resolve(5000);
    t.begin();
    expect(t.ms).toBe(2);
  });

  it('does not reuse a slot whose result is still pending', () => {
    const gl = new FakeGL();
    const t = new GpuTimer(gl, EXT);
    for (let i = 0; i < 6; i++) frame(t);
    // Only four queries exist; frames 5 and 6 found the ring full and were not timed.
    expect(gl.ended.length).toBe(4);
    gl.resolve(1, 1, 1, 2);
    frame(t);
    expect(t.ms).toBe(2);
    expect(gl.ended.length).toBe(1);
  });
});
