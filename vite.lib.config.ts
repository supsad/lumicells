import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { toJsonSchema } from './src/schema/json-schema';

const root = dirname(fileURLToPath(import.meta.url));

/** Emits the JSON Schema of the config file (`pixel-life/schema.json`) next to the bundles. */
function jsonSchemaAsset(): Plugin {
  return {
    name: 'pixel-life:json-schema',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'pixel-life.schema.json',
        source: `${JSON.stringify(toJsonSchema(), null, 2)}\n`,
      });
    },
  };
}

// Library build: ES entry points sharing common chunks (the core is bundled once).
// The <script src> bundle of the Web Component is produced by vite.element.config.ts, which
// runs after this config (this one empties the output directory).
export default defineConfig({
  plugins: [jsonSchemaAsset()],
  // public/ holds demo assets; they must not leak into the package.
  publicDir: false,
  build: {
    outDir: 'dist/lib',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: {
        'pixel-life': resolve(root, 'src/core/index.ts'),
        'pixel-life-schema': resolve(root, 'src/schema/index.ts'),
        'pixel-life-react': resolve(root, 'src/react/index.ts'),
        'pixel-life-element': resolve(root, 'src/element/index.ts'),
        'pixel-life-element-define': resolve(root, 'src/element/define.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^react(\/.*)?$/, /^react-dom(\/.*)?$/],
    },
  },
});
