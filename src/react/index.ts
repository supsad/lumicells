'use client';

/**
 * pixel-life/react: <PixelLife> component and hooks. Client-only pieces are created in effects,
 * so the component renders on the server (static poster) without touching the DOM.
 */

// The imperative class, under a distinct name (the component owns `PixelLife` here).
export type { PixelLife as PixelLifeInstance } from '../core/pixel-life';
export { PixelLifeContext } from './context';
export {
  useInfluence,
  useModulator,
  usePixelLife,
  usePixelLifeEvent,
  usePixelLifeStats,
  usePulse,
} from './hooks';
export { PixelLife, type PixelLifeProps } from './PixelLife';
