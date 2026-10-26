/**
 * locale.ts — the window in Chinese or English.
 *
 * 2.x borrowed dsh's locale service (`ctx.locale`) and keyed every string
 * (`panel.tab.teams`). 3 has no dsh, so it keys by the CHINESE TEXT ITSELF:
 * Chinese is the language the product is written in, it is what shows when a
 * translation is missing, and a component reads as the screen it draws rather
 * than as a list of keys. English lives in `locales.ts`, one entry per
 * Chinese template.
 *
 * The language is read at call time from a module-level value. A switch
 * re-mounts the window (App keys its tree on the language), so nothing needs
 * to subscribe.
 *
 * What is NOT translated: sentences that come from the main process (a
 * refusal's own words) and what the seats said. Those are the record.
 */
import { EN } from "./locales.ts";

export type Language = "zh" | "en";

/** The language the system asks for, when the person chose none. */
export function systemLanguage(): Language {
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Language = "zh";

export function setLanguage(language: Language): void {
  current = language;
}

export function language(): Language {
  return current;
}

/**
 * Translate one Chinese template. `{name}` placeholders are filled from
 * `params` in either language; a template with no English entry shows in
 * Chinese rather than as a key.
 */
export function t(zh: string, params?: Readonly<Record<string, string | number>>): string {
  const template = current === "en" ? (EN[zh] ?? zh) : zh;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
