**English** | [Русский](ru/performance.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Performance

LumiCells is built for 60+ FPS: procedural math runs at cell resolution, the cell shape is a baked
stamp, quality adapts to the device and resolution is capped by a pixel budget.

This page covers one background. By default large backgrounds get a WebGL context of their own and
the others share one; see [Many instances on one page](many-instances.md) for how LumiCells picks
the renderer and keeps the number of contexts in check.

## How a frame stays cheap

- All procedural math runs at grid resolution: one texel per cell, thousands of points instead
  of millions. Full resolution only runs one composite pass and the instanced lifted pixels.
- The cell shape (rounding, halo, hot core) is baked into a small stamp the size of one grid
  step, so the composite pass does not evaluate SDFs and exponentials per pixel. Bloom and haze
  share one texture.
- Every instance on the page runs on one shared `requestAnimationFrame`, split into phases:
  app animations, DOM reads, GPU work.
- No objects or arrays are allocated per frame; uniform buffers upload only on change.
- Rendering stops while the tab is hidden or the container is off screen. With
  `prefers-reduced-motion` the animation slows down and lifted pixels are off, including
  `lift()` calls (opt out with `render.reducedMotion: 'ignore'`).

## Start-up and shader compilation

- Start-up does not freeze the page, even on a first visit with cold shader caches. Shaders
  compile in the background (`KHR_parallel_shader_compile`) and a look compiles only the
  animation modes and color features it uses. On Windows (ANGLE on Direct3D 11) every costly
  shader has a single output, so it compiles on a worker thread and not on the thread that
  composites the page, and every program is drawn once off screen before the first visible
  frame. On a desktop in a fresh browser profile the playground shows its first frame after
  about 1.1 s instead of about 6 s, and its longest main-thread task went from about 2.5 s to
  under 0.1 s.
- Turning a mode, the noise color mapping or the warp on later compiles one more shader in the
  background. Until it is ready the picture stays exactly as it was, then the change fades in
  over its full transition: it starts later by the compile time (a few hundred milliseconds on
  Direct3D). On Direct3D the first use of such a shader also stops the page's frames for about
  0.1 to 0.2 s, while the driver prepares it on the thread that composites the page; once the
  browser has cached the shader, this does not happen again.

How compilation differs in Firefox and WebKit is described in
[Browser support](browser-support.md#what-differs-between-browsers).

## Resolution and adaptive quality

- Resolution is capped by `render.maxDpr` and the pixel budget `render.maxPixels` (at most
  2.4 MP on touch devices).
- Adaptive quality learns the display rate (60, 120, 144 Hz and up) from frames that carry no GL
  work: while the first backgrounds of a page compile (their first draws wait a few frames more
  when needed, about 25 ms at 165 Hz, under the poster), and again when the tab comes back or the
  device pixel ratio changes (zoom, a move to a display with another DPR). So a GPU that is too
  slow from the very first frame is not mistaken for a slower display. A display that gets slower
  without a recalibration (a monitor with the same DPR, an OS power profile) is picked up from the
  frame cadence once the GPU time or the steps already taken show that the pace is not ours.
- When frames run late, it steps quality and resolution down with hysteresis. It does not mistake
  main-thread stalls or an OS frame-rate cap for a slow GPU, and a step that cuts neither the late
  frames nor the GPU time is undone (the cost does not depend on pixels there). Tiers: `high` full
  picture, `medium` cheaper glow sampling, `low` no halo and bevel, plus the lite glow pipeline
  (see [Cost reducers](many-instances.md#cost-reducers)).

## Bundle size

The engine (WebGL passes, shaders, the controller, the shared renderer) is a chunk of its own that
loads lazily behind the poster. The first instance on the page starts the download, so the chunk
arrives while the poster shows and the page finds out where the background is; every call made
before (config, `modulate`, `bindElement`, `pulse`...) is applied once it is there.

An app that imports only `LumiCells` loads about 16 KB gzip (14 KB brotli) up front and about
82 KB gzip (72 KB brotli) in total after minification; the up-front figure includes the bundler's
chunk loader (under 1 KB), which an app with lazy imports of its own already has.

The cost of the split: on a cold visit over a network the first animated frame arrives about one
round trip later than with a single bundle, because the chunk is requested only once the app's code
runs. The React component and `lumicells/element/define` start the download themselves as early as
they can; other apps can call `LumiCells.preload()` from their entry or add a
`<link rel="modulepreload">` for the engine chunk. A chunk that fails to download keeps every
instance on the page on its poster (`fallback` `'load'`) until the page is reloaded.

The plain `<script>` bundle is one file of about 85 KB gzip. Shaders are minified at build time and
UI texts of the schema are not part of the runtime. `npm run size` checks both budgets (see
[Development](development.md#scripts)).

## Measurements

Measured on a desktop (RTX 5090, 165 Hz): about 0.04 to 0.06 ms GPU and 0.1 ms CPU per frame at
1920×1080, about 0.08 ms GPU at 3840×2160 on `high`.

There are no measurements on real mobile GPUs yet: the mobile path is budgeted by design (DPR cap
2, pixel budget: on a phone with DPR 3 the resolution is capped at DPR 2 and by the pixel budget),
so check your target devices with the playground stats (see [Playground](playground.md)).
