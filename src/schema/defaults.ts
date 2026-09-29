import { type GroupDef, isGroup } from './fields';
import { CONFIG_VERSION, type PixelLifeConfig, schema } from './schema';

function build(g: GroupDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(g.fields)) {
    const node = g.fields[key];
    if (!node) continue;
    if (isGroup(node)) out[key] = build(node);
    else out[key] = Array.isArray(node.default) ? node.default.slice() : node.default;
  }
  return out;
}

/** A fresh deep copy of the default config (the "reference" look). */
export function getDefaults(): PixelLifeConfig {
  return { version: CONFIG_VERSION, ...build(schema) } as PixelLifeConfig;
}
