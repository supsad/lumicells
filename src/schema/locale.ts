/**
 * Localized schema texts. English is the primary language and comes from the schema itself
 * (labels, descriptions, units, enum labels, preset names), so the generated JSON Schema is
 * English. Other locales are plain tables keyed by dotted path (see locales/*.ts); the helpers
 * below fall back to English for anything a table does not cover.
 */

import { type FieldDef, type GroupDef, isGroup } from './fields';
import { ru } from './locales/ru';
import { getNode } from './paths';
import { PRESETS, type PresetId } from './presets';

export type Locale = 'en' | 'ru';

export const LOCALES: readonly Locale[] = ['en', 'ru'];

export function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'ru';
}

/** Display texts of one schema node (group or field). */
export interface LocalizedText {
  label: string;
  description?: string;
  unit?: string;
}

/** Display texts of a preset. */
export interface LocalizedPreset {
  label: string;
  description: string;
}

/** Shape of a translation table (every non-English locale provides one). */
export interface SchemaLocaleTexts {
  /** Groups by dotted path (units never apply to groups). */
  groups: Record<string, { label: string; description?: string }>;
  /** Leaf fields by dotted path. `unit` is required when the field has a non-angle unit. */
  fields: Record<string, LocalizedText>;
  /** Enum value labels: path -> value -> label. */
  enums: Record<string, Record<string, string>>;
  presets: Record<PresetId, LocalizedPreset>;
}

const TABLES: Record<Exclude<Locale, 'en'>, SchemaLocaleTexts> = { ru };

/** The translation table of a locale (undefined for English, which lives in the schema). */
export function getSchemaLocaleTexts(locale: Locale): SchemaLocaleTexts | undefined {
  return locale === 'en' ? undefined : TABLES[locale];
}

function englishOf(node: FieldDef | GroupDef): LocalizedText {
  const out: LocalizedText = { label: node.label };
  if (node.description) out.description = node.description;
  if (!isGroup(node) && 'unit' in node && node.unit) out.unit = node.unit;
  return out;
}

/**
 * Label, description and unit of the schema node at `path` in `locale`. Returns undefined for an
 * unknown path; missing translations fall back to English field by field.
 */
export function localizedText(path: string, locale: Locale): LocalizedText | undefined {
  const node = getNode(path);
  if (!node) return undefined;
  const base = englishOf(node);
  const table = getSchemaLocaleTexts(locale);
  if (!table) return base;
  const tr: LocalizedText | undefined = isGroup(node) ? table.groups[path] : table.fields[path];
  if (!tr) return base;
  const out: LocalizedText = { label: tr.label || base.label };
  const description = tr.description ?? base.description;
  if (description) out.description = description;
  const unit = tr.unit ?? base.unit;
  if (unit) out.unit = unit;
  return out;
}

/** Label of one enum value; falls back to the English label, then to the raw value. */
export function localizedEnumLabel(path: string, value: string, locale: Locale): string {
  const node = getNode(path);
  const english =
    node?.kind === 'enum'
      ? ((node.labels as Record<string, string> | undefined)?.[value] ?? value)
      : value;
  return getSchemaLocaleTexts(locale)?.enums[path]?.[value] ?? english;
}

/** Name and description of a preset in `locale`. */
export function localizedPreset(id: PresetId, locale: Locale): LocalizedPreset {
  const def = PRESETS[id];
  const tr = getSchemaLocaleTexts(locale)?.presets[id];
  return {
    label: tr?.label ?? def.label,
    description: tr?.description ?? def.description,
  };
}
