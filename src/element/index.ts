/**
 * pixel-life/element: the <pixel-life> custom element class and helpers. Importing this module
 * does NOT register the tag (use `pixel-life/element/define` for that), so it is safe on the
 * server and lets apps register the element under a different name.
 */

export {
  ATTR_FOR,
  ATTR_INFLUENCE,
  ATTR_LIFT,
  ATTR_PULSE,
  DATA_PL_ATTRS,
  isManaged,
  type PlAttrs,
  type PointerTrigger,
  parsePlAttrs,
} from './data-attrs';
export {
  definePixelLifeElement,
  PIXEL_LIFE_TAG,
  PixelLifeElement,
  type PixelLifeElementEventMap,
} from './pixel-life-element';
export {
  DEFAULT_OVERFLOW_PX,
  overflowToPx,
  type ResolvedConfig,
  type ResolveInput,
  resolveConfig,
} from './resolve';
