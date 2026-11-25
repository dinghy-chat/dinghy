import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLinkPreviews, type LinkPreview } from "./link-preview.ts";

const card = (url: string): LinkPreview => ({ url, title: url, image: null, token: "t" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function follow() {
  const asked: string[] = [];
  const shown: (string | null)[] = [];
  const answers = new Map<string, (found: LinkPreview | null) => void>();
  const previews = createLinkPreviews(
    (url) => {
      asked.push(url);
      return new Promise((resolve) => answers.set(url, resolve));
    },
    (found) => shown.push(found?.url ?? null),
  );
  return { previews, asked, shown, answers };
}

test("typing asks after a 500 ms pause, and a paste asks at once", async () => {
  const { previews, asked } = follow();
  previews.update("See https://a.example", true);
  previews.update("See https://a.example/", true);
  await vi.advanceTimersByTimeAsync(499);
  expect(asked).toEqual([]);
  previews.update("See https://a.example/x", true);
  await vi.advanceTimersByTimeAsync(500);
  expect(asked).toEqual(["https://a.example/x"]);
  previews.update("See https://a.example/x and https://b.example", true);
  previews.update("", true);
  previews.update("https://b.example/pasted", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(asked).toEqual(["https://a.example/x", "https://b.example/pasted"]);
});

test("an answer for a link that left the draft is dropped", async () => {
  const { previews, shown, answers } = follow();
  previews.update("https://a.example", true);
  await vi.advanceTimersByTimeAsync(0);
  previews.update("No link now", true);
  answers.get("https://a.example")?.(card("https://a.example"));
  await vi.advanceTimersByTimeAsync(0);
  expect(shown.filter((url) => url !== null)).toEqual([]);
});

test("a removed card stays removed in that draft, and a new draft starts over", async () => {
  const { previews, asked, shown, answers } = follow();
  previews.update("https://a.example", true);
  await vi.advanceTimersByTimeAsync(0);
  answers.get("https://a.example")?.(card("https://a.example"));
  await vi.advanceTimersByTimeAsync(0);
  expect(shown.at(-1)).toBe("https://a.example");
  previews.remove();
  expect(shown.at(-1)).toBeNull();
  previews.update("Thanks", true);
  previews.update("https://a.example again", true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(asked).toEqual(["https://a.example"]);
  previews.update("", true);
  previews.update("https://a.example", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(asked).toEqual(["https://a.example", "https://a.example"]);
});

test("a note in between keeps a removed card removed", async () => {
  const { previews, asked, answers } = follow();
  previews.update("https://a.example", true);
  await vi.advanceTimersByTimeAsync(0);
  answers.get("https://a.example")?.(card("https://a.example"));
  previews.remove();
  previews.update("https://a.example", false);
  previews.update("https://a.example", true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(asked).toEqual(["https://a.example"]);
});

test("only the latest request's answer shows", async () => {
  const asked: ((found: LinkPreview | null) => void)[] = [];
  const shown: (string | null)[] = [];
  const previews = createLinkPreviews(
    () => new Promise((resolve) => asked.push(resolve)),
    (found) => shown.push(found?.title ?? null),
  );
  previews.update("https://a.example", true);
  await vi.advanceTimersByTimeAsync(0);
  previews.update("https://a.example", false);
  previews.update("https://a.example", true);
  await vi.advanceTimersByTimeAsync(500);
  expect(asked).toHaveLength(2);
  asked[1]?.({ ...card("https://a.example"), title: "New" });
  await vi.advanceTimersByTimeAsync(0);
  asked[0]?.({ ...card("https://a.example"), title: "Old" });
  await vi.advanceTimersByTimeAsync(0);
  expect(shown.at(-1)).toBe("New");
});
