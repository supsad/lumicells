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
| `renderer` | `{ renderer, previous, reason }` when the renderer changes: `'promote'`, `'demote'`, `'budget'` or `'explicit'` |
| `contextlost`, `contextrestored`, `destroy` | Lifecycle |

The Web Component re-dispatches them as DOM events: `lc-ready`, `lc-config`, `lc-stats`,
`lc-error`, `lc-fallback`, `lc-contextlost`, `lc-contextrestored` (the end of a
`context-lost` fallback: the animation is back) and `lc-renderer`.

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
- Adaptive quality learns the display rate (60, 120, 144 Hz and up) from frames that carry no GL
  work: while the first backgrounds of a page compile (their first draws wait a few frames more
  when needed, about 25 ms at 165 Hz, under the poster), and again when the tab comes back or the
  device pixel ratio changes (zoom, a move to a display with another DPR). So a GPU that is too
  slow from the very first frame is not mistaken for a slower display. A display that gets slower
  without a recalibration (a monitor with the same DPR, an OS power profile) is picked up from the
  frame cadence once the GPU time or the steps already taken show that the pace is not ours.
  When frames run late, it steps quality and resolution down with hysteresis. It does not mistake main-thread stalls or an OS frame-rate cap for a slow GPU, and
  a step that cuts neither the late frames nor the GPU time is undone (the cost does not depend
  on pixels there). Tiers: `high` full picture, `medium` cheaper glow sampling, `low` no halo and
  bevel, plus the lite glow pipeline (see [Cost reducers](#cost-reducers)).
- Rendering stops while the tab is hidden or the container is off screen. With
  `prefers-reduced-motion` the animation slows down and lifted pixels are off, including
  `lift()` calls (opt out with `render.reducedMotion: 'ignore'`).
- No objects or arrays are allocated per frame; uniform buffers upload only on change.
- Bundle: an app that imports only `LumiCells` ships about 68 KB gzip (60 KB brotli) after
  minification, the plain `<script>` bundle about 73 KB gzip. Shaders are minified at build
  time and UI texts of the schema are not part of the runtime. `npm run size` checks the budget.

Measured on a desktop (RTX 5090, 165 Hz): about 0.04 to 0.06 ms GPU and 0.1 ms CPU per frame at
1920×1080, about 0.08 ms GPU at 3840×2160 on `high`. There are no measurements on real mobile
GPUs yet: the mobile path is budgeted by design (DPR cap 2, pixel budget), so check your target
devices with the playground stats.

By default large backgrounds get a WebGL context of their own and the others share one; see
[Many instances on one page](#many-instances-on-one-page) for how LumiCells picks the renderer and
keeps the number of contexts in check.

## Many instances on one page

Browsers keep only about 16 WebGL contexts per page (fewer on phones). Past that they silently
kill the oldest one, which may be your hero background or the app's own WebGL (maps, three.js).
So LumiCells does not give every background a context of its own: it picks a renderer per
instance and keeps the number of contexts small page-wide, whatever the number of backgrounds.

### Renderers

By default (`renderer: 'auto'`) each instance picks one of two renderers:

- **Own context** for large backgrounds: a canvas of at least 0.5 megapixels (device pixels,
  `render.overflow` margin included), or a quarter of the viewport. A hero or a full-screen
  background draws straight into its own canvas: no copy per frame, and a context loss elsewhere
  on the page does not touch it.
- **Shared renderer** for everything else: one WebGL context for all of them. Each instance draws
  into its own region of one offscreen canvas, then its frame is copied into a 2D canvas in its
  host.

A page with a full-screen hero and a hundred cards therefore runs on two contexts: the hero's
own and the shared one.

- **Budget.** Own contexts are limited to 4 on desktop and 2 on touch devices (`maxContexts`).
  When the budget is full, a large `auto` instance uses the shared renderer instead of waiting,
  and takes a context of its own as soon as one frees up. Among large instances competing for
  contexts, a higher `priority` wins, then a clearly larger size. An `auto` instance, even with
  `priority: 'high'`, never takes the context of a visible `renderer: 'own'` instance; it stays on
  the shared renderer instead. Use `renderer: 'own'` with `priority: 'high'` to guarantee a
  context.
- **Resizes.** The choice is re-evaluated when the host, the viewport, the DPR or the render
  config change. It uses hysteresis (a shared instance switches to its own context at 1x the
  threshold, an own one goes shared below 0.7x) and waits until the size has held still for
  about a second, so dragging a resize handle across the threshold switches nothing. While the
  renderer switches, the last frame stays on screen until the new renderer draws.
- **Stats and events.** `getStats().renderer` is the renderer in use (`'own'` or `'shared'`),
  `getStats().rendererMode` the one asked for. The `renderer` event
  `{ renderer, previous, reason }` reports every switch after the first choice, with the reason
  `'promote'`, `'demote'`, `'budget'` or `'explicit'` (`lc-renderer` on the Web Component).

Force a renderer when you know better than the size:

- `renderer: 'own'` always takes a context of its own and never switches. Use it for a background
  that must never depend on the shared context, or a medium-sized one you want without the copy.
  When the budget is full it waits on its poster (`getStats().state` is `'waiting'`, a visible
  one emits `fallback` with reason `'budget'`, and the page logs one warning).
- `renderer: 'shared'` never takes a context of its own, even when large. Use it when the app
  needs its WebGL contexts for itself (maps, three.js), or to keep several large backgrounds on
  one context.

```ts
import { LumiCells } from 'lumicells';

// Page-wide settings: call before or after creating instances (safe on the server too).
LumiCells.configure({ maxContexts: 2, promoteArea: 1 });

const hero = new LumiCells(heroEl, { preset: 'reference', priority: 'high' }); // 'auto'
const card = new LumiCells(cardEl, { preset: 'orb' }); // small: the shared renderer
const map = new LumiCells(mapEl, { renderer: 'shared' }); // never takes a context of its own

hero.on('renderer', (e) => console.log(e.previous, '->', e.renderer, e.reason));
hero.getStats().state; // 'pending' | 'waiting' | 'live' | 'parked' | 'lost' | 'failed' | 'destroyed'
card.setRenderer('own'); // switch a running instance ('auto' hands it back to the policy)
```

In React use `<LumiCells renderer="own" priority="high">`, in HTML
`<lumi-cells renderer="own" priority="high">`. Without the prop or attribute the page default
applies.

| `LumiCells.configure()` option | Default | Meaning |
| --- | --- | --- |
| `renderer` | `'auto'` | Renderer of instances created afterwards that do not ask for one |
| `promoteArea` | `0.5` | Megapixels (device px) from which an `auto` instance prefers a context of its own; a quarter of the viewport always qualifies |
| `maxContexts` | `'auto'` | Own contexts at once: 4, or 2 on touch devices. Lowering it moves the lowest ranked `auto` instances to the shared renderer at once (`own` ones park) |
| `parkAfterMs` | `10000` | An instance farther than about one viewport for this long releases its GPU side and shows its poster; `Infinity` never parks |
| `createPerFrame` | `1` | Contexts created per frame |
| `sharedBudget` | `'auto'` | Megapixels of the shared canvas: 4, or 2 on touch devices. Past it, all shared instances render at a lower resolution |
| `secondaryMaxFps` | `'auto'` | Frame-rate cap of the inactive shared instances: fps, `0` off, `'auto'` only when needed (see [Cost reducers](#cost-reducers)) |
| `lite` | `'auto'` | Lite glow pipeline of the shared instances: `'auto'` small or crowded inactive ones, `true` every inactive one, `false` never |

### Lazy creation and parking

- **Lazy creation.** Nothing is created in the constructor. A context (or a slot on the shared
  one) is requested only when the container comes within about one viewport of the screen, at
  most one context per frame, so mounting a long list does not freeze the page: creating 100
  instances in one task takes about 20-25 ms of main thread on a first load on the test desktop
  (about 15 ms once the browser has cached the code). Inside a scrolling element (a carousel, a
  chat pane) the zone reaches one element size beyond its visible part in Chrome and Edge 120+
  (IntersectionObserver `scrollMargin`). Other browsers create the context there only once the
  background scrolls into the element's visible part, and treat the rest of the element as far
  away; in a cross-origin iframe the zone is the visible area.
- **Parking.** A background that stays farther away for 10 seconds releases its context (or its
  shared slot) and GPU memory and shows its poster. Scrolling back rebuilds it; the config,
  tweens and bound elements are kept, only the Life automaton reseeds.
- Instances with `render.pauseOffscreen: false` (for example an offscreen source copied into
  other canvases) are created right away, never parked, and rank as visible wherever they are.

### Shared renderer details

- Config, pointer, influences, pulses, lifted pixels, events, debug views and quality tiers work
  per instance as with an own context. `canvas` is the 2D canvas, and `ready` fires after the
  first copy.
- Only instances on screen get a region. When they need more pixels than `sharedBudget`, all of
  them render at a lower resolution: the grid and the cell size stay, only the sharpness drops,
  and no instance is dropped. The factor snaps down to a whole pixel cell size, never below 3
  device pixels: instances whose cells are already that small keep their resolution.
- Parked instances give their slot back and shrink their 2D canvas to 0×0, because Safari caps
  the canvas memory of a page.
- A lost shared context affects every shared instance. Each keeps its last frame (no poster) and
  gets `contextlost`, then `contextrestored` once the context is rebuilt.
- Each instance that presents a frame costs its own GPU work plus one `drawImage`, so the frame
  time grows with the number of animating instances; [Cost reducers](#cost-reducers) keep a
  hundred of them smooth. `getStats()` reports `presentMs` (this instance's copy, with its share
  of the frame's atlas snapshot) and `shared` (atlas size, draw and copy cost, the snapshot part
  of the copy cost, and a calibration of the copy cost per megapixel, measured again when the
  atlas size or budget scale changes). For a shared instance `gpuMs` is the GPU time of the
  whole shared device.

### Cost reducers

A hundred animated cards cost a hundred instances' draws and copies every frame. The shared
renderer cuts that where nobody looks closely, decided anew every frame:

- **Secondary frame rate.** An instance is active while the pointer is over it, for about a
  second after a pulse, a lift, an influence that moved or changed, a config transition or a
  modulated value. Active instances run at the full rate, and so does the largest one drawing,
  whatever its state. The others present every n-th display frame, spread evenly over the frames (at n = 2 half of
  them on even frames, half on odd ones), so every frame carries about the same load. Their
  animation time runs on: they show fewer frames, never a slower animation, and nothing jumps
  when an instance changes rate. With `secondaryMaxFps: 'auto'` (default) this starts only when
  needed: more than 8 shared instances drawing (at most 60 fps, and at most half the refresh
  rate), or the page missing its frame budget on the main thread or the GPU (about 30, then
  15 fps; at 60 Hz 30 fps is already the crowd rate, so a budget step goes to 15 fps, and on a
  30 Hz display the last step is 10 fps), and it eases back once the budget allows. A number caps
  them at that rate (snapped to a whole divisor of the refresh rate), `0` turns it off.
- **Lite pipeline.** Inactive shared instances smaller than about 0.15 megapixels, or every
  inactive one while more than 12 draw, blur bloom and haze inside one glow pass at cell
  resolution: 2 glow passes instead of 5. This goes by activity only, so the largest instance
  draws lite too when it is inactive and small enough (it still runs at the full rate). On the
  test desktop the picture differs from the full pipeline by at most 3 levels of 255 (0.1 to 0.2
  on average). Instances with a context of their own use it only at the adaptive `low` tier.
- **Copy cost.** Once the copy cost per megapixel is measured, the copies of a frame may take a
  quarter of it. Where copying is slow (a software 2D canvas, a weak device), the secondary rate
  drops further and, past 15 fps, the shared pixel budget comes down (to no less than a quarter
  of what the instances need).

`getStats().reducers` tells what acts on an instance (`{ lite, frameDivisor }`), and
`getStats().shared.reducers` the page-wide state: the secondary `frameDivisor` and `level`, the
`reason` (`'off'`, `'fixed'`, `'crowd'`, `'budget'` or `'copy'`), how many instances are secondary
and lite, the refresh interval it plans with and the lowered `copyBudget`, if any.

Stress bench, 100 cards of 130×80 px on one screen (Chrome, RTX 5090, 165 Hz; main thread and
GPU per frame):

| | Before | After |
| --- | --- | --- |
| CPU ×1 | 114 fps, p95 12.2 ms, 1.4 ms, GPU 4.2 ms | 165 fps, p95 6.2 ms, 0.6 ms, GPU 1.2 ms |
| CPU ×4 | 81 fps, p95 18.2 ms, 6.6 ms, GPU 3.6 ms | 163 fps, p95 6.2 ms, 2.1 ms, GPU 0.7 ms |
| DPR 2, CPU ×4 | 70 fps, p95 18.3 ms, 8.0 ms, GPU 4.3 ms | 164 fps, p95 6.2 ms, 2.3 ms, GPU 0.6 ms |

One or four cards run as before (165 fps), and the card under the pointer stays at 165 fps on
the full pipeline.

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

1. Add the runtime field to `src/schema/schema.ts`, for example
   `strength: num({ min: 0, max: 2, step: 0.01, default: 0.5, gpu: true })`.
2. Add its English label and description to `src/schema/meta.ts` under the same dotted path, for
   example `'glow.halo.strength': { label: 'Strength', description: '...' }`.
3. Add the Russian text to `src/schema/locales/ru.ts` under the same path.
4. Use it in a shader as `P_<path_with_underscores>`, for example `P_glow_halo_strength`.

Types, validation, the playground, the JSON Schema and export pick it up automatically. Tests fail
if a path has no English or Russian text. UI texts live outside the runtime schema, so an app that
only renders a background does not ship them.

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
