#!/usr/bin/env node
/**
 * Consumer type check of the built package (`npm run build:lib` first).
 *
 * Copies package.json + dist/lib + dist/types into `<tmp>/node_modules/lumicells`, exactly the
 * layout a consumer gets, and compiles a small file that imports every public entry point with
 * `moduleResolution: nodenext` (the strict ESM resolver) and with `bundler`. The declarations are
 * checked too (no skipLibCheck), so a specifier that only resolves under bundler resolution
 * fails here instead of silently erasing the public types for nodenext users.
 *
 * Uses the repo's own TypeScript (no network); `react` and its types are linked from the repo.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

for (const dir of ['dist/lib', 'dist/types']) {
  if (!existsSync(join(root, dir))) {
    console.error(`check-types: ${dir} is missing, run "npm run build:lib" first`);
    process.exit(1);
  }
}

const CONSUMER = `import {
  getDefaults,
  LumiCells,
  type LumiCellsConfig,
  type LumiCellsConfigInput,
  type Stats,
} from 'lumicells';
import { LumiCellsElement } from 'lumicells/element';
import 'lumicells/element/define';
import {
  LumiCells as LumiCellsView,
  useInfluence,
  useLumiCellsStats,
  type LumiCellsProps,
} from 'lumicells/react';
import { schema, type PresetId } from 'lumicells/schema';
import { createElement, useRef } from 'react';

const config: LumiCellsConfig = getDefaults();
const input: LumiCellsConfigInput = { animation: { speed: 2 } };
const preset: PresetId = 'reference';
export const readFps = (stats: Stats | null): number | undefined => stats?.fps;

export function makeInstance(host: HTMLElement): LumiCells {
  return new LumiCells(host, { config: { ...config, ...input } });
}

export function Hero(props: LumiCellsProps) {
  const ref = useRef<HTMLDivElement>(null);
  useInfluence(ref, { type: 'light', padding: 8 });
  const live = useLumiCellsStats();
  return createElement(LumiCellsView, { ...props, preset }, createElement('div', { ref }, live?.fps));
}

export const el: LumiCellsElement | null = null;
export { schema };
`;

function run(cwd, project) {
  const res = spawnSync(process.execPath, [tsc, '--noEmit', '-p', project], {
    cwd,
    encoding: 'utf8',
  });
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

function link(target, path) {
  if (!existsSync(target)) return false;
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'junction');
  return true;
}

const tmp = mkdtempSync(join(tmpdir(), 'lumicells-consumer-'));
let failed = false;
try {
  const pkg = join(tmp, 'node_modules', 'lumicells');
  mkdirSync(pkg, { recursive: true });
  cpSync(join(root, 'package.json'), join(pkg, 'package.json'));
  cpSync(join(root, 'dist', 'lib'), join(pkg, 'dist', 'lib'), { recursive: true });
  cpSync(join(root, 'dist', 'types'), join(pkg, 'dist', 'types'), { recursive: true });
  for (const dep of ['react', '@types/react', 'csstype']) {
    link(join(root, 'node_modules', dep), join(tmp, 'node_modules', dep));
  }
  writeFileSync(join(tmp, 'package.json'), '{"name":"consumer","private":true,"type":"module"}\n');
  writeFileSync(join(tmp, 'consumer.ts'), CONSUMER);

  const variants = {
    nodenext: { module: 'nodenext', moduleResolution: 'nodenext' },
    bundler: { module: 'esnext', moduleResolution: 'bundler' },
  };
  for (const [name, options] of Object.entries(variants)) {
    const file = `tsconfig.${name}.json`;
    writeFileSync(
      join(tmp, file),
      JSON.stringify({
        compilerOptions: {
          ...options,
          target: 'es2022',
          lib: ['es2023', 'esnext.disposable', 'dom', 'dom.iterable'],
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        files: ['consumer.ts'],
      }),
    );
    const { ok, output } = run(tmp, file);
    console.log(`check-types [${name}]: ${ok ? 'ok' : 'FAILED'}`);
    if (!ok) {
      failed = true;
      console.log(output);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
