#!/usr/bin/env node
/**
 * Web server of the end-to-end tests (started by playwright.config.ts, or by hand).
 *
 * Default: builds and serves the demo exactly like GitHub Pages does (pages.yml: `vite build`
 * with BASE_PATH=/lumicells/, here into dist/e2e instead of dist-demo), then builds the dev-only
 * pages the tests need (stress bench, parity pages, the lifecycle fixture) into dist/e2e/dev with
 * the same config, and serves both with `vite preview`:
 *
 *   /lumicells/                                  the stand (index.html)
 *   /lumicells/examples/*.html                   the published examples
 *   /lumicells/dev/examples/stress.html          dev-only pages (not on the published site)
 *   /lumicells/dev/tests/e2e/site/lifecycle.html the lifecycle fixture
 *
 * The published site is untouched: its build is the unmodified vite.config.ts (only the output
 * directory differs) and the dev pages are a separate build next to it.
 *
 * Options:
 *   --dev         serve everything from the Vite dev server instead (no build; same base path,
 *                 dev pages without the dev/ prefix: set LC_E2E_SERVER=dev for the tests too)
 *   --no-build    serve the last build of dist/e2e as is
 *   --port N      port (default 5285, or LC_E2E_PORT)
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, loadConfigFromFile, preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configFile = join(root, 'vite.config.ts');
const outDir = join(root, 'dist', 'e2e');
const BASE = '/lumicells/';

/** Dev-only pages the tests open (paths relative to the project root). */
const DEV_PAGES = {
  stress: 'examples/stress.html',
  'multi-slot': 'examples/multi-slot.html',
  'shared-parity': 'examples/shared-parity.html',
  lifecycle: 'tests/e2e/site/lifecycle.html',
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const portArg = args.indexOf('--port');
const port = Number(portArg >= 0 ? args[portArg + 1] : (process.env.LC_E2E_PORT ?? 5285));
const host = '127.0.0.1';

// vite.config.ts reads the base path from the environment, like the Pages workflow sets it.
process.env.BASE_PATH = BASE;

async function buildSite() {
  const started = performance.now();
  // 1. The published site, as pages.yml builds it (only the output directory differs).
  await build({ configFile, root, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  // 2. The dev-only pages: the same config with other inputs, under dev/ of the same site.
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production', isSsrBuild: false, isPreview: false },
    configFile,
    root,
  );
  if (!loaded) throw new Error(`cannot load ${configFile}`);
  const { test: _test, ...config } = loaded.config;
  await build({
    ...config,
    configFile: false,
    root,
    base: `${BASE}dev/`,
    // public/ is already part of the published site above.
    publicDir: false,
    logLevel: 'warn',
    build: {
      ...config.build,
      outDir: join(outDir, 'dev'),
      emptyOutDir: true,
      rollupOptions: {
        input: Object.fromEntries(
          Object.entries(DEV_PAGES).map(([name, page]) => [name, join(root, page)]),
        ),
      },
    },
  });
  console.log(`[e2e] built ${outDir} in ${Math.round(performance.now() - started)} ms`);
}

if (flag('--dev')) {
  const server = await createServer({
    configFile,
    root,
    server: { host, port, strictPort: true },
  });
  await server.listen();
  server.printUrls();
} else {
  if (!flag('--no-build') || !existsSync(join(outDir, 'index.html'))) await buildSite();
  const server = await preview({
    configFile,
    root,
    build: { outDir },
    preview: { host, port, strictPort: true, open: false },
  });
  server.printUrls();
}
