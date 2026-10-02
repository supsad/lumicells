**English** | [Русский](README.ru.md)

<h1 align="center">LumiCells</h1>

<p align="center">
  <b>A live neon pixel-grid background for the web.</b><br />
  WebGL2 · 8 blendable animation modes · reacts to your page · zero runtime dependencies
</p>

<p align="center">
  <a href="https://supsad.github.io/lumicells/"><img alt="Live demo" src="https://img.shields.io/badge/live%20demo-open%20the%20playground-e0267a?style=flat-square" /></a>
  <img alt="WebGL2" src="https://img.shields.io/badge/WebGL2-shaders-0476ff?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-typed%20API-3178c6?style=flat-square" />
  <img alt="Zero dependencies" src="https://img.shields.io/badge/runtime%20deps-0-19e6d0?style=flat-square" />
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-8a5cf6?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://supsad.github.io/lumicells/">
    <img src="docs/media/hero.webp" width="960" alt="LumiCells demo scene: a glowing grid of neon cells forms a rotating sphere behind floating topic bubbles; clicks send rings through the grid and the bubbles fly out and back in" />
  </a>
</p>

LumiCells is an animated background for websites, drawn with WebGL2 shaders: a neon pixel grid
whose glowing cells form rings, spheres, waves, spirals, rain or Conway's Life. The background
responds to the page around it: buttons tint the grid with their own color, clicks send ripples,
hovering lifts pixels. Use it as a React component, as the `<lumi-cells>` Web Component, or from
plain TypeScript.

**[Live demo](https://supsad.github.io/lumicells/)**: the playground, where you switch presets,
tune every parameter live and export the config. Two plain HTML examples are published next to it:
[Web Component](https://supsad.github.io/lumicells/examples/web-component.html) and
[vanilla core](https://supsad.github.io/lumicells/examples/core-basic.html).

## Features

- **8 animation modes** that blend as weighted layers and cross-fade when you switch, and 9 presets
  to start from.
- **Neat 3-layer glow** and **pop-out pixels** that can leave the canvas box.
- **Any palette**: 1 to 32 color stops, OKLab, linear or stepped interpolation, 5 mapping modes.
- **Live tweening**: every change animates smoothly, including preset switches.
- **Binds to the page**: element influences (light, shadow, lift, seed, repel), pulses, lifts and
  modulators that drive any numeric parameter from your own data.
- **Built for 60+ FPS**: procedural math at cell resolution, adaptive quality, a pixel budget.
- **Many per page**: a page-wide WebGL context budget, lazy creation and parking.
- **Small first load**: about 16 KB gzip up front, the engine downloads behind the poster.
- **SSR-safe** and **TypeScript first**: typed config, typed parameter paths.
- **JSON config with a JSON Schema** for editor autocompletion.
- **Zero runtime dependencies** (React is an optional peer dependency of `lumicells/react`).

## Install

> **The npm package is coming soon.** Until it is published, build it from source:

```bash
git clone https://github.com/supsad/lumicells.git
cd lumicells
npm ci
npm run build:lib   # dist/lib (ES modules, IIFE bundle, schema.json) and dist/types
npm pack            # lumicells-0.1.0.tgz
```

Then install the tarball in your app with `npm install ../lumicells/lumicells-0.1.0.tgz`, and the
imports below work as written. For a page without a bundler, load
`dist/lib/lumicells-element.iife.js` with a `<script src>`. More in
[Installation](docs/installation.md).

## Quick start

### React

```tsx
import type { LumiCellsConfigInput } from 'lumicells';
import { LumiCells, useInfluence } from 'lumicells/react';
import { type ReactNode, useRef } from 'react';
import rawConfig from './lumicells.config.json';

const config = rawConfig as LumiCellsConfigInput;

export function Hero() {
  return (
    <LumiCells config={config} interactive style={{ height: '100vh' }}>
      <Bubble color="#ee2848">Travel</Bubble>
    </LumiCells>
  );
}

function Bubble({ color, children }: { color: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  // The bubble tints the cells under it with its own color and follows its position.
  useInfluence(ref, { type: 'light', color, colorMix: 0.6, strength: 0.8 });
  return <button ref={ref}>{children}</button>;
}
```

`lumicells.config.json` is a config exported from the playground ([Config file](docs/config.md)).
Props, hooks, server rendering and the fallback: [React](docs/react.md).

### Web Component

```html
<script type="module">
  import 'lumicells/element/define';
</script>

<lumi-cells id="bg" preset="reference" interactive style="height: 100vh">
  <button data-lc-influence data-lc-color="#0481f5" data-lc-pulse="click" data-lc-lift="hover">
    Science
  </button>
</lumi-cells>

<script type="module">
  // Set the config as a property, or load a file with the src attribute.
  document.getElementById('bg').config = { modes: { sphere: { radius: 0.7 } } };
</script>
```

Attributes, `data-lc-*` binding and DOM events: [Web Component](docs/web-component.md).

### Vanilla TypeScript

```ts
import { LumiCells } from 'lumicells';

const cells = new LumiCells(document.querySelector<HTMLElement>('#hero')!, { preset: 'reference' });

const bubble = document.querySelector('#bubble')!;
cells.bindElement(bubble, { type: 'light', color: '#ee2848', colorMix: 0.6 });
bubble.addEventListener('click', (e) => {
  const { clientX, clientY } = e as MouseEvent;
  cells.pulse({ x: clientX, y: clientY, space: 'client' });
});

// Tween a parameter over 800 ms.
cells.set('modes.sphere.radius', 0.5, { transition: 800 });

// Release the WebGL context.
cells.destroy();
```

Options and methods: [Vanilla TypeScript](docs/vanilla.md).

## Documentation

The [documentation index](docs/README.md) lists every page:

- [Installation](docs/installation.md): building before the npm release, entry points.
- [React](docs/react.md): the component, props, hooks, SSR.
- [Web Component](docs/web-component.md): the `<lumi-cells>` tag and `data-lc-*` binding.
- [Vanilla TypeScript](docs/vanilla.md): the `LumiCells` class, its options and methods.
- [Config file](docs/config.md): `lumicells.config.json`, JSON Schema, validation.
- [Presets and animation modes](docs/presets-and-modes.md): presets, modes, glow, palette.
- [Binding to the page](docs/binding.md): influences, ripples, lifts, modulators.
- [Events](docs/events.md): instance events and their payloads.
- [Playground](docs/playground.md): the tuning stand, hotkeys, examples.
- [Performance](docs/performance.md): frame cost, start-up, adaptive quality, bundle size.
- [Many instances on one page](docs/many-instances.md): renderers, context budget, cost reducers.
- [Browser support](docs/browser-support.md): what is tested where, browser differences.
- [Architecture](docs/architecture.md): source layout, adding a parameter or a mode.
- [Development](docs/development.md): scripts, end-to-end tests, dev pages.

## Browser support

Needs WebGL2: current Chrome, Edge, Firefox, and Safari 15 or newer. Without WebGL2 a static CSS
poster in the config colors is shown. The test suite runs in the Chromium, Firefox and WebKit
builds of Playwright; nothing has been measured on Safari, iOS or Android yet. See
[Browser support](docs/browser-support.md).

## Roadmap

- [ ] Publish `lumicells` to npm.
- [ ] Measure on real mobile GPUs and publish the numbers.

## License

[MIT](LICENSE).
