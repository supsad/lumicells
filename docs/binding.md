**English** | [Русский](ru/binding.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Binding to the page

The background knows what happens around it through four mechanisms: influences, pulses and
lifts, modulators, and coordinate spaces that tie them to the page.

The examples use the [vanilla API](vanilla.md), where `cells` is a `LumiCells` instance. In React
use the hooks `useInfluence`, `usePulse` and `useModulator` ([React](react.md#hooks)). In HTML,
influences, ripples and lifts can be declared on child elements with the `data-lc-*` attributes
([Web Component](web-component.md#declarative-binding-of-child-elements)).

## Influences

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

### Tracking modes

The `track` option sets how a bound element is followed:

- `auto` reads the element rect only while it may move (resize, scroll, CSS transitions, Web
  Animations);
- `frame` reads it every frame;
- `manual` never touches the DOM and takes coordinates from `update({ x, y, w, h })`.

For elements moved by JavaScript, animate them inside `onBeforeFrame` from `lumicells` and the
light never lags a frame behind.

## Pulses and lifts

**One-off events** (`pulse`, `lift`): a ripple from a point and a lift of pixels at a point.

```ts
cells.pulse({ x: 0.5, y: 0.5, space: 'norm', color: '#19e6d0', strength: 1 });
cells.lift({ x: 12, y: 8, space: 'cells', count: 6, radius: 2 });
```

The look of lifted pixels is described in
[Presets and animation modes](presets-and-modes.md#lifted-pixels).

## Modulators

**Modulators** (`modulate`): drive any numeric parameter from a number, a function or an object
with `get()`. Blend modes: `add`, `mul`, `override`, `max`, with optional smoothing. Modulators
live only at runtime and never end up in a saved config, so they never fight with the
[playground](playground.md).

```ts
// The sphere grows while something is happening on the page.
const m = cells.modulate('modes.sphere.radius', () => activity * 0.1, {
  blend: 'add',
  smoothingMs: 150,
});

// External energy, for example an audio level.
cells.setEnergy(1.4);
```

## Coordinate spaces

**Coordinate spaces** (`space`): `host` (CSS px from the container corner), `client` (viewport
px, like `PointerEvent`), `norm` (0..1 of the container) and `cells` (grid cells).
