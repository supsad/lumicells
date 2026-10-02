/**
 * The page-wide settings of LumiCells.configure(): kept eager (the facade, the React wrapper and
 * the element read them before any GPU code has loaded) and validated here. What acts on them
 * (the context budget, park timers) is the scheduler's (runtime/scheduler.ts, part of the GPU
 * side's chunk): it reads the settings when it starts and reacts to later changes
 * (settingsApplied). Nothing runs at import (SSR-safe).
 */

import type { ConfigureOptions, RendererMode } from '../types';

export interface RuntimeSettings {
  maxContexts: number | 'auto';
  parkAfterMs: number;
  createPerFrame: number;
  /** Pixel budget of the shared renderer's atlas, megapixels, or 'auto'. */
  sharedBudget: number | 'auto';
  /** Renderer of new instances that do not ask for one. */
  renderer: RendererMode;
  /** `auto`: canvas megapixels from which an instance prefers a context of its own. */
  promoteArea: number;
  /** Frame-rate cap of inactive shared instances: fps, 'auto' (when needed) or 0 (off). */
  secondaryMaxFps: number | 'auto';
  /** Lite pipeline for shared instances: 'auto' (small or crowded), true (all inactive), false. */
  lite: boolean | 'auto';
}

/** What a configure() call changed that the scheduler acts on (see applySettings). */
export interface SettingsChange {
  /** `parkAfterMs` changed: park timers follow it. */
  park: boolean;
  /** `maxContexts` was set (to a valid value): the budget follows it. */
  maxContexts: boolean;
}

/** Default `promoteArea`, megapixels of device pixels. */
export const DEFAULT_PROMOTE_AREA = 0.5;

/**
 * Longest delay setTimeout honours (2^31 - 1 ms, about 24.8 days). Browsers and Node store the
 * delay as a signed 32-bit integer: anything longer wraps around and fires almost at once.
 */
const MAX_TIMER_MS = 0x7fffffff;

const DEFAULTS: Readonly<RuntimeSettings> = {
  maxContexts: 'auto',
  parkAfterMs: 10_000,
  createPerFrame: 1,
  sharedBudget: 'auto',
  renderer: 'auto',
  promoteArea: DEFAULT_PROMOTE_AREA,
  secondaryMaxFps: 'auto',
  lite: 'auto',
};

const settings: RuntimeSettings = { ...DEFAULTS };

export function runtimeSettings(): Readonly<RuntimeSettings> {
  return settings;
}

export function isRendererMode(v: unknown): v is RendererMode {
  return v === 'auto' || v === 'own' || v === 'shared';
}

/** A usable context limit: an integer >= 1 or Infinity (no limit); anything else is null. */
export function sanitizeMaxContexts(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value === Number.POSITIVE_INFINITY) return value;
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : null;
}

/**
 * Stores the valid options of a LumiCells.configure() call (invalid values are ignored) and
 * says what changed for the scheduler.
 */
export function applySettings(opts: ConfigureOptions): SettingsChange {
  const change: SettingsChange = { park: false, maxContexts: false };
  if (opts.parkAfterMs !== undefined) {
    let v = Number(opts.parkAfterMs);
    // A delay no timer can express means "never" (a wrapped timer would park at once).
    if (v > MAX_TIMER_MS) v = Number.POSITIVE_INFINITY;
    if (v >= 0 && v !== settings.parkAfterMs) {
      settings.parkAfterMs = v;
      change.park = true;
    }
  }
  if (opts.createPerFrame !== undefined) {
    const v = Number(opts.createPerFrame);
    if (v >= 1) settings.createPerFrame = Number.isFinite(v) ? Math.floor(v) : v;
  }
  if (opts.sharedBudget !== undefined) {
    const v = opts.sharedBudget === 'auto' ? 'auto' : Number(opts.sharedBudget);
    if (v === 'auto' || (Number.isFinite(v) && v > 0)) settings.sharedBudget = v;
  }
  if (isRendererMode(opts.renderer)) settings.renderer = opts.renderer;
  if (opts.promoteArea !== undefined) {
    const v = Number(opts.promoteArea);
    if (Number.isFinite(v) && v > 0) settings.promoteArea = v;
  }
  if (opts.secondaryMaxFps !== undefined) {
    const v = opts.secondaryMaxFps === 'auto' ? 'auto' : Number(opts.secondaryMaxFps);
    if (v === 'auto' || (Number.isFinite(v) && v >= 0)) settings.secondaryMaxFps = v;
  }
  if (opts.lite === 'auto' || opts.lite === true || opts.lite === false) settings.lite = opts.lite;
  if (opts.maxContexts !== undefined) {
    const v = opts.maxContexts === 'auto' ? 'auto' : sanitizeMaxContexts(opts.maxContexts);
    if (v !== null) {
      settings.maxContexts = v;
      change.maxContexts = true;
    }
  }
  return change;
}

/** Tests only: the defaults again. */
export function resetSettingsForTesting(): void {
  Object.assign(settings, DEFAULTS);
}
