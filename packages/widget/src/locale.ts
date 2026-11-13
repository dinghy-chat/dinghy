import { LOCALES, type Locale, type WidgetSettings } from "./shared.ts";
import type { Texts } from "./text.ts";

/** The language a tag such as `fr-CA` names, when the widget speaks it. */
const spoken = (tag: string | undefined): Locale | undefined => {
  const primary = tag?.split("-")[0]?.toLowerCase();
  return LOCALES.find((locale) => locale === primary);
};

/**
 * The chat's language: the page's data-locale or configure() first, then a fixed saved language,
 * then for `visitor` the first of the browser's languages that the widget speaks, and English.
 */
export const pickLocale = (
  page: string | undefined,
  saved: WidgetSettings["language"],
  browser: readonly string[],
): Locale =>
  spoken(page) ??
  (saved === "visitor" ? browser.map(spoken).find((found) => found !== undefined) : saved) ??
  "en";

/**
 * A language's texts, from its file beside the chat bundle. English is in the bundle, and a file
 * that does not load leaves the chat in English.
 */
export const loadTexts = (base: string, locale: Locale): Promise<Partial<Texts>> =>
  locale === "en"
    ? Promise.resolve({})
    : fetch(`${base}${locale}.json`)
        .then((response) => (response.ok ? response.json() : {}))
        .catch(() => ({}));
