import {
  DEFAULT_LOCALE,
  normalizeAppLocale,
  type AppLocale,
} from '../shared/types';
import en from './notify/en.json';
import hi from './notify/hi.json';
import pa from './notify/pa.json';

type NotifyCatalog = Record<string, string>;

const catalogs: Record<AppLocale, NotifyCatalog> = {
  en: en as NotifyCatalog,
  hi: hi as NotifyCatalog,
  pa: pa as NotifyCatalog,
};

export function tNotify(
  locale: string | null | undefined,
  key: string,
  vars?: Record<string, string | number | null | undefined>,
): string {
  const lang = normalizeAppLocale(locale);
  const template = catalogs[lang]?.[key] ?? catalogs[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    return value == null ? '' : String(value);
  });
}

export function resolveNotifyLocale(locale: string | null | undefined): AppLocale {
  return normalizeAppLocale(locale);
}
