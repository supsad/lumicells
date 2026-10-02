import type { Stats } from './types';

/** A copy of `stats` for a caller to keep (LumiCells.getStats, the 'stats' event). */
export function statsCopy(stats: Stats, groupSize: number): Stats {
  stats.groupSize = groupSize;
  return {
    ...stats,
    shared: stats.shared ? { ...stats.shared, reducers: { ...stats.shared.reducers } } : null,
    reducers: { ...stats.reducers },
  };
}
