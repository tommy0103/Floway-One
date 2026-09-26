export const defaultLanguage = 'en';

export const supportedLanguages = ['en', 'zh-Hans'] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];

export type LanguagePreference = SupportedLanguage | 'system';

const LANGUAGE_PREFERENCE_KEY = 'floway.language';

// The supported language keys are BCP-47 tags in their own right, so the
// document language is the language; a locale is separate because number and
// date formatting needs a region the tag does not carry.
const languageLocales: Record<SupportedLanguage, string> = {
  'en': 'en-US',
  'zh-Hans': 'zh-CN',
};

// A Traditional reader gets more out of Simplified Chinese than out of English.
export const normalizeLanguage = (value: string | null | undefined): SupportedLanguage | null => {
  if (!value) return null;

  const language = value.trim().replaceAll('_', '-').toLowerCase();
  if (language === 'en' || language.startsWith('en-')) return 'en';
  if (language === 'zh' || language.startsWith('zh-')) return 'zh-Hans';

  return null;
};

// The prerender renders one index.html for every visitor and has no navigator
// to ask, so it answers with the default language.
export const browserLanguage = (): SupportedLanguage =>
  (typeof window === 'undefined' ? null : normalizeLanguage(window.navigator.language)) ?? defaultLanguage;

export const languagePreference = (): LanguagePreference => {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(LANGUAGE_PREFERENCE_KEY);
    return stored === 'en' || stored === 'zh-Hans' ? stored : 'system';
  } catch {
    // Browser storage may be disabled; the app can still follow the system.
    return 'system';
  }
};

export const selectedLanguage = (): SupportedLanguage => {
  const preference = languagePreference();
  return preference === 'system' ? browserLanguage() : preference;
};

export const saveLanguagePreference = (preference: LanguagePreference): void => {
  if (preference === 'system') window.localStorage.removeItem(LANGUAGE_PREFERENCE_KEY);
  else window.localStorage.setItem(LANGUAGE_PREFERENCE_KEY, preference);
};

export const localeForLanguage = (language: string | null | undefined): string => {
  const normalized = normalizeLanguage(language) ?? defaultLanguage;
  return languageLocales[normalized];
};

export const htmlLanguageFor = (language: string | null | undefined): SupportedLanguage =>
  normalizeLanguage(language) ?? defaultLanguage;
