/**
 * Packs every `gpu` schema field into a std140 `vec4 u_p[N]` uniform array and generates the
 * matching GLSL prelude (block declaration + one `#define P_<path>` per field + enum macros).
 *
 * Packing is first-fit in schema order, so the layout is deterministic and holes left by
 * vec2/color alignment get reused by later scalars. vec2 sits on .xy or .zw, colors on .xyz,
 * so no vector ever straddles a vec4 boundary.
 */

import {
  type FieldDef,
  type GroupDef,
  isGroup,
  MODE_IDS,
  type ParamPath,
  schema,
  walkSchema,
} from '../../schema';
import { hexToRgb, srgbToLinear } from '../color';

export type SlotKind = 'number' | 'int' | 'angle' | 'boolean' | 'enum' | 'color' | 'vec2';

export interface ParamSlot {
  /** vec4 index in u_p. */
  index: number;
  /** First component inside the vec4 (0..3). */
  comp: number;
  size: 1 | 2 | 3;
  kind: SlotKind;
  /** Float offset in the Float32Array: index * 4 + comp. */
  offset: number;
  /** GLSL macro name, e.g. P_grid_gap. */
  define: string;
  field: FieldDef;
}

export interface ParamLayout {
  readonly slots: ReadonlyMap<string, ParamSlot>;
  /** Paths of packed fields in packing (schema) order. */
  readonly paths: readonly ParamPath[];
  readonly vec4Count: number;
  /** vec4Count * 4: length of the Float32Array to upload. */
  readonly floatCount: number;
  readonly glslPrelude: string;
  /**
   * Writes one value converted for the GPU: angle deg -> rad, color hex -> linear RGB (an
   * `[r, g, b]` array is taken as already-linear RGB, so tweened colors avoid string parsing),
   * enum value -> index (a number is written as-is), boolean -> 0/1. Unknown paths are ignored.
   * Returns false when the path has no slot.
   */
  write(target: Float32Array, path: string, value: unknown): boolean;
  /** Writes every packed field from a full config. */
  writeAll(target: Float32Array, config: unknown): void;
}

export const MAX_PARAM_VEC4 = 64;

/** GLSL macro name for a parameter path. */
export function paramsDefine(path: string): string {
  return `P_${path.replace(/\./g, '_')}`;
}

/** GLSL macro name for an enum value. */
export function enumDefine(path: string, value: string): string {
  return `E_${path.replace(/\./g, '_')}_${value}`;
}

function slotSize(f: FieldDef): 1 | 2 | 3 {
  if (f.kind === 'vec2') return 2;
  if (f.kind === 'color') return 3;
  return 1;
}

function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

const SWIZZLE = 'xyzw';

// Colors are written every frame while tweening; cache hex parsing (bounded).
const linearCache = new Map<string, [number, number, number]>();
function hexToLinear(hex: string): [number, number, number] {
  let v = linearCache.get(hex);
  if (!v) {
    const [r, g, b] = hexToRgb(hex);
    v = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
    if (linearCache.size > 256) linearCache.clear();
    linearCache.set(hex, v);
  }
  return v;
}

function getByPath(cfg: unknown, path: string): unknown {
  let cur: unknown = cfg;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function createParamLayout(root: GroupDef = schema): ParamLayout {
  const gpuFields: { path: string; field: FieldDef }[] = [];
  walkSchema((node, path) => {
    if (!isGroup(node) && node.gpu) gpuFields.push({ path, field: node });
  }, root);

  // used[i] is a 4-bit mask of occupied components of vec4 i.
  const used: number[] = [];
  const place = (size: 1 | 2 | 3): [number, number] => {
    const candidates = size === 1 ? [0, 1, 2, 3] : size === 2 ? [0, 2] : [0];
    const mask = size === 1 ? 1 : size === 2 ? 3 : 7;
    for (let i = 0; ; i++) {
      const u = used[i] ?? 0;
      for (const c of candidates) {
        const m = mask << c;
        if ((u & m) === 0) {
          used[i] = u | m;
          return [i, c];
        }
      }
    }
  };

  const slots = new Map<string, ParamSlot>();
  const paths: ParamPath[] = [];
  for (const { path, field } of gpuFields) {
    if (field.kind === 'palette') {
      throw new Error(`lumicells: palette field '${path}' cannot be packed (use the LUT)`);
    }
    const size = slotSize(field);
    const [index, comp] = place(size);
    slots.set(path, {
      index,
      comp,
      size,
      kind: field.kind,
      offset: index * 4 + comp,
      define: paramsDefine(path),
      field,
    });
    paths.push(path as ParamPath);
  }

  const vec4Count = Math.max(1, used.length);
  if (vec4Count > MAX_PARAM_VEC4) {
    throw new Error(`lumicells: ${vec4Count} param vec4s exceed the limit of ${MAX_PARAM_VEC4}`);
  }

  const lines: string[] = [
    `#define PARAMS_VEC4_COUNT ${vec4Count}`,
    `layout(std140) uniform ParamsBlock { vec4 u_p[${vec4Count}]; };`,
  ];
  for (const path of paths) {
    const s = slots.get(path) as ParamSlot;
    const swz = SWIZZLE.slice(s.comp, s.comp + s.size);
    lines.push(`#define ${s.define} u_p[${s.index}].${swz}`);
  }
  MODE_IDS.forEach((id, i) => {
    lines.push(`#define MODE_${id.toUpperCase()} ${i}`);
  });
  // Enum value macros for every enum (packed or not), so shaders can compare CPU-provided indices too.
  walkSchema((node, path) => {
    if (node.kind === 'enum') {
      node.values.forEach((v, i) => {
        lines.push(`#define ${enumDefine(path, v)} ${glslFloat(i)}`);
      });
    }
  }, root);
  const glslPrelude = `${lines.join('\n')}\n`;

  const write = (target: Float32Array, path: string, value: unknown): boolean => {
    const s = slots.get(path);
    if (!s) return false;
    const o = s.offset;
    switch (s.kind) {
      case 'angle':
        target[o] = ((value as number) * Math.PI) / 180;
        break;
      case 'boolean':
        target[o] = value ? 1 : 0;
        break;
      case 'enum': {
        if (typeof value === 'number') target[o] = value;
        else {
          const i = (s.field as { values: readonly string[] }).values.indexOf(value as string);
          target[o] = i < 0 ? 0 : i;
        }
        break;
      }
      case 'color': {
        const lin = typeof value === 'string' ? hexToLinear(value) : (value as ArrayLike<number>);
        target[o] = lin[0] ?? 0;
        target[o + 1] = lin[1] ?? 0;
        target[o + 2] = lin[2] ?? 0;
        break;
      }
      case 'vec2': {
        const v = value as ArrayLike<number>;
        target[o] = v[0] ?? 0;
        target[o + 1] = v[1] ?? 0;
        break;
      }
      default:
        target[o] = value as number;
    }
    return true;
  };

  const writeAll = (target: Float32Array, config: unknown): void => {
    for (const path of paths) {
      const v = getByPath(config, path);
      if (v !== undefined) write(target, path, v);
    }
  };

  return { slots, paths, vec4Count, floatCount: vec4Count * 4, glslPrelude, write, writeAll };
}
