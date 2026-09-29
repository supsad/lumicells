/**
 * Field factories and type machinery for the config schema.
 *
 * The schema tree (schema.ts) is the single source of truth: the config type, defaults,
 * normalization, the stand UI, JSON Schema and the GPU parameter layout are all derived from it.
 * Factories return precisely typed objects so the config type can be inferred without a
 * hand-written duplicate.
 */

/**
 * How a change of the field reaches the renderer.
 * - uniform: tweened and uploaded to the GPU (or read by the CPU sim) every frame; modulatable if numeric
 * - lut: rebakes the palette LUT (animated OKLab transition)
 * - realloc: changes grid geometry (tweened where numeric; the engine reallocates textures)
 * - restart: resets a simulation instantly (e.g. the life rule)
 * - static: read on change, never tweened (render settings, the transition itself)
 */
export type Live = 'uniform' | 'lut' | 'realloc' | 'restart' | 'static';

/** Show a control only when another field matches. Exactly one comparison is expected. */
export interface VisibleWhen {
  path: string;
  eq?: unknown;
  neq?: unknown;
  gt?: number;
}

export interface Base<T> {
  default: T;
  label: string;
  description?: string;
  order?: number;
  advanced?: boolean;
  /** Defaults to 'uniform'. */
  live?: Live;
  /** Packed into the Params UBO. Defaults to false. */
  gpu?: boolean;
  visibleWhen?: VisibleWhen;
}

export interface NumOptions extends Base<number> {
  min: number;
  max: number;
  step?: number;
  scale?: 'linear' | 'log';
  unit?: string;
  tween?: 'exp' | 'none';
  widget?: 'slider' | 'knob';
}

export interface NumField extends NumOptions {
  readonly kind: 'number';
  live: Live;
  gpu: boolean;
}

export interface IntField extends NumOptions {
  readonly kind: 'int';
  live: Live;
  gpu: boolean;
}

export interface AngleOptions extends Base<number> {
  min?: number;
  max?: number;
  step?: number;
}

export interface AngleField extends Base<number> {
  readonly kind: 'angle';
  min: number;
  max: number;
  step: number;
  unit: string;
  /** True when [min, max] spans a full turn: values wrap and tween along the shortest arc. */
  fullCircle: boolean;
  live: Live;
  gpu: boolean;
}

export interface BoolField extends Base<boolean> {
  readonly kind: 'boolean';
  live: Live;
  gpu: boolean;
}

export interface ColorField extends Base<string> {
  readonly kind: 'color';
  live: Live;
  gpu: boolean;
}

export type Vec2 = [number, number];

export interface Vec2Options extends Base<Vec2> {
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

export interface Vec2Field extends Vec2Options {
  readonly kind: 'vec2';
  live: Live;
  gpu: boolean;
}

export interface EnumOptions<V extends readonly string[]> extends Base<V[number]> {
  values: V;
  labels?: Record<V[number], string>;
  transition?: 'instant' | 'crossfade';
}

export interface EnumField<V extends readonly string[] = readonly string[]> extends EnumOptions<V> {
  readonly kind: 'enum';
  transition: 'instant' | 'crossfade';
  live: Live;
  gpu: boolean;
}

export interface PaletteOptions extends Base<string[]> {
  minStops?: number;
  maxStops?: number;
}

export interface PaletteField extends Base<string[]> {
  readonly kind: 'palette';
  minStops: number;
  maxStops: number;
  live: Live;
  gpu: boolean;
}

export type FieldDef =
  | NumField
  | IntField
  | AngleField
  | BoolField
  | ColorField
  | Vec2Field
  | EnumField
  | PaletteField;

export type FieldKind = FieldDef['kind'];

export interface GroupMeta {
  label: string;
  description?: string;
  order?: number;
  advanced?: boolean;
  visibleWhen?: VisibleWhen;
  /** 'mode' marks an animation mode (children start with `weight`). */
  kind?: 'mode';
}

export type SchemaNode = FieldDef | GroupDef<SchemaFields>;
export type SchemaFields = { readonly [key: string]: SchemaNode };

export interface GroupDef<F extends SchemaFields = SchemaFields> extends Omit<GroupMeta, 'kind'> {
  readonly kind: 'group';
  /** 'mode' for animation mode groups. */
  role?: 'mode';
  fields: F;
}

// ---------------------------------------------------------------------------------------------
// Factories

export function num(o: NumOptions): NumField {
  return { ...o, kind: 'number', live: o.live ?? 'uniform', gpu: o.gpu ?? false };
}

export function int(o: NumOptions): IntField {
  return { ...o, kind: 'int', live: o.live ?? 'uniform', gpu: o.gpu ?? false };
}

export function angle(o: AngleOptions): AngleField {
  const min = o.min ?? 0;
  const max = o.max ?? 360;
  return {
    ...o,
    kind: 'angle',
    min,
    max,
    step: o.step ?? 1,
    unit: '°',
    fullCircle: max - min >= 360,
    live: o.live ?? 'uniform',
    gpu: o.gpu ?? false,
  };
}

export function bool(o: Base<boolean>): BoolField {
  return { ...o, kind: 'boolean', live: o.live ?? 'uniform', gpu: o.gpu ?? false };
}

export function color(o: Base<string>): ColorField {
  return { ...o, kind: 'color', live: o.live ?? 'uniform', gpu: o.gpu ?? false };
}

export function vec2(o: Vec2Options): Vec2Field {
  return { ...o, kind: 'vec2', live: o.live ?? 'uniform', gpu: o.gpu ?? false };
}

export function enumField<const V extends readonly string[]>(o: EnumOptions<V>): EnumField<V> {
  return {
    ...o,
    kind: 'enum',
    transition: o.transition ?? 'instant',
    live: o.live ?? 'uniform',
    gpu: o.gpu ?? false,
  };
}

export function palette(o: PaletteOptions): PaletteField {
  return {
    ...o,
    kind: 'palette',
    minStops: o.minStops ?? 1,
    maxStops: o.maxStops ?? 32,
    live: o.live ?? 'lut',
    gpu: o.gpu ?? false,
  };
}

export function group<const F extends SchemaFields>(meta: GroupMeta, fields: F): GroupDef<F> {
  const { kind, ...rest } = meta;
  const g: GroupDef<F> = { ...rest, kind: 'group', fields };
  if (kind === 'mode') g.role = 'mode';
  return g;
}

export function isGroup(node: SchemaNode | undefined): node is GroupDef {
  return node?.kind === 'group';
}

export function isNumericField(
  node: SchemaNode | undefined,
): node is NumField | IntField | AngleField {
  return node?.kind === 'number' || node?.kind === 'int' || node?.kind === 'angle';
}

// ---------------------------------------------------------------------------------------------
// Type machinery (tree depth <= 4, so plain recursion stays cheap)

/** Value type of one schema node: group -> nested object, enum -> literal union. */
export type InferField<N> =
  N extends GroupDef<infer C>
    ? InferConfig<C>
    : N extends EnumField<infer V>
      ? V[number]
      : N extends { default: infer T }
        ? T
        : never;

export type InferConfig<S> = { -readonly [K in keyof S]: InferField<S[K]> };

/** Dotted paths of every leaf (non-group) node. */
export type SchemaLeafPaths<S, P extends string = ''> = {
  [K in keyof S & string]: S[K] extends GroupDef<infer C>
    ? SchemaLeafPaths<C, `${P}${K}.`>
    : `${P}${K}`;
}[keyof S & string];

/** Value at a dotted path of an object type. */
export type PathValue<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? PathValue<T[H], R>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/** Schema node at a dotted path. */
export type NodeAt<S, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof S
    ? S[H] extends GroupDef<infer C>
      ? NodeAt<C, R>
      : never
    : never
  : P extends keyof S
    ? S[P]
    : never;

/** Arrays and tuples are leaves: they are replaced as a whole, never partially. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
