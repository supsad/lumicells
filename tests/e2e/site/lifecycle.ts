/**
 * Lifecycle fixture (see lifecycle.html): mounts N LumiCells instances into fresh cards and
 * destroys them again, for the lifecycle spec (tests/e2e/lifecycle.spec.ts). Nothing runs until
 * the spec calls window.lifecycle.
 */

import { LumiCells, type RendererMode } from 'lumicells';

const grid = document.getElementById('grid') as HTMLElement;
let instances: LumiCells[] = [];

function nextFrame(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r));
}

const lifecycle = {
  /** Mounts `n` instances (preset 'reference'), each in a card of its own. */
  mount(n: number, opts: { renderer?: RendererMode } = {}): void {
    for (let i = 0; i < n; i++) {
      const host = document.createElement('div');
      host.className = 'card';
      grid.appendChild(host);
      instances.push(
        new LumiCells(host, {
          preset: 'reference',
          ...(opts.renderer ? { renderer: opts.renderer } : {}),
        }),
      );
    }
  },

  /** Waits (frame by frame) until every mounted instance draws, or `timeoutMs` passed. */
  async untilLive(timeoutMs = 20_000): Promise<{ live: number; total: number; ms: number }> {
    const start = performance.now();
    let live = 0;
    while (performance.now() - start < timeoutMs) {
      await nextFrame();
      live = instances.filter((c) => c.getStats().state === 'live').length;
      if (live === instances.length) break;
    }
    return { live, total: instances.length, ms: Math.round(performance.now() - start) };
  },

  /**
   * Sets a mode weight of the first instance (with its config transition, default 600 ms) and
   * records every animation frame for `ms`, then on until the weight has reached `weight` (at most
   * `maxMs` in all): [ms since the change, gap to the previous frame, effective weight]. For the
   * live-change spec (the variant the mode needs compiles first, which takes longer where the
   * browser has no program cache).
   */
  async setModeWeight(
    mode: string,
    weight: number,
    ms = 2500,
    maxMs = ms,
  ): Promise<[number, number, number][]> {
    const c = instances[0];
    if (!c) return [];
    const path = `modes.${mode}.weight` as Parameters<LumiCells['getEffective']>[0];
    const log: [number, number, number][] = [];
    const t0 = performance.now();
    c.setConfig({ modes: { [mode]: { weight } } } as Parameters<LumiCells['setConfig']>[0]);
    let last = t0;
    for (;;) {
      const t = await nextFrame();
      const w = c.getEffective(path);
      log.push([Math.round(t - t0), Math.round(t - last), w]);
      last = t;
      const elapsed = performance.now() - t0;
      if (elapsed >= maxMs || (elapsed >= ms && Math.abs(w - weight) < 1e-6)) break;
    }
    return log;
  },

  /** Destroys every instance and removes the cards. */
  destroyAll(): void {
    for (const c of instances) c.destroy();
    instances = [];
    grid.replaceChildren();
  },

  /** Instances by getStats().state. */
  states(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of instances) {
      const s = c.getStats().state;
      out[s] = (out[s] ?? 0) + 1;
    }
    return out;
  },

  get count(): number {
    return instances.length;
  },
};

declare global {
  interface Window {
    lifecycle: typeof lifecycle;
  }
}
window.lifecycle = lifecycle;
