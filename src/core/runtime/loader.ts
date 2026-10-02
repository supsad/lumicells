/**
 * Loads the GPU side of the instances (runtime/live.ts and everything only it needs: the
 * controller, the engine, its GLSL and passes, the shared renderer, look groups) on demand.
 *
 * The facade (lumi-cells.ts) is the eager part: API, config, poster, observers and the context
 * budget's bookkeeping. The first instance constructed in a browser starts the import (never
 * module evaluation, never the server), so the chunk downloads while the poster shows and the
 * observers report where the host is; instances constructed after it arrived get their GPU side
 * synchronously, as if it had always been there. A bundler emits the import as a chunk of its
 * own (the <script src> bundle inlines it).
 *
 * A failed import is final for the page's lifetime: every instance, the current ones and those
 * constructed later, reports the 'load' fallback and keeps its poster (see Shell.#failLoad).
 * Importing the same chunk again would not help: browsers keep a failed dynamic import in their
 * module map and reject every later import() of that URL at once, without a new request. Only a
 * reload tries again (a bundler whose chunk loader retries, e.g. webpack's, does so before the
 * import rejects).
 */

import type { PacerGL } from '../engine/warmup';
import type * as Live from './live';

export type LiveModule = typeof Live;

let loaded: LiveModule | null = null;
let loading: Promise<LiveModule> | null = null;
/** The import failed: final for the page (see the header). */
let failed = false;
let importer: () => Promise<LiveModule> = () => import('./live');

/** The WebGL2 support probe's context, held for the pacer until the GPU side takes it. */
interface HeldPacer {
  gl: PacerGL;
  release: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

let held: HeldPacer | null = null;
/** A held probe context nobody took is released after this long, ms (warmup's PACER_IDLE_MS). */
const HOLD_MS = 5_000;

/**
 * Offers the support probe's context (LumiCells.isSupported) as the pacer of the page's first
 * context creation (engine/warmup.ts, adoptPacer), which belongs to the GPU side: handed over at
 * once when that has loaded, else as soon as it does; released unused after HOLD_MS.
 */
export function offerPacer(gl: PacerGL, release: () => void): void {
  if (loaded) {
    loaded.adoptPacer(gl, release);
    return;
  }
  // One pacer at a time (adoptPacer would release a second one too).
  if (held) {
    release();
    return;
  }
  const h: HeldPacer = { gl, release, timer: undefined };
  if (typeof setTimeout === 'function') {
    h.timer = setTimeout(() => {
      if (held !== h) return;
      held = null;
      release();
    }, HOLD_MS);
  }
  held = h;
}

function handOverPacer(mod: LiveModule): void {
  const h = held;
  if (!h) return;
  held = null;
  if (h.timer !== undefined) clearTimeout(h.timer);
  mod.adoptPacer(h.gl, h.release);
}

/** The GPU side's module once it has loaded (null before). */
export function liveModule(): LiveModule | null {
  return loaded;
}

/**
 * Loads the GPU side's module, once. A failure is kept: every later call gets the same rejection
 * (see the header: the browser would not fetch the chunk again anyway).
 */
export function loadLive(): Promise<LiveModule> {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    const p: Promise<LiveModule> = importer().then(
      (m) => {
        loaded = m;
        handOverPacer(m);
        return m;
      },
      (err: unknown) => {
        if (loading === p) failed = true;
        throw err;
      },
    );
    // Nobody may be waiting for it (every instance destroyed meanwhile, or a preload).
    p.catch(() => {});
    loading = p;
  }
  return loading;
}

/**
 * Whether the GPU side's module is loading, loaded or failed for good ('idle': nothing asked for
 * it yet).
 */
export function liveLoadState(): 'idle' | 'loading' | 'loaded' | 'failed' {
  return loaded ? 'loaded' : failed ? 'failed' : loading ? 'loading' : 'idle';
}

/**
 * Tests only: replaces how the module is imported (null: the real import) and forgets a loaded
 * or failed one, so instances created afterwards wait for (or fail) the next load.
 */
export function setLiveImporterForTesting(fn: (() => Promise<LiveModule>) | null): void {
  importer = fn ?? (() => import('./live'));
  loaded = null;
  loading = null;
  failed = false;
}
