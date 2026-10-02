**English** | [Русский](ru/many-instances.md)

[LumiCells](../README.md) › [Documentation](README.md)

# Many instances on one page

Browsers keep only about 16 WebGL contexts per page (fewer on phones). Past that they silently
kill the oldest one, which may be your hero background or the app's own WebGL (maps, three.js).
So LumiCells does not give every background a context of its own: it picks a renderer per
instance and keeps the number of contexts small page-wide, whatever the number of backgrounds.
A page-wide WebGL context budget, lazy creation near the viewport and parking of far-away
backgrounds mean a long list never hits the browser's context limit.

- [Renderers](#renderers): own context or the shared renderer, the budget, page-wide settings.
- [Lazy creation and parking](#lazy-creation-and-parking): when a background gets and releases
  its GPU side.
- [Shared renderer details](#shared-renderer-details): what works per instance, resolution,
  context loss, stats.
- [Cost reducers](#cost-reducers): how a hundred animated cards stay smooth.
- [Identical cards](#identical-cards): one picture shared by cards with the same config.

## Renderers

By default (`renderer: 'auto'`) each instance picks one of two renderers:

- **Own context** for large backgrounds: a canvas of at least 0.5 megapixels (device pixels,
  `render.overflow` margin included), or a quarter of the viewport. A hero or a full-screen
  background draws straight into its own canvas: no copy per frame, and a context loss elsewhere
  on the page does not touch it.
- **Shared renderer** for everything else: one WebGL context for all of them. Each instance draws
  into its own region of one offscreen canvas, then its frame is copied into a 2D canvas in its
  host.

A page with a full-screen hero and a hundred cards therefore runs on two contexts: the hero's
own and the shared one.

- **Budget.** Own contexts are limited to 4 on desktop and 2 on touch devices (`maxContexts`).
  When the budget is full, a large `auto` instance uses the shared renderer instead of waiting,
  and takes a context of its own as soon as one frees up. Among large instances competing for
  contexts, a higher `priority` wins, then a clearly larger size. An `auto` instance, even with
  `priority: 'high'`, never takes the context of a visible `renderer: 'own'` instance; it stays on
  the shared renderer instead. Use `renderer: 'own'` with `priority: 'high'` to guarantee a
  context.
- **Resizes.** The choice is re-evaluated when the host, the viewport, the DPR or the render
  config change. It uses hysteresis (a shared instance switches to its own context at 1x the
  threshold, an own one goes shared below 0.7x) and waits until the size has held still for
  about a second, so dragging a resize handle across the threshold switches nothing. While the
  renderer switches, the last frame stays on screen until the new renderer draws.
- **Stats and events.** `getStats().renderer` is the renderer in use (`'own'` or `'shared'`),
  `getStats().rendererMode` the one asked for. The `renderer` event
  `{ renderer, previous, reason }` reports every switch after the first choice, with the reason
  `'promote'`, `'demote'`, `'budget'` or `'explicit'` (`lc-renderer` on the Web Component).

Force a renderer when you know better than the size:

- `renderer: 'own'` always takes a context of its own and never switches. Use it for a background
  that must never depend on the shared context, or a medium-sized one you want without the copy.
  When the budget is full it waits on its poster (`getStats().state` is `'waiting'`, a visible
  one emits `fallback` with reason `'budget'`, and the page logs one warning).
- `renderer: 'shared'` never takes a context of its own, even when large. Use it when the app
  needs its WebGL contexts for itself (maps, three.js), or to keep several large backgrounds on
  one context.

```ts
import { LumiCells } from 'lumicells';

// Page-wide settings: call before or after creating instances (safe on the server too).
LumiCells.configure({ maxContexts: 2, promoteArea: 1 });

const hero = new LumiCells(heroEl, { preset: 'reference', priority: 'high' }); // 'auto'
const card = new LumiCells(cardEl, { preset: 'orb' }); // small: the shared renderer
const map = new LumiCells(mapEl, { renderer: 'shared' }); // never takes a context of its own

hero.on('renderer', (e) => console.log(e.previous, '->', e.renderer, e.reason));
hero.getStats().state; // 'pending' | 'waiting' | 'live' | 'parked' | 'lost' | 'failed' | 'destroyed'
card.setRenderer('own'); // switch a running instance ('auto' hands it back to the policy)
```

In React use `<LumiCells renderer="own" priority="high">`, in HTML
`<lumi-cells renderer="own" priority="high">`. Without the prop or attribute the page default
applies.

### Page-wide settings

| `LumiCells.configure()` option | Default | Meaning |
| --- | --- | --- |
| `renderer` | `'auto'` | Renderer of instances created afterwards that do not ask for one |
| `promoteArea` | `0.5` | Megapixels (device px) from which an `auto` instance prefers a context of its own; a quarter of the viewport always qualifies |
| `maxContexts` | `'auto'` | Own contexts at once: 4, or 2 on touch devices. Lowering it moves the lowest ranked `auto` instances to the shared renderer at once (`own` ones park) |
| `parkAfterMs` | `10000` | An instance farther than about one viewport for this long releases its GPU side and shows its poster; `Infinity` never parks |
| `createPerFrame` | `1` | Contexts created per frame |
| `sharedBudget` | `'auto'` | Megapixels of the shared canvas: 4, or 2 on touch devices. Past it, all shared instances render at a lower resolution |
| `secondaryMaxFps` | `'auto'` | Frame-rate cap of the inactive shared instances: fps, `0` off, `'auto'` only when needed (see [Cost reducers](#cost-reducers)) |
| `lite` | `'auto'` | Lite glow pipeline of the shared instances: `'auto'` small or crowded inactive ones, `true` every inactive one, `false` never |

## Lazy creation and parking

- **Lazy creation.** Nothing is created in the constructor. A context (or a slot on the shared
  one) is requested only when the container comes within about one viewport of the screen, at
  most one context per frame, so mounting a long list does not freeze the page: creating 100
  instances in one task takes about 20-25 ms of main thread on a first load on the test desktop
  (about 15 ms once the browser has cached the code). Inside a scrolling element (a carousel, a
  chat pane) the zone reaches one element size beyond its visible part in Chrome and Edge 120+
  (IntersectionObserver `scrollMargin`). Other browsers create the context there only once the
  background scrolls into the element's visible part, and treat the rest of the element as far
  away; in a cross-origin iframe the zone is the visible area.
- **Parking.** A background that stays farther away for 10 seconds releases its context (or its
  shared slot) and GPU memory and shows its poster. Scrolling back rebuilds it; the config,
  tweens and bound elements are kept, only the Life automaton reseeds.
- Instances with `render.pauseOffscreen: false` (for example an offscreen source copied into
  other canvases) are created right away, never parked, and rank as visible wherever they are.

## Shared renderer details

- Config, pointer, influences, pulses, lifted pixels, events, debug views and quality tiers work
  per instance as with an own context. `canvas` is the 2D canvas, and `ready` fires after the
  first copy.
- Only instances on screen get a region. When they need more pixels than `sharedBudget`, all of
  them render at a lower resolution: the grid and the cell size stay, only the sharpness drops,
  and no instance is dropped. The factor snaps down to a whole pixel cell size, never below 3
  device pixels: instances whose cells are already that small keep their resolution.
- Parked instances give their slot back and shrink their 2D canvas to 0×0, because Safari caps
  the canvas memory of a page.
- A lost shared context affects every shared instance. Each keeps its last frame (no poster) and
  gets `contextlost`, then `contextrestored` once the context is rebuilt.
- Each instance that presents a frame costs its own GPU work plus one `drawImage`, so the frame
  time grows with the number of animating instances; [Cost reducers](#cost-reducers) keep a
  hundred of them smooth. `getStats()` reports `presentMs` (this instance's copy, with its share
  of the frame's atlas snapshot) and `shared` (atlas size, draw and copy cost, the snapshot part
  of the copy cost, whether the copies went through a snapshot, `copyStaged`, read with
  `readPixels`, `copyReadback`, and a calibration of the copy cost per megapixel, measured again
  when the atlas size or budget scale changes). For a shared instance `gpuMs` is the GPU time of
  the whole shared device.

## Cost reducers

A hundred animated cards cost a hundred instances' draws and copies every frame. The shared
renderer cuts that where nobody looks closely, decided anew every frame:

- **Secondary frame rate.** An instance is active while the pointer is over it, for about a
  second after a pulse, a lift, an influence that moved or changed, a config transition or a
  modulated value. Active instances run at the full rate, and so does the largest one drawing,
  whatever its state. The others present every n-th display frame, spread evenly over the frames
  (at n = 2 half of them on even frames, half on odd ones), so every frame carries about the same
  load. Their animation time runs on: they show fewer frames, never a slower animation, and
  nothing jumps when an instance changes rate. With `secondaryMaxFps: 'auto'` (default) this
  starts only when needed: more than 8 shared instances drawing (at most 60 fps, and at most half
  the refresh rate), or the page missing its frame budget on the main thread or the GPU (about 30,
  then 15 fps; at 60 Hz 30 fps is already the crowd rate, so a budget step goes to 15 fps, and on a
  30 Hz display the last step is 10 fps), and it eases back once the budget allows. A number caps
  them at that rate (snapped to a whole divisor of the refresh rate), `0` turns it off.
- **Lite pipeline.** Inactive shared instances smaller than about 0.15 megapixels, or every
  inactive one while more than 12 draw, blur bloom and haze inside one glow pass at cell
  resolution: 2 glow passes instead of 5. This goes by activity only, so the largest instance
  draws lite too when it is inactive and small enough (it still runs at the full rate). On the
  test desktop the picture differs from the full pipeline by at most 3 levels of 255 (0.1 to 0.2
  on average). Instances with a context of their own use it only at the adaptive `low` tier.
- **Copy cost.** Once the copy cost per megapixel is measured, the copies of a frame may take a
  quarter of it. Where copying is slow (a software 2D canvas, a weak device), the secondary rate
  drops further and, past 15 fps, the shared pixel budget comes down (to no less than a quarter
  of what the instances need).

`getStats().reducers` tells what acts on an instance (`{ lite, frameDivisor }`), and
`getStats().shared.reducers` the page-wide state: the secondary `frameDivisor` and `level`, the
`reason` (`'off'`, `'fixed'`, `'crowd'`, `'budget'` or `'copy'`), how many instances are secondary
and lite, the refresh interval it plans with and the lowered `copyBudget`, if any.

Stress bench, 100 cards of 130×80 px on one screen (Chrome, RTX 5090, 165 Hz; main thread and
GPU per frame):

| | Before | After |
| --- | --- | --- |
| CPU ×1 | 114 fps, p95 12.2 ms, 1.4 ms, GPU 4.2 ms | 165 fps, p95 6.2 ms, 0.6 ms, GPU 1.2 ms |
| CPU ×4 | 81 fps, p95 18.2 ms, 6.6 ms, GPU 3.6 ms | 163 fps, p95 6.2 ms, 2.1 ms, GPU 0.7 ms |
| DPR 2, CPU ×4 | 70 fps, p95 18.3 ms, 8.0 ms, GPU 4.3 ms | 164 fps, p95 6.2 ms, 2.3 ms, GPU 0.6 ms |

One or four cards run as before (165 fps), and the card under the pointer stays at 165 fps on
the full pipeline.

## Identical cards

A list of cards with one config animates a hundred copies of the same picture. With
`look: 'shared'` (opt-in: it changes how the page looks), cards whose config draws the same picture
share one: it is rendered once per frame, and each card shows its part of it.

```ts
new LumiCells(cardEl, { preset: 'orb', look: 'shared' });
new LumiCells(otherEl, { preset: 'orb', look: 'shared', lookOffset: 0.25 }); // not in sync
```

In React use `<LumiCells look="shared">`, in HTML `<lumi-cells look="shared" look-offset="0.25">`.

- **Same picture.** Cards share when their configs match apart from `interaction`,
  `render.pauseOffscreen` and `transition`, which change no frame by themselves. All cards of a
  group animate in sync; `lookOffset` (0 to 0.5) shifts each card's window by up to that share of
  its size, in whole cells and seeded per instance, so neighbors do not show the same cells (the
  group renders that much larger: a large shift shows more of the picture's outskirts). The cells
  keep the card's own size, with `grid.sizing: 'count'` too.
- **Crop, never scale.** A card shows the part of the shared picture its own canvas covers, at its
  own pixel scale: in a group of equal cards each shows exactly what it would draw alone. Cards of
  different sizes share only when their cells come out the same size (`grid.sizing: 'pitch'`, or
  `'count'` with the same shorter side). A smaller or shifted card then has its cells where it
  would draw them alone, but the pattern is laid out for the group's size, and with
  `render.overflow` its margin shows the group's cells. A group never resizes once it has drawn:
  a larger card that comes later gets a picture of its own, and a group keeps its size when its
  largest card leaves, so no card's picture changes when another one comes or goes.
- **Leaving and rejoining.** A card leaves its group the moment it draws something of its own: a
  pointer light or hover lift (`interactive`), a click ripple or `pulse()`, an influence or bound
  element, `lift()`, a modulator, `setEnergy()`, a config change or a debug view. It continues the
  shared picture in a region of its own with the same clock, cells and lifted cells (the Life
  automaton reseeds; the pattern of a card smaller than its group, or shifted in it, lays out for
  the card's own size) and rejoins about 2 seconds after the last of these is gone, its lifted
  cells changing to the group's then. `setLook('own')` leaves at once. The GPU targets of a card
  that rejoins are kept for a while for the next card that leaves, so hovering one card after
  another does not allocate new ones per card.
- **Renderers and cost.** A shared look needs the shared renderer: with `renderer: 'auto'` the card
  stays there whatever its size, and `renderer: 'own'` wins over `look`. A group counts once for
  the atlas, the pixel budget and the lite pipeline, and is drawn in every frame in which one of
  its cards presents. Each card keeps its own pace from the secondary frame rate: what it still
  costs is its copy. Parking, context loss (each card keeps its last frame) and stats work per
  card as before.
- **Stats and events.** While in a group a card's stats describe what it shows: the group's
  quality tier and scale, its crop's pixels and cells, the group's lifted cells. A card that joins
  (or leaves) a group at another tier than it last reported gets a `quality` event with the reason
  `'look'`. `getStats().look` is `'group'` or `'own'` and `getStats().groupSize` the
  number of cards sharing the picture; `getStats().shared.groups` counts the pictures and
  `.draws` the regions drawn in the last frame. The `look` event `{ look, previous, reason,
  groupSize }` (`lc-look` on the Web Component) reports joins and leaves, with the reason
  `'join'`, `'layers'`, `'config'`, `'explicit'` or `'renderer'` (parked or moved to a context of
  its own).

Stress bench, 100 cards of 130×80 px (Chrome, RTX 5090, 165 Hz; main thread and GPU per frame,
regions drawn per frame):

| | `look: 'own'` | `look: 'shared'` |
| --- | --- | --- |
| CPU ×1 | 164 fps, 0.9 ms, GPU 1.0 ms, 34 draws | 165 fps, 0.3 ms, GPU 0.05 ms, 1 draw |
| CPU ×4 | 161 fps, 2.3 ms, inactive cards at 15 fps | 161 fps, 1.6 ms, inactive cards at 55 fps |
| DPR 2, CPU ×4 | 160 fps, 2.6 ms, inactive cards at 15 fps | 157 fps, 1.8 ms, inactive cards at 55 fps |
| CPU ×4, every card every frame | 67 fps, 8.0 ms, GPU 4.2 ms, 100 draws | 109 fps, 2.3 ms, GPU 0.04 ms, 1 draw |

The last row turns the secondary frame rate off (`secondaryMaxFps: 0`): what is left of a shared
look's cost is one `drawImage` per card and frame, and the browser compositing every canvas that
changed. The rate of the inactive cards is not set by the shared look but by the frame budget (the
crowding floor is about 55 fps, the budget can lower it to about 15 fps), so it depends on the load
of the machine: re-measured under other load, both looks had the inactive cards at 15 fps, with the
shared look still ahead on frame rate and main-thread time (138 against 108 to 113 fps at CPU ×4).

How the shared renderer's copies behave in Firefox and WebKit is described in
[Browser support](browser-support.md#what-differs-between-browsers).
