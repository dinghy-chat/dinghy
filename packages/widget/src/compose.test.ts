import { expect, test } from "vitest";
import {
  acceptedFiles,
  fileExtension,
  fileSize,
  inCommitOrder,
  isComposing,
  newClientId,
  refusalProblem,
  uploadProblem,
} from "./compose.ts";

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

test("only PNG, JPEG and WebP images up to 5 MB are sent where files are off", () => {
  const file = (type: string, size: number) => new File([new Uint8Array(size)], "a", { type });
  expect(uploadProblem(file("image/png", 10), false)).toBeNull();
  expect(uploadProblem(file("image/webp", 5 * 1024 * 1024), false)).toBeNull();
  expect(uploadProblem(file("image/gif", 10), false)).toBe("imageWrongType");
  expect(uploadProblem(file("application/pdf", 10), false)).toBe("imageWrongType");
  expect(uploadProblem(file("image/jpeg", 5 * 1024 * 1024 + 1), false)).toBe("imageTooLarge");
});

test("other files go by their extension, up to 10 MB", () => {
  const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);
  expect(uploadProblem(file("Report.PDF"), true)).toBeNull();
  expect(uploadProblem(file("clip.mov", 10 * 1024 * 1024), true)).toBeNull();
  expect(uploadProblem(file("clip.mov", 10 * 1024 * 1024 + 1), true)).toBe("fileTooLarge");
  expect(uploadProblem(file("logo.svg"), true)).toBe("fileWrongType");
  expect(uploadProblem(file("pdf"), true)).toBe("fileWrongType");
  expect(fileExtension(".pdf")).toBeNull();
  expect(fileExtension("a.tar.ZIP")).toBe("zip");
  expect(acceptedFiles(false)).toBe("image/png,image/jpeg,image/webp");
  expect(acceptedFiles(true)).toContain(",.pdf,");
});

test("a file's size reads in KB under a megabyte, and in MB above", () => {
  expect(fileSize(10)).toBe("1 KB");
  expect(fileSize(340 * 1024)).toBe("340 KB");
  expect(fileSize(2.45 * 1024 * 1024)).toBe("2.5 MB");
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

test("a refused upload's text follows the server's error code", () => {
  const pdf = new File(["%PDF-"], "a.pdf", { type: "application/pdf" });
  const png = new File(["not a png"], "a.png", { type: "image/png" });
  expect(refusalProblem("too_large", pdf)).toBe("fileTooLarge");
  expect(refusalProblem("too_large", png)).toBe("imageTooLarge");
  expect(refusalProblem("type_not_allowed", pdf)).toBe("fileWrongType");
  // The widget's files were turned off after it loaded.
  expect(refusalProblem("not_an_image", pdf)).toBe("imageWrongType");
  expect(refusalProblem("type_not_allowed", png)).toBe("imageFailed");
  expect(refusalProblem("too_many_pixels", png)).toBe("imageFailed");
});
