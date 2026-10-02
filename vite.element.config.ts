import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { glslMinify } from './scripts/glsl-minify.mjs';

const root = dirname(fileURLToPath(import.meta.url));

// Self-contained <script src> bundle: registers <lumi-cells> and exposes the global `LumiCells`
// (element class, the imperative LumiCells class, presets). Runs after vite.lib.config.ts,
// which owns (and empties) the output directory, so this config must not empty it again.
// The GLSL template literals are minified too (scripts/glsl-minify.mjs). One file has nothing to
// load later: the GPU side's loader (src/core/runtime/loader.ts, a dynamic import in the ES build)
// is replaced by one that ships it statically (loader-static.ts), so instances get it at once and
// no module needs the lazy-init wrappers an inlined dynamic import brings.
export default defineConfig({
  plugins: [glslMinify()],
  publicDir: false,
  resolve: {
    alias: [
      {
        find: /^\.\/runtime\/loader$/,
        replacement: resolve(root, 'src/core/runtime/loader-static.ts'),
      },
    ],
  },
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
