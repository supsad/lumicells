**English** | [Русский](ru/config.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Config file

A look is a JSON config. The [playground](playground.md) exports it as `lumicells.config.json`:

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
  change when library defaults change later. The presets are listed in
  [Presets and animation modes](presets-and-modes.md#presets).
- The JSON Schema ships with the package (`lumicells/schema.json`) and can be downloaded from the
  playground, so your editor suggests fields and ranges.
- `normalizeConfig(raw)` never throws: it fixes types, clamps ranges, drops unknown keys and
  returns a list of issues with paths. `validateConfig(raw)` is stricter and suits CI checks.

## Using the file

- **React**: import the JSON and pass it as the `config` prop (see the example in
  [React](react.md#example)).
- **Web Component**: point the `src` attribute at the file, or set the `config` property (see
  [Web Component](web-component.md)).
- **Vanilla TypeScript**: pass it as the `config` option, or apply it later with `setConfig()` or
  `replaceConfig()` (see [Vanilla TypeScript](vanilla.md#changing-the-config)).

## Playground round trip

*Export* gives JSON (full or diff), TypeScript, React and HTML snippets and the JSON Schema;
*Import* takes a file or pasted JSON and reports what it fixed. *Link* copies a URL with the config
inside.
