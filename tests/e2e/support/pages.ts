/**
 * URLs and automation surfaces of the pages under test. The type references pull the dev pages'
 * own declarations of `window.bench` (stress bench) and `window.parity` (shared parity) into the
 * type check, so page.evaluate() results are typed by the pages themselves.
 */
/// <reference path="../../../examples/stress/main.ts" />
/// <reference path="../../../examples/shared-parity/main.ts" />
import { DESKTOP_MAX_CONTEXTS } from '../../../src/core/runtime/context-budget';
import { devPage } from './env';

declare global {
  interface Window {
    /** examples/multi-slot (it does not declare itself). */
    multi?: {
      done: boolean;
      last: {
        verdict?: string;
        failures?: string[];
        /** Mismatches of waived slots (the `waive` URL parameter), outside the verdict. */
        waived?: string[];
        summary?: { waivers?: string[] };
      } | null;
    };
  }
}

/** Published pages (part of the GitHub Pages build). */
export const PAGES = {
  stand: './',
  webComponent: 'examples/web-component.html',
  coreBasic: 'examples/core-basic.html',
} as const;

/** Stress bench URL with the given parameters (see examples/stress.html). */
export function stressUrl(params: Record<string, string | number>): string {
  const qs = new URLSearchParams({ hud: '0' });
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  return `${devPage('examples/stress.html')}?${qs}`;
}

export const MULTI_SLOT = devPage('examples/multi-slot.html');

/**
 * Multi-slot page with known issues waived (`scenario/slot` keys, see known-issues.ts): the page
 * reports their region-vs-own mismatches under `waived` instead of `failures`.
 */
export function multiSlotUrl(waive: readonly string[] = []): string {
  if (waive.length === 0) return MULTI_SLOT;
  const qs = new URLSearchParams();
  for (const w of waive) qs.append('waive', w);
  return `${MULTI_SLOT}?${qs}`;
}
export const SHARED_PARITY = devPage('examples/shared-parity.html');
export const LIFECYCLE = devPage('tests/e2e/site/lifecycle.html');

/**
 * Most WebGL contexts a page with default settings may hold at once on a desktop (fine pointer:
 * maxContexts 'auto' is DESKTOP_MAX_CONTEXTS): the budget of own contexts plus the shared
 * renderer's device (on top of the budget). The library's support probe (LumiCells.isSupported(),
 * memoized) adds nothing: it runs before the first engine exists and loses its context right
 * after creating it, so it is never live next to another one. The own contexts alone are checked
 * against DESKTOP_MAX_CONTEXTS (window.__glProbe.counters.peakLiveOwn), so an off-by-one in the
 * budget fails even where the shared device is absent.
 */
export const CONTEXT_CEILING = DESKTOP_MAX_CONTEXTS + 1;

export { DESKTOP_MAX_CONTEXTS };
