/**
 * lumicells/schema: the pure (no DOM, no GL) config layer. Field factories stay internal
 * (generic names like `color` or `group` would pollute the package root); their types are public.
 * The UI metadata (meta.ts) and everything built on it (localized texts, JSON Schema) is only
 * reachable from exports nothing in the runtime uses, so bundlers drop it from apps that never
 * import those helpers.
 */
export * from './defaults';
export * from './export';
export type {
  AngleField,
  Base,
  BoolField,
  ColorField,
  DeepPartial,
  EnumField,
  FieldDef,
  FieldKind,
  GroupDef,
  InferConfig,
  InferField,
  IntField,
  Live,
  NumField,
  PaletteField,
  PathValue,
  SchemaFields,
  SchemaLeafPaths,
  SchemaNode,
  Vec2,
  Vec2Field,
} from './fields';
export { isGroup, isNumericField } from './fields';
export * from './json-schema';
export * from './locale';
export * from './meta';
export * from './normalize';
export * from './paths';
export * from './poster';
export * from './presets';
export * from './schema';
