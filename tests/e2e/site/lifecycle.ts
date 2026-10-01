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
