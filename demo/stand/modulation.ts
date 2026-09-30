/**
 * Tracks which parameters are currently driven by modulators, so the panel can show a "мод."
 * badge and the effective value next to them. The instance API has no "list modulators" call,
 * so every modulator created by the stand goes through `tracker.modulate`.
 */

import type { LumiCells, ModulatablePath, ModulateOptions, ModulationSource } from 'lumicells';
import { createContext, useContext, useSyncExternalStore } from 'react';

const POLL_MS = 250; // 4 Hz: enough for a readout, invisible next to the render loop

export interface TrackedModulator {
  dispose(): void;
}

export class ModulationTracker {
  private instance: LumiCells | null = null;
  private counts = new Map<string, number>();
  private values = new Map<string, number>();
  private listeners = new Set<() => void>();
  private timer = 0;

  setInstance(instance: LumiCells | null): void {
    this.instance = instance;
    this.values.clear();
    this.syncTimer();
  }

  /** `instance.modulate` plus bookkeeping. Dispose the result, not the raw handle. */
  modulate(
    instance: LumiCells,
    path: ModulatablePath,
    source: ModulationSource,
    opts?: ModulateOptions,
  ): TrackedModulator {
    const handle = instance.modulate(path, source, opts);
    this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
    this.syncTimer();
    let done = false;
    return {
      dispose: () => {
        if (done) return;
        done = true;
        handle.dispose();
        const n = (this.counts.get(path) ?? 1) - 1;
        if (n <= 0) {
          this.counts.delete(path);
          this.values.delete(path);
        } else this.counts.set(path, n);
        this.syncTimer();
        this.emit();
      },
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Effective value of a path with an active modulator, otherwise undefined. */
  effective(path: string): number | undefined {
    return this.counts.has(path) ? this.values.get(path) : undefined;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private syncTimer(): void {
    const need = this.instance !== null && this.counts.size > 0;
    if (need && !this.timer) {
      this.timer = window.setInterval(() => this.poll(), POLL_MS);
      this.poll();
    } else if (!need && this.timer) {
      window.clearInterval(this.timer);
      this.timer = 0;
    }
  }

  private poll(): void {
    const inst = this.instance;
    if (!inst || inst.destroyed) return;
    let changed = false;
    for (const path of this.counts.keys()) {
      let v: number;
      try {
        v = inst.getEffective(path as ModulatablePath);
      } catch {
        continue;
      }
      // Round so idle modulators do not wake the panel every tick.
      v = Math.round(v * 1e4) / 1e4;
      if (this.values.get(path) !== v) {
        this.values.set(path, v);
        changed = true;
      }
    }
    if (changed) this.emit();
  }
}

export const ModulationContext = createContext<ModulationTracker | null>(null);

/** Effective value of a modulated path (undefined when nothing modulates it). */
export function useModulated(path: string): number | undefined {
  const tracker = useContext(ModulationContext);
  return useSyncExternalStore(tracker?.subscribe ?? noopSubscribe, () => tracker?.effective(path));
}

function noopSubscribe(): () => void {
  return () => {};
}
