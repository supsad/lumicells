/**
 * Pause for the stand: time stands still, but rendering keeps running.
 *
 * `instance.stop()` would unsubscribe the ticker, so nothing would be drawn after that: edits
 * made while paused would stay invisible and the stats would go stale. Instead the stand pins the
 * two parameters that keep the field alive to zero with override modulators, through the public
 * modulation API:
 *
 *  - animation.speed = 0  freezes every phase (modes, drift, flicker, sparkle, ripples' clock);
 *  - lift.amount = 0      stops new random lifts from popping up.
 *
 * Modulators live in the runtime layer, never in the stored config, so exports, share links and
 * autosave are untouched, and the sliders keep their values (the panel shows the effective one
 * with a "мод." badge). Disposing the modulators on resume returns everything to the config.
 */

import type { LumiCells, ModulatablePath } from 'lumicells';
import { useEffect } from 'react';
import type { ModulationTracker } from './modulation';

export const PAUSE_PATHS: readonly ModulatablePath[] = ['animation.speed', 'lift.amount'];

export function usePauseModulators(
  instance: LumiCells | null,
  tracker: ModulationTracker,
  paused: boolean,
): void {
  useEffect(() => {
    if (!instance || !paused) return;
    const mods = PAUSE_PATHS.map((path) =>
      tracker.modulate(instance, path, 0, { blend: 'override' }),
    );
    return () => {
      for (const m of mods) m.dispose();
    };
  }, [instance, tracker, paused]);
}
