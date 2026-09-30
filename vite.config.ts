import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

// Demo site (GitHub Pages): the tuning stand (index.html) plus two plain HTML examples. The other
// pages under examples/ (tune, engine-harness, ui-kit, scene-preview) are dev-only and are not
// part of the production build. Set BASE_PATH (e.g. `/lumicells/`) when the site is served from a
// sub-path; asset URLs and the public/ files then resolve under it.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    // The demo imports the library by its package name, exactly like a consumer would.
    alias: [
      { find: /^lumicells$/, replacement: resolve(root, 'src/core/index.ts') },
      { find: /^lumicells\/schema$/, replacement: resolve(root, 'src/schema/index.ts') },
      { find: /^lumicells\/react$/, replacement: resolve(root, 'src/react/index.ts') },
      { find: /^lumicells\/element$/, replacement: resolve(root, 'src/element/index.ts') },
      {
        find: /^lumicells\/element\/define$/,
        replacement: resolve(root, 'src/element/define.ts'),
      },
    ],
  },
  build: {
    outDir: 'dist-demo',
    target: 'es2022',
    rollupOptions: {
      input: {
        stand: resolve(root, 'index.html'),
        element: resolve(root, 'examples/web-component.html'),
        core: resolve(root, 'examples/core-basic.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
