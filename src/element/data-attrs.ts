/**
 * Parsing of the declarative `data-pl-*` attributes. Values follow the same rules as the config
 * schema: numbers are clamped to the documented range, colors must be valid hex, enums fall back
 * to "not set" instead of throwing. Pure functions over anything with `getAttribute`.
 */

import { isHexColor, normalizeHex } from '../core/color';
import type { BindElementOptions, InfluenceType } from '../core/types';

export const ATTR_INFLUENCE = 'data-pl-influence';
export const ATTR_FOR = 'data-pl-for';
export const ATTR_PULSE = 'data-pl-pulse';
export const ATTR_LIFT = 'data-pl-lift';

/** Every attribute that changes binding behavior; used as the MutationObserver filter. */
export const DATA_PL_ATTRS: readonly string[] = [
  ATTR_INFLUENCE,
  ATTR_FOR,
  ATTR_PULSE,
  ATTR_LIFT,
  'data-pl-type',
  'data-pl-color',
  'data-pl-color-mix',
  'data-pl-strength',
  'data-pl-falloff',
  'data-pl-priority',
  'data-pl-track',
  'data-pl-padding',
];

/** Selector matching every element that may carry bindings. */
export const MANAGED_SELECTOR = `[${ATTR_INFLUENCE}],[${ATTR_PULSE}],[${ATTR_LIFT}]`;

const INFLUENCE_TYPES: readonly InfluenceType[] = ['light', 'shadow', 'lift', 'seed', 'repel'];
const TRACK_MODES = ['auto', 'frame'] as const;

/** Ranges mirror the schema (interaction.influenceStrength / influenceFalloff). */
export const RANGES = {
  strength: [0, 2],
  falloff: [0.2, 10],
  priority: [-1000, 1000],
  padding: [0, 200],
  colorMix: [0, 1],
} as const;

export type PointerTrigger = 'click' | 'hover';

export interface PlAttrs {
  /** Influence options, or null when the element has no `data-pl-influence`. */
  influence: BindElementOptions | null;
  /** `data-pl-pulse`: emit a pulse on this event. */
  pulse: PointerTrigger | null;
  /** `data-pl-lift`: lift cells on this event. */
  lift: PointerTrigger | null;
  /** Color/strength reused for pulses triggered by `data-pl-pulse`. */
  pulseColor?: string;
  pulseStrength?: number;
}

type AttrSource = Pick<Element, 'getAttribute' | 'hasAttribute'>;

function parseNumber(
  raw: string | null,
  [min, max]: readonly [number, number] | readonly number[],
): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max as number, Math.max(min as number, n));
}

function parseEnum<T extends string>(raw: string | null, values: readonly T[]): T | undefined {
  const v = raw?.trim().toLowerCase();
  return values.find((x) => x === v);
}

function parseTrigger(
  raw: string | null,
  allowed: readonly PointerTrigger[],
): PointerTrigger | null {
  return parseEnum(raw, allowed) ?? null;
}

/** True when the element carries any binding attribute. */
export function isManaged(el: AttrSource): boolean {
  return (
    el.hasAttribute(ATTR_INFLUENCE) || el.hasAttribute(ATTR_PULSE) || el.hasAttribute(ATTR_LIFT)
  );
}

export function parsePlAttrs(el: AttrSource): PlAttrs {
  const colorRaw = el.getAttribute('data-pl-color');
  const color = isHexColor(colorRaw) ? normalizeHex(colorRaw) : undefined;
  const strength = parseNumber(el.getAttribute('data-pl-strength'), RANGES.strength);

  let influence: BindElementOptions | null = null;
  const flag = el.getAttribute(ATTR_INFLUENCE);
  if (flag !== null && flag.trim().toLowerCase() !== 'false') {
    // The attribute value doubles as a type shorthand: data-pl-influence="shadow".
    const type =
      parseEnum(el.getAttribute('data-pl-type'), INFLUENCE_TYPES) ??
      parseEnum(flag, INFLUENCE_TYPES);
    const colorMix =
      parseNumber(el.getAttribute('data-pl-color-mix'), RANGES.colorMix) ?? (color ? 1 : undefined);
    influence = {};
    // Undefined keys are skipped so the facade applies its own defaults.
    const set = <K extends keyof BindElementOptions>(
      k: K,
      v: BindElementOptions[K] | undefined,
    ) => {
      if (v !== undefined && influence) influence[k] = v;
    };
    set('type', type);
    set('color', color);
    set('colorMix', colorMix);
    set('strength', strength);
    set('falloff', parseNumber(el.getAttribute('data-pl-falloff'), RANGES.falloff));
    set('priority', parseNumber(el.getAttribute('data-pl-priority'), RANGES.priority));
    set('padding', parseNumber(el.getAttribute('data-pl-padding'), RANGES.padding));
    set('track', parseEnum(el.getAttribute('data-pl-track'), TRACK_MODES));
  }

  return {
    influence,
    pulse: parseTrigger(el.getAttribute(ATTR_PULSE), ['click', 'hover']),
    lift: parseTrigger(el.getAttribute(ATTR_LIFT), ['hover', 'click']),
    pulseColor: color,
    pulseStrength: strength,
  };
}

/** Stable text form of parsed attributes; equal strings mean nothing needs to change. */
export function attrsSignature(a: PlAttrs): string {
  return JSON.stringify(a);
}
