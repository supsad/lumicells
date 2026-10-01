/**
 * A tiny i18n layer for the stand and its UI kit: two static dictionaries, a context and hooks.
 * English is the default, so UI kit components rendered without a provider (the UI kit preview
 * page) read English. Schema texts (labels, descriptions, units, enum and preset names) come from
 * lumicells/schema, which carries English itself and a Russian table.
 */

import {
  isLocale,
  type Locale,
  localizedEnumLabel,
  localizedPreset,
  localizedText,
  type PresetId,
} from 'lumicells/schema';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { en, type Messages } from './en';
import { ru } from './ru';

export type { Locale } from 'lumicells/schema';
export type { Messages } from './en';

export const MESSAGES: Record<Locale, Messages> = { en, ru };

/** Switcher captions (the tooltip names come from the dictionaries: `meta.localeNames`). */
export const LOCALE_NAMES: Record<Locale, { short: string }> = {
  en: { short: 'EN' },
  ru: { short: 'RU' },
};

interface I18nValue {
  locale: Locale;
  t: Messages;
  setLocale(locale: Locale): void;
}

const I18nContext = createContext<I18nValue>({ locale: 'en', t: en, setLocale: () => {} });

export function I18nProvider({
  locale,
  setLocale,
  children,
}: {
  locale: Locale;
  setLocale(locale: Locale): void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale, t: MESSAGES[locale], setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** The message dictionary of the current locale. */
export function useT(): Messages {
  return useContext(I18nContext).t;
}

/** `?lang=ru|en` in the page URL, if present and valid. */
export function localeFromUrl(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = new URLSearchParams(window.location.search).get('lang');
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

/** Keeps an explicit `?lang=` in the address bar in step with the switcher (no reload). */
export function syncUrlLocale(locale: Locale): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('lang')) return;
    url.searchParams.set('lang', locale);
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // ignore: the URL is only a convenience
  }
}

/** Localized schema texts for the current locale. */
export interface SchemaText {
  locale: Locale;
  label(path: string): string;
  description(path: string): string | undefined;
  unit(path: string): string | undefined;
  enumLabel(path: string, value: string): string;
  preset(id: PresetId): { label: string; description: string };
}

function schemaText(locale: Locale): SchemaText {
  return {
    locale,
    label: (path) => localizedText(path, locale)?.label ?? path,
    description: (path) => localizedText(path, locale)?.description,
    unit: (path) => localizedText(path, locale)?.unit,
    enumLabel: (path, value) => localizedEnumLabel(path, value, locale),
    preset: (id) => localizedPreset(id, locale),
  };
}

const SCHEMA_TEXT: Record<Locale, SchemaText> = { en: schemaText('en'), ru: schemaText('ru') };

export function useSchemaText(): SchemaText {
  return SCHEMA_TEXT[useContext(I18nContext).locale];
}
