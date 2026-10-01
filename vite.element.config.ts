import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { glslMinify } from './scripts/glsl-minify.mjs';

const root = dirname(fileURLToPath(import.meta.url));

// Self-contained <script src> bundle: registers <lumi-cells> and exposes the global `LumiCells`
// (element class, the imperative LumiCells class, presets). Runs after vite.lib.config.ts,
// which owns (and empties) the output directory, so this config must not empty it again.
// The GLSL template literals are minified too (scripts/glsl-minify.mjs).
export default defineConfig({
  plugins: [glslMinify()],
  publicDir: false,
  build: {
    outDir: 'dist/lib',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: true,
    minify: true,
    lib: {
      entry: resolve(root, 'src/element/iife.ts'),
      name: 'LumiCells',
      formats: ['iife'],
      fileName: () => 'lumicells-element.iife.js',
    },
  },
});
