import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

// Library build: three ES entry points sharing one core chunk.
// The IIFE bundle of the Web Component is produced by vite.element.config.ts.
export default defineConfig({
  build: {
    outDir: 'dist/lib',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: {
        'pixel-life': resolve(root, 'src/core/index.ts'),
        'pixel-life-react': resolve(root, 'src/react/index.ts'),
        'pixel-life-element': resolve(root, 'src/element/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    },
  },
});
