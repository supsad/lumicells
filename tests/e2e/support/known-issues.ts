/**
 * Known issues the end-to-end suite keeps out of a verdict, each scoped as narrowly as the
 * evidence allows:
 * - multi-slot waivers: library bugs on one renderer, one scenario, one slot. Everything else
 *   stays a hard gate: the parity specs run without retries, so an intermittent mismatch anywhere
 *   else fails the run instead of passing as 'flaky';
 * - console waivers: messages one browser engine prints about behavior of its own that the
 *   library cannot avoid, matched by their whole text. They only take a message off the page's
 *   problem list (support/test.ts); the invariant the message touches is checked by other means.
 */
import type { BrowserName } from './env';

export interface MultiSlotWaiver {
  /** Scenario name on examples/multi-slot ('base', 'changed', 'rgba8+debug'). */
  scenario: string;
  /** Slot letter: the first word of the slot's name on the page ('A', 'D2', 'L', ...). */
  slot: string;
  /** Renderers (WebGL UNMASKED_RENDERER string) the waiver applies to. */
  renderer: RegExp;
  /** What is known about the bug and where it is tracked. */
  note: string;
}

/**
 * None at the moment. The last one, 'rgba8+debug/D2' on ANGLE/D3D11 ('D2 halo @1.25x' off by
 * ~150 LSB on ~12k pixels in about 1 run in 4), was fixed in the library: with its render
 * targets lazily initialized by a clear right before the cell stamp bake, NVIDIA's D3D11 driver
 * could drop the bake's second MRT output, leaving the halo layer empty. Render targets now get
 * zero texels by upload when they are created (createTargetTexture in src/core/gl/target.ts), and
 * the stamp is baked by two single-output programs (src/core/engine/passes/stamp.ts).
 */
export const MULTI_SLOT_WAIVERS: readonly MultiSlotWaiver[] = [];

/** The waivers for this renderer, as `scenario/slot` keys for the page's `waive` parameter. */
export function multiSlotWaivers(renderer: string): string[] {
  return MULTI_SLOT_WAIVERS.filter((w) => w.renderer.test(renderer)).map(
    (w) => `${w.scenario}/${w.slot}`,
  );
}

/** The note of a `scenario/slot` waiver key. */
export function waiverNote(key: string): string {
  return MULTI_SLOT_WAIVERS.find((w) => `${w.scenario}/${w.slot}` === key)?.note ?? key;
}

export interface ConsoleWaiver {
  browser: BrowserName;
  /** Browser versions (Playwright build) the message was seen and analyzed with. */
  seen: string;
  /** The whole message as Playwright reports it (anchored). */
  text: RegExp;
  /** Why the library cannot avoid it, and what checks the invariant it touches instead. */
  note: string;
}

export const CONSOLE_WAIVERS: readonly ConsoleWaiver[] = [
  {
    browser: 'firefox',
    seen: 'Firefox 155.0 (Playwright firefox-1543)',
    text: /^\[JavaScript Warning: "WebGL context was lost\." (\{[^}]*\})?\]$/,
    note:
      'Firefox logs this warning for every context loss (ClientWebGLContext::OnContextLoss), ' +
      'deliberate ones included: WEBGL_lose_context.loseContext() is how the library releases a ' +
      'context at once (destroy, parking, its support probe, loseContextForTesting) instead of ' +
      'waiting for the garbage collector. Losses nobody asked for are counted by the page probe ' +
      '(evicted), a hard 0 in every spec.',
  },
  {
    browser: 'webkit',
    seen: 'WebKit 26.6 (Playwright webkit-2359, Windows)',
    text: /^There are too many active WebGL contexts on this page, the oldest context will be lost\.$/,
    note:
      'WebKit keeps a context released with WEBGL_lose_context on its list of 16 active ' +
      'contexts until the context is garbage collected (loseContext() does not call ' +
      'destroyGraphicsContextGL()), so a page that releases contexts and creates new ones ' +
      '(parking and reviving own backgrounds) passes 16 and WebKit recycles the context it used ' +
      'least recently: one the library already released (every draw moves a live context up). ' +
      'No API frees a released context sooner. A live context recycled would fire ' +
      "'webglcontextlost', which the page probe counts as evicted: a hard 0 in every spec.",
  },
  {
    browser: 'webkit',
    seen: 'WebKit 26.6 (Playwright webkit-2359, Windows)',
    text: /^WebGL: INVALID_OPERATION: loseContext: context already lost$/,
    note:
      'Printed by the recycling above (recycleContext() loses the context again before ' +
      'destroying it), not by a call of the library: it releases a context once, and only one ' +
      'that is not lost.',
  },
];

/** Console waivers of a browser engine. */
export function consoleWaivers(browser: BrowserName): readonly ConsoleWaiver[] {
  return CONSOLE_WAIVERS.filter((w) => w.browser === browser);
}
