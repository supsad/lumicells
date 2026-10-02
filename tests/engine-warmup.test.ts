/**
 * Page-wide warm-up state (src/core/engine/warmup.ts): fences followed by whoever asks, claims
 * that let a device link from the program cache instead of compiling again, and the pacer of the
 * first context creation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adoptPacer,
  CLAIM_TIMEOUT_MS,
  claimCompile,
  type FenceGL,
  forgetWarmups,
  gpuBusy,
  PACE_TIMEOUT_MS,
  PACER_IDLE_MS,
  type PacerGL,
  readyForContext,
  releaseCompile,
  resetWarmupForTesting,
  trackWarmup,
  WARM_TIMEOUT_MS,
} from '../src/core/engine/warmup';

interface FakeFenceGL extends FenceGL {
  signaled: Set<WebGLSync>;
  deleted: WebGLSync[];
  lost: boolean;
  polls: number;
  /** Polls without SYNC_FLUSH_COMMANDS_BIT (Firefox warns after 100 of one fence). */
  unflushedPolls: number;
}

// WebGL2's values.
const ALREADY_SIGNALED = 0x911a;
const TIMEOUT_EXPIRED = 0x911b;
const CONDITION_SATISFIED = 0x911c;
const SYNC_FLUSH_COMMANDS_BIT = 0x1;

function fenceGL(): FakeFenceGL {
  const gl: FakeFenceGL = {
    SYNC_FLUSH_COMMANDS_BIT,
    ALREADY_SIGNALED,
    CONDITION_SATISFIED,
    signaled: new Set(),
    deleted: [],
    lost: false,
    polls: 0,
    unflushedPolls: 0,
    clientWaitSync(sync: WebGLSync, flags: GLbitfield, timeout: GLuint64) {
      gl.polls++;
      if (!(flags & SYNC_FLUSH_COMMANDS_BIT)) gl.unflushedPolls++;
      // Never blocks.
      expect(timeout).toBe(0);
      return gl.signaled.has(sync) ? CONDITION_SATISFIED : TIMEOUT_EXPIRED;
    },
    deleteSync(sync: WebGLSync | null) {
      if (sync) gl.deleted.push(sync);
    },
    isContextLost: () => gl.lost,
  };
  return gl;
}

const sync = () => ({}) as WebGLSync;

/** The next task: fences are polled once per task (see warmup.ts). */
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

interface FakePacerGL extends FakeFenceGL, PacerGL {
  fences: WebGLSync[];
  flushes: number;
}

function pacerGL(): FakePacerGL {
  const gl = fenceGL() as FakePacerGL;
  Object.assign(gl, {
    SYNC_GPU_COMMANDS_COMPLETE: 4,
    fences: [],
    flushes: 0,
    fenceSync() {
      const f = sync();
      gl.fences.push(f);
      return f;
    },
    flush() {
      gl.flushes++;
    },
  });
  return gl;
}

afterEach(() => {
  resetWarmupForTesting();
  vi.useRealTimers();
});

describe('warm-up fences', () => {
  it('keep the page busy until the GPU is past them, then run done once', async () => {
    const gl = fenceGL();
    const s = sync();
    const done = vi.fn();
    expect(gpuBusy()).toBe(false);
    trackWarmup(gl, s, done);
    expect(gpuBusy()).toBe(true);
    await nextTask();
    expect(gpuBusy()).toBe(true);
    expect(done).not.toHaveBeenCalled();
    gl.signaled.add(s);
    await nextTask();
    expect(gpuBusy()).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
    expect(gl.deleted).toEqual([s]);
    await nextTask();
    expect(gpuBusy()).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('are polled once per task, whoever asks, always with SYNC_FLUSH_COMMANDS_BIT', async () => {
    const gl = fenceGL();
    const s = sync();
    trackWarmup(gl, s, vi.fn());
    // A hundred instances asking in one frame cost one poll (a sync object only changes state
    // between tasks), and no poll goes without the flush bit (Firefox warns after 100 of those).
    for (let i = 0; i < 100; i++) expect(gpuBusy()).toBe(true);
    expect(gl.polls).toBe(1);
    gl.signaled.add(s);
    expect(gpuBusy()).toBe(true);
    expect(gl.polls).toBe(1);
    await nextTask();
    expect(gpuBusy()).toBe(false);
    expect(gl.polls).toBe(2);
    expect(gl.unflushedPolls).toBe(0);
    // A fence tracked after this task's poll waits for the next task (it cannot have passed).
    trackWarmup(gl, sync(), vi.fn());
    expect(gpuBusy()).toBe(true);
    expect(gl.polls).toBe(2);
  });

  it('are settled by any caller: a device that stopped polling holds nobody back', async () => {
    const a = fenceGL();
    const b = fenceGL();
    const sa = sync();
    const sb = sync();
    const doneA = vi.fn();
    trackWarmup(a, sa, doneA);
    trackWarmup(b, sb, vi.fn());
    b.signaled.add(sb);
    expect(gpuBusy()).toBe(true);
    a.signaled.add(sa);
    await nextTask();
    expect(gpuBusy()).toBe(false);
    expect(doneA).toHaveBeenCalledTimes(1);
  });

  it('end without done on a lost context, and when the device forgets them', () => {
    const a = fenceGL();
    const b = fenceGL();
    const doneA = vi.fn();
    const doneB = vi.fn();
    trackWarmup(a, sync(), doneA);
    trackWarmup(b, sync(), doneB);
    a.lost = true;
    forgetWarmups(b);
    expect(gpuBusy()).toBe(false);
    expect(doneA).not.toHaveBeenCalled();
    expect(doneB).not.toHaveBeenCalled();
    expect(a.deleted).toEqual([]);
    expect(b.deleted).toHaveLength(1);
  });

  it('are given up after WARM_TIMEOUT_MS (a fence that never signals)', async () => {
    vi.useFakeTimers();
    const gl = fenceGL();
    const done = vi.fn();
    trackWarmup(gl, sync(), done);
    vi.advanceTimersByTime(WARM_TIMEOUT_MS - 1);
    expect(gpuBusy()).toBe(true);
    vi.advanceTimersByTime(2);
    // Fake timers leave microtasks alone: the task ends once its microtasks ran.
    await Promise.resolve();
    expect(gpuBusy()).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('compile claims', () => {
  it('let one device compile a program set at a time; others wait, other sets do not', () => {
    const a = {};
    const b = {};
    const c = {};
    expect(claimCompile(a, 'hdr')).toBe(true);
    expect(claimCompile(a, 'hdr')).toBe(true);
    expect(claimCompile(b, 'hdr')).toBe(false);
    expect(claimCompile(c, 'rgba8')).toBe(true);
    // Done: the set is in the program cache, every later device may go (together).
    releaseCompile(a, true);
    expect(claimCompile(b, 'hdr')).toBe(true);
    expect(claimCompile({}, 'hdr')).toBe(true);
  });

  it('a device gone before it finished hands the turn on without priming the set', () => {
    const a = {};
    const b = {};
    const d = {};
    expect(claimCompile(a, 'hdr')).toBe(true);
    releaseCompile(a, false);
    expect(claimCompile(b, 'hdr')).toBe(true);
    expect(claimCompile(d, 'hdr')).toBe(false);
  });

  it('are waited for at most CLAIM_TIMEOUT_MS', () => {
    vi.useFakeTimers();
    expect(claimCompile({}, 'hdr')).toBe(true);
    const b = {};
    vi.advanceTimersByTime(CLAIM_TIMEOUT_MS - 1);
    expect(claimCompile(b, 'hdr')).toBe(false);
    vi.advanceTimersByTime(2);
    expect(claimCompile(b, 'hdr')).toBe(true);
  });

  it('keep the claimant compiling while others wait, and let them go once it is done', () => {
    const a = {};
    const b = {};
    let steps = 0;
    const progressA = vi.fn(() => {
      steps++;
      // Linked and warmed up on its third step.
      if (steps === 3) releaseCompile(a, true);
    });
    const progressB = vi.fn();
    expect(claimCompile(a, 'hdr', progressA)).toBe(true);
    expect(progressA).not.toHaveBeenCalled();
    expect(claimCompile(b, 'hdr', progressB)).toBe(false);
    expect(claimCompile(b, 'hdr', progressB)).toBe(false);
    expect(progressA).toHaveBeenCalledTimes(2);
    // The step that finishes a's compile lets b go in the same call.
    expect(claimCompile(b, 'hdr', progressB)).toBe(true);
    expect(progressA).toHaveBeenCalledTimes(3);
    // b holds its claim now; a device of another set is not held back by it.
    expect(claimCompile(b, 'hdr', progressB)).toBe(true);
    expect(progressB).not.toHaveBeenCalled();
    expect(claimCompile({}, 'rgba8')).toBe(true);
  });

  it('let a waiting device go when the claimant gives up (fails or is disposed) mid-wait', () => {
    const a = {};
    const b = {};
    expect(claimCompile(a, 'hdr', () => releaseCompile(a, false))).toBe(true);
    expect(claimCompile(b, 'hdr')).toBe(true);
    // Not primed: a third device waits for b.
    expect(claimCompile({}, 'hdr')).toBe(false);
  });
});

describe('the pacer of the first context creation', () => {
  it('lets the first creation wait for its fence (issued on the first ask), then no more', async () => {
    const gl = pacerGL();
    const release = vi.fn();
    adoptPacer(gl, release);
    expect(release).not.toHaveBeenCalled();
    expect(readyForContext()).toBe(false);
    expect(gl.fences).toHaveLength(1);
    expect(gl.flushes).toBe(1);
    // Polled without issuing another fence until the GPU process answers it.
    expect(readyForContext()).toBe(false);
    expect(gl.fences).toHaveLength(1);
    gl.signaled.add(gl.fences[0] as WebGLSync);
    // Served: released at once, before the context it paced is created (never live next to it).
    expect(release).not.toHaveBeenCalled();
    expect(readyForContext()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(gl.deleted).toEqual(gl.fences);
    // Served once: later creations only wait for warm-ups.
    expect(readyForContext()).toBe(true);
    const warm = fenceGL();
    const s = sync();
    trackWarmup(warm, s, vi.fn());
    expect(readyForContext()).toBe(false);
    expect(gl.fences).toHaveLength(1);
    warm.signaled.add(s);
    await nextTask();
    expect(readyForContext()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(gl.unflushedPolls + warm.unflushedPolls).toBe(0);
  });

  it('waits for warm-ups first, and gives the fence up after PACE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const gl = pacerGL();
    adoptPacer(gl, vi.fn());
    const warm = fenceGL();
    const s = sync();
    trackWarmup(warm, s, vi.fn());
    expect(readyForContext()).toBe(false);
    expect(gl.fences).toHaveLength(0);
    warm.signaled.add(s);
    await Promise.resolve();
    expect(readyForContext()).toBe(false);
    vi.advanceTimersByTime(PACE_TIMEOUT_MS - 1);
    expect(readyForContext()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(readyForContext()).toBe(true);
  });

  it('is released at once when it cannot serve, and after PACER_IDLE_MS when nobody asks', () => {
    vi.useFakeTimers();
    // No fences (a stand-in context), then a lost context: released, no pacer.
    const plain = vi.fn();
    adoptPacer(fenceGL() as unknown as PacerGL, plain);
    expect(plain).toHaveBeenCalledTimes(1);
    const lost = pacerGL();
    lost.lost = true;
    const lostRelease = vi.fn();
    adoptPacer(lost, lostRelease);
    expect(lostRelease).toHaveBeenCalledTimes(1);
    expect(readyForContext()).toBe(true);
    // One pacer at a time; an unused one goes after PACER_IDLE_MS.
    const first = vi.fn();
    const second = vi.fn();
    adoptPacer(pacerGL(), first);
    adoptPacer(pacerGL(), second);
    expect(second).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PACER_IDLE_MS - 1);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(readyForContext()).toBe(true);
  });

  it('a pacer whose context is lost lets creation go (without releasing a dead context)', () => {
    const gl = pacerGL();
    const release = vi.fn();
    adoptPacer(gl, release);
    expect(readyForContext()).toBe(false);
    gl.lost = true;
    expect(readyForContext()).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });
});
