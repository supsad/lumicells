/** Stand-only preferences (not part of the lumicells config): stage size, toggles, panel state. */

import type { DebugView } from 'lumicells';

export type SizeMode = 'full' | 'card' | 'banner' | 'phone' | 'custom';

export interface SizeDef {
  id: SizeMode;
  label: string;
  w?: number;
  h?: number;
}

export const SIZE_MODES: readonly SizeDef[] = [
  { id: 'full', label: 'Весь экран' },
  { id: 'card', label: 'Карточка 360×360', w: 360, h: 360 },
  { id: 'banner', label: 'Баннер 1200×320', w: 1200, h: 320 },
  { id: 'phone', label: 'Телефон 390×844', w: 390, h: 844 },
  { id: 'custom', label: 'Свой размер' },
];

export const DEBUG_VIEWS: ReadonlyArray<{ id: DebugView; label: string }> = [
  { id: 'final', label: 'Итог' },
  { id: 'field', label: 'Поле' },
  { id: 'halo', label: 'Гало' },
  { id: 'bloom', label: 'Блум' },
  { id: 'haze', label: 'Дымка' },
  { id: 'cells', label: 'Ячейки' },
];

export const MIN_STAGE = 120;
export const MAX_STAGE = 4096;

export interface Prefs {
  size: SizeMode;
  customW: number;
  customH: number;
  scene: boolean;
  debug: DebugView;
  panelCollapsed: boolean;
  showAdvanced: boolean;
  statsOpen: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  size: 'full',
  customW: 640,
  customH: 480,
  scene: true,
  debug: 'final',
  panelCollapsed: false,
  showAdvanced: false,
  statsOpen: false,
};

/** Below this viewport width (px) the stand uses the phone layout: the panel starts collapsed. */
export const NARROW_MAX = 699;

export function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= NARROW_MAX;
}

/** Pixel size of the stage frame for a mode (undefined = fills the stage area). */
export function frameSize(p: Prefs): { w: number; h: number } | null {
  if (p.size === 'full') return null;
  if (p.size === 'custom') return { w: p.customW, h: p.customH };
  const def = SIZE_MODES.find((s) => s.id === p.size);
  return def?.w && def.h ? { w: def.w, h: def.h } : null;
}

const isSize = (v: unknown): v is SizeMode => SIZE_MODES.some((s) => s.id === v);
const isDebug = (v: unknown): v is DebugView => DEBUG_VIEWS.some((d) => d.id === v);
const clampDim = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(MAX_STAGE, Math.max(MIN_STAGE, Math.round(v)))
    : fallback;

/** Repairs whatever came out of storage into a valid Prefs. */
export function sanitizePrefs(raw: Partial<Prefs>): Prefs {
  const d = DEFAULT_PREFS;
  return {
    size: isSize(raw.size) ? raw.size : d.size,
    customW: clampDim(raw.customW, d.customW),
    customH: clampDim(raw.customH, d.customH),
    scene: typeof raw.scene === 'boolean' ? raw.scene : d.scene,
    debug: isDebug(raw.debug) ? raw.debug : d.debug,
    panelCollapsed: typeof raw.panelCollapsed === 'boolean' ? raw.panelCollapsed : d.panelCollapsed,
    showAdvanced: typeof raw.showAdvanced === 'boolean' ? raw.showAdvanced : d.showAdvanced,
    statsOpen: typeof raw.statsOpen === 'boolean' ? raw.statsOpen : d.statsOpen,
  };
}
