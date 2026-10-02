**English** | [Русский](ru/browser-support.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Browser support

Needs WebGL2: current Chrome, Edge, Firefox, and Safari 15 or newer. Without WebGL2, after a
context loss, before the first frame (the engine's chunk loads meanwhile) and while an instance
waits for a context or is parked, a static CSS poster in the config colors is shown. With
float render targets the glow is computed in HDR, otherwise in RGBA8 with compression.

How an app finds out that the poster stays is described in [Events](events.md) (the `fallback`
event) and, for React, in [React](react.md#fallback).

## What is tested where

- The browser end-to-end suite ([Development](development.md#end-to-end-tests)) runs in the
  Chromium, Firefox and WebKit builds of Playwright: in CI on a Linux runner without a GPU
  (software rendering: SwiftShader in Chromium, Mesa's llvmpipe in Firefox and WebKit), and
  locally on Windows with the GPU (RTX 5090, 165 Hz). The same invariants hold in all three; where
  a browser is slower by nature, its timing limits say so, each next to its measurement.
- Playwright's WebKit is not Safari: on Windows it is WebKit's own Windows port, on Linux
  WebKitGTK, each with its own GPU process and compositor. Nothing has been measured on Safari,
  iOS or Android yet.

## What differs between browsers

As measured on that Windows desktop:

- Firefox compiles the shaders of every new WebGL context anew (no program cache shared between
  contexts, no `KHR_parallel_shader_compile`): about 1.6 s per context, with the page waiting.
  Backgrounds with contexts of their own start, and come back from a context loss, one after the
  other at that pace (four of them: 7-10 s). The shared renderer compiles once for all of its
  instances.
- In Firefox a `drawImage()` from a WebGL canvas reads the whole canvas back. The shared renderer
  then copies through one snapshot of its atlas per frame instead of one readback per card, read
  with `readPixels` (only the part in use) when that is cheaper, decided by measuring. A hundred
  cards on one screen still spend 15-25 ms per frame on copies there (about a quarter less than
  with the snapshot drawn from the WebGL canvas: 41 against 34 fps), against under 1 ms in
  Chrome, so the cost reducers lower their rate and resolution more.
- WebKit's Windows port blocks on a new context's first shader warm-up (`fenceSync` waits for
  its GPU process there) and compiles a restored context's shaders anew. It also shows a
  canvas's first frame later than the style change that reveals it, so a new or restored canvas
  appears with its second frame (in every browser: one frame later than before).
- Firefox logs a warning for every lost WebGL context, the ones the library releases on purpose
  included. WebKit counts released contexts toward its limit of 16 until they are garbage
  collected, and logs errors when it recycles one of them.
- `performance.now()` advances in 1 ms steps in Firefox and WebKit (0.1 ms in Chrome), and of
  the three only Chromium has a GPU timer and the Long Tasks API: in Firefox and WebKit the
  adaptive quality, the cost reducers and the copy path choice work from averages over frames.

The shared renderer, its snapshot copies and the cost reducers are described in
[Many instances on one page](many-instances.md), the adaptive quality in
[Performance](performance.md#resolution-and-adaptive-quality).
