/**
 * Path helpers over configs and the schema tree. Pure and allocation-light; not meant for
 * per-frame use (the controller resolves paths to slots once).
 */

import { type FieldDef, type GroupDef, isGroup, type SchemaNode } from './fields';
import { type LumiCellsConfig, type ParamPath, type ParamValue, schema } from './schema';

export type SchemaVisitor = (
  node: SchemaNode,
  path: string,
  parentGroups: readonly GroupDef[],
) => unknown;

/**
 * Depth-first walk in declaration order (the order shared by the stand, JSON Schema and the GPU
 * layout). Visits groups before their children; returning false from a group skips its subtree.
 */
export function walkSchema(visitor: SchemaVisitor, root: GroupDef = schema): void {
  const parents: GroupDef[] = [];
  const visit = (g: GroupDef, prefix: string) => {
    parents.push(g);
    for (const key of Object.keys(g.fields)) {
      const node = g.fields[key] as SchemaNode;
      const path = prefix ? `${prefix}.${key}` : key;
      const r = visitor(node, path, parents.slice());
      if (isGroup(node) && r !== false) visit(node, path);
    }
    parents.pop();
  };
  visit(root, '');
}

let leafCache: { paths: ParamPath[]; fields: Map<string, FieldDef> } | null = null;

function leaves() {
  if (!leafCache) {
    const paths: ParamPath[] = [];
    const fields = new Map<string, FieldDef>();
    walkSchema((node, path) => {
      if (!isGroup(node)) {
        paths.push(path as ParamPath);
        fields.set(path, node);
      }
    });
    leafCache = { paths, fields };
  }
  return leafCache;
}

/** Every leaf path in schema order. */
export function getLeafPaths(): readonly ParamPath[] {
  return leaves().paths;
}

/** Leaf field definition at a path (undefined for groups and unknown paths). */
export function getField(path: string): FieldDef | undefined {
  return leaves().fields.get(path);
}

export function isParamPath(path: string): path is ParamPath {
  return leaves().fields.has(path);
}

/** Schema node (leaf or group) at a path; '' is the root. */
export function getNode(path: string, root: GroupDef = schema): SchemaNode | undefined {
  if (path === '') return root;
  let node: SchemaNode | undefined = root;
  for (const key of path.split('.')) {
    if (!isGroup(node) || !Object.hasOwn(node.fields, key)) return undefined;
    node = node.fields[key];
  }
  return node;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function getPath<P extends ParamPath>(cfg: LumiCellsConfig, path: P): ParamValue<P>;
export function getPath(cfg: unknown, path: string): unknown;
export function getPath(cfg: unknown, path: string): unknown {
  let cur: unknown = cfg;
  for (const key of path.split('.')) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Immutable copy-on-write set: returns a new root sharing untouched branches.
 * Missing intermediate objects are created.
 */
export function setPath<T>(cfg: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const rec = (obj: unknown, i: number): unknown => {
    const src = isPlainObject(obj) ? obj : {};
    const key = keys[i] as string;
    const next = i === keys.length - 1 ? value : rec(src[key], i + 1);
    return { ...src, [key]: next };
  };
  return rec(cfg, 0) as T;
}

/** Map of every schema leaf path to its value (arrays are leaves). */
export function flattenLeaves(cfg: unknown): Map<ParamPath, unknown> {
  const out = new Map<ParamPath, unknown>();
  for (const p of getLeafPaths()) {
    const v = getPath(cfg, p);
    if (v !== undefined) out.set(p, v);
  }
  return out;
}

/** Structural equality for leaf values (numbers, strings, booleans, arrays of those). */
export function valueEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valueEquals(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && valueEquals(a[k], b[k]));
  }
  return false;
}

/** Leaf paths whose values differ, in schema order. */
export function diffConfigs(a: unknown, b: unknown): ParamPath[] {
  const out: ParamPath[] = [];
  for (const p of getLeafPaths()) {
    if (!valueEquals(getPath(a, p), getPath(b, p))) out.push(p);
  }
  return out;
}

/** Deep clone of plain data (objects, arrays, primitives). */
export function cloneData<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cloneData) as T;
  if (isPlainObject(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = cloneData(v[k]);
    return o as T;
  }
  return v;
}

/**
 * Merges plain objects recursively; arrays and primitives in `patch` replace. `undefined` in the
 * patch is ignored. Neither input is mutated; the result shares no mutable data with `patch`.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return cloneData(patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (pv === undefined) continue;
    out[k] = deepMerge(out[k], pv);
  }
  return out as T;
}

/** JSON with sorted object keys: equal data always yields the same string (cache keys). */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
