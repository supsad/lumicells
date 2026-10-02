**English** | [Русский](ru/events.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Events

`cells.on(type, handler)` subscribes to an instance event and returns the function that
unsubscribes:

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
| `fallback` | `{ reason: 'no-webgl2' \| 'compile' \| 'context-lost' \| 'budget' \| 'load' }`: the static poster is shown instead of the animation (see [Fallback reasons](#fallback-reasons)) |
| `renderer` | `{ renderer, previous, reason }` when the renderer changes: `'promote'`, `'demote'`, `'budget'` or `'explicit'` |
| `look` | `{ look, previous, reason, groupSize }` when a card joins or leaves a shared picture (see [Identical cards](many-instances.md#identical-cards)) |
| `contextlost`, `contextrestored`, `destroy` | Lifecycle |

The adaptive quality behind `quality` is described in
[Performance](performance.md#resolution-and-adaptive-quality), the renderers behind `renderer` in
[Renderers](many-instances.md#renderers).

## Fallback reasons

- `'no-webgl2'`: the browser has no WebGL2.
- `'compile'`: the engine could not be set up (a shader failure, for example).
- `'context-lost'`: the WebGL context was lost; it lasts until `contextrestored`.
- `'budget'`: a visible `renderer: 'own'` instance waits for a WebGL context because the page
  budget is full; it starts drawing as soon as a context frees up (see
  [Many instances on one page](many-instances.md#renderers)).
- `'load'`: the engine's chunk could not be downloaded, the poster stays (for every instance,
  until the page is reloaded).

## In React and the Web Component

In React, `useLumiCellsEvent(type, handler)` subscribes to an event and `onReady`, `onError` and
`onStats` are props ([React](react.md)). The Web Component re-dispatches most of them as DOM
events with the `lc-` prefix, such as `lc-ready` and `lc-fallback`; the full list is in
[Web Component](web-component.md#events).
