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
