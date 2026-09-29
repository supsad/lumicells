/**
 * Config resolution shared by the React wrapper and the Web Component: the wrappers accept a
 * preset, a partial config and a few shortcut props, and both must turn them into the same
 * normalized config (and the same change key).
 *
 * Pure (no DOM), so it is safe to import on the server.
 */

import {
  type ConfigIssue,
  deepMerge,
  normalizeConfig,
  type PixelLifeConfig,
  type PixelLifeConfigInput,
  type PresetId,
  stableStringify,
} from '../schema';

/** Margin used when `overflow` is given as a bare `true`. */
export const DEFAULT_OVERFLOW_PX = 64;

/** `overflow` shortcut -> `render.overflow` in px (undefined = do not touch the config). */
export function overflowToPx(value: boolean | number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true) return DEFAULT_OVERFLOW_PX;
  if (value === false) return 0;
  return Number.isFinite(value) ? Math.max(0, value) : undefined;
}

export interface ResolveInput {
  preset?: PresetId | null;
  /** Patches applied over the preset, later layers win (e.g. fetched file, then inline config). */
  layers?: ReadonlyArray<PixelLifeConfigInput | null | undefined>;
  /** Shortcut for `interaction.pointer` + `interaction.click`; undefined leaves them alone. */
  interactive?: boolean;
  overflow?: boolean | number | null;
}

export interface ResolvedConfig {
  config: PixelLifeConfig;
  /** stableStringify of the normalized config: equal keys mean "nothing to apply". */
  key: string;
  issues: ConfigIssue[];
}

/** Merge order: defaults < preset < layers < shortcut props. Never throws. */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  let raw: PixelLifeConfigInput = input.preset ? { extends: input.preset } : {};
  for (const layer of input.layers ?? []) {
    if (layer) raw = deepMerge(raw, layer);
  }
  if (input.interactive !== undefined) {
    raw = deepMerge(raw, {
      interaction: { pointer: input.interactive, click: input.interactive },
    });
  }
  const overflow = overflowToPx(input.overflow);
  if (overflow !== undefined) raw = deepMerge(raw, { render: { overflow } });
  const { config, issues } = normalizeConfig(raw);
  return { config, key: stableStringify(config), issues };
}
