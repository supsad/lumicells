import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type FieldDef,
  getField,
  getMeta,
  isGroup,
  PRESET_IDS,
  PRESET_TEXTS,
  SCHEMA_META,
  walkSchema,
} from '../src/schema';

/** Keys the UI metadata may use; anything else is a typo or runtime data in the wrong place. */
const GROUP_KEYS = ['label', 'description', 'order', 'advanced', 'visibleWhen'];
const FIELD_KEYS = [...GROUP_KEYS, 'unit', 'widget'];
/** UI keys that must never reappear on runtime schema nodes (they would ship to every app). */
const UI_KEYS = [...FIELD_KEYS, 'labels'];

interface Paths {
  groups: string[];
  fields: Map<string, FieldDef>;
}

function schemaPaths(): Paths {
  const out: Paths = { groups: [], fields: new Map() };
  walkSchema((node, path) => {
    if (isGroup(node)) out.groups.push(path);
    else out.fields.set(path, node);
  });
  return out;
}

describe('schema UI metadata (meta.ts)', () => {
  const { groups, fields } = schemaPaths();

  it('every group and field has an English label and description', () => {
    const missing: string[] = [];
    for (const path of groups) {
      const m = SCHEMA_META.groups[path];
      if (!m?.label) missing.push(`group ${path} label`);
      if (!m?.description) missing.push(`group ${path} description`);
    }
    for (const path of fields.keys()) {
      const m = SCHEMA_META.fields[path];
      if (!m?.label) missing.push(`field ${path} label`);
      if (!m?.description) missing.push(`field ${path} description`);
    }
    expect(missing).toEqual([]);
  });

  it('every enum value and preset has English texts', () => {
    const missing: string[] = [];
    for (const [path, f] of fields) {
      if (f.kind !== 'enum') continue;
      for (const v of f.values) if (!SCHEMA_META.enums[path]?.[v]) missing.push(`${path}=${v}`);
    }
    for (const id of PRESET_IDS) {
      const p = SCHEMA_META.presets[id];
      if (!p?.label || !p.description) missing.push(`preset ${id}`);
    }
    expect(missing).toEqual([]);
  });

  it('has no stale keys', () => {
    const stale: string[] = [];
    const fieldPaths = new Set(fields.keys());
    for (const path of Object.keys(SCHEMA_META.groups)) {
      // '' is the root group (walkSchema starts below it).
      if (path !== '' && !groups.includes(path)) stale.push(`group ${path}`);
    }
    for (const path of Object.keys(SCHEMA_META.fields)) {
      if (!fieldPaths.has(path)) stale.push(`field ${path}`);
    }
    for (const [path, labels] of Object.entries(SCHEMA_META.enums)) {
      const f = fields.get(path);
      if (f?.kind !== 'enum') {
        stale.push(`enum ${path}`);
        continue;
      }
      for (const v of Object.keys(labels)) if (!f.values.includes(v)) stale.push(`${path}=${v}`);
    }
    for (const id of Object.keys(SCHEMA_META.presets)) {
      if (!(PRESET_IDS as readonly string[]).includes(id)) stale.push(`preset ${id}`);
    }
    expect(stale).toEqual([]);
  });

  it('entries use only UI keys, with valid hints', () => {
    const bad: string[] = [];
    for (const [path, m] of Object.entries(SCHEMA_META.groups)) {
      for (const k of Object.keys(m)) if (!GROUP_KEYS.includes(k)) bad.push(`group ${path}.${k}`);
    }
    for (const [path, m] of Object.entries(SCHEMA_META.fields)) {
      for (const k of Object.keys(m)) if (!FIELD_KEYS.includes(k)) bad.push(`field ${path}.${k}`);
      const f = fields.get(path);
      // Angles always read in degrees.
      if (f?.kind === 'angle' && m.unit !== '°') bad.push(`angle ${path} unit ${m.unit}`);
      if (m.widget && f?.kind !== 'number' && f?.kind !== 'int') bad.push(`widget ${path}`);
    }
    for (const m of [...Object.values(SCHEMA_META.groups), ...Object.values(SCHEMA_META.fields)]) {
      if (m.order !== undefined && !Number.isFinite(m.order)) bad.push(`order ${m.label}`);
      const w = m.visibleWhen;
      if (!w) continue;
      const cmp = ['eq', 'neq', 'gt'].filter((k) => k in w);
      if (!getField(w.path) || cmp.length !== 1) bad.push(`visibleWhen ${m.label} ${w.path}`);
    }
    expect(bad).toEqual([]);
  });

  it('runtime schema nodes carry no UI metadata', () => {
    const leaked: string[] = [];
    walkSchema((node, path) => {
      for (const k of UI_KEYS) if (k in node) leaked.push(`${path}.${k}`);
    });
    expect(leaked).toEqual([]);
  });

  it('PRESET_TEXTS is the preset part of SCHEMA_META', () => {
    // The <script src> bundle exports PRESET_TEXTS to name presets (PRESETS holds configs only).
    expect(SCHEMA_META.presets).toBe(PRESET_TEXTS);
    expect(Object.keys(PRESET_TEXTS)).toEqual([...PRESET_IDS]);
  });

  it('getMeta resolves groups and fields by own keys only', () => {
    expect(getMeta('grid')).toBe(SCHEMA_META.groups.grid);
    expect(getMeta('grid.pitch')).toBe(SCHEMA_META.fields['grid.pitch']);
    expect(getMeta('grid.pitch')?.unit).toBe('px');
    expect(getMeta('lift.floatSpeed')?.visibleWhen).toEqual({ path: 'lift.style', eq: 'float' });
    expect(getMeta('')).toEqual({ label: 'LumiCells' });
    expect(getMeta('no.such')).toBeUndefined();
    expect(getMeta('constructor')).toBeUndefined();
    expect(getMeta('__proto__')).toBeUndefined();
  });
});

// The runtime must not reach the UI metadata, or every app that only renders a background would
// ship it (scripts/size.mjs checks the built bundles; this catches it at the source).
describe('runtime modules do not use the UI metadata', () => {
  const src = resolve(__dirname, '../src');
  const UI_MODULES = /\/(meta|locale|json-schema)['"]|\/locales\//;
  const UI_NAMES =
    /\b(SCHEMA_META|getMeta|localizedText|localizedEnumLabel|localizedPreset|getSchemaLocaleTexts|toJsonSchema)\b/;

  function* files(dir: string): Generator<string> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) yield* files(full);
      else if (/\.tsx?$/.test(e.name)) yield full;
    }
  }

  /** Import statements and identifiers, without comments (which may mention the helpers). */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('core, react and element code never imports or calls the metadata helpers', () => {
    const offenders: string[] = [];
    for (const dir of ['core', 'react', 'element']) {
      for (const file of files(join(src, dir))) {
        const text = code(file);
        const imports = text.match(/\bfrom\s+['"][^'"]+['"]/g) ?? [];
        if (imports.some((i) => UI_MODULES.test(i)) || UI_NAMES.test(text)) {
          offenders.push(relative(src, file).replaceAll('\\', '/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime schema modules do not import the UI modules', () => {
    const runtime = [
      'defaults',
      'export',
      'fields',
      'normalize',
      'paths',
      'poster',
      'presets',
      'schema',
    ];
    const offenders: string[] = [];
    for (const name of runtime) {
      const text = code(join(src, 'schema', `${name}.ts`));
      const imports = text.match(/\bimport\s+(?!type\b)[^;]*?from\s+['"][^'"]+['"]/g) ?? [];
      if (imports.some((i) => UI_MODULES.test(i)) || UI_NAMES.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
