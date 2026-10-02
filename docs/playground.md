**English** | [Русский](ru/playground.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Playground

The playground (the tuning stand) is a Vite app with a demo scene of floating bubbles on top of the
background. **[supsad.github.io/lumicells](https://supsad.github.io/lumicells/)** opens it live.

<p align="center">
  <img src="media/playground.png" width="960" alt="The LumiCells playground: toolbar with presets, stage sizes and export, the animated stage with the demo scene, and a settings panel generated from the parameter schema" />
</p>

## What you can do there

- switch between the 9 presets and tweak every parameter with live tweening;
- resize the stage (full screen, 360×360 card, 1200×320 banner, 390×844 phone, custom);
- toggle the demo scene, pointer interaction and debug layers (field, halo, bloom, haze, cells);
- pause the animation and simulate a context loss;
- watch FPS, CPU and GPU frame time, quality tier, pixel and cell count;
- undo and redo changes; the config is saved automatically;
- export your look as JSON, TypeScript, React or HTML, import a config back, or copy a share link
  (see [Playground round trip](config.md#playground-round-trip)).

## Settings panel

The panel on the right is built from the parameter schema automatically (see
[Architecture](architecture.md)). Every control shows a hint and its path in the config, and a
double click on a label returns the preset's value.

Hotkeys: `H` panel, `P` pause, `D` debug layer, `Ctrl+Z` / `Ctrl+Shift+Z` history.

The interface is in English and Russian: use the EN/RU switch, or add `?lang=ru` to the address.

## Examples

Two plain HTML examples are published next to it:
[Web Component](https://supsad.github.io/lumicells/examples/web-component.html) and
[vanilla core](https://supsad.github.io/lumicells/examples/core-basic.html).

## Running it locally

In a clone of the repository, `npm ci` and then `npm run dev` serve the playground at
`http://localhost:5173/`. The other dev pages are listed in
[Development](development.md#dev-pages).
