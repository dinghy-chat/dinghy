import { expect, test } from "vitest";
import { imageProblem, inCommitOrder, isComposing, newClientId } from "./compose.ts";

test("a client ID is 32 hex characters, new each time", () => {
  const first = newClientId();
  expect(first).toMatch(/^[0-9a-f]{32}$/);
  expect(newClientId()).not.toBe(first);
});

test("Enter during an IME composition, or Safari's keyCode 229 after it, does not send", () => {
  // Tests run in Node, which has no KeyboardEvent; the check reads only these two fields.
  const key = (isComposing: boolean, keyCode: number) =>
    ({ isComposing, keyCode }) as KeyboardEvent;
  expect(isComposing(key(true, 13))).toBe(true);
  expect(isComposing(key(false, 229))).toBe(true);
  expect(isComposing(key(false, 13))).toBe(false);
});

test("only PNG, JPEG and WebP files up to 5 MB are sent", () => {
  const file = (type: string, size: number) => new File([new Uint8Array(size)], "a", { type });
  expect(imageProblem(file("image/png", 10))).toBeNull();
  expect(imageProblem(file("image/webp", 5 * 1024 * 1024))).toBeNull();
  expect(imageProblem(file("image/gif", 10))).toBe("imageWrongType");
  expect(imageProblem(file("image/jpeg", 5 * 1024 * 1024 + 1))).toBe("imageTooLarge");
});

test("a confirmed line goes in commit order, before the pending ones", () => {
  const line = (id: string, seq: bigint | null) => ({ id, seq });
  expect(
    inCommitOrder([line("a", 1n), line("c", 3n), line("pending", null)], line("b", 2n)).map(
      (one) => one.id,
    ),
  ).toEqual(["a", "b", "c", "pending"]);
});

test("a replay in order, and a late line, both end in commit order", () => {
  const line = (id: string, seq: bigint | null) => ({ id, seq });
  let lines = [line("pending", null)];
  for (let seq = 1n; seq <= 2000n; seq++) lines = inCommitOrder(lines, line(`m${seq}`, seq));
  lines = inCommitOrder(lines, line("first", 0n));
  expect(lines.map((one) => one.id)).toEqual([
    "first",
    ...Array.from({ length: 2000 }, (_, index) => `m${index + 1}`),
    "pending",
  ]);
});
