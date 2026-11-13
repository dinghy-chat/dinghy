import { afterEach, describe, expect, test } from "vitest";
import { pickLocale } from "./locale.ts";
import { setLanguage, type Texts, t } from "./text.ts";
import { es } from "./texts/es.ts";
import { fr } from "./texts/fr.ts";

afterEach(() => setLanguage("en", {}));

describe("the chat's language", () => {
  test("the page's data-locale or configure() wins over the saved language", () => {
    expect(pickLocale("es", "fr", ["fr-FR"])).toBe("es");
    expect(pickLocale("fr-CA", "visitor", ["es"])).toBe("fr");
  });

  test("a page language the widget does not speak is ignored", () => {
    expect(pickLocale("de", "fr", [])).toBe("fr");
    expect(pickLocale("", "visitor", ["es-MX"])).toBe("es");
  });

  test("a fixed language ignores the browser's", () => {
    expect(pickLocale(undefined, "en", ["fr-FR", "fr"])).toBe("en");
    expect(pickLocale(undefined, "fr", ["en-US"])).toBe("fr");
  });

  test("the visitor's language is the first of the browser's that the widget speaks", () => {
    expect(pickLocale(undefined, "visitor", ["de-DE", "es-ES", "fr"])).toBe("es");
    expect(pickLocale(undefined, "visitor", ["FR-be"])).toBe("fr");
  });

  test("with none of the browser's languages spoken, it is English", () => {
    expect(pickLocale(undefined, "visitor", ["de", "ja"])).toBe("en");
    expect(pickLocale(undefined, "visitor", [])).toBe("en");
  });
});

describe("the texts", () => {
  test("follow the language set", () => {
    setLanguage("fr", fr);
    expect(t("send")).toBe("Envoyer");
    setLanguage("es", es);
    expect(t("send")).toBe("Enviar");
  });

  test("a key the language's file lacks stays in English", () => {
    const { send: _send, ...withoutSend } = fr;
    setLanguage("fr", withoutSend);
    expect(t("send")).toBe("Send");
    expect(t("close")).toBe("Fermer le chat");
  });

  test.each([
    ["French", fr],
    ["Spanish", es],
  ])("%s keeps every placeholder of the English", (_name, texts: Texts) => {
    const placeholders = (text: string) => text.match(/\{\w+\}/g)?.sort() ?? [];
    setLanguage("en", {});
    for (const [id, text] of Object.entries(texts) as [keyof Texts, string][]) {
      expect(placeholders(text), id).toEqual(placeholders(t(id)));
    }
  });
});
