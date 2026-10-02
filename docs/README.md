**English** | [Русский](ru/README.md)

[LumiCells](../README.md) › Documentation

# LumiCells documentation

LumiCells is a live neon pixel-grid background for the web, drawn with WebGL2 shaders. The
[README](../README.md) gives a short overview and a quick start; these pages cover each topic in
detail.

## Using it

- [Installation](installation.md): building the package before the npm release, entry points, a
  page without a bundler, requirements.
- [React](react.md): the `<LumiCells>` component, its props and hooks, server rendering and the
  fallback.
- [Web Component](web-component.md): the `<lumi-cells>` tag, its attributes and properties, and
  declarative binding of child elements with `data-lc-*`.
- [Vanilla TypeScript](vanilla.md): the `LumiCells` class, its options and methods.
- [Config file](config.md): `lumicells.config.json`, `extends`, the JSON Schema, normalization and
  validation, the playground round trip.

## Look and behavior

- [Presets and animation modes](presets-and-modes.md): the 9 presets, the 8 animation modes, glow,
  palette and lifted pixels.
- [Binding to the page](binding.md): influences, ripples and lifts, modulators, coordinate spaces.
- [Events](events.md): instance events, their payloads and the Web Component's DOM events.
- [Playground](playground.md): the tuning stand, its panel, hotkeys and published examples.

## Under the hood

- [Performance](performance.md): what keeps a frame cheap, shader compilation at start-up,
  adaptive quality, bundle size and measurements.
- [Many instances on one page](many-instances.md): renderers and the WebGL context budget, lazy
  creation and parking, the shared renderer, cost reducers and identical cards.
- [Browser support](browser-support.md): requirements, the poster, what is tested where and how
  browsers differ.

## Contributing

- [Architecture](architecture.md): the source layout, the parameter schema, adding a parameter or
  an animation mode.
- [Development](development.md): scripts, end-to-end tests and dev pages.
