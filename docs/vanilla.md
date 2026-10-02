**English** | [Русский](ru/vanilla.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Vanilla TypeScript

The core package `lumicells` exports the `LumiCells` class. It needs no framework: the
[React component](react.md) and the [Web Component](web-component.md) are built on it. Until the
npm release, install the package as described in [Installation](installation.md).

## Example

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

## Options

`new LumiCells(host, options)` draws the background in the `host` element.

| Option | Meaning |
| --- | --- |
| `preset` | Named preset used as the base under `config` (see [Presets](presets-and-modes.md#presets)) |
| `config` | Partial config merged over the preset (or the defaults) |
| `interactive` | Shortcut for `interaction.pointer` + `interaction.click` |
| `autoStart` | Start right away (default `true`). The WebGL context itself is created lazily (see [Lazy creation and parking](many-instances.md#lazy-creation-and-parking)) |
| `priority` | Priority for the page's context budget: `'high'`, `'normal'` (default) or `'low'` |
| `renderer` | `'auto'`, `'own'` or `'shared'`; without the option the page default applies (`'auto'` unless changed with [`LumiCells.configure()`](many-instances.md#page-wide-settings)), see [Renderers](many-instances.md#renderers) |
| `look`, `lookOffset` | Share one picture between cards that draw the same (see [Identical cards](many-instances.md#identical-cards)) |

## Changing the config

Every change animates smoothly, including preset switches. The config is typed, and so are the
parameter paths of `set()` and `modulate()`.

| Method | What it does |
| --- | --- |
| `set(path, value, opts)` | Changes one parameter by its dotted path, for example `'modes.sphere.radius'` |
| `setConfig(patch, opts)` | Merges a partial config into the current one |
| `replaceConfig(config, opts)` | Replaces the whole config; missing keys fall back to the defaults or `extends` |
| `get(path)`, `getConfig()` | The current config value of a path, or the whole config |
| `getEffective(path)` | The current value of a numeric parameter after tweening and modulation |
| `exportConfig({ mode, base })` | The config as a config file object: `mode` is `'full'` or `'diff'`, `base` is `'defaults'` or a preset |

`opts.transition` is the tween duration in ms; it defaults to `config.transition`, and `0` applies
the change at once. The file format is described in [Config file](config.md).

## Other methods

| Method | What it does | Details |
| --- | --- | --- |
| `bindElement(el, opts)`, `addInfluence(opts)` | Light, shadow, lift, seed or repel areas | [Binding to the page](binding.md#influences) |
| `pulse(opts)`, `lift(opts)` | A one-off ripple, a lift of pixels | [Binding to the page](binding.md#pulses-and-lifts) |
| `modulate(path, source, opts)`, `setEnergy(value)` | Drive a numeric parameter from your own data | [Binding to the page](binding.md#modulators) |
| `on(type, handler)` | Subscribes to an event, returns the unsubscribe function | [Events](events.md) |
| `getStats()` | Frame stats, renderer, state, cost reducers | [Events](events.md), [Many instances on one page](many-instances.md) |
| `setRenderer(mode)`, `setPriority(priority)`, `setLook(look, offset)` | Switch a running instance | [Many instances on one page](many-instances.md) |
| `setDebugView(view)` | Shows a debug layer: `'field'`, `'halo'`, `'bloom'`, `'haze'` or `'cells'`; `'final'` is the normal picture | |
| `start()`, `stop()` | Start or stop rendering; `stop()` keeps the last frame | |
| `destroy()` | Releases the WebGL context | |
| `loseContextForTesting()` | Simulates a context loss and the browser's restore about 0.5 s later, to test recovery. On a shared instance it loses the shared context, so every shared instance is affected | |

Read-only properties: `host`, `canvas`, `supported`, `destroyed`, `renderer`, `rendererMode`,
`priority`, `look`, `lookOffset`.

Static members:

- `LumiCells.configure(options)`: page-wide settings (see
  [Page-wide settings](many-instances.md#page-wide-settings)).
- `LumiCells.preload()`: starts downloading the engine's chunk early (see
  [Bundle size](performance.md#bundle-size)).
- `LumiCells.isSupported()`: whether WebGL2 is available.

`onBeforeFrame(callback)` from `lumicells` runs a callback at the start of every frame, before any
instance measures the DOM: animate elements bound to the background there (see
[Tracking modes](binding.md#tracking-modes)).
