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
</p>

<p align="center">
  <a href="https://supsad.github.io/lumicells/">
    <img src="docs/media/hero.webp" width="960" alt="LumiCells demo scene: a glowing grid of neon cells forms a rotating sphere behind floating topic bubbles; clicks send rings through the grid and the bubbles fly out and back in" />
  </a>
</p>

A grid of glowing cells forms rings, spheres, waves, spirals, rain or Conway's Life. The glow
is soft and layered, single pixels pop out of the plane, and the background responds to the page
around it: buttons tint the grid with their own color, clicks send ripples, hovering lifts pixels.
Use it from React, as a `<lumi-cells>` Web Component, or with plain TypeScript.

## Live demo

**[supsad.github.io/lumicells](https://supsad.github.io/lumicells/)** opens the playground (the
tuning stand) with a demo scene on top of the background. There you can:

- switch between the 9 presets and tweak every parameter with live tweening;
- resize the stage (full screen, 360×360 card, 1200×320 banner, 390×844 phone, custom);
- toggle the demo scene, pointer interaction and debug layers (field, halo, bloom, haze, cells);
- watch FPS, CPU and GPU frame time, quality tier and pixel count;
- export your look as JSON, TypeScript, React or HTML, import a config back, or copy a share link.

Two plain HTML examples are published next to it:
[Web Component](https://supsad.github.io/lumicells/examples/web-component.html) and
[vanilla core](https://supsad.github.io/lumicells/examples/core-basic.html).

<p align="center">
  <img src="docs/media/playground.png" width="960" alt="The LumiCells playground: toolbar with presets, stage sizes and export, the animated stage with the demo scene, and a settings panel generated from the parameter schema" />
</p>

## Features

- **8 animation modes** (`sphere`, `flow`, `pulse`, `wave`, `ripple`, `vortex`, `life`, `rain`)
  that blend as weighted layers and cross-fade when you switch.
- **Neat 3-layer glow**: a tight halo around each cell, a soft bloom and a wide haze.
- **Pop-out pixels**: cells spring up, wobble and land with a small ripple. With
  `render.overflow` they (and their glow) can leave the canvas box.
- **Any palette**: 1 to 32 color stops, OKLab, linear or stepped interpolation, 5 mapping modes.
- **Live tweening**: every change animates smoothly, including preset switches.
- **Binds to the page**: element influences (light, shadow, lift, seed, repel), pulses, lifts and
  modulators that drive any numeric parameter from your own data.
- **Built for 60+ FPS**: procedural math runs at cell resolution, the cell shape is a baked stamp,
  quality adapts to the device, resolution is capped by a pixel budget.
- **Many per page**: a page-wide WebGL context budget, lazy creation near the viewport and
  parking of far-away backgrounds, so a long list never hits the browser's context limit.
- **React, Web Component and vanilla** entry points over one core.
- **SSR-safe**: importing does not touch `window`; the React component renders a static poster
  on the server.
- **TypeScript first**: typed config, typed parameter paths for `set()` and `modulate()`.
- **JSON config with a JSON Schema**: editor autocompletion, `normalizeConfig` and
  `validateConfig`.
- **Zero runtime dependencies** (React is an optional peer dependency of `lumicells/react`).

## Quick start

> **The npm package is coming soon.** Until it is published, build it from source (see
> [Using it before the npm release](#using-it-before-the-npm-release)). The import paths below are
> the ones the package will have.

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

Props: `preset`, `config`, `transition`, `paused`, `interactive`, `overflow`, `priority`,
`renderer`, `fallback`, `onReady`, `onError`, `onStats`, `ref`, plus regular `div` attributes. The merge order is
defaults, then `preset`, then `config`. `config` may be a new object on every render: the
component compares content, not identity. Requires React 19 (`ref` is a regular prop).

| Hook | Purpose |
| --- | --- |
| `useLumiCells()` | The instance of the nearest `<LumiCells>` (`null` on the server, before mount and after unmount) |
| `useInfluence(ref, opts)` | Turns an element into a light, shadow or lift source; returns a ref to its handle |
| `useModulator(path, source, opts)` | Drives a numeric parameter from a value, a function or `{ get() }` |
| `usePulse()` | Stable function that sends a ripple |
| `useLumiCellsStats()` | Frame stats, updated about 4 times per second |
| `useLumiCellsEvent(type, handler)` | Subscribes to an instance event |

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

Without a bundler, load the single file `dist/lib/lumicells-element.iife.js` with a plain
`<script>`: it registers the tag and exposes the API as the global `LumiCells`.

Attributes: `preset`, `src` (URL of a config file), `interactive`, `overflow`, `paused`,
`transition`, `priority`, `renderer`. Properties: `config`, `preset`, `src`, `paused`,
`interactive`, `overflow`, `transition`, `priority`, `renderer` and the read-only `instance`.

Declarative binding of child elements:

| Attribute | Meaning |
| --- | --- |
| `data-lc-influence` | The element affects the background. The value (or `data-lc-type`) sets the type: `light` (default), `shadow`, `lift`, `seed`, `repel` |
| `data-lc-color`, `data-lc-color-mix` | Tint color and how much of it is mixed into the palette |
| `data-lc-strength`, `data-lc-falloff`, `data-lc-padding`, `data-lc-priority` | Strength, soft edge in cells, padding in px, priority |
| `data-lc-track` | `auto` or `frame`: how often the position is re-read |
| `data-lc-pulse` | `click` or `hover`: send a ripple from the element |
| `data-lc-lift` | `hover` or `click`: lift pixels at the element |
| `data-lc-for="bg"` | Bind an element outside the tag (a portal, for example) to `<lumi-cells id="bg">` |

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

### Using it before the npm release

```bash
git clone https://github.com/supsad/lumicells.git
cd lumicells
npm ci
npm run build:lib   # dist/lib (ES modules, IIFE bundle, schema.json) and dist/types
npm pack            # lumicells-0.1.0.tgz
```

Then install the tarball in your app with `npm install ../lumicells/lumicells-0.1.0.tgz`, and all
the imports above work as written. For a page without a bundler, copy
`dist/lib/lumicells-element.iife.js` next to it and load it with `<script src>`.

## Config file

The playground exports `lumicells.config.json`:

```json
{
  "$schema": "./lumicells.schema.json",
  "version": 1,
  "extends": "reference",
  "grid": { "count": 36, "gap": 0.25 },
  "color": { "palette": ["#f21239", "#6a3cc8", "#0476ff", "#19e6d0"] }
}
```

- Save the whole config, or only the difference from a preset (`extends`). A full file does not
  change when library defaults change later.
- The JSON Schema ships with the package (`lumicells/schema.json`) and can be downloaded from the
  playground, so your editor suggests fields and ranges.
- `normalizeConfig(raw)` never throws: it fixes types, clamps ranges, drops unknown keys and
  returns a list of issues with paths. `validateConfig(raw)` is stricter and suits CI checks.
- **Playground round trip**: *Export* gives JSON (full or diff), TypeScript, React and HTML
  snippets and the JSON Schema; *Import* takes a file or pasted JSON and reports what it fixed.
  *Link* copies a URL with the config inside.

## Presets

<p align="center">
  <img src="docs/media/presets.png" width="760" alt="The nine presets side by side: reference, orb, pulse, life, vortex, waves, ripples, rain and minimal" />
</p>

`reference` (the default look), `orb`, `pulse`, `life`, `vortex`, `waves`, `ripples`, `rain`,
`minimal`. Every preset is a small patch over the defaults, so it makes a good starting point
for your own config: `{ "extends": "vortex", ... }`.

## Animation modes

Modes blend as layers with weights (`animation.blend`: `screen`, `add` or `max`). Switching a
mode cross-fades the weights.

| Mode | What it does |
| --- | --- |
| `sphere` | A rotating sphere with a dark core and a bright rim |
| `flow` | Flowing noise, living blobs |
| `pulse` | Breathing and concentric rings from a point |
| `wave` | Directional waves and interference |
| `ripple` | Raindrops with spreading circles |
| `vortex` | Spiral arms |
| `life` | Conway's automaton and its variants, with a smooth fade |
| `rain` | Falling columns |

On top of the modes: flicker, rare sparkles, sparse edges, external energy and the 3-layer glow.
**Lifted pixels** (`lift`) come in two styles: `pop` raises a cell in place, `float` detaches it
and carries it upward like a bubble.

## Binding to the page

The background knows what happens around it through four mechanisms.

**Influences** (`bindElement`, `addInfluence`): a rounded rectangle or a circle that adds light
(`light`), darkens (`shadow`, for example under a heading for readability), lifts pixels
(`lift`), seeds Life (`seed`) or pushes the pattern away (`repel`). Use as many as you like:
the 64 most important ones (by priority and area) reach the shader, the rest wait and swap in
smoothly.

```ts
const light = cells.bindElement(el, { type: 'light', color: '#0481f5', strength: 0.8 });
light.update({ strength: 1.3 }); // on hover
light.dispose();

// A darker area under a heading, so the text stays readable.
cells.bindElement(title, { type: 'shadow', padding: 24 });
```

Tracking modes (`track`): `auto` reads the element rect only while it may move (resize, scroll,
CSS transitions, Web Animations), `frame` reads it every frame, `manual` never touches the DOM
and takes coordinates from `update({ x, y, w, h })`. For elements moved by JavaScript, animate
them inside `onBeforeFrame` from `lumicells` and the light never lags a frame behind.

**Events** (`pulse`, `lift`): a one-off ripple from a point and a lift of pixels at a point.

```ts
cells.pulse({ x: 0.5, y: 0.5, space: 'norm', color: '#19e6d0', strength: 1 });
cells.lift({ x: 12, y: 8, space: 'cells', count: 6, radius: 2 });
```

**Modulators** (`modulate`): drive any numeric parameter from a number, a function or an object
with `get()`. Blend modes: `add`, `mul`, `override`, `max`, with optional smoothing. Modulators
live only at runtime and never end up in a saved config.

```ts
// The sphere grows while something is happening on the page.
const m = cells.modulate('modes.sphere.radius', () => activity * 0.1, {
  blend: 'add',
  smoothingMs: 150,
});

// External energy, for example an audio level.
cells.setEnergy(1.4);
```

**Coordinate spaces** (`space`): `host` (CSS px from the container corner), `client` (viewport
px, like `PointerEvent`), `norm` (0..1 of the container) and `cells` (grid cells).

## Events

```ts
const off = cells.on('stats', (s) => console.log(s.fps, s.gpuMs, s.quality));
off(); // unsubscribe
```

| Event | Payload |
| --- | --- |
| `ready` | First frame is on screen |
| `frame` | `{ time, dt }` every frame (reused object) |
| `stats` | FPS, CPU/GPU ms, quality, pixels, cells, lifts, influences (about 4 Hz) |
| `resize` | `{ width, height, cols, rows, dpr, scale }` |
| `config` | `{ config, changed, source }`, coalesced per frame |
| `quality` | `{ scale, quality, reason }` when adaptive quality steps |
| `warn`, `error` | Non-fatal warnings and errors |
| `fallback` | `{ reason: 'no-webgl2' \| 'compile' \| 'context-lost' \| 'budget' }` (see [Many instances on one page](#many-instances-on-one-page)) |
| `contextlost`, `contextrestored`, `destroy` | Lifecycle |

The Web Component re-dispatches them as DOM events: `lc-ready`, `lc-config`, `lc-stats`,
`lc-error`, `lc-fallback`, `lc-contextlost` and `lc-contextrestored` (the end of a
`context-lost` fallback: the animation is back).

## Performance

- All procedural math runs at grid resolution: one texel per cell, thousands of points instead
  of millions. Full resolution only runs one composite pass and the instanced lifted pixels.
- The cell shape (rounding, halo, hot core) is baked into a small stamp the size of one grid
  step, so the composite pass does not evaluate SDFs and exponentials per pixel. Bloom and haze
  share one texture.
- Every instance on the page runs on one shared `requestAnimationFrame`, split into phases:
  app animations, DOM reads, GPU work.
- Resolution is capped by `render.maxDpr` and the pixel budget `render.maxPixels` (at most
  2.4 MP on touch devices).
- Adaptive quality detects the display rate (60, 120, 144 Hz and up) and, when frames run late,
  steps quality and resolution down with hysteresis. It does not mistake main-thread stalls for
  a slow GPU. Tiers: `high` full picture, `medium` cheaper glow sampling, `low` no halo and bevel.
- Rendering stops while the tab is hidden or the container is off screen. With
  `prefers-reduced-motion` the animation slows down and lifted pixels are off, including
  `lift()` calls (opt out with `render.reducedMotion: 'ignore'`).
- No objects or arrays are allocated per frame; uniform buffers upload only on change.

Measured on a desktop (RTX 5090, 165 Hz): about 0.04 to 0.06 ms GPU and 0.1 ms CPU per frame at
1920×1080, about 0.08 ms GPU at 3840×2160 on `high`. There are no measurements on real mobile
GPUs yet: the mobile path is budgeted by design (DPR cap 2, pixel budget), so check your target
devices with the playground stats.

By default each instance owns a WebGL context; see
[Many instances on one page](#many-instances-on-one-page) for how LumiCells keeps their number in
check, and for the shared renderer that draws any number of instances with one context.

## Many instances on one page

Every live background owns a WebGL context, and browsers keep only about 16 per page (fewer on
phones). Past that they silently kill the oldest one, which may be your hero background or the
app's own WebGL (maps, three.js). LumiCells therefore manages its contexts page-wide:

- **Budget.** At most 4 contexts on desktop and 2 on touch devices by default. When the budget
  is full, a background that scrolls into view takes the context of an offscreen one (the one seen
  least recently first). Among visible backgrounds a higher `priority` wins, then the larger one.
  The others show their CSS poster until a context frees up: `getStats().state` is `'waiting'`,
  visible ones emit `fallback` with reason `'budget'`, and the page logs one warning.
- **Lazy creation.** A context is created only when the container comes within about one
  viewport of the screen, at most one per frame, so mounting a long list does not freeze the page.
  Inside a scrolling element (a carousel, a chat pane) the zone reaches one element size beyond
  its visible part in Chrome and Edge 120+ (IntersectionObserver `scrollMargin`). Other browsers
  create the context there only once the background scrolls into the element's visible part,
  and treat the rest of the element as far away; in a cross-origin iframe the zone is the
  visible area.
- **Parking.** A background that stays farther away for 10 seconds releases its context and GPU
  memory and shows its poster. Scrolling back rebuilds it; the config, tweens and bound elements
  are kept, only the Life automaton reseeds.

```ts
import { LumiCells } from 'lumicells';

// Page-wide settings: call before or after creating instances (safe on the server too).
LumiCells.configure({ maxContexts: 8, parkAfterMs: 5000, createPerFrame: 1 });

const hero = new LumiCells(heroEl, { preset: 'reference', priority: 'high' });
hero.getStats().state; // 'pending' | 'waiting' | 'live' | 'parked' | 'lost' | 'failed' | 'destroyed'
```

In React use `<LumiCells priority="high">`, in HTML `<lumi-cells priority="high">`. If more
backgrounds must animate at the same time (a feed with ten cards on screen needs at least ten
contexts), raise `maxContexts`, but stay well below 16. Instances with
`render.pauseOffscreen: false` (for example an offscreen source copied into other canvases) are
created right away, never parked, and rank as visible wherever they are: a visible background
takes their context only with a higher `priority` or a clearly larger size.

### Shared renderer

For many small backgrounds that should all animate at once (cards, list items), use
`renderer: 'shared'`. Every shared instance draws into its own region of one offscreen WebGL
canvas, which is then copied into a 2D canvas in each host. Any number of them cost one WebGL
context, counted on top of `maxContexts`.

```ts
const card = new LumiCells(cardEl, { preset: 'orb', renderer: 'shared' });
LumiCells.configure({ sharedBudget: 4 }); // megapixels of the shared canvas ('auto': 4, touch 2)
```

- Config, pointer, influences, pulses, lifted pixels, events, debug views and quality tiers work
  per instance as before. `canvas` is the 2D canvas, and `ready` fires after the first copy.
- Only instances on screen get a region. When they need more pixels than `sharedBudget`, all of
  them render at a lower resolution: the grid and the cell size stay, only the sharpness drops,
  and no instance is dropped. The factor snaps down to a whole pixel cell size, never below 3
  device pixels: instances whose cells are already that small keep their resolution.
- Parked instances give their slot back and shrink their 2D canvas to 0×0, because Safari caps
  the canvas memory of a page.
- A lost shared context affects every shared instance. Each keeps its last frame (no poster) and
  gets `contextlost`, then `contextrestored` once the context is rebuilt.
- Each instance still costs its own GPU work plus one `drawImage` per frame, so the frame time
  grows with the number of animating instances. On the test desktop 100 cards animating at once
  took 2.9 ms of main thread per frame; at 165 Hz the GPU work capped them at about 47 fps.
  `getStats()` reports `renderer`, `presentMs` (this instance's copy, with its share of the
  frame's atlas snapshot) and `shared` (atlas size, draw and copy cost, the snapshot part of the
  copy cost, and a calibration of the copy cost per megapixel, measured again when the atlas size
  or budget scale changes). For a shared instance `gpuMs` is the GPU time of the whole shared
  device.
- Keep large backgrounds (hero, full screen) on the default `'own'`: they need no copy, and
  another instance's context loss does not affect them.

In React use `<LumiCells renderer="shared">`, in HTML `<lumi-cells renderer="shared">`;
`setRenderer()` switches a running instance. A mode that chooses the renderer automatically is
planned.

## Browser support

Needs WebGL2: current Chrome, Edge, Firefox, and Safari 15 or newer. Without WebGL2, after a
context loss, before the first frame and while an instance waits for a context or is parked, a
static CSS poster in the config colors is shown. With
float render targets the glow is computed in HDR, otherwise in RGBA8 with compression.

## Architecture

```
src/schema      parameter schema: types, defaults, validation, presets, export, JSON Schema (no DOM)
src/core
  controller    tweens, modulators, influences, pulses, lifted pixels, adaptive quality (no DOM, no GL)
  engine        WebGL2: life, field, bloom, stamp, composite and lift passes, GLSL modes
  dom           canvas and its size, element tracking, pointer
  lumi-cells.ts the LumiCells facade
src/react       component and hooks
src/element     Web Component
demo            playground and demo scene
examples        plain HTML pages and dev tools
```

The schema is the single source of truth. The config type, the paths for `set` and `modulate`,
defaults, validation, the JSON Schema, the GPU uniform layout (`P_<path>` macros in GLSL) and the
playground panel are all derived from it.

### Adding a parameter

1. Add a field to `src/schema/schema.ts`, for example
   `num({ min, max, default, label, gpu: true })`.
2. Use it in a shader as `P_<path_with_underscores>`, for example `P_glow_halo_strength`.

Types, validation, the playground and export pick it up automatically. Add the Russian label to
`src/schema/locales/ru.ts` (a test checks that every path has one).

### Adding an animation mode

1. Add the mode group to `modes` in the schema and its id to `MODE_IDS`.
2. Write `vec3 mode_<id>(ModeIn m)` in `src/core/engine/glsl/modes/<id>.ts` and register it in
   `modes/index.ts`. The function returns brightness, envelope and accent.
3. If the mode needs its own animated phase, add it to `src/core/controller/clock.ts` and the
   frame block.

## Development

```bash
npm ci
npm run dev   # http://localhost:5173/
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Playground and examples |
| `npm run build` | Type check and build the playground into `dist-demo` |
| `npm run build:lib` | Build the package into `dist/lib` and types into `dist/types` |
| `npm run check:types` | Type check the built package as a consumer would |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | Type check |
| `npm run lint` | Biome |

Dev pages: `/` (playground), `/examples/web-component.html`, `/examples/core-basic.html`,
`/examples/engine-harness.html` (passes one by one, frame timing),
`/examples/tune.html` (deterministic time for screenshot comparisons),
`/examples/scene-preview.html` and `/examples/ui-kit.html`.

## Roadmap

- [ ] Publish `lumicells` to npm.
- [ ] Choose and add an open-source license.
- [ ] Measure on real mobile GPUs and publish the numbers.

## License

Not chosen yet. A license will be added before the npm release; until then the code is not
licensed for reuse.
