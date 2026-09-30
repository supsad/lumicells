export type BubbleKind = 'topic' | 'primary' | 'secondary' | 'card' | 'action';

export type BubbleInfo = {
  id: string;
  label: string;
  kind: BubbleKind;
  /** Hex color for the light influence: red #ee2848 or blue #0481f5. */
  color: string;
  selected: boolean;
  /** Extra to the agreed shape: pointer is currently over the element (hover changes only). */
  hovered?: boolean;
};

export type SceneAction = 'done' | 'back';
export type FlightPhase = 'start' | 'end';

export type DemoSceneProps = {
  /** Called once per bubble element; the returned function is called on unmount. */
  // biome-ignore lint/suspicious/noConfusingVoidType: same shape as a React effect callback
  onBubbleMount?(el: HTMLElement, info: BubbleInfo): void | (() => void);
  /** Selection or hover changed. */
  onBubbleChange?(el: HTMLElement, info: BubbleInfo): void;
  onBubbleHover?(el: HTMLElement, info: BubbleInfo, hovering: boolean): void;
  /** `point` is in client pixels. */
  onBubbleClick?(el: HTMLElement, info: BubbleInfo, point: { x: number; y: number }): void;
  // biome-ignore lint/suspicious/noConfusingVoidType: same shape as a React effect callback
  onTitleMount?(el: HTMLElement): void | (() => void);
  onAction?(action: SceneAction, el: HTMLElement): void;
  /** Entrance/exit flight events (start = the element begins to move, end = it has settled or gone). */
  onFlight?(el: HTMLElement, info: BubbleInfo, phase: FlightPhase): void;
  /** false plays the exit and keeps the bubbles hidden; true (default) plays the entrance. */
  visible?: boolean;
  /** Language of the scene copy (default 'en'). Switching it keeps the bubbles mounted. */
  locale?: 'en' | 'ru';
  className?: string;
};

export const COLOR_RED = '#ee2848';
export const COLOR_BLUE = '#0481f5';
