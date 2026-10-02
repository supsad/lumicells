#!/usr/bin/env node
/**
 * Consumer bundle size of the built package (`npm run build:lib` first).
 *
 * The number that matters is not the size of the files in dist/lib but what an app pays after
 * its own bundler tree-shakes and minifies them. So, like check-types.mjs, this copies
 * package.json + dist/lib into `<tmp>/node_modules/lumicells` (the layout a consumer gets) and
 * builds tiny probe apps with Vite (production mode, default minifier), one per public entry:
 *
 *   core     import { LumiCells } from 'lumicells'                 (the imperative class only)
 *   react    import { LumiCells } from 'lumicells/react'           (react itself is external)
 *   element  import 'lumicells/element/define'                     (registers <lumi-cells>)
 *   iife     dist/lib/lumicells-element.iife.js as published (already minified)
 *
 * Each is reported raw / gzip (level 9) / brotli (quality 11) and checked against a gzip budget.
 * The probes are also checked for things that must never reach an app that only renders a
 * background: the UI metadata of the schema (labels, descriptions) and the Russian locale. The
 * one exception is the IIFE, which exports the English preset texts (PRESET_TEXTS) on purpose.
 *
 * Usage: node scripts/size.mjs [--lib dist/lib] [--out dir] [--json file] [--no-budget]
 *   --lib        built library directory (default dist/lib)
 *   --out        keep the probe project in this directory instead of a temp one
 *   --json       also write the measurements as JSON
 *   --no-budget  report only (exit 0 even when over budget)
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Gzip budgets in KiB, about 3% above the measured sizes (October 2026, with the shared look and
 * the cold-start work: core 79.0, react 80.0, element 83.0, iife 83.8 KiB), so ordinary changes
 * pass and a regression fails: the UI metadata leaking back into the runtime adds ~5 KiB,
 * unminified GLSL ~9 KiB. Raise them only on purpose, for a feature worth its weight (the shared
 * look cost ~5.5 KiB; a first visit without a frozen page on Windows, ~5 KiB: field variants,
 * warm-ups, the staged field pass on Direct3D, the paced first context).
 */
const BUDGET_GZIP = {
  core: 81 * 1024,
  react: 82 * 1024,
  element: 85 * 1024,
  iife: 86 * 1024,
};

const PROBES = {
  core: "import { LumiCells } from 'lumicells';\nnew LumiCells(document.body);\n",
  react: [
    "import { LumiCells } from 'lumicells/react';",
    "import { createElement } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "createRoot(document.body).render(createElement(LumiCells, { preset: 'orb' }));",
    '',
  ].join('\n'),
  element: "import 'lumicells/element/define';\n",
};

const IIFE = 'lumicells-element.iife.js';

function parseArgs(argv) {
  const out = { lib: join(root, 'dist', 'lib'), keep: null, json: null, budget: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lib') out.lib = resolve(argv[++i] ?? '');
    else if (a === '--out') out.keep = resolve(argv[++i] ?? '');
    else if (a === '--json') out.json = resolve(argv[++i] ?? '');
    else if (a === '--no-budget') out.budget = false;
    else {
      console.error(`size: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function sizes(buf) {
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }).length,
  };
}

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...jsFiles(full));
    else if (name.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Builds one probe app the way a consumer's Vite production build would. */
async function buildProbe(project, name) {
  const outDir = join(project, 'out', name);
  await build({
    configFile: false,
    root: project,
    logLevel: 'silent',
    publicDir: false,
    mode: 'production',
    build: {
      outDir,
      emptyOutDir: true,
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: join(project, `${name}.js`),
        // Only the library is measured; the app brings its own React.
        external: [/^react(-dom)?(\/.*)?$/],
        output: { entryFileNames: '[name].js', chunkFileNames: '[name].js' },
      },
    },
  });
  return jsFiles(outDir).map((f) => readFileSync(f));
}

/**
 * Long English UI texts of the schema (labels are too short to be unambiguous), split into the
 * preset texts (PRESET_TEXTS, which the IIFE exports on purpose) and everything else.
 */
async function metadataTexts(libDir) {
  const out = { schema: [], presets: [] };
  // Imported from the package copy: its package.json makes the .js files ES modules.
  const file = join(libDir, 'lumicells-schema.js');
  if (!existsSync(file)) return out;
  const mod = await import(pathToFileURL(file).href);
  const meta = mod.SCHEMA_META;
  if (!meta) return out;
  const usable = (t) => typeof t === 'string' && t.length >= 24 && !/['"\\`]/.test(t);
  for (const table of [meta.groups, meta.fields]) {
    for (const e of Object.values(table)) if (usable(e.description)) out.schema.push(e.description);
  }
  for (const e of Object.values(meta.presets)) {
    if (usable(e.description)) out.presets.push(e.description);
  }
  return out;
}

const CYRILLIC = /[Ѐ-ӿ]/;

const args = parseArgs(process.argv.slice(2));
if (!existsSync(join(args.lib, 'lumicells.js'))) {
  console.error(`size: ${args.lib} has no lumicells.js, run "npm run build:lib" first`);
  process.exit(1);
}

const project = args.keep ?? mkdtempSync(join(tmpdir(), 'lumicells-size-'));
const results = {};
const problems = [];
try {
  const pkg = join(project, 'node_modules', 'lumicells');
  if (args.keep) {
    // Only what this script creates is replaced; the directory itself may hold other things.
    for (const dir of [pkg, join(project, 'out')]) rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(pkg, { recursive: true });
  cpSync(join(root, 'package.json'), join(pkg, 'package.json'));
  cpSync(args.lib, join(pkg, 'dist', 'lib'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  });
  writeFileSync(join(project, 'package.json'), '{"name":"probe","private":true,"type":"module"}\n');

  const meta = await metadataTexts(join(pkg, 'dist', 'lib'));
  const iife = readFileSync(join(args.lib, IIFE));
  const outputs = { iife: [iife] };
  for (const [name, code] of Object.entries(PROBES)) {
    writeFileSync(join(project, `${name}.js`), code);
    outputs[name] = await buildProbe(project, name);
  }

  for (const name of ['core', 'react', 'element', 'iife']) {
    const files = outputs[name];
    const all = Buffer.concat(files);
    results[name] = { ...sizes(all), files: files.length };
    const text = all.toString('utf8');
    if (CYRILLIC.test(text)) problems.push(`${name}: contains Cyrillic (the ru locale leaked in)`);
    // The <script src> bundle names presets for script-tag users (PRESET_TEXTS); nothing else may.
    const forbidden = name === 'iife' ? meta.schema : [...meta.schema, ...meta.presets];
    const leaked = forbidden.filter((t) => text.includes(t));
    if (leaked.length > 0) {
      problems.push(
        `${name}: contains ${leaked.length} schema UI description(s), e.g. "${leaked[0]}"`,
      );
    }
    if (name === 'iife' && !meta.presets.every((t) => text.includes(t))) {
      problems.push('iife: does not export the preset texts (PRESET_TEXTS)');
    }
    if (args.budget && results[name].gzip > BUDGET_GZIP[name]) {
      problems.push(
        `${name}: gzip ${results[name].gzip} B is over the budget of ${BUDGET_GZIP[name]} B`,
      );
    }
  }
} finally {
  if (!args.keep) rmSync(project, { recursive: true, force: true });
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`.padStart(9);
console.log('size: consumer bundles (Vite production build, minified)');
console.log(
  `  ${'entry'.padEnd(8)}${'raw'.padStart(9)}${'gzip'.padStart(9)}${'brotli'.padStart(9)}   budget (gzip)`,
);
for (const [name, r] of Object.entries(results)) {
  console.log(
    `  ${name.padEnd(8)}${kb(r.raw)}${kb(r.gzip)}${kb(r.brotli)}   ${kb(BUDGET_GZIP[name]).trim()}`,
  );
}
if (args.json) {
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, `${JSON.stringify({ results, budgetGzip: BUDGET_GZIP }, null, 2)}\n`);
}
if (problems.length > 0) {
  console.log(`size: FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('size: ok');
