import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

// Self-contained <script src> bundle: registers <pixel-life> and exposes the global `PixelLife`
// (element class, the imperative PixelLife class, presets). Runs after vite.lib.config.ts,
// which owns (and empties) the output directory, so this config must not empty it again.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/lib',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: true,
    minify: true,
    lib: {
      entry: resolve(root, 'src/element/iife.ts'),
      name: 'PixelLife',
      formats: ['iife'],
      fileName: () => 'pixel-life-element.iife.js',
    },
  },
});
