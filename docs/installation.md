**English** | [Русский](ru/installation.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Installation

> **The npm package is coming soon.** Until it is published, build it from source as shown below.
> The import paths in these docs are the ones the package will have.

## Using it before the npm release

```bash
git clone https://github.com/supsad/lumicells.git
cd lumicells
npm ci
npm run build:lib   # dist/lib (ES modules, IIFE bundle, schema.json) and dist/types
npm pack            # lumicells-0.1.0.tgz
```

Then install the tarball in your app with `npm install ../lumicells/lumicells-0.1.0.tgz`, and all
the imports in these docs work as written.

## A page without a bundler

Copy `dist/lib/lumicells-element.iife.js` next to the page and load it with a plain
`<script src>`. This single file registers the `<lumi-cells>` tag and exposes the API as the global
`LumiCells`. The tag itself is described in [Web Component](web-component.md).

## Entry points

LumiCells is one core with three ways to use it: from React, as a Web Component, or with plain
TypeScript.

| Import | What it gives |
| --- | --- |
| `lumicells` | The core: the `LumiCells` class, `onBeforeFrame`, config helpers such as `normalizeConfig` and `validateConfig`, and the types ([Vanilla TypeScript](vanilla.md)) |
| `lumicells/react` | The `<LumiCells>` component and hooks ([React](react.md)) |
| `lumicells/element/define` | Registers the `<lumi-cells>` tag ([Web Component](web-component.md)) |
| `lumicells/element` | The element class (`LumiCellsElement`) and helpers. Importing it does not register the tag, so an app can register it under another name with `defineLumiCellsElement(tag)` |
| `lumicells/schema` | The config layer alone (no DOM, no GL): types, defaults, presets, normalization |
| `lumicells/schema.json` | The JSON Schema of the config file ([Config file](config.md)) |
| `dist/lib/lumicells-element.iife.js` | The single file for a plain `<script>` (see above) |

## Requirements

- **WebGL2** in the browser. Without it a static CSS poster in the config colors is shown; see
  [Browser support](browser-support.md).
- **Zero runtime dependencies.** React is an optional peer dependency of `lumicells/react`; the
  core and the Web Component do not need it.
- **React 19** for `lumicells/react` (`ref` is a regular prop).
- **SSR-safe**: importing does not touch `window`, nothing happens until an instance is
  constructed, and the React component renders a static poster on the server.
