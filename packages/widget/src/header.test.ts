import { afterEach, describe, expect, test } from "vitest";
import { backLine, headerFaces } from "./panel.tsx";
import { type SavedAppearance, type TeamFace, WIDGET_DEFAULTS, withDefaults } from "./shared.ts";
import { setLanguage } from "./text.ts";
import { es } from "./texts/es.ts";
import { fr } from "./texts/fr.ts";

const face = (id: string): TeamFace => ({ id, name: id, pictureUrl: null });
const maya = face("maya");
const sam = face("sam");
const ana = face("ana");
const lee = face("lee");
const ids = (faces: TeamFace[]) => faces.map((one) => one.id);

/** Sam and Maya replied last. Every member is a candidate for Online now. */
const saved = (change: Partial<SavedAppearance>): SavedAppearance => ({
  ...WIDGET_DEFAULTS,
  team: [sam, maya],
  faces: [sam, maya, ana, lee],
  ...change,
});
const repliers = (change: Partial<SavedAppearance>) =>
  saved({ headerFaces: "repliers", faces: [sam, maya], ...change });

describe("the header's faces", () => {
  test("Online now shows the members online, in order", () => {
    expect(ids(headerFaces(saved({}), ["lee", "maya"]))).toEqual(["maya", "lee"]);
  });

  test("Online now shows the latest repliers when nobody is online", () => {
    expect(ids(headerFaces(saved({}), []))).toEqual(["sam", "maya"]);
  });

  test("each mode keeps to the count", () => {
    const one = { headerFaceCount: 1 };
    expect(ids(headerFaces(saved(one), ["ana", "lee"]))).toEqual(["ana"]);
    expect(ids(headerFaces(repliers(one), []))).toEqual(["sam"]);
    expect(ids(headerFaces(saved({ ...one, headerFaces: "chosen" }), []))).toEqual(["sam"]);
  });

  test("Latest repliers and chosen members do not depend on who is online", () => {
    expect(ids(headerFaces(repliers({}), ["lee"]))).toEqual(["sam", "maya"]);
    const chosen = saved({ headerFaces: "chosen", faces: [ana, sam] });
    expect(ids(headerFaces(chosen, ["lee"]))).toEqual(["ana", "sam"]);
  });

  test("None shows nobody", () => {
    expect(headerFaces(saved({ headerFaces: "none", faces: [] }), ["maya"])).toEqual([]);
  });
});

test("an answer from before the header settings still shows a header", () => {
  const { headerFaces: _mode, headerFaceCount: _count, faces: _faces, ...old } = saved({});
  expect(ids(headerFaces(withDefaults(old), []))).toEqual(["sam", "maya"]);
});

describe("the line that says when the team is back", () => {
  afterEach(() => setLanguage("en", {}));
  // Monday 16 November 2026, 20:00 on the visitor's clock.
  const now = new Date(2026, 10, 16, 20, 0);
  const clean = (line: string) => line.replace(/\s/g, " ");

  test("says today, or the weekday within the coming week", () => {
    expect(clean(backLine(new Date(2026, 10, 16, 21, 0), now))).toBe("We're back today at 9:00 PM");
    expect(clean(backLine(new Date(2026, 10, 22, 9, 0), now))).toBe("We're back Sunday at 9:00 AM");
  });

  test("adds the date when the reopening is more than 6 days away, in each language", () => {
    const later = new Date(2026, 10, 23, 9, 0);
    expect(clean(backLine(later, now))).toBe("We're back Monday, November 23 at 9:00 AM");
    setLanguage("fr", fr);
    expect(clean(backLine(later, now))).toBe("De retour lundi 23 novembre à 9:00");
    setLanguage("es", es);
    expect(clean(backLine(later, now))).toBe("Volvemos el lunes, 23 de noviembre (9:00)");
  });
});
