/**
 * Config layer of one instance: the normalized config, its changes (normalized patches and the
 * leaf paths they changed) and what derives from the config alone (the CSS poster, the look key).
 *
 * It is part of the eager facade: getConfig/setConfig, the `config` event and the poster work
 * before the GPU side (runtime/live.ts, loaded on demand) exists. The Controller follows the
 * commits (onCommit) to tween its parameters; a controller created later starts from the first
 * config (`initial`) and replays the commits made meanwhile, in call order, so it ends up exactly
 * where one created at construction would be.
 *
 * Creation is cheap when many instances start from the same config input (a list of cards with
 * one preset): the normalized config, its JSON and the poster are kept per input (START_MAX
 * inputs, least recently used first out). Each state still gets its own config copy.
 */

import {
  cloneData,
  deepMerge,
  diffConfigs,
  isPlainObject,
  type LumiCellsConfig,
  type LumiCellsConfigInput,
  normalizeConfig,
  normalizePatch,
  type ParamPath,
  posterCss,
  stableStringify,
} from '../schema';

/** What a state starts from for one config input (shared; never handed out). */
export interface ConfigStart {
  readonly config: LumiCellsConfig;
  /**
   * `config` as JSON when that round trip is exact (it is for normalized configs: finite
   * numbers, strings, booleans, arrays, plain objects): JSON.parse copies it faster than a walk,
   * mostly while the code is still cold (a page mounting its backgrounds).
   */
  readonly json: string | null;
  /** posterCss(config), computed on first use. */
  poster: string | null;
  /** lookKeyOf(config), computed on first use. */
  lookKey: string | null;
}

/** One change of the config: what changed, the config after it, its tween duration (ms). */
export interface ConfigCommit {
  readonly changed: ParamPath[];
  readonly next: LumiCellsConfig;
  readonly transition: number;
}

/** Inputs kept (least recently used first out). */
const START_MAX = 32;
const starts = new Map<string, ConfigStart>();
let misses = 0;

/** How many states normalized their input themselves (a cached input does not). */
export function initMissCount(): number {
  return misses;
}

/**
 * Exact content key of a config input, or null when it holds anything but plain data (plain
 * objects, arrays, strings, numbers, booleans, null): normalization treats class instances and
 * the like differently from plain objects with the same fields, so those are never cached.
 */
function inputKey(v: unknown, depth = 0): string | null {
  if (v === null) return 'n';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return String(v);
    case 'boolean':
      return v ? 't' : 'f';
    case 'object':
      break;
    default:
      return null;
  }
  if (depth > 16) return null;
  if (Array.isArray(v)) {
    let out = '[';
    for (let i = 0; i < v.length; i++) {
      const k = inputKey(v[i], depth + 1);
      if (k === null) return null;
      out += i > 0 ? `,${k}` : k;
    }
    return `${out}]`;
  }
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v).sort();
  let out = '{';
  let first = true;
  for (const key of keys) {
    const val = v[key];
    // Normalization ignores undefined values like absent keys.
    if (val === undefined) continue;
    const k = inputKey(val, depth + 1);
    if (k === null) return null;
    out += `${first ? '' : ','}${JSON.stringify(key)}:${k}`;
    first = false;
  }
  return `${out}}`;
}

/** Whether JSON.parse(JSON.stringify(v)) gives back exactly `v` (see ConfigStart.json). */
function jsonExact(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0);
  if (depth > 16) return false;
  if (Array.isArray(v)) return v.every((x) => jsonExact(x, depth + 1));
  if (!isPlainObject(v)) return false;
  for (const key of Object.keys(v)) {
    if (key === '__proto__' || !jsonExact(v[key], depth + 1)) return false;
  }
  return true;
}

/**
 * Key of the picture a config draws (`look: 'shared'` groups cards by it): the canonical
 * serialization of the normalized config without the paths that never change a frame on their
 * own. `interaction` (pointer, clicks and the defaults of influences and pulses) acts only through
 * runtime layers, which take a card out of its group anyway; `render.pauseOffscreen` only decides
 * when an instance draws; `transition` only shapes a config change, which changes the key.
 */
export function lookKeyOf(config: Readonly<LumiCellsConfig>): string {
  const { interaction: _i, transition: _t, render, ...rest } = config;
  const { pauseOffscreen: _p, ...visual } = render;
  return stableStringify({ ...rest, render: visual });
}

export class ConfigState {
  /** The current config (a new object on every change; never mutated). */
  config: LumiCellsConfig;
  /** The first config: a controller created later starts from it and replays the commits. */
  readonly initial: LumiCellsConfig;
  /** The cached start of `initial` (null when its input is not plain data). */
  readonly start: ConfigStart | null;
  /** Called with every change, after `config` was updated. */
  onCommit: ((commit: ConfigCommit) => void) | null = null;
  /** The cached start this config came from (its poster is known), until the first change. */
  #init: ConfigStart | null;
  #posterFor: LumiCellsConfig | null = null;
  #posterText = '';
  #lookKeyFor: LumiCellsConfig | null = null;
  #lookKeyText = '';

  constructor(input: LumiCellsConfigInput = {}) {
    let key: string | null = null;
    try {
      key = inputKey(input);
    } catch {
      // A getter that throws, or the like: normalization copes, the cache stays out of it.
    }
    const hit = key === null ? undefined : starts.get(key);
    let start: ConfigStart | null = null;
    if (hit) {
      starts.delete(key as string);
      starts.set(key as string, hit);
      this.config = hit.json !== null ? JSON.parse(hit.json) : cloneData(hit.config);
      start = hit;
    } else {
      misses++;
      this.config = normalizeConfig(input).config;
      if (key !== null) {
        const config = cloneData(this.config);
        start = {
          config,
          json: jsonExact(config) ? JSON.stringify(config) : null,
          poster: null,
          lookKey: null,
        };
        starts.set(key, start);
        if (starts.size > START_MAX) starts.delete(starts.keys().next().value as string);
      }
    }
    this.initial = this.config;
    this.start = start;
    this.#init = start;
  }

  /** CSS poster of the current config (posterCss), computed once per config. */
  get poster(): string {
    const cfg = this.config;
    if (this.#posterFor !== cfg) {
      const init = this.#init;
      if (init) {
        init.poster ??= posterCss(cfg);
        this.#posterText = init.poster;
      } else {
        this.#posterText = posterCss(cfg);
      }
      this.#posterFor = cfg;
    }
    return this.#posterText;
  }

  /**
   * Key of the picture the current config draws (lookKeyOf), computed once per config: the same
   * string object until the config changes (cards started from one input share it).
   */
  get lookKey(): string {
    const cfg = this.config;
    if (this.#lookKeyFor !== cfg) {
      const init = this.#init;
      if (init) {
        init.lookKey ??= lookKeyOf(cfg);
        this.#lookKeyText = init.lookKey;
      } else {
        this.#lookKeyText = lookKeyOf(cfg);
      }
      this.#lookKeyFor = cfg;
    }
    return this.#lookKeyText;
  }

  /** Merges a partial config; returns the changed leaf paths (schema order). */
  setConfig(patch: LumiCellsConfigInput, transition?: number): ParamPath[] {
    const { patch: clean } = normalizePatch(patch);
    return this.#commit(normalizeConfig(deepMerge(this.config, clean)).config, transition);
  }

  /** Replaces the whole config (missing keys fall back to defaults / `extends`). */
  replaceConfig(input: LumiCellsConfigInput, transition?: number): ParamPath[] {
    return this.#commit(normalizeConfig(input).config, transition);
  }

  #commit(next: LumiCellsConfig, transition: number | undefined): ParamPath[] {
    const changed = diffConfigs(this.config, next);
    if (changed.length === 0) return changed;
    this.config = next;
    this.#init = null;
    this.onCommit?.({ changed, next, transition: Math.max(0, transition ?? next.transition) });
    return changed;
  }
}
