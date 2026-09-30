/**
 * Turns untrusted input (JSON files, attributes, stand imports, API calls) into a valid config.
 * Never throws: every problem becomes a precise issue with a path, and the offending value
 * falls back to the base (defaults or preset) value.
 */

import { isHexColor, normalizeHex } from '../core/color';
import { getDefaults } from './defaults';
import {
  type AngleField,
  type FieldDef,
  type GroupDef,
  type IntField,
  isGroup,
  type NumField,
  type PaletteField,
  type Vec2Field,
} from './fields';
import { cloneData, deepMerge, isPlainObject } from './paths';
import { PRESET_IDS, PRESETS, type PresetId } from './presets';
import { CONFIG_VERSION, type LumiCellsConfig, type LumiCellsConfigInput, schema } from './schema';

export type ConfigIssueCode =
  | 'unknown-key'
  | 'out-of-range'
  | 'clamped'
  | 'bad-type'
  | 'bad-color'
  | 'migrated';

export interface ConfigIssue {
  path: string;
  code: ConfigIssueCode;
  message: string;
  value?: unknown;
}

export interface Migration {
  from: number;
  to: number;
  up(raw: Record<string, unknown>): Record<string, unknown>;
}

/** Config migrations, applied in sequence starting from the input's `version`. */
export const migrations: Migration[] = [];

/** Top-level keys that are not config fields but are accepted in files. */
const META_KEYS = new Set(['$schema', 'version', 'extends']);

export function isPresetId(v: unknown): v is PresetId {
  return typeof v === 'string' && (PRESET_IDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// Leaf sanitizing

type LeafResult = { ok: true; value: unknown } | { ok: false };

const describe = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return typeof v;
};

function toNumber(v: unknown, path: string, issues: ConfigIssue[]): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) {
      issues.push({
        path,
        code: 'bad-type',
        message: `expected number, coerced string "${v}"`,
        value: v,
      });
      return n;
    }
  }
  issues.push({ path, code: 'bad-type', message: `expected number, got ${describe(v)}`, value: v });
  return undefined;
}

function clampNum(
  n: number,
  f: NumField | IntField | AngleField | Vec2Field,
  path: string,
  issues: ConfigIssue[],
): number {
  if (f.kind === 'angle' && f.fullCircle) {
    // Full-turn angles wrap: 370° and 10° are the same direction, so this is not an error.
    const span = f.max - f.min;
    return n >= f.min && n <= f.max ? n : ((((n - f.min) % span) + span) % span) + f.min;
  }
  if (n < f.min || n > f.max) {
    const c = Math.min(f.max, Math.max(f.min, n));
    issues.push({
      path,
      code: 'clamped',
      message: `${n} is outside [${f.min}, ${f.max}], clamped to ${c}`,
      value: n,
    });
    return c;
  }
  return n;
}

function sanitizeColor(v: unknown, path: string, issues: ConfigIssue[]): string | undefined {
  if (isHexColor(v)) return normalizeHex(v);
  issues.push({ path, code: 'bad-color', message: `invalid color ${JSON.stringify(v)}`, value: v });
  return undefined;
}

function sanitizePalette(
  v: unknown,
  f: PaletteField,
  path: string,
  issues: ConfigIssue[],
): LeafResult {
  let arr: unknown[];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string' && isHexColor(v)) {
    issues.push({
      path,
      code: 'bad-type',
      message: 'expected array of colors, got one color',
      value: v,
    });
    arr = [v];
  } else {
    issues.push({
      path,
      code: 'bad-type',
      message: `expected array of colors, got ${describe(v)}`,
      value: v,
    });
    return { ok: false };
  }
  const out: string[] = [];
  arr.forEach((c, i) => {
    const hex = sanitizeColor(c, `${path}.${i}`, issues);
    if (hex !== undefined) out.push(hex);
  });
  if (out.length > f.maxStops) {
    issues.push({
      path,
      code: 'out-of-range',
      message: `${out.length} stops exceed the maximum of ${f.maxStops}, extra stops dropped`,
      value: out.length,
    });
    out.length = f.maxStops;
  }
  if (out.length < f.minStops) {
    issues.push({
      path,
      code: 'out-of-range',
      message: `palette needs at least ${f.minStops} valid color(s)`,
      value: v,
    });
    return { ok: false };
  }
  return { ok: true, value: out };
}

function sanitizeLeaf(f: FieldDef, v: unknown, path: string, issues: ConfigIssue[]): LeafResult {
  switch (f.kind) {
    case 'number':
    case 'angle':
    case 'int': {
      const n = toNumber(v, path, issues);
      if (n === undefined) return { ok: false };
      const c = clampNum(n, f, path, issues);
      return { ok: true, value: f.kind === 'int' ? Math.round(c) : c };
    }
    case 'boolean': {
      if (typeof v === 'boolean') return { ok: true, value: v };
      const coerced =
        v === 'true' || v === 1 || v === '1' || v === ''
          ? true
          : v === 'false' || v === 0 || v === '0'
            ? false
            : undefined;
      if (coerced !== undefined) {
        issues.push({
          path,
          code: 'bad-type',
          message: `expected boolean, coerced ${JSON.stringify(v)}`,
          value: v,
        });
        return { ok: true, value: coerced };
      }
      issues.push({
        path,
        code: 'bad-type',
        message: `expected boolean, got ${describe(v)}`,
        value: v,
      });
      return { ok: false };
    }
    case 'color': {
      const hex = sanitizeColor(v, path, issues);
      return hex === undefined ? { ok: false } : { ok: true, value: hex };
    }
    case 'vec2': {
      if (!Array.isArray(v) || v.length !== 2) {
        issues.push({
          path,
          code: 'bad-type',
          message: `expected [x, y], got ${describe(v)}`,
          value: v,
        });
        return { ok: false };
      }
      const out: number[] = [];
      for (let i = 0; i < 2; i++) {
        const n = toNumber(v[i], `${path}.${i}`, issues);
        if (n === undefined) return { ok: false };
        out.push(clampNum(n, f, `${path}.${i}`, issues));
      }
      return { ok: true, value: out };
    }
    case 'enum': {
      if (typeof v === 'string' && f.values.includes(v)) return { ok: true, value: v };
      issues.push({
        path,
        code: 'bad-type',
        message: `expected one of ${f.values.join(' | ')}, got ${JSON.stringify(v)}`,
        value: v,
      });
      return { ok: false };
    }
    case 'palette':
      return sanitizePalette(v, f, path, issues);
  }
}

// ---------------------------------------------------------------------------------------------
// Tree walk

/**
 * Sanitizes `raw` against group `g`. With `base` it returns a complete object (missing or invalid
 * values come from base); without it only valid keys present in `raw` are kept (patch mode).
 */
function sanitizeGroup(
  g: GroupDef,
  raw: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  prefix: string,
  issues: ConfigIssue[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(g.fields)) {
    const node = g.fields[key];
    if (!node) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const has = Object.hasOwn(raw, key) && raw[key] !== undefined;
    const baseVal = base?.[key];
    if (isGroup(node)) {
      const rv = has ? raw[key] : undefined;
      if (has && !isPlainObject(rv)) {
        issues.push({
          path,
          code: 'bad-type',
          message: `expected object, got ${describe(rv)}`,
          value: rv,
        });
      }
      const sub = sanitizeGroup(
        node,
        isPlainObject(rv) ? rv : {},
        base ? (baseVal as Record<string, unknown>) : undefined,
        path,
        issues,
      );
      if (base || Object.keys(sub).length > 0) out[key] = sub;
      continue;
    }
    if (!has) {
      if (base) out[key] = cloneData(baseVal);
      continue;
    }
    const r = sanitizeLeaf(node, raw[key], path, issues);
    if (r.ok) out[key] = r.value;
    else if (base) out[key] = cloneData(baseVal);
  }
  for (const key of Object.keys(raw)) {
    if (Object.hasOwn(g.fields, key)) continue;
    if (!prefix && META_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    issues.push({
      path,
      code: 'unknown-key',
      message: `unknown key '${path}' dropped`,
      value: raw[key],
    });
  }
  return out;
}

function migrate(raw: Record<string, unknown>, issues: ConfigIssue[]): Record<string, unknown> {
  if (!Object.hasOwn(raw, 'version') || raw.version === undefined) return raw;
  let version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    issues.push({
      path: 'version',
      code: 'bad-type',
      message: 'version must be an integer',
      value: version,
    });
    return raw;
  }
  let cur = raw;
  for (let guard = 0; guard < 32 && version !== CONFIG_VERSION; guard++) {
    const m = migrations.find((x) => x.from === version);
    if (!m) break;
    try {
      cur = m.up(cur);
    } catch {
      break;
    }
    issues.push({
      path: 'version',
      code: 'migrated',
      message: `migrated from v${m.from} to v${m.to}`,
      value: m.from,
    });
    version = m.to;
  }
  if (version !== CONFIG_VERSION) {
    issues.push({
      path: 'version',
      code: 'out-of-range',
      message: `unsupported version ${version}, read as v${CONFIG_VERSION}`,
      value: version,
    });
  }
  return cur;
}

function checkExtends(raw: Record<string, unknown>, issues: ConfigIssue[]): PresetId | undefined {
  const ext = raw.extends;
  if (ext === undefined) return undefined;
  if (isPresetId(ext)) return ext;
  issues.push({
    path: 'extends',
    code: 'bad-type',
    message: `unknown preset ${JSON.stringify(ext)}; expected one of ${PRESET_IDS.join(', ')}`,
    value: ext,
  });
  return undefined;
}

function checkRoot(raw: unknown, issues: ConfigIssue[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (isPlainObject(raw)) return raw;
  issues.push({
    path: '',
    code: 'bad-type',
    message: `expected config object, got ${describe(raw)}`,
    value: raw,
  });
  return {};
}

const presetCache = new Map<PresetId, LumiCellsConfig>();

/** The cached resolved preset: shared, never to be mutated or handed out. */
function presetBase(id: PresetId): LumiCellsConfig {
  let cfg = presetCache.get(id);
  if (!cfg) {
    const preset = PRESETS[id];
    // Presets are authored in this repo; they still go through the sanitizer so a bad value
    // cannot leak into a live config (tests assert presets produce no issues).
    const merged = deepMerge(getDefaults() as unknown, preset?.config ?? {});
    const body = sanitizeGroup(schema, merged as Record<string, unknown>, getDefaults(), '', []);
    cfg = { ...body, version: CONFIG_VERSION } as LumiCellsConfig;
    presetCache.set(id, cfg);
  }
  return cfg;
}

/** Fully resolved config of a preset (defaults + preset patch). Returns a fresh copy. */
export function getPresetConfig(id: PresetId): LumiCellsConfig {
  return cloneData(presetBase(id));
}

/**
 * Full normalization: `extends` preset (if any), then the input over it, with every value checked
 * against the schema. Never throws.
 */
export function normalizeConfig(raw: unknown): { config: LumiCellsConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  let obj = checkRoot(raw, issues);
  obj = migrate(obj, issues);
  const ext = checkExtends(obj, issues);
  // The base is only read: sanitizeGroup copies (clones) whatever it takes from it.
  const base = (ext ? presetBase(ext) : getDefaults()) as unknown as Record<string, unknown>;
  const body = sanitizeGroup(schema, obj, base, '', issues);
  return { config: { version: CONFIG_VERSION, ...body } as LumiCellsConfig, issues };
}

/** Strict check: any issue (even a harmless coercion) makes the config invalid. */
export function validateConfig(raw: unknown): { ok: boolean; issues: ConfigIssue[] } {
  const { issues } = normalizeConfig(raw);
  return { ok: issues.length === 0, issues };
}

/**
 * Validates a partial config without filling defaults: invalid values are dropped from the
 * patch (so they do not override the current value), out-of-range values are clamped.
 * `extends` is kept when it names a known preset.
 */
export function normalizePatch(raw: unknown): {
  patch: LumiCellsConfigInput;
  issues: ConfigIssue[];
} {
  const issues: ConfigIssue[] = [];
  let obj = checkRoot(raw, issues);
  obj = migrate(obj, issues);
  const ext = checkExtends(obj, issues);
  const body = sanitizeGroup(schema, obj, undefined, '', issues);
  const patch = (ext ? { extends: ext, ...body } : body) as LumiCellsConfigInput;
  return { patch, issues };
}
