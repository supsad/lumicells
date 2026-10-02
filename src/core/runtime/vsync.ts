/**
 * Known display refresh intervals, ms (240, 165, 144, 120, 90, 60, 30 Hz). A module of its own:
 * the display calibration (eager, the ticker feeds it) and adaptive quality (part of the engine
 * chunk) both snap to them.
 */
export const VSYNC_CANDIDATES = [4.17, 6.06, 6.94, 8.33, 11.11, 16.67, 33.33] as const;
