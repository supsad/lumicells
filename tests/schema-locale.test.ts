import { describe, expect, it } from 'vitest';
import {
  type FieldDef,
  getSchemaLocaleTexts,
  isGroup,
  LOCALES,
  localizedEnumLabel,
  localizedPreset,
  localizedText,
  PRESET_IDS,
  SCHEMA_META,
  toJsonSchema,
  walkSchema,
} from '../src/schema';
import { ru } from '../src/schema/locales/ru';

const CYRILLIC = /[Ѐ-ӿ]/;

interface Expected {
  groups: Map<string, { description: boolean }>;
  fields: Map<string, { description: boolean; unit: boolean }>;
  enums: Map<string, readonly string[]>;
}

/** What a translation must cover, derived from the schema and its English UI metadata. */
function expected(): Expected {
  const out: Expected = { groups: new Map(), fields: new Map(), enums: new Map() };
  walkSchema((node, path) => {
    if (isGroup(node)) {
      out.groups.set(path, { description: !!SCHEMA_META.groups[path]?.description });
      return;
    }
    const f = node as FieldDef;
    const meta = SCHEMA_META.fields[path];
    // Angles always read in degrees; every other unit is a word that needs translating.
    const unit = f.kind !== 'angle' && !!meta?.unit;
    out.fields.set(path, { description: !!meta?.description, unit });
    if (f.kind === 'enum') out.enums.set(path, f.values);
  });
  return out;
}

describe('schema locales', () => {
  const exp = expected();

  it('English is the source: the UI metadata and JSON Schema carry no Cyrillic', () => {
    const texts: string[] = [];
    for (const e of Object.values(SCHEMA_META.groups)) texts.push(e.label, e.description ?? '');
    for (const e of Object.values(SCHEMA_META.fields)) {
      texts.push(e.label, e.description ?? '', e.unit ?? '');
    }
    for (const labels of Object.values(SCHEMA_META.enums)) texts.push(...Object.values(labels));
    for (const p of Object.values(SCHEMA_META.presets)) texts.push(p.label, p.description);
    for (const t of texts) expect(CYRILLIC.test(t), t).toBe(false);
    expect(CYRILLIC.test(JSON.stringify(toJsonSchema()))).toBe(false);
  });

  it('ru covers every group, field, enum value and preset', () => {
    for (const [path, want] of exp.groups) {
      const e = ru.groups[path];
      expect(e?.label, `group ${path}`).toBeTruthy();
      if (want.description) expect(e?.description, `group ${path} description`).toBeTruthy();
    }
    for (const [path, want] of exp.fields) {
      const e = ru.fields[path];
      expect(e?.label, `field ${path}`).toBeTruthy();
      if (want.description) expect(e?.description, `field ${path} description`).toBeTruthy();
      if (want.unit) expect(e?.unit, `field ${path} unit`).toBeTruthy();
    }
    for (const [path, values] of exp.enums) {
      for (const v of values) expect(ru.enums[path]?.[v], `enum ${path}=${v}`).toBeTruthy();
    }
    for (const id of PRESET_IDS) {
      expect(ru.presets[id]?.label, `preset ${id}`).toBeTruthy();
      expect(ru.presets[id]?.description, `preset ${id} description`).toBeTruthy();
    }
  });

  it('ru has no stale keys', () => {
    const stale: string[] = [];
    for (const [path, e] of Object.entries(ru.groups)) {
      const want = exp.groups.get(path);
      if (!want) stale.push(`group ${path}`);
      else if (e.description && !want.description) stale.push(`group ${path} description`);
    }
    for (const [path, e] of Object.entries(ru.fields)) {
      const want = exp.fields.get(path);
      if (!want) stale.push(`field ${path}`);
      else {
        if (e.description && !want.description) stale.push(`field ${path} description`);
        if (e.unit && !want.unit) stale.push(`field ${path} unit`);
      }
    }
    for (const [path, labels] of Object.entries(ru.enums)) {
      const values = exp.enums.get(path);
      if (!values) stale.push(`enum ${path}`);
      else for (const v of Object.keys(labels)) if (!values.includes(v)) stale.push(`${path}=${v}`);
    }
    for (const id of Object.keys(ru.presets)) {
      if (!(PRESET_IDS as readonly string[]).includes(id)) stale.push(`preset ${id}`);
    }
    expect(stale).toEqual([]);
  });

  it('helpers return English from the UI metadata and Russian from the table', () => {
    expect(LOCALES).toEqual(['en', 'ru']);
    // English has a table too now: the UI metadata itself (it used to be undefined).
    expect(getSchemaLocaleTexts('en')).toBe(SCHEMA_META);
    expect(getSchemaLocaleTexts('ru')).toBe(ru);
    expect(localizedText('grid', 'en')).toEqual({
      label: 'Grid',
      description: 'Size and shape of the pixel-grid cells.',
    });
    expect(localizedText('grid', 'ru')?.label).toBe(ru.groups.grid?.label);
    expect(localizedText('animation.flicker.rate', 'en')?.unit).toBe('Hz');
    expect(localizedText('animation.flicker.rate', 'ru')?.unit).toBe('Гц');
    // Angle units are language-neutral and come from the English metadata in every locale.
    expect(localizedText('color.angle', 'en')?.unit).toBe('°');
    expect(localizedText('color.angle', 'ru')?.unit).toBe('°');
    expect(localizedText('no.such.path', 'ru')).toBeUndefined();
    // The root (path '') is named in every locale, as before the UI metadata moved to meta.ts.
    expect(localizedText('', 'en')).toEqual({ label: 'LumiCells' });
    expect(localizedText('', 'ru')).toEqual({ label: 'LumiCells' });
    // Paths are user input: inherited object keys are not entries.
    expect(localizedText('constructor', 'en')).toBeUndefined();
    expect(localizedText('toString', 'ru')).toBeUndefined();
    expect(localizedEnumLabel('render.quality', 'auto', 'en')).toBe('Auto');
    expect(localizedEnumLabel('render.quality', 'auto', 'ru')).toBe(
      ru.enums['render.quality']?.auto,
    );
    expect(localizedEnumLabel('render.quality', 'bogus', 'ru')).toBe('bogus');
    expect(localizedEnumLabel('render.quality', 'constructor', 'en')).toBe('constructor');
    expect(localizedEnumLabel('grid.gap', 'x', 'en')).toBe('x');
    expect(localizedPreset('orb', 'en')).toEqual(SCHEMA_META.presets.orb);
    expect(localizedPreset('orb', 'ru')).toEqual(ru.presets.orb);
  });

  it('an unknown locale (untyped callers) falls back to English', () => {
    const bogus = 'xx' as 'ru';
    expect(getSchemaLocaleTexts(bogus)).toBeUndefined();
    expect(localizedText('grid', bogus)?.label).toBe('Grid');
    expect(localizedEnumLabel('render.quality', 'auto', bogus)).toBe('Auto');
    expect(localizedPreset('orb', bogus)).toEqual(SCHEMA_META.presets.orb);
  });

  it('Russian texts are Russian', () => {
    for (const [path, e] of Object.entries(ru.fields)) {
      expect(CYRILLIC.test(e.label + (e.description ?? '')), path).toBe(true);
    }
  });
});
