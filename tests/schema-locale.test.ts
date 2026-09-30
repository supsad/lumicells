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
  PRESETS,
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

function expected(): Expected {
  const out: Expected = { groups: new Map(), fields: new Map(), enums: new Map() };
  walkSchema((node, path) => {
    if (isGroup(node)) {
      out.groups.set(path, { description: !!node.description });
      return;
    }
    const f = node as FieldDef;
    // Angles always read in degrees; every other unit is a word that needs translating.
    const unit = f.kind !== 'angle' && 'unit' in f && !!f.unit;
    out.fields.set(path, { description: !!f.description, unit });
    if (f.kind === 'enum') out.enums.set(path, f.values);
  });
  return out;
}

describe('schema locales', () => {
  const exp = expected();

  it('English is the source: the schema, presets and JSON Schema carry no Cyrillic', () => {
    walkSchema((node, path) => {
      const texts = [node.label, node.description ?? ''];
      if (!isGroup(node)) {
        if ('unit' in node && node.unit) texts.push(node.unit);
        if (node.kind === 'enum' && node.labels) texts.push(...Object.values(node.labels));
      }
      for (const t of texts) expect(CYRILLIC.test(t), `${path}: ${t}`).toBe(false);
    });
    for (const id of PRESET_IDS) {
      expect(CYRILLIC.test(PRESETS[id].label + PRESETS[id].description), id).toBe(false);
    }
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

  it('helpers return English from the schema and Russian from the table', () => {
    expect(LOCALES).toEqual(['en', 'ru']);
    expect(getSchemaLocaleTexts('en')).toBeUndefined();
    expect(localizedText('grid', 'en')?.label).toBe('Grid');
    expect(localizedText('grid', 'ru')?.label).toBe(ru.groups.grid?.label);
    expect(localizedText('animation.flicker.rate', 'en')?.unit).toBe('Hz');
    expect(localizedText('animation.flicker.rate', 'ru')?.unit).toBe('Гц');
    // Angle units are language-neutral and come from the schema in every locale.
    expect(localizedText('color.angle', 'ru')?.unit).toBe('°');
    expect(localizedText('no.such.path', 'ru')).toBeUndefined();
    expect(localizedEnumLabel('render.quality', 'auto', 'en')).toBe('Auto');
    expect(localizedEnumLabel('render.quality', 'auto', 'ru')).toBe(
      ru.enums['render.quality']?.auto,
    );
    expect(localizedEnumLabel('render.quality', 'bogus', 'ru')).toBe('bogus');
    expect(localizedPreset('orb', 'en')).toEqual({
      label: PRESETS.orb.label,
      description: PRESETS.orb.description,
    });
    expect(localizedPreset('orb', 'ru')).toEqual(ru.presets.orb);
  });

  it('Russian texts are Russian', () => {
    for (const [path, e] of Object.entries(ru.fields)) {
      expect(CYRILLIC.test(e.label + (e.description ?? '')), path).toBe(true);
    }
  });
});
