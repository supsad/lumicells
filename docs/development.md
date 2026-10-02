**English** | [Русский](ru/development.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Development

This page is for working on LumiCells itself: setup, scripts, tests and dev pages.

## Setup

In a clone of the repository:

```bash
npm ci
npm run dev   # http://localhost:5173/
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Playground and examples |
| `npm run build` | Type check and build the playground into `dist-demo` |
| `npm run build:lib` | Build the package into `dist/lib` and types into `dist/types` |
| `npm run check:types` | Type check the built package as a consumer would |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | Type check |
| `npm run lint` | Biome |
| `npm run test:e2e` | Browser end-to-end tests (Playwright: Chromium, Firefox, WebKit) |
| `npm run size` | Consumer bundle sizes against the budget (after `npm run build:lib`) |

Building the package for use in an app is described in [Installation](installation.md), the size
budgets in [Performance](performance.md#bundle-size).

## End-to-end tests

Run `npx playwright install chromium firefox webkit` once before the first e2e run. Every spec
runs in all three browsers; `npm run test:e2e -- --project=firefox` runs one.

The GPU, port and server switches are described in
[`tests/e2e/support/env.ts`](../tests/e2e/support/env.ts): CI renders in software (one job per
browser: SwiftShader in Chromium, Mesa's llvmpipe in Firefox and WebKit), local runs use the
hardware GPU.

The e2e suite checks hard invariants in every browser (no lost contexts, the context budget, every
visible card live, no leaks after 20 mount/destroy cycles, recovery from context loss, pixel parity
pages) and records timings in `test-results/e2e-perf.json`. The JS heap after those cycles is
checked in Chromium only (it needs CDP). Console messages a browser prints about its own behavior
are listed with the reason in
[`tests/e2e/support/known-issues.ts`](../tests/e2e/support/known-issues.ts); timing limits of a
browser other than Chromium sit next to their measurement in the specs.

Which browsers are tested where, and how they differ, is described in
[Browser support](browser-support.md).

## Dev pages

| Address | What it is |
| --- | --- |
| `/` | The playground with the settings panel and the demo scene ([Playground](playground.md)) |
| `/examples/web-component.html` | The Web Component in plain HTML, declarative binding with `data-lc-*` |
| `/examples/core-basic.html` | The core without frameworks, pixels flying out of the card bounds |
| `/examples/engine-harness.html` | Engine debugging: passes one by one, frame timing |
| `/examples/tune.html` | Deterministic time for screenshot comparisons |
| `/examples/scene-preview.html` | The demo scene on its own, over a static stand-in for the background |
| `/examples/ui-kit.html` | The playground's UI kit |

The first three are also published on GitHub Pages: the playground at
[supsad.github.io/lumicells](https://supsad.github.io/lumicells/) and the two examples next to it.
