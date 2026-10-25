import React from 'react';
import ReactDOM from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import 'maplibre-gl/dist/maplibre-gl.css';
import en from './admin-en.json';
import hi from './admin-hi.json';
import './admin.css';
import AdminApp from './AdminApp';

const LANG_KEY = 'samaan.lang';
function storedLang(): 'en' | 'hi' {
  try {
    return localStorage.getItem(LANG_KEY) === 'hi' ? 'hi' : 'en';
  } catch {
    return 'en';
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi } },
  lng: storedLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});
document.documentElement.lang = i18n.language;
i18n.on('languageChanged', (l) => {
  document.documentElement.lang = l;
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* ignore */
  }
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>,
);
