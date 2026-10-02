**English** | [Русский](ru/web-component.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Web Component

The `<lumi-cells>` tag works with any stack, plain HTML included. Until the npm release, install
the package as described in [Installation](installation.md).

## Example

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

`lumicells/element/define` registers the tag. `lumicells/element` exports the element class
without registering it (see [Entry points](installation.md#entry-points)).

## Attributes and properties

Attributes: `preset`, `src` (URL of a config file), `interactive`, `overflow`, `paused`,
`transition`, `priority`, `renderer`, `look`, `look-offset`. Properties: `config`, `preset`,
`src`, `paused`, `interactive`, `overflow`, `transition`, `priority`, `renderer`, `look`,
`lookOffset` and the read-only `instance`.

The config file that `src` points to is described in [Config file](config.md). For `renderer`,
`priority`, `look` and `look-offset` see [Many instances on one page](many-instances.md). Without
the `renderer` attribute the page default applies; `priority` defaults to `normal`, `look` to
`own`, `look-offset` to 0.

## Declarative binding of child elements

| Attribute | Meaning |
| --- | --- |
| `data-lc-influence` | The element affects the background. The value (or `data-lc-type`) sets the type: `light` (default), `shadow`, `lift`, `seed`, `repel` |
| `data-lc-color`, `data-lc-color-mix` | Tint color and how much of it is mixed into the palette |
| `data-lc-strength`, `data-lc-falloff`, `data-lc-padding`, `data-lc-priority` | Strength, soft edge in cells, padding in px, priority |
| `data-lc-track` | `auto` or `frame`: how often the position is re-read |
| `data-lc-pulse` | `click` or `hover`: send a ripple from the element |
| `data-lc-lift` | `hover` or `click`: lift pixels at the element |
| `data-lc-for="bg"` | Bind an element outside the tag (a portal, for example) to `<lumi-cells id="bg">` |

These attributes map to the influences, ripples and lifts described in
[Binding to the page](binding.md).

## Events

The element re-dispatches instance events as DOM events: `lc-ready`, `lc-config`, `lc-stats`,
`lc-error`, `lc-fallback`, `lc-contextlost`, `lc-contextrestored` (the end of a `context-lost`
fallback: the animation is back), `lc-renderer` (the renderer changed) and `lc-look`. Their
payloads are described in [Events](events.md).
