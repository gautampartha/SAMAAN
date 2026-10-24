import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import hi from './hi.json';

export type Lang = 'en' | 'hi';
export const LANGS: readonly Lang[] = ['en', 'hi'] as const;
export const LANG_STORAGE_KEY = 'samaan.lang';

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    if (v === 'hi' || v === 'en') return v;
  } catch {
    /* storage unavailable (private mode, etc.) */
  }
  return 'en';
}

export function toLang(code: string | undefined): Lang {
  return code && code.toLowerCase().startsWith('hi') ? 'hi' : 'en';
}

function applyDocumentLang(code: string): void {
  document.documentElement.lang = toLang(code);
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    hi: { translation: hi },
  },
  lng: readStoredLang(),
  fallbackLng: 'en',
  supportedLngs: [...LANGS],
  interpolation: { escapeValue: false },
  returnNull: false,
});

applyDocumentLang(i18n.language);
i18n.on('languageChanged', (code) => {
  applyDocumentLang(code);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, toLang(code));
  } catch {
    /* ignore */
  }
});

export default i18n;
