**English** | [Русский](ru/react.md)

[LumiCells](../README.md) › [Documentation](README.md)

# React

`lumicells/react` wraps the core in a `<LumiCells>` component and a few hooks. It requires
React 19 (`ref` is a regular prop). Until the npm release, install the package as described in
[Installation](installation.md).

## Example

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

`lumicells.config.json` is the file the playground exports; see [Config file](config.md).

## Props

Besides the props below, the component takes regular `div` attributes. The merge order is
defaults, then `preset`, then `config`. `config` may be a new object on every render: the component
compares content, not identity.

| Prop | Meaning |
| --- | --- |
| `preset` | Named preset used as the base under `config` (see [Presets](presets-and-modes.md#presets)) |
| `config` | Partial config merged over the preset |
| `transition` | Tween duration in ms used when the config changes; defaults to `config.transition` |
| `paused` | Stops rendering while `true` |
| `interactive` | Shortcut for `interaction.pointer` + `interaction.click` |
| `overflow` | Lets the canvas extend beyond the box: `true` is 64 px, a number is px, `false` is none |
| `priority` | Priority for the page's WebGL context budget: `'high'`, `'normal'` (default) or `'low'` |
| `renderer` | `'auto'`, `'own'` or `'shared'`; without the prop the page default applies (see [Renderers](many-instances.md#renderers)) |
| `look`, `lookOffset` | Share one picture between cards that draw the same (see [Identical cards](many-instances.md#identical-cards)) |
| `fallback` | Rendered over the static poster when there is no animation (see [Fallback](#fallback)) |
| `onReady` | Called with the instance once the first frame is on screen |
| `onError` | Called with an error |
| `onStats` | Called with frame stats about 4 times per second |
| `ref` | The `LumiCells` instance (`null` until mounted) |
| `children` | Rendered above the canvas |

## Hooks

| Hook | Purpose |
| --- | --- |
| `useLumiCells()` | The instance of the nearest `<LumiCells>`. It is `null` only on the server, before mount and after unmount. Without WebGL2 the instance is still returned: check `instance.supported` or use the `fallback` prop |
| `useInfluence(ref, opts)` | Turns an element into a light, shadow or lift source; returns a ref to its handle |
| `useModulator(path, source, opts)` | Drives a numeric parameter from a value, a function or `{ get() }` |
| `usePulse()` | Stable function that sends a ripple |
| `useLumiCellsStats()` | Frame stats, updated about 4 times per second |
| `useLumiCellsEvent(type, handler)` | Subscribes to an instance event |

What influences, ripples and modulators do is described in [Binding to the page](binding.md), the
event types in [Events](events.md).

## Server rendering

The component renders a static poster on the server (SSR); WebGL is created only in the browser.
The `lumicells/react` entry is marked `'use client'`.

## Fallback

The `fallback` prop is shown on the fallback reasons `no-webgl2`, `compile` and `load` (the
engine's chunk could not be downloaded). On a temporary context loss it is shown too and goes away
as soon as the context is restored. A wait for a context of the page budget (reason `budget`) does
not show it: the poster is enough there. The reasons are listed in [Events](events.md).
