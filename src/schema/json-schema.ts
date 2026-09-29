/**
 * JSON Schema (draft 2020-12) generated from the schema tree, for editor autocompletion and
 * validation of exported config files. `x-*` keywords carry stand metadata.
 */

import { type FieldDef, type GroupDef, isGroup } from './fields';
import { PRESET_IDS } from './presets';
import { CONFIG_VERSION, schema } from './schema';

type Json = Record<string, unknown>;

const HEX_PATTERN = '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$';

function meta(node: FieldDef | GroupDef, out: Json): Json {
  out.title = node.label;
  if (node.description) out.description = node.description;
  if (node.order !== undefined) out['x-order'] = node.order;
  if (node.advanced) out['x-advanced'] = true;
  if (node.visibleWhen) out['x-visibleWhen'] = { ...node.visibleWhen };
  return out;
}

function leaf(f: FieldDef): Json {
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
      if (f.unit) out['x-unit'] = f.unit;
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
      if (f.unit) out['x-unit'] = f.unit;
      break;
    case 'enum':
      out.type = 'string';
      out.enum = [...f.values];
      if (f.labels) out['x-enumLabels'] = { ...f.labels };
      break;
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
  return meta(f, out);
}

function groupSchema(g: GroupDef): Json {
  const properties: Json = {};
  for (const key of Object.keys(g.fields)) {
    const node = g.fields[key];
    if (!node) continue;
    properties[key] = isGroup(node) ? groupSchema(node) : leaf(node);
  }
  const out: Json = { type: 'object', additionalProperties: false, properties };
  if (g.role) out['x-kind'] = g.role;
  return meta(g, out);
}

/** Builds the JSON Schema for config files (every property optional; unknown keys rejected). */
export function toJsonSchema(): Json {
  const root = groupSchema(schema);
  const properties = {
    $schema: { type: 'string', title: 'JSON Schema URL' },
    version: { const: CONFIG_VERSION, title: 'Версия формата' },
    extends: { type: 'string', enum: [...PRESET_IDS], title: 'Базовый пресет' },
    ...(root.properties as Json),
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'pixel-life.schema.json',
    title: 'Pixel Life config',
    description: 'Конфигурация живого пиксельного фона pixel-life.',
    type: 'object',
    additionalProperties: false,
    properties,
  };
}
