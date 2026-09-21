import { es } from './es';
import { en } from './en';

export type MsgKey = keyof typeof es;
export type Lang = 'es' | 'en';

const dict: Record<Lang, Record<MsgKey, string>> = { es, en };

let current: Lang = 'es';

export function setLanguage(l: Lang) {
  current = l;
  document.documentElement.lang = l;
}

export function getLanguage(): Lang {
  return current;
}

export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = dict[current][key] ?? dict.es[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function detectLanguage(): Lang {
  const nav = (navigator.language || 'es').toLowerCase();
  return nav.startsWith('es') ? 'es' : 'en';
}
