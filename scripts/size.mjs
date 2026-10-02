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
 * The GPU side (engine, GLSL, passes, shared renderer, controller...) is a chunk of its own that
 * the first instance imports dynamically (src/core/runtime/loader.ts), so each ES probe is
 * reported twice:
 *
 *   eager  what the page loads up front: the probe's entry chunk and every chunk it imports
 *          statically (from the build manifest). It includes the bundler's chunk loader (Vite's
 *          preload helper, reported below), which an app with lazy imports of its own has anyway;
 *   total  everything the probe ships, the GPU side's chunk included (all chunks).
 *
 * The <script src> bundle stays one file without a dynamic import (eager = total there). Each
 * figure is raw / gzip (level 9) / brotli (quality 11), summed over the chunks it covers with
 * each chunk compressed on its own, the way a browser transfers them (sumSizes), and both gzip
 * figures are checked against budgets. The probes are also checked for things that must never reach an app that only renders
 * a background: the UI metadata of the schema (labels, descriptions) and the Russian locale (the
 * one exception is the IIFE, which exports the English preset texts, PRESET_TEXTS, on purpose),
 * and for the split itself: an ES probe has a separate GPU-side chunk, and its eager part holds
 * no GLSL.
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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Gzip budgets in KiB.
 *
 * All figures are per-chunk sums (sumSizes), what a browser actually transfers.
 *
 * eager: about 2-3% above what the split achieved (October 2026: core 15.9, react 16.9, element
 *   19.8 KiB, Vite's chunk loader included; the IIFE has no eager part of its own). A regression
 *   here means something heavy is imported statically again (see tests/lazy-boundary.test.ts).
 * total: today's totals (core 82.2, react 83.2, element 86.1 KiB) plus 0.6 KiB, which for core
 *   is where the bundle before the split (about 80.3 KiB) plus the usual 3% lands; the IIFE
 *   (84.4 KiB before the split, one file and so not affected by it) keeps its 3%. The split
 *   itself adds about 4 KiB to an ES probe: Vite's chunk loader (under 1 KiB, once per app), the
 *   eager half's queue for calls made before the GPU side arrives, the two halves' interface,
 *   the imports between the chunks and the compression each chunk starts over with. Turning
 *   TypeScript `private` members into `#private` ones (which minifiers shorten) paid back about
 *   half of it: core went from about 80.3 to 82.2 KiB in total.
 * Earlier steps: the UI metadata leaking back into the runtime adds ~5 KiB, unminified GLSL
 * ~9 KiB; the shared look cost ~5.5 KiB, a first visit without a frozen page on Windows ~5 KiB.
 * Raised by 0.1 KiB (totals only) in October 2026 for the shared renderer's read snapshot (0.6
 * KiB): in Firefox the staged copy series reads only the part of the atlas in use with
 * readPixels, about a quarter cheaper than a snapshot drawn from the WebGL canvas, which reads
 * all of it (100 cards on one screen: copies 18 instead of 25 ms per frame, 41 instead of 34
 * fps). The fixes for Firefox and WebKit next to it (renderer string, warm-up fence polls, a new
 * canvas shown with its second frame) add 0.1 KiB. The eager parts did not move. Raise a budget
 * only on purpose, for a feature worth its weight.
 */
const BUDGET_GZIP = {
  core: { eager: 16.2 * 1024, total: 82.9 * 1024 },
  react: { eager: 17.3 * 1024, total: 83.9 * 1024 },
  element: { eager: 20.3 * 1024, total: 86.8 * 1024 },
  iife: { eager: null, total: 86.9 * 1024 },
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

/** An app with one lazy import and nothing else: its entry chunk is Vite's chunk loader. */
const LOADER_PROBE = "import('./loader-lazy.js').then((m) => m.default);\n";

const IIFE = 'lumicells-element.iife.js';

/** Part of the GPU side's GLSL (engine/frame-block.ts): never in an eager part. */
const GLSL_MARKER = '#define MAX_INFLUENCES';

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

/** Raw, gzip (level 9) and brotli (quality 11) size of one file, in bytes. */
export function sizes(buf) {
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

/**
 * What a set of chunks costs to transfer: the sum of each chunk's own sizes(). A browser
 * downloads and decompresses every chunk separately, so compressing them joined together would
 * let gzip and brotli reuse matches across chunks and understate the cost of a split.
 */
export function sumSizes(bufs) {
  const out = { raw: 0, gzip: 0, brotli: 0 };
  for (const buf of bufs) {
    const s = sizes(buf);
    out.raw += s.raw;
    out.gzip += s.gzip;
    out.brotli += s.brotli;
  }
  return out;
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

/**
 * Builds one probe app the way a consumer's Vite production build would. Returns its chunks,
 * each marked eager (the entry chunk or one it imports statically, from the build manifest).
 */
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
      manifest: true,
      rollupOptions: {
        input: join(project, `${name}.js`),
        // Only the library is measured; the app brings its own React.
        external: [/^react(-dom)?(\/.*)?$/],
        output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
      },
    },
  });
  const manifest = JSON.parse(readFileSync(join(outDir, '.vite', 'manifest.json'), 'utf8'));
  const eager = new Set();
  const visit = (key) => {
    const chunk = manifest[key];
    if (!chunk || eager.has(chunk.file)) return;
    eager.add(chunk.file);
    for (const dep of chunk.imports ?? []) visit(dep);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
  return jsFiles(outDir).map((f) => {
    const file = relative(outDir, f).split('\\').join('/');
    return { file, eager: eager.has(file), buf: readFileSync(f) };
  });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(join(args.lib, 'lumicells.js'))) {
    console.error(`size: ${args.lib} has no lumicells.js, run "npm run build:lib" first`);
    process.exit(1);
  }

  const project = args.keep ?? mkdtempSync(join(tmpdir(), 'lumicells-size-'));
  const results = {};
  let loader = null;
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
    writeFileSync(
      join(project, 'package.json'),
      '{"name":"probe","private":true,"type":"module"}\n',
    );

    const meta = await metadataTexts(join(pkg, 'dist', 'lib'));
    const iife = readFileSync(join(args.lib, IIFE));
    const outputs = { iife: [{ file: IIFE, eager: true, buf: iife }] };
    for (const [name, code] of Object.entries(PROBES)) {
      writeFileSync(join(project, `${name}.js`), code);
      outputs[name] = await buildProbe(project, name);
    }
    writeFileSync(join(project, 'loader.js'), LOADER_PROBE);
    writeFileSync(join(project, 'loader-lazy.js'), 'export default 1;\n');
    const loaderOut = await buildProbe(project, 'loader');
    loader = sumSizes(loaderOut.filter((c) => c.eager).map((c) => c.buf));

    for (const name of ['core', 'react', 'element', 'iife']) {
      const chunks = outputs[name];
      const eagerChunks = chunks.filter((c) => c.eager);
      // Joined only for the text checks below; the sizes are summed per chunk (sumSizes).
      const all = Buffer.concat(chunks.map((c) => c.buf));
      const eager = Buffer.concat(eagerChunks.map((c) => c.buf));
      results[name] = {
        eager: sumSizes(eagerChunks.map((c) => c.buf)),
        total: sumSizes(chunks.map((c) => c.buf)),
        files: chunks.length,
        eagerFiles: eagerChunks.length,
      };
      const text = all.toString('utf8');
      if (CYRILLIC.test(text))
        problems.push(`${name}: contains Cyrillic (the ru locale leaked in)`);
      // The <script src> bundle names presets for script-tag users (PRESET_TEXTS); nothing else may.
      const forbidden = name === 'iife' ? meta.schema : [...meta.schema, ...meta.presets];
      const leaked = forbidden.filter((t) => text.includes(t));
      if (leaked.length > 0) {
        problems.push(
          `${name}: contains ${leaked.length} schema UI description(s), e.g. "${leaked[0]}"`,
        );
      }
      if (!text.includes(GLSL_MARKER)) problems.push(`${name}: the GPU side (its GLSL) is missing`);
      if (name === 'iife') {
        if (!meta.presets.every((t) => text.includes(t))) {
          problems.push('iife: does not export the preset texts (PRESET_TEXTS)');
        }
        if (/\bimport\s*\(/.test(text)) problems.push('iife: has a dynamic import (one file only)');
      } else {
        if (eagerChunks.length === chunks.length) {
          problems.push(`${name}: the GPU side is not a chunk of its own (nothing loads lazily)`);
        }
        if (eager.toString('utf8').includes(GLSL_MARKER)) {
          problems.push(`${name}: the eager part holds GLSL (the GPU side is imported statically)`);
        }
      }
      const budget = BUDGET_GZIP[name];
      if (args.budget && budget.eager !== null && results[name].eager.gzip > budget.eager) {
        problems.push(
          `${name}: eager gzip ${results[name].eager.gzip} B is over the budget of ${budget.eager} B`,
        );
      }
      if (args.budget && results[name].total.gzip > budget.total) {
        problems.push(
          `${name}: total gzip ${results[name].total.gzip} B is over the budget of ${budget.total} B`,
        );
      }
    }
  } finally {
    if (!args.keep) rmSync(project, { recursive: true, force: true });
  }

  const kb = (n) => (n / 1024).toFixed(1).padStart(7);
  const triple = (s) => `${kb(s.raw)}${kb(s.gzip)}${kb(s.brotli)}`;
  console.log('size: consumer bundles (Vite production build, minified), KiB');
  console.log(`  ${''.padEnd(8)}${'eager'.padStart(21)}   ${'total'.padStart(21)}   budget (gzip)`);
  console.log(
    `  ${'entry'.padEnd(8)}${'raw'.padStart(7)}${'gzip'.padStart(7)}${'brotli'.padStart(7)}   ${'raw'.padStart(7)}${'gzip'.padStart(7)}${'brotli'.padStart(7)}   eager / total`,
  );
  for (const [name, r] of Object.entries(results)) {
    const b = BUDGET_GZIP[name];
    const eagerBudget = b.eager === null ? '-' : kb(b.eager).trim();
    const eager = name === 'iife' ? `${'(one file)'.padStart(21)}` : triple(r.eager);
    console.log(
      `  ${name.padEnd(8)}${eager}   ${triple(r.total)}   ${eagerBudget} / ${kb(b.total).trim()}`,
    );
  }
  if (loader) {
    console.log(
      `  The eager figures include Vite's chunk loader (${(loader.gzip / 1024).toFixed(1)} KiB gzip), which an app with lazy imports of its own already ships.`,
    );
  }
  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(
      args.json,
      `${JSON.stringify({ results, chunkLoader: loader, budgetGzip: BUDGET_GZIP }, null, 2)}\n`,
    );
  }
  if (problems.length > 0) {
    console.log(`size: FAILED\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('size: ok');
}

// Run only as a script: tests import sizes() and sumSizes() without building anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
