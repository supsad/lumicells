/**
 * lumicells/schema: the pure (no DOM, no GL) config layer. Field factories stay internal
 * (generic names like `color` or `group` would pollute the package root); their types are public.
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
  GroupMeta,
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
  VisibleWhen,
} from './fields';
export { isGroup, isNumericField } from './fields';
export * from './json-schema';
export * from './normalize';
export * from './paths';
export * from './poster';
export * from './presets';
export * from './schema';
