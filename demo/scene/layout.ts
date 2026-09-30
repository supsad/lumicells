import type { BubbleKind, SceneAction } from './types';

/** Reference composition size in px: every measured value below is in these units (see `--s` in scene.css). */
export const REF_SIZE = 345;

export type SceneItem = {
  id: string;
  kind: BubbleKind;
  /** Center as a fraction of the (square) scene stage. */
  fx: number;
  fy: number;
  /**
   * Box height in reference px. Pills take their width from the (localized) text plus padding,
   * with a per-kind minimum (scene.css); only the card has a fixed width.
   */
  h: number;
  w?: number;
  /** Selected on first render. */
  selected?: boolean;
  /** Only topics with kind topic/primary toggle their selection. */
  action?: SceneAction;
  /** Entrance order (lower flies out first). */
  order: number;
};

// Centers measured on the 345 px reference (critique.md, "bubbles style"). Labels and captions
// live in texts.ts.
export const SCENE_ITEMS: readonly SceneItem[] = [
  { id: 'travel', kind: 'topic', fx: 0.66, fy: 0.23, h: 20.5, order: 3 },
  { id: 'music', kind: 'card', fx: 0.345, fy: 0.338, w: 54, h: 54, order: 0 },
  { id: 'space', kind: 'topic', fx: 0.64, fy: 0.42, h: 20.5, order: 5 },
  { id: 'cats', kind: 'topic', fx: 0.79, fy: 0.55, h: 20.5, order: 7 },
  { id: 'crypto', kind: 'topic', fx: 0.22, fy: 0.61, h: 20.5, order: 2 },
  { id: 'science', kind: 'primary', fx: 0.62, fy: 0.658, h: 30, selected: true, order: 6 },
  { id: 'food', kind: 'topic', fx: 0.35, fy: 0.71, h: 20.5, order: 1 },
  { id: 'done', kind: 'action', fx: 0.494, fy: 0.874, h: 20.5, action: 'done', order: 8 },
  { id: 'back', kind: 'secondary', fx: 0.165, fy: 0.936, h: 20.5, action: 'back', order: 9 },
];

/** Title center as a fraction of the stage (measured at (0.495, 0.515)). */
export const TITLE_CENTER = { fx: 0.5, fy: 0.515 };
