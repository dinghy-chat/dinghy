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
  previews.update("See https://a.example");
  previews.update("See https://a.example/");
  await vi.advanceTimersByTimeAsync(499);
  expect(asked).toEqual([]);
  previews.update("See https://a.example/x");
  await vi.advanceTimersByTimeAsync(500);
  expect(asked).toEqual(["https://a.example/x"]);
  previews.update("See https://a.example/x and https://b.example");
  previews.update("");
  previews.update("https://b.example/pasted");
  await vi.advanceTimersByTimeAsync(0);
  expect(asked).toEqual(["https://a.example/x", "https://b.example/pasted"]);
});

test("an answer for a link that left the draft is dropped", async () => {
  const { previews, shown, answers } = follow();
  previews.update("https://a.example");
  await vi.advanceTimersByTimeAsync(0);
  previews.update("No link now");
  answers.get("https://a.example")?.(card("https://a.example"));
  await vi.advanceTimersByTimeAsync(0);
  expect(shown.filter((url) => url !== null)).toEqual([]);
});

test("a removed card stays removed in that draft, and a new draft starts over", async () => {
  const { previews, asked, shown, answers } = follow();
  previews.update("https://a.example");
  await vi.advanceTimersByTimeAsync(0);
  answers.get("https://a.example")?.(card("https://a.example"));
  await vi.advanceTimersByTimeAsync(0);
  expect(shown.at(-1)).toBe("https://a.example");
  previews.remove();
  expect(shown.at(-1)).toBeNull();
  previews.update("Thanks");
  previews.update("https://a.example again");
  await vi.advanceTimersByTimeAsync(1000);
  expect(asked).toEqual(["https://a.example"]);
  previews.update("");
  previews.update("https://a.example");
  await vi.advanceTimersByTimeAsync(0);
  expect(asked).toEqual(["https://a.example", "https://a.example"]);
});
