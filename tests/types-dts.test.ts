import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The script is plain JS (run by node in build:lib); load it without type-checking it here.
const scriptUrl = pathToFileURL(resolve(__dirname, '../scripts/fix-dts.mjs')).href;
const { fixDeclarations } = (await import(/* @vite-ignore */ scriptUrl)) as {
  fixDeclarations(dir: string): { files: number; rewritten: number };
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-dts-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

describe('fix-dts (node16/nodenext-safe declarations)', () => {
  it('rewrites relative specifiers to explicit .js and /index.js', () => {
    const dir = fixture({
      'core/index.d.ts': [
        "export * from '../schema';",
        "export { LumiCells } from './lumi-cells';",
        "export type * from './types';",
        "import './side';",
        'export declare const x: import("./lumi-cells").LumiCells;',
      ].join('\n'),
      'core/lumi-cells.d.ts':
        "import type { Stats } from '../core/types';\nexport declare class LumiCells {}",
      'core/types.d.ts': 'export interface Stats {}',
      'core/side.d.ts': 'export {};',
      'schema/index.d.ts': "export * from './schema';",
      'schema/schema.d.ts': "export declare const schema: import('./fields').Field;",
      'schema/fields.d.ts': 'export interface Field {}',
    });
    const { rewritten } = fixDeclarations(dir);
    expect(rewritten).toBe(8);
    expect(readFileSync(join(dir, 'core/index.d.ts'), 'utf8')).toBe(
      [
        "export * from '../schema/index.js';",
        "export { LumiCells } from './lumi-cells.js';",
        "export type * from './types.js';",
        "import './side.js';",
        'export declare const x: import("./lumi-cells.js").LumiCells;',
      ].join('\n'),
    );
    expect(readFileSync(join(dir, 'schema/schema.d.ts'), 'utf8')).toContain(
      "import('./fields.js')",
    );
  });

  it('leaves bare and already explicit specifiers alone, and is idempotent', () => {
    const dir = fixture({
      'a.d.ts': [
        "import type { Context } from 'react';",
        "export * from './b.js';",
        "export * from './sub/index.js';",
      ].join('\n'),
      'b.d.ts': 'export {};',
      'sub/index.d.ts': 'export {};',
    });
    const before = readFileSync(join(dir, 'a.d.ts'), 'utf8');
    expect(fixDeclarations(dir).rewritten).toBe(0);
    expect(readFileSync(join(dir, 'a.d.ts'), 'utf8')).toBe(before);
  });

  it('fails loudly on a specifier that matches nothing on disk', () => {
    const dir = fixture({ 'a.d.ts': "export * from './missing';" });
    expect(() => fixDeclarations(dir)).toThrow(/missing/);
  });
});
