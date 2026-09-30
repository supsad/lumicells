/**
 * Scene copy per language. Layout (positions, entrance order) lives in layout.ts and does not
 * depend on the language: pills size themselves from their text (see `.lc-scene-pill` in
 * scene.css), so any wording keeps the composition.
 */

export type SceneLocale = 'en' | 'ru';

/** One run of title text; `hl` marks the highlighted word. */
export interface TitleRun {
  text: string;
  hl?: boolean;
}

export interface SceneText {
  /** Title lines, each a list of runs. */
  title: readonly (readonly TitleRun[])[];
  /** Label (and optional caption pill) per scene item id. */
  items: Readonly<Record<string, { label: string; caption?: string }>>;
}

export const SCENE_TEXT: Record<SceneLocale, SceneText> = {
  en: {
    title: [[{ text: 'What are' }], [{ text: 'you', hl: true }, { text: ' into?' }]],
    items: {
      travel: { label: 'Travel' },
      music: { label: 'Music' },
      space: { label: 'Space' },
      cats: { label: 'Cats' },
      crypto: { label: 'Crypto' },
      science: { label: 'Science', caption: 'digital tech' },
      food: { label: 'Food' },
      done: { label: 'Done' },
      back: { label: 'Back' },
    },
  },
  ru: {
    title: [[{ text: 'Какие темы ' }, { text: 'тебе', hl: true }], [{ text: 'интересны?' }]],
    items: {
      travel: { label: 'путешествия' },
      music: { label: 'музыка' },
      space: { label: 'космос' },
      cats: { label: 'котики' },
      crypto: { label: 'криптография' },
      science: { label: 'наука', caption: 'цифровые технологии' },
      food: { label: 'еда' },
      done: { label: 'готово' },
      back: { label: 'назад' },
    },
  },
};

export function isSceneLocale(v: unknown): v is SceneLocale {
  return v === 'en' || v === 'ru';
}
