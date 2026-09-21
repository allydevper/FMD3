import { useEffect, useState } from "react";
import { en } from "./en";
import { es } from "./es";

export type AppLanguage = "en" | "es";

export const LANG_KEY = "fmd-lang";

type Listener = () => void;

const listeners = new Set<Listener>();

let currentLang: AppLanguage = readStoredLanguage();

function readStoredLanguage(): AppLanguage {
  if (typeof localStorage === "undefined") return "es";
  try {
    return parseLanguage(localStorage.getItem(LANG_KEY));
  } catch {
    return "es";
  }
}

export function parseLanguage(raw: string | null | undefined): AppLanguage {
  const v = (raw || "").trim().toLowerCase();
  if (v === "en" || v === "english" || v.startsWith("en-") || v.startsWith("en_")) return "en";
  return "es";
}

export function getLanguage(): AppLanguage {
  return currentLang;
}

export function localeTag(lang: AppLanguage = currentLang): string {
  return lang === "en" ? "en-US" : "es-ES";
}

export function setCurrentLanguage(lang: AppLanguage): void {
  if (currentLang === lang) {
    applyHtmlLang(lang);
    return;
  }
  currentLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* ignore quota / private mode */
  }
  applyHtmlLang(lang);
  for (const fn of listeners) fn();
}

function applyHtmlLang(lang: AppLanguage): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
  }
}

applyHtmlLang(currentLang);

function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] == null ? `{${k}}` : String(vars[k]),
  );
}

/** Translate `key` using the active language. Falls back to Spanish, then the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const primary = currentLang === "en" ? en : es;
  let raw = getByPath(primary, key);
  if (typeof raw !== "string") raw = getByPath(es, key);
  if (typeof raw !== "string") return interpolate(key, vars);
  return interpolate(raw, vars);
}

export function tPlural(
  key: string,
  n: number,
  vars?: Record<string, string | number>,
): string {
  const suffix = n === 1 ? "one" : "other";
  return t(`${key}.${suffix}`, { n, ...vars });
}

/** Subscribe so a component re-renders when the language changes. */
export function useLanguage(): AppLanguage {
  const [lang, setLang] = useState(currentLang);
  useEffect(() => {
    const onChange = () => setLang(currentLang);
    listeners.add(onChange);
    if (lang !== currentLang) setLang(currentLang);
    return () => {
      listeners.delete(onChange);
    };
  }, [lang]);
  return lang;
}

export function genreLabel(id: string): string {
  const fromDict = t(`genres.${id}`);
  return fromDict === `genres.${id}` ? id : fromDict;
}

export function formatMb(bytes: number): string {
  if (bytes <= 0) return t("units.zeroMb");
  const mb = bytes / (1024 * 1024);
  const loc = localeTag();
  if (mb < 0.1) return t("units.mbLessThan", { n: (0.1).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  return `${mb.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${t("units.mb")}`;
}
