import { describe, expect, test } from "vitest";
import { headerFaces } from "./panel.tsx";
import { type SavedAppearance, type TeamFace, WIDGET_DEFAULTS, withDefaults } from "./shared.ts";

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
