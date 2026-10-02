**English** | [Русский](ru/architecture.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Architecture

The repository holds the library (one core, the React wrapper and the Web Component), the
playground and the examples:

```
src/schema      parameter schema: types, defaults, validation, presets, export, JSON Schema (no DOM)
src/core
  controller    tweens, modulators, influences, pulses, lifted pixels, adaptive quality (no DOM, no GL)
  engine        WebGL2: life, field, bloom, stamp, composite and lift passes, GLSL modes
  dom           canvas and its size, element tracking, pointer
  runtime       context budget, shared renderer, look groups; live.ts: the GPU side of an instance
  lumi-cells.ts the LumiCells facade; with shell.ts (config, poster, observers) the eager part,
                runtime/loader.ts imports the rest (controller, engine, runtime) on demand
src/react       component and hooks
src/element     Web Component
demo            playground and demo scene
examples        plain HTML pages and dev tools
```

The schema is the single source of truth. The config type, the paths for `set` and `modulate`,
defaults, validation, the JSON Schema, the GPU uniform layout (`P_<path>` macros in GLSL) and the
playground panel are all derived from it. The texts of the schema are in English by default; the
Russian ones live in `src/schema/locales/ru.ts`.

How the eager part and the lazily loaded engine split the bundle is described in
[Performance](performance.md#bundle-size).

## Adding a parameter

1. Add the runtime field to `src/schema/schema.ts`, for example
   `strength: num({ min: 0, max: 2, step: 0.01, default: 0.5, gpu: true })`.
2. Add its English label and description to `src/schema/meta.ts` under the same dotted path, for
   example `'glow.halo.strength': { label: 'Strength', description: '...' }`.
3. Add the Russian text to `src/schema/locales/ru.ts` under the same path.
4. Use it in a shader as `P_<path_with_underscores>`, for example `P_glow_halo_strength`.

Types, validation, the playground, the JSON Schema and export pick it up automatically. Tests fail
if a path has no English or Russian text. UI texts live outside the runtime schema, so an app that
only renders a background does not ship them.

## Adding an animation mode

1. Add the mode group to `modes` in the schema and its id to `MODE_IDS`.
2. Write `vec3 mode_<id>(ModeIn m)` in `src/core/engine/glsl/modes/<id>.ts` and register it in
   `modes/index.ts`. The function returns brightness, envelope and accent.
3. If the mode needs its own animated phase, add it to `src/core/controller/clock.ts` and the
   frame block.

The existing modes are listed in
[Presets and animation modes](presets-and-modes.md#animation-modes). Commands to build and test a
change are in [Development](development.md).
