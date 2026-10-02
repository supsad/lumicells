/**
 * Page-wide state of shader warm-ups (see GpuDevice).
 *
 * ANGLE's Direct3D 11 backend (Chrome and Edge on Windows, Firefox too) compiles part of a
 * program's code on its first draw instead of at link time: the pixel shader of a program with
 * several outputs (MRT), the geometry shader that emulates flat-varying provoking vertices. That
 * compile runs on the GPU process's main thread, which every WebGL context of the page shares.
 * Any synchronous call meanwhile (checkFramebufferStatus, creating a context, resizing a WebGL
 * canvas: the browser waits for the GPU process to answer) blocks the page's main thread until
 * it finishes: a cold first visit used to freeze for seconds in one task.
 *
 * So every device draws each program once into scratch targets (a warm-up) before its first
 * frame and puts a fence behind those draws (trackWarmup), unless the programs came from the
 * browser's program cache (CACHED_LINK_MS): their draw-time code is cached with them. While any
 * warm-up fence of the page is pending, the engine makes no synchronous call: devices do not
 * poll or set up programs, slots do not allocate targets or resize their canvas (they skip the
 * frame), the shared renderer does not resize its atlas and the scheduler creates no context.
 * The fences are polled (non-blocking) by whoever asks gpuBusy(), so a device that stopped
 * drawing (its instance went off screen) never keeps the others waiting. They are polled once per
 * task: a WebGL sync object only changes state between tasks, so a hundred instances asking in
 * one frame cost one poll, not a hundred (Firefox warns about a fence polled 100 times without
 * SYNC_FLUSH_COMMANDS_BIT; the polls set it, so a fence that takes long keeps moving too).
 *
 * A device also waits with its programs while another device compiles the same ones
 * (claimCompile): once those are linked, the browser's program cache holds them, and the next
 * device links them from there in milliseconds instead of compiling them again. A waiting device
 * keeps the claimant's compile going (its own instances may have moved on, e.g. the shared
 * renderer's device once they got contexts of their own: then nobody else polls it). A claim
 * older than CLAIM_TIMEOUT_MS no longer holds anyone back.
 *
 * The first context of a page has the same problem with the browser's own work: right after the
 * first paint, the GPU process rasterizes the page, and on a first visit that compiles shaders
 * of its own (hundreds of milliseconds on Direct3D). Creating a context then waits for all of it,
 * twice (the context, then its first query). So the page keeps the context of its WebGL2 probe
 * (LumiCells.isSupported) for a moment as a pacer (adoptPacer): before the first context of an
 * instance is created, a fence goes through the pacer, and the context is created once the GPU
 * process has answered it, i.e. caught up with the work queued before it (readyForContext). That
 * costs a frame when the GPU process is idle (a warm visit) and saves the page a long task when
 * it is not. The pacer is released right then, before that context is created (the GPU process
 * has just caught up, so its release waits little): it is never live next to an instance's
 * context. Unused, it is released after PACER_IDLE_MS.
 */

/** A warm-up fence that never signals (a driver bug) is given up after this long, ms. */
export const WARM_TIMEOUT_MS = 15_000;
/**
 * Programs that are linked this long after their submission came from the browser's program
 * cache (a page seen before; compiling even the smallest pass takes longer), their draw-time
 * code included: they need no warm-up, ms. Checked by a timer, not on a frame: the first frames
 * may draw nothing (a display calibration holds them, see runtime/display.ts).
 */
export const CACHED_LINK_MS = 80;
/** Another device compiling the same programs is waited for at most this long, ms. */
export const CLAIM_TIMEOUT_MS = 4_000;
/** The pacer's fence is waited for at most this long, ms (see readyForContext). */
export const PACE_TIMEOUT_MS = 1_000;
/** A pacer is released at the latest this long after it was adopted, ms. */
export const PACER_IDLE_MS = 5_000;

/** The calls warmup.ts makes on a context (a subset of WebGL2, so tests can fake it). */
export interface FenceGL {
  readonly SYNC_FLUSH_COMMANDS_BIT: GLbitfield;
  readonly ALREADY_SIGNALED: GLenum;
  readonly CONDITION_SATISFIED: GLenum;
  clientWaitSync(sync: WebGLSync, flags: GLbitfield, timeout: GLuint64): GLenum;
  deleteSync(sync: WebGLSync | null): void;
  isContextLost(): boolean;
}

/** Whether the GPU is past `sync`: a non-blocking poll (timeout 0) that flushes if it is not. */
function passed(gl: FenceGL, sync: WebGLSync): boolean {
  const r = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
  return r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED;
}

/** The calls the pacer makes on its context (a subset of WebGL2, so tests can fake it). */
export interface PacerGL extends FenceGL {
  readonly SYNC_GPU_COMMANDS_COMPLETE: GLenum;
  fenceSync(condition: GLenum, flags: GLbitfield): WebGLSync | null;
  flush(): void;
}

interface Warmup {
  gl: FenceGL;
  sync: WebGLSync;
  startedAt: number;
  done: () => void;
}

const warmups: Warmup[] = [];

interface Claim {
  key: string;
  at: number;
  /** One step of its device's compile (GpuDevice.progress). */
  progress: () => void;
}

/** Devices compiling their programs (submitted, not yet linked), by program set. */
const compiling = new Map<object, Claim>();
/** Program sets some device of the page linked: the program cache holds them. */
const primed = new Set<string>();

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Follows a warm-up fence: `done` runs once the GPU is past it (or it is given up, or the
 * context is lost: then without `done`).
 */
export function trackWarmup(gl: FenceGL, sync: WebGLSync, done: () => void): void {
  warmups.push({ gl, sync, startedAt: now(), done });
}

/** Drops the fences of `gl` without running their `done` (a disposed or lost device). */
export function forgetWarmups(gl: FenceGL): void {
  for (let i = warmups.length - 1; i >= 0; i--) {
    const w = warmups[i] as Warmup;
    if (w.gl !== gl) continue;
    warmups.splice(i, 1);
    if (!gl.isContextLost()) gl.deleteSync(w.sync);
  }
}

/** The fences were polled in the current task (see the header). */
let polledInTask = false;
const endOfTask = (): void => {
  polledInTask = false;
};

/** Settles every fence the GPU is past (non-blocking polls, once per task). */
function settle(): void {
  if (warmups.length === 0 || polledInTask) return;
  polledInTask = true;
  queueMicrotask(endOfTask);
  const t = now();
  for (let i = 0; i < warmups.length; ) {
    const w = warmups[i] as Warmup;
    const lost = w.gl.isContextLost();
    const over = lost || passed(w.gl, w.sync) || t - w.startedAt > WARM_TIMEOUT_MS;
    if (!over) {
      i++;
      continue;
    }
    warmups.splice(i, 1);
    if (lost) continue;
    w.gl.deleteSync(w.sync);
    w.done();
  }
}

/** A warm-up draw is still running on the GPU: make no synchronous GL call. */
export function gpuBusy(): boolean {
  settle();
  return warmups.length > 0;
}

const idle = (): void => {};

/**
 * Whether `device` may submit its programs (the set `key`, e.g. their shared header) now: no
 * other device has been compiling the same set for less than CLAIM_TIMEOUT_MS. While one has,
 * this call advances that device's compile one step (`progress` of its claim), so it finishes
 * even if nobody else polls it. Records the claim (with `progress`, this device's own step)
 * when it may.
 */
export function claimCompile(device: object, key: string, progress: () => void = idle): boolean {
  if (compiling.has(device)) return true;
  const t = now();
  if (!primed.has(key)) {
    for (const [other, c] of compiling) {
      if (c.key !== key || t - c.at >= CLAIM_TIMEOUT_MS) continue;
      c.progress();
      // Still compiling: wait. Done (the set is primed) or gone: go ahead.
      if (compiling.has(other)) return false;
      break;
    }
  }
  compiling.set(device, { key, at: t, progress });
  return true;
}

/** `device` finished compiling (`done`: its programs are linked) or is gone. */
export function releaseCompile(device: object, done: boolean): void {
  const claim = compiling.get(device);
  compiling.delete(device);
  if (done && claim) primed.add(claim.key);
}

interface Pacer {
  gl: PacerGL;
  release: () => void;
  sync: WebGLSync | null;
  /** When the fence was issued. */
  since: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

let pacer: Pacer | null = null;

/**
 * Keeps `gl` (a context the page has no other use for) as the pacer of the first context
 * creation (see the header); `release` frees it once it has served, or after PACER_IDLE_MS. A
 * context without fences or a second pacer is released at once.
 */
export function adoptPacer(gl: PacerGL, release: () => void): void {
  if (pacer || typeof gl.fenceSync !== 'function' || gl.isContextLost()) {
    release();
    return;
  }
  const p: Pacer = { gl, release, sync: null, since: 0, timer: undefined };
  if (typeof setTimeout === 'function') {
    p.timer = setTimeout(() => {
      if (pacer === p) releasePacer();
    }, PACER_IDLE_MS);
  }
  pacer = p;
}

function releasePacer(): void {
  const p = pacer;
  if (!p) return;
  pacer = null;
  if (p.timer !== undefined) clearTimeout(p.timer);
  if (p.gl.isContextLost()) return;
  if (p.sync) p.gl.deleteSync(p.sync);
  p.release();
}

/**
 * Whether a context may be created now: no warm-up is compiling (gpuBusy) and the GPU process has
 * answered the pacer's fence, if the page has a pacer (issued on the first call, then polled
 * without blocking; given up after PACE_TIMEOUT_MS). The pacer serves once: later creations only
 * wait for warm-ups. False means "ask again next frame". `pace` false: only ask, leave the
 * pacer to another caller (the first creation then goes to that one).
 */
export function readyForContext(pace = true): boolean {
  if (gpuBusy()) return false;
  const p = pacer;
  if (!p) return true;
  if (!pace) return false;
  const gl = p.gl;
  if (gl.isContextLost()) {
    releasePacer();
    return true;
  }
  if (!p.sync) {
    p.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!p.sync) {
      releasePacer();
      return true;
    }
    gl.flush();
    p.since = now();
    return false;
  }
  if (!passed(gl, p.sync) && now() - p.since < PACE_TIMEOUT_MS) return false;
  releasePacer();
  return true;
}

/** Tests only. */
export function resetWarmupForTesting(): void {
  warmups.length = 0;
  polledInTask = false;
  compiling.clear();
  primed.clear();
  if (pacer?.timer !== undefined) clearTimeout(pacer.timer);
  pacer = null;
}
