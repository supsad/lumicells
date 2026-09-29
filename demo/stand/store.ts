/**
 * Stand state outside React: the full normalized config, the selected preset and the undo
 * history. Panel rows subscribe to single paths through useSyncExternalStore, so dragging one
 * slider re-renders that row (and whatever else depends on the changed value), not the panel.
 */

import { getPath, getPresetConfig, type PixelLifeConfig, type PresetId, setPath } from 'pixel-life';
import { createContext, useContext, useSyncExternalStore } from 'react';

/** Tween used while a value is being dragged: feels immediate, still hides steps. */
export const DRAG_TRANSITION_MS = 120;
const UNDO_TRANSITION_MS = 200;
const COALESCE_MS = 400;
const HISTORY_LIMIT = 100;

export interface StandSnapshot {
  cfg: PixelLifeConfig;
  presetId: PresetId;
  /** Resolved config of `presetId`; stable identity, the "default" of every control. */
  presetCfg: PixelLifeConfig;
  /** Tween duration (ms) to use for the change that produced this snapshot. */
  transition: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Bumped on every change (cheap "did anything change" for effects). */
  rev: number;
}

interface Entry {
  cfg: PixelLifeConfig;
  presetId: PresetId;
}

export interface SetOptions {
  /** Discrete edits (toggles, selects) always get their own history entry. */
  discrete?: boolean;
}

export class StandStore {
  private snap: StandSnapshot;
  private past: Entry[] = [];
  private future: Entry[] = [];
  private listeners = new Set<() => void>();
  /** Open coalescing group: consecutive edits of one path merge into one history entry. */
  private group: { path: string; timer: number } | null = null;

  constructor(cfg: PixelLifeConfig, presetId: PresetId) {
    this.snap = {
      cfg,
      presetId,
      presetCfg: getPresetConfig(presetId),
      transition: cfg.transition,
      canUndo: false,
      canRedo: false,
      rev: 0,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): StandSnapshot => this.snap;

  get cfg(): PixelLifeConfig {
    return this.snap.cfg;
  }

  /** Closes the coalescing group (pointer released, or explicit boundary). */
  endGroup = (): void => {
    if (this.group) window.clearTimeout(this.group.timer);
    this.group = null;
  };

  /** Edit one parameter. Values are expected to come from schema-aware controls (clamped). */
  set(path: string, value: unknown, opts: SetOptions = {}): void {
    this.setMany([[path, value]], opts);
  }

  /** Edit several parameters as one history entry. */
  setMany(entries: ReadonlyArray<readonly [string, unknown]>, opts: SetOptions = {}): void {
    let next = this.snap.cfg;
    let changedPath: string | null = null;
    for (const [path, value] of entries) {
      if (getPath(next, path) === value) continue;
      next = setPath(next, path, value);
      changedPath ??= path;
    }
    if (changedPath === null) return;
    const discrete = opts.discrete || entries.length > 1;
    this.touch(entries.length === 1 ? changedPath : '*', discrete);
    const transition = discrete
      ? this.snap.cfg.transition
      : Math.min(DRAG_TRANSITION_MS, this.snap.cfg.transition);
    this.publish(next, this.snap.presetId, transition);
  }

  /** Replaces the whole config (preset switch, import, reset, load): always a new entry. */
  replace(
    cfg: PixelLifeConfig,
    presetId: PresetId = this.snap.presetId,
    transition?: number,
  ): void {
    this.endGroup();
    this.pushHistory();
    this.publish(cfg, presetId, transition ?? cfg.transition);
  }

  /**
   * Switches the look. The environment groups (render, interaction) belong to the stand, not to
   * a look, so they survive the switch.
   */
  selectPreset(id: PresetId): void {
    const base = getPresetConfig(id);
    const cur = this.snap.cfg;
    this.replace({ ...base, render: cur.render, interaction: cur.interaction }, id);
  }

  reset(): void {
    this.replace(getPresetConfig(this.snap.presetId));
  }

  undo(): void {
    this.endGroup();
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push({ cfg: this.snap.cfg, presetId: this.snap.presetId });
    this.publish(prev.cfg, prev.presetId, UNDO_TRANSITION_MS);
  }

  redo(): void {
    this.endGroup();
    const next = this.future.pop();
    if (!next) return;
    this.past.push({ cfg: this.snap.cfg, presetId: this.snap.presetId });
    this.publish(next.cfg, next.presetId, UNDO_TRANSITION_MS);
  }

  private touch(path: string, discrete: boolean): void {
    if (discrete || !this.group || this.group.path !== path) {
      this.endGroup();
      this.pushHistory();
      if (!discrete) this.group = { path, timer: 0 };
    }
    if (this.group) {
      window.clearTimeout(this.group.timer);
      this.group.timer = window.setTimeout(this.endGroup, COALESCE_MS);
    }
  }

  private pushHistory(): void {
    this.past.push({ cfg: this.snap.cfg, presetId: this.snap.presetId });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
  }

  private publish(cfg: PixelLifeConfig, presetId: PresetId, transition: number): void {
    const presetCfg =
      presetId === this.snap.presetId ? this.snap.presetCfg : getPresetConfig(presetId);
    this.snap = {
      cfg,
      presetId,
      presetCfg,
      transition,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      rev: this.snap.rev + 1,
    };
    for (const l of this.listeners) l();
  }
}

export const StoreContext = createContext<StandStore | null>(null);

export function useStore(): StandStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error('StoreContext is missing');
  return s;
}

/** Subscribes to a derived value; `select` must return a stable value (primitive or same ref). */
export function useSelector<T>(select: (s: StandSnapshot) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}

/** Current value of one config path (arrays keep their identity until the value changes). */
export function usePathValue<T = unknown>(path: string): T {
  return useSelector((s) => getPath(s.cfg, path) as T);
}
