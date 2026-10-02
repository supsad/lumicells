/**
 * Validation of instance options (LumiCellsOptions, the setters): shared by the eager facade and
 * the GPU side, dependency-free.
 */
import type { InstancePriority, LookMode } from './types';

export function isPriority(v: unknown): v is InstancePriority {
  return v === 'high' || v === 'normal' || v === 'low';
}

export function isLookMode(v: unknown): v is LookMode {
  return v === 'own' || v === 'shared';
}

/** Largest window shift (LumiCellsOptions.lookOffset), share of the host size per axis. */
export const MAX_LOOK_OFFSET = 0.5;

/** Clamps a lookOffset value (non-numbers are 0). */
export function lookOffset(v: unknown): number {
  return typeof v === 'number' && v > 0 ? Math.min(MAX_LOOK_OFFSET, v) : 0;
}
