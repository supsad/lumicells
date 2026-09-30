'use client';

/**
 * lumicells/react: <LumiCells> component and hooks. Client-only pieces are created in effects,
 * so the component renders on the server (static poster) without touching the DOM.
 */

// The imperative class, under a distinct name (the component owns `LumiCells` here).
export type { LumiCells as LumiCellsInstance } from '../core/lumi-cells';
export { LumiCellsContext } from './context';
export {
  useInfluence,
  useLumiCells,
  useLumiCellsEvent,
  useLumiCellsStats,
  useModulator,
  usePulse,
} from './hooks';
export { LumiCells, type LumiCellsProps } from './LumiCells';
