/**
 * Known library bugs the end-to-end suite keeps out of a verdict, each scoped as narrowly as the
 * evidence allows (one renderer, one scenario, one slot). Everything else stays a hard gate: the
 * parity specs run without retries, so an intermittent mismatch anywhere else fails the run
 * instead of passing as 'flaky'.
 */

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
 * Library bug, not test noise (no issue filed yet; file one and link it here): on ANGLE/D3D11
 * (Windows), in scenario rgba8+debug, slot 'D2 halo @1.25x' (debug view 2, dpr 1.25,
 * overflow 14) differs from its own-context engine by up to ~160 LSB on ~12k pixels at every
 * checkpoint, with the same numbers each time, in about 1 run in 4. Never seen on SwiftShader
 * (CI) or on the other slots. Only its region-vs-own comparison is waived; its draw count, the
 * pixels outside the regions and every other slot and scenario still decide the verdict.
 */
export const MULTI_SLOT_WAIVERS: readonly MultiSlotWaiver[] = [
  {
    scenario: 'rgba8+debug',
    slot: 'D2',
    renderer: /\bD3D11\b|Direct3D11/i,
    note: "ANGLE/D3D11: 'D2 halo @1.25x' differs from its own-context engine by ~160 LSB on ~12k pixels in ~1 run in 4 (library bug)",
  },
];

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
