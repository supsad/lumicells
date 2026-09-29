import type { BubbleKind, SceneAction } from './types';

/** Reference composition size in px: every measured value below is in these units (see `--s` in scene.css). */
export const REF_SIZE = 345;

export type SceneItem = {
  id: string;
  label: string;
  kind: BubbleKind;
  /** Center as a fraction of the (square) scene stage. */
  fx: number;
  fy: number;
  /** Box size in reference px. Fixed so the composition does not depend on the font metrics. */
  w: number;
  h: number;
  /** Selected on first render. */
  selected?: boolean;
  /** Only topics with kind topic/primary toggle their selection. */
  action?: SceneAction;
  /** Entrance order (lower flies out first). */
  order: number;
  /** Small caption pill overlapping the bottom-right corner. */
  caption?: string;
};

// Centers and sizes measured on the 345 px reference (critique.md, "bubbles style").
export const SCENE_ITEMS: readonly SceneItem[] = [
  {
    id: 'travel',
    label: 'путешествия',
    kind: 'topic',
    fx: 0.66,
    fy: 0.23,
    w: 69,
    h: 20.5,
    order: 3,
  },
  { id: 'music', label: 'музыка', kind: 'card', fx: 0.345, fy: 0.338, w: 54, h: 54, order: 0 },
  { id: 'space', label: 'космос', kind: 'topic', fx: 0.64, fy: 0.42, w: 48, h: 20.5, order: 5 },
  { id: 'cats', label: 'котики', kind: 'topic', fx: 0.79, fy: 0.55, w: 47, h: 20.5, order: 7 },
  {
    id: 'crypto',
    label: 'криптография',
    kind: 'topic',
    fx: 0.22,
    fy: 0.61,
    w: 75,
    h: 20.5,
    order: 2,
  },
  {
    id: 'science',
    label: 'наука',
    kind: 'primary',
    fx: 0.62,
    fy: 0.658,
    w: 64,
    h: 30,
    selected: true,
    order: 6,
    caption: 'цифровые технологии',
  },
  { id: 'food', label: 'еда', kind: 'topic', fx: 0.35, fy: 0.71, w: 33, h: 20.5, order: 1 },
  {
    id: 'done',
    label: 'готово',
    kind: 'action',
    fx: 0.494,
    fy: 0.874,
    w: 45,
    h: 20.5,
    action: 'done',
    order: 8,
  },
  {
    id: 'back',
    label: 'назад',
    kind: 'secondary',
    fx: 0.165,
    fy: 0.936,
    w: 42,
    h: 20.5,
    action: 'back',
    order: 9,
  },
];

/** Title center as a fraction of the stage (measured at (0.495, 0.515)). */
export const TITLE_CENTER = { fx: 0.5, fy: 0.515 };
