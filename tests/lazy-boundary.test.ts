/**
 * The eager/lazy boundary of the runtime: what an app pays up front is the static import graph
 * of the entry it imports; the GPU side (runtime/live.ts and everything only it needs) must stay
 * behind the one dynamic import in runtime/loader.ts, or bundlers pull it into the first chunk.
 * scripts/size.mjs measures the result in a consumer build; this catches a stray import at once.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

/** `import ... from` / `export ... from` / bare `import '...'`, not type-only ones. */
const STATIC =
  /^\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"](\.[^'"]+)['"]|^\s*import\s+['"](\.[^'"]+)['"]/gm;

function resolveSpec(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function typeOnly(clause: string): boolean {
  if (!clause.startsWith('{')) return false;
  const names = clause
    .replace(/[{}\s]/g, '')
    .split(',')
    .filter(Boolean);
  return names.length > 0 && names.every((n) => n.startsWith('type'));
}

/** Every module statically reachable from `entry`, as repository-relative paths. */
function eagerGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    const rel = relative(root, file).split('\\').join('/');
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(STATIC)) {
      if (m[1] || typeOnly(m[2] ?? '')) continue;
      const next = resolveSpec(file, (m[3] ?? m[4]) as string);
      if (next) walk(next);
    }
  };
  walk(resolve(root, entry));
  return seen;
}

/** Modules only the GPU side needs. */
const LAZY = [
  /^src\/core\/controller\//,
  /^src\/core\/engine\//,
  /^src\/core\/gl\//,
  /^src\/core\/dom\/(tracking|pointer|viewport)\.ts$/,
  /^src\/core\/runtime\/(live|scheduler|context-budget|auto-renderer|shared-renderer|look|atlas|frame-load)\.ts$/,
];

describe('eager / lazy boundary', () => {
  for (const entry of [
    'src/core/index.ts',
    'src/react/index.ts',
    'src/element/index.ts',
    'src/element/define.ts',
  ]) {
    it(`${entry} reaches no GPU-side module statically`, () => {
      const graph = eagerGraph(entry);
      expect(graph.has('src/core/lumi-cells.ts')).toBe(true);
      expect([...graph].filter((f) => LAZY.some((re) => re.test(f)))).toEqual([]);
    });
  }

  it('the GPU side is reached through the loader only, by a dynamic import', () => {
    const loader = readFileSync(resolve(root, 'src/core/runtime/loader.ts'), 'utf8');
    expect(loader).toMatch(/import\(\s*'\.\/live'\s*\)/);
    const graph = eagerGraph('src/core/runtime/live.ts');
    // The GPU side builds on the eager modules, never the other way round.
    expect(graph.has('src/core/runtime/loader.ts')).toBe(false);
    expect(graph.has('src/core/shell.ts')).toBe(false);
  });
});
