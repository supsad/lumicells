#!/usr/bin/env node
/**
 * Post-build step for the emitted declarations (dist/types).
 *
 * The package is `"type": "module"`, so under `moduleResolution: node16 | nodenext` TypeScript
 * treats every published .d.ts as ESM, where relative specifiers must be explicit: a file needs
 * its `.js` extension and a directory needs `/index.js`. tsc keeps the extensionless specifiers
 * of the sources (they are written for `bundler` resolution), so they are rewritten here based on
 * the declaration files that actually exist. `bundler` and `node10` resolution accept the result
 * as well.
 *
 * Usage: node scripts/fix-dts.mjs [dir]   (default: dist/types)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, process.argv[2] ?? 'dist/types');

/** Matches `from './x'`, `import('./x')` and `import './x'` (single or double quotes). */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}(?:\/[^'"\n]*)?)\2/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.d.ts')) yield full;
  }
}

/** The explicit ESM specifier for a relative one, or null when nothing on disk matches. */
export function explicitSpecifier(fromFile, spec, exists = existsSync) {
  if (/\.(?:js|mjs|cjs|json)$/.test(spec)) return spec;
  const base = resolve(dirname(fromFile), spec);
  const clean = spec.replace(/\/+$/, '');
  if (exists(`${base}.d.ts`)) return `${clean}.js`;
  if (exists(join(base, 'index.d.ts'))) return `${clean}/index.js`;
  return null;
}

export function fixDeclarations(dir) {
  if (!existsSync(dir))
    throw new Error(`fix-dts: ${dir} does not exist (run the type build first)`);
  let files = 0;
  let rewritten = 0;
  const unresolved = [];
  for (const file of walk(dir)) {
    files++;
    const before = readFileSync(file, 'utf8');
    const after = before.replace(SPECIFIER, (match, lead, quote, spec) => {
      const next = explicitSpecifier(file, spec);
      if (next === null) {
        unresolved.push(`${file}: ${spec}`);
        return match;
      }
      if (next !== spec) rewritten++;
      return `${lead}${quote}${next}${quote}`;
    });
    if (after !== before) writeFileSync(file, after);
  }
  if (unresolved.length > 0) {
    throw new Error(`fix-dts: cannot resolve relative specifiers:\n  ${unresolved.join('\n  ')}`);
  }
  return { files, rewritten };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, rewritten } = fixDeclarations(target);
  console.log(`fix-dts: ${rewritten} specifier(s) rewritten in ${files} declaration file(s)`);
}
