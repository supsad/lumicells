**English** | [Русский](ru/presets-and-modes.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Presets and animation modes

## Presets

<p align="center">
  <img src="media/presets.png" width="760" alt="The nine presets side by side: reference, orb, pulse, life, vortex, waves, ripples, rain and minimal" />
</p>

`reference` (the default look), `orb`, `pulse`, `life`, `vortex`, `waves`, `ripples`, `rain`,
`minimal`. Every preset is a small patch over the defaults, so it makes a good starting point
for your own config: `{ "extends": "vortex", ... }` (see [Config file](config.md)).

Pick a preset with the `preset` option of the class, the `preset` prop of the React component or
the `preset` attribute of the Web Component. Switching presets animates like any other change.

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

How to add a mode of your own is described in
[Architecture](architecture.md#adding-an-animation-mode).

## Glow and palette

On top of the modes: flicker, rare sparkles, sparse edges, external energy (see
[Modulators](binding.md#modulators)) and the 3-layer glow: a tight halo around each cell, a soft
bloom and a wide haze.

The palette takes 1 to 32 color stops, interpolated in OKLab, linearly or in steps
(`color.interpolation`: `oklab`, `linear`, `steps`), with 5 mapping modes (`color.mapping`:
`spatial`, `radial`, `angular`, `intensity`, `noise`).

## Lifted pixels

**Lifted pixels** (`lift`): some cells pop out of the grid. They spring up, wobble and land with a
small ripple. They come in two styles: `pop` raises a cell in place, `float` detaches it and
carries it upward like a bubble. With `render.overflow` (a margin in px) they and their glow can
leave the canvas box.

Lifts also come from the page: hovering, `lift()` calls and `lift` influences (see
[Binding to the page](binding.md)). With `prefers-reduced-motion` lifted pixels are off (see
[Performance](performance.md#how-a-frame-stays-cheap)).
