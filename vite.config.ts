import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

// Demo app: the tuning stand (index.html) and a plain HTML page that uses the Web Component.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // The demo imports the library by its package name, exactly like a consumer would.
    alias: [
      { find: /^pixel-life$/, replacement: resolve(root, 'src/core/index.ts') },
      { find: /^pixel-life\/schema$/, replacement: resolve(root, 'src/schema/index.ts') },
      { find: /^pixel-life\/react$/, replacement: resolve(root, 'src/react/index.ts') },
      { find: /^pixel-life\/element$/, replacement: resolve(root, 'src/element/index.ts') },
      {
        find: /^pixel-life\/element\/define$/,
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
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
