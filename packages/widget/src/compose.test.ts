import { afterEach, expect, test, vi } from "vitest";
import {
  acceptedFiles,
  fileExtension,
  fileSize,
  inCommitOrder,
  isComposing,
  newClientId,
  refusalProblem,
  saveWithRefresh,
  uploadProblem,
  urlWaiter,
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

test("a file's size reads in kB under a megabyte, and in MB above, in the reader's language", () => {
  expect(fileSize(10, "en")).toBe("1 kB");
  expect(fileSize(340 * 1024, "en")).toBe("340 kB");
  expect(fileSize(2.45 * 1024 * 1024, "en")).toBe("2.5 MB");
  expect(fileSize(2 * 1024 * 1024, "en")).toBe("2.0 MB");
  expect(fileSize(340 * 1024, "fr")).toBe("340\u202fko");
  expect(fileSize(2.45 * 1024 * 1024, "fr")).toBe("2,5\u202fMo");
  expect(fileSize(2.45 * 1024 * 1024, "es")).toBe("2,5 MB");
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

/** Answers each URL with its status, and records the URLs fetched and the names saved. */
function fakeFiles(statuses: Record<string, number>, whileFetching = (_url: string) => {}) {
  const fetched: string[] = [];
  const saved: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    whileFetching(url);
    return new Response("file", { status: statuses[url] ?? 500 });
  });
  vi.stubGlobal("document", {
    createElement: () => ({
      click(this: { download: string }) {
        saved.push(this.download);
      },
    }),
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:file");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { fetched, saved };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a file saves from its URL without asking for a new one", async () => {
  const files = fakeFiles({ "/old": 200 });
  const newUrl = vi.fn(async () => "/new");
  await saveWithRefresh("/old", "a.pdf", newUrl);
  expect(files.saved).toEqual(["a.pdf"]);
  expect(newUrl).not.toHaveBeenCalled();
});

test("an expired URL asks once for a new one and saves with it", async () => {
  const files = fakeFiles({ "/old": 404, "/new": 200 });
  await saveWithRefresh("/old", "a.pdf", async () => "/new");
  expect(files.fetched).toEqual(["/old", "/new"]);
  expect(files.saved).toEqual(["a.pdf"]);
});

test("a second expired URL ends the click", async () => {
  const files = fakeFiles({ "/old": 404, "/new": 404 });
  const newUrl = vi.fn(async () => "/new");
  await saveWithRefresh("/old", "a.pdf", newUrl);
  expect(newUrl).toHaveBeenCalledOnce();
  expect(files.saved).toEqual([]);
});

test("any other failure ends the click without a new URL", async () => {
  const files = fakeFiles({ "/old": 500 });
  const newUrl = vi.fn(async () => "/new");
  await saveWithRefresh("/old", "a.pdf", newUrl);
  expect(newUrl).not.toHaveBeenCalled();
  expect(files.saved).toEqual([]);
});

test("a waiter answers the next URL offered, after asking for it", async () => {
  const urls = urlWaiter();
  urls.offer("/old");
  const askForUrls = vi.fn();
  const next = urls.wait("/old", askForUrls);
  expect(askForUrls).toHaveBeenCalledOnce();
  urls.offer("/new");
  expect(await next).toBe("/new");
});

test("a URL that changed during the failed fetch saves without waiting for another", async () => {
  const urls = urlWaiter();
  urls.offer("/old");
  // Another file's refresh brings new URLs before this file's 404 arrives.
  const files = fakeFiles({ "/old": 404, "/new": 200 }, (url) => {
    if (url === "/old") urls.offer("/new");
  });
  const askForUrls = vi.fn();
  await saveWithRefresh("/old", "a.pdf", () => urls.wait("/old", askForUrls));
  expect(askForUrls).not.toHaveBeenCalled();
  expect(files.fetched).toEqual(["/old", "/new"]);
  expect(files.saved).toEqual(["a.pdf"]);
});
