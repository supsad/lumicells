/**
 * Autosave (localStorage) and share links (URL hash). Every storage access is wrapped: private
 * windows and blocked site data must never break the stand.
 */

import {
  type ConfigIssue,
  isPresetId,
  normalizeConfig,
  type PixelLifeConfig,
  type PresetId,
  toConfigFile,
} from 'pixel-life';

export const AUTOSAVE_KEY = 'pixel-life:stand:v1';
export const UI_KEY = 'pixel-life:stand:ui:v1';
const HASH_PREFIX = '#c=';

export interface LoadedState {
  cfg: PixelLifeConfig;
  presetId: PresetId;
  issues: ConfigIssue[];
}

/** The compact form used by autosave and links: only what differs from the preset. */
function diffOf(cfg: PixelLifeConfig, presetId: PresetId) {
  const { $schema: _omit, ...rest } = toConfigFile(cfg, { mode: 'diff', base: presetId });
  return rest;
}

function fromFile(raw: unknown, fallbackPreset: PresetId): LoadedState {
  const { config, issues } = normalizeConfig(raw);
  const ext = (raw as { extends?: unknown } | null)?.extends;
  return { cfg: config, presetId: isPresetId(ext) ? ext : fallbackPreset, issues };
}

// ---------------------------------------------------------------- base64url

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// --------------------------------------------------------------- share link

export function encodeShareHash(cfg: PixelLifeConfig, presetId: PresetId): string {
  return HASH_PREFIX + toBase64Url(JSON.stringify(diffOf(cfg, presetId)));
}

export function shareUrl(cfg: PixelLifeConfig, presetId: PresetId): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}${encodeShareHash(cfg, presetId)}`;
}

export function decodeShareHash(hash: string): LoadedState | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  try {
    return fromFile(JSON.parse(fromBase64Url(hash.slice(HASH_PREFIX.length))), 'reference');
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- autosave

export function saveAutosave(cfg: PixelLifeConfig, presetId: PresetId): void {
  try {
    localStorage.setItem(
      AUTOSAVE_KEY,
      JSON.stringify({ v: 1, preset: presetId, config: diffOf(cfg, presetId) }),
    );
  } catch {
    // Quota or blocked storage: autosave is best effort.
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // ignore
  }
}

function loadAutosave(): LoadedState | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { preset?: unknown; config?: unknown };
    const preset = isPresetId(data.preset) ? data.preset : 'reference';
    const withBase =
      data.config && typeof data.config === 'object' ? { extends: preset, ...data.config } : {};
    return fromFile(withBase, preset);
  } catch {
    return null;
  }
}

export interface InitialState extends LoadedState {
  source: 'hash' | 'autosave' | 'default';
}

/** A link in the URL wins over autosave; without either the reference preset is used. */
export function readInitialState(): InitialState {
  const fromHash = decodeShareHash(window.location.hash);
  if (fromHash) {
    // Drop the hash so later reloads restore the autosave, not this stale link.
    try {
      const { pathname, search } = window.location;
      window.history.replaceState(null, '', pathname + search);
    } catch {
      // ignore
    }
    return { ...fromHash, source: 'hash' };
  }
  const saved = loadAutosave();
  if (saved) return { ...saved, source: 'autosave' };
  const { config } = normalizeConfig({ extends: 'reference' });
  return { cfg: config, presetId: 'reference', issues: [], source: 'default' };
}

// ------------------------------------------------------------------ ui prefs

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? { ...fallback, ...(parsed as object) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

let initialMemo: InitialState | null = null;

/** Read once per page load: StrictMode runs initializers twice and the hash is consumed. */
export function getInitialState(): InitialState {
  initialMemo ??= readInitialState();
  return initialMemo;
}
