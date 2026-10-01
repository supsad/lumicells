/**
 * Localized schema texts. English is the primary language: the UI metadata table (meta.ts) holds
 * the English labels, descriptions, units, enum labels and preset names, so the generated JSON
 * Schema is English. Other locales are plain tables of the same shape keyed by dotted path (see
 * locales/*.ts); the helpers below fall back to English for anything a table does not cover.
 */

import { ru } from './locales/ru';
import { type FieldMeta, type GroupMeta, SCHEMA_META } from './meta';
import type { PresetId } from './presets';

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

/** Shape of a translation table (every locale provides one; English is the UI metadata). */
export interface SchemaLocaleTexts {
  /** Groups by dotted path (units never apply to groups). */
  groups: Record<string, { label: string; description?: string }>;
  /** Leaf fields by dotted path. `unit` is required when the field has a non-angle unit. */
  fields: Record<string, LocalizedText>;
  /** Enum value labels: path -> value -> label. */
  enums: Record<string, Record<string, string>>;
  presets: Record<PresetId, LocalizedPreset>;
}

const TABLES: Record<Locale, SchemaLocaleTexts> = { en: SCHEMA_META, ru };

/** Own entry of a table (paths are user input: never read inherited keys like 'constructor'). */
function own<T>(table: Record<string, T> | undefined, key: string): T | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The translation table of a locale. For English it is the UI metadata table itself (SCHEMA_META);
 * undefined only for an unknown locale.
 */
export function getSchemaLocaleTexts(locale: Locale): SchemaLocaleTexts | undefined {
  return own(TABLES, locale);
}

function textOf(meta: GroupMeta | FieldMeta): LocalizedText {
  const out: LocalizedText = { label: meta.label };
  if (meta.description) out.description = meta.description;
  if ('unit' in meta && meta.unit) out.unit = meta.unit;
  return out;
}

/**
 * Label, description and unit of the schema node at `path` in `locale`. Returns undefined for an
 * unknown path; missing translations fall back to English field by field.
 */
export function localizedText(path: string, locale: Locale): LocalizedText | undefined {
  const field = own(SCHEMA_META.fields, path);
  const meta = field ?? own(SCHEMA_META.groups, path);
  if (!meta) return undefined;
  const base = textOf(meta);
  const table = locale === 'en' ? undefined : own(TABLES, locale);
  if (!table) return base;
  const tr: LocalizedText | undefined = field ? own(table.fields, path) : own(table.groups, path);
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
  return (
    own(own(own(TABLES, locale)?.enums, path), value) ??
    own(own(SCHEMA_META.enums, path), value) ??
    value
  );
}

/** Name and description of a preset in `locale`. */
export function localizedPreset(id: PresetId, locale: Locale): LocalizedPreset {
  const en = SCHEMA_META.presets[id];
  const tr = own<LocalizedPreset>(own(TABLES, locale)?.presets, id);
  return {
    label: tr?.label ?? en.label,
    description: tr?.description ?? en.description,
  };
}
