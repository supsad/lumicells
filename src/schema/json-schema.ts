/**
 * JSON Schema (draft 2020-12) generated from the schema tree, for editor autocompletion and
 * validation of exported config files. Titles, descriptions and units come from the UI metadata
 * (meta.ts); `x-*` keywords carry stand metadata.
 */

import { type FieldDef, type GroupDef, isGroup } from './fields';
import { type FieldMeta, getMeta, SCHEMA_META } from './meta';
import { PRESET_IDS } from './presets';
import { CONFIG_VERSION, schema } from './schema';

type Json = Record<string, unknown>;

const HEX_PATTERN = '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$';

function metaOf(path: string): FieldMeta {
  const m = getMeta(path);
  if (!m) throw new Error(`[lumicells] no UI metadata for "${path}"`);
  return m;
}

function annotate(m: FieldMeta, out: Json): Json {
  out.title = m.label;
  if (m.description) out.description = m.description;
  if (m.order !== undefined) out['x-order'] = m.order;
  if (m.advanced) out['x-advanced'] = true;
  if (m.visibleWhen) out['x-visibleWhen'] = { ...m.visibleWhen };
  return out;
}

function leaf(f: FieldDef, path: string): Json {
  const m = metaOf(path);
  const out: Json = {};
  switch (f.kind) {
    case 'number':
    case 'int':
    case 'angle':
      out.type = f.kind === 'int' ? 'integer' : 'number';
      out.minimum = f.min;
      out.maximum = f.max;
      if (f.step !== undefined) out['x-step'] = f.step;
      if (f.kind !== 'angle' && f.scale) out['x-scale'] = f.scale;
      if (m.unit) out['x-unit'] = m.unit;
      break;
    case 'boolean':
      out.type = 'boolean';
      break;
    case 'color':
      out.type = 'string';
      out.pattern = HEX_PATTERN;
      out.format = 'color';
      break;
    case 'vec2':
      out.type = 'array';
      out.prefixItems = [0, 1].map(() => ({ type: 'number', minimum: f.min, maximum: f.max }));
      out.items = false;
      out.minItems = 2;
      out.maxItems = 2;
      if (m.unit) out['x-unit'] = m.unit;
      break;
    case 'enum': {
      out.type = 'string';
      out.enum = [...f.values];
      const labels = Object.hasOwn(SCHEMA_META.enums, path) ? SCHEMA_META.enums[path] : undefined;
      if (labels) out['x-enumLabels'] = { ...labels };
      break;
    }
    case 'palette':
      out.type = 'array';
      out.items = { type: 'string', pattern: HEX_PATTERN };
      out.minItems = f.minStops;
      out.maxItems = f.maxStops;
      break;
  }
  out.default = Array.isArray(f.default) ? [...f.default] : f.default;
  out['x-live'] = f.live;
  if (f.gpu) out['x-gpu'] = true;
  return annotate(m, out);
}

function groupSchema(g: GroupDef, path: string): Json {
  const properties: Json = {};
  for (const key of Object.keys(g.fields)) {
    const node = g.fields[key];
    if (!node) continue;
    const p = path ? `${path}.${key}` : key;
    properties[key] = isGroup(node) ? groupSchema(node, p) : leaf(node, p);
  }
  const out: Json = { type: 'object', additionalProperties: false, properties };
  if (g.role) out['x-kind'] = g.role;
  return path ? annotate(metaOf(path), out) : out;
}

/** Builds the JSON Schema for config files (every property optional; unknown keys rejected). */
export function toJsonSchema(): Json {
  const root = groupSchema(schema, '');
  const properties = {
    $schema: { type: 'string', title: 'JSON Schema URL' },
    version: { const: CONFIG_VERSION, title: 'Format version' },
    extends: { type: 'string', enum: [...PRESET_IDS], title: 'Base preset' },
    ...(root.properties as Json),
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'lumicells.schema.json',
    title: 'LumiCells config',
    description: 'Configuration of the LumiCells live pixel-grid background.',
    type: 'object',
    additionalProperties: false,
    properties,
  };
}
