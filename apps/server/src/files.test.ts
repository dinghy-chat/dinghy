import { expect, test } from "vitest";
import { allowedFileName } from "./files.ts";

const text = Buffer.from("hello");

test("a long name keeps its extension within 100 characters", () => {
  const name = allowedFileName(`${"é".repeat(300)}.txt`, text);
  expect(name).toBe(`${"é".repeat(96)}.txt`);
  expect(Array.from(name ?? "")).toHaveLength(100);
});

test("a path, quotes and control characters are cleaned out of a name", () => {
  expect(allowedFileName('C:\\Users\\ada\\"notes"\n.txt', text)).toBe("C_Users_ada_notes_.txt");
  expect(allowedFileName("  ..notes.txt.. ", text)).toBe("notes.txt");
});

test("a name needs an allowed extension and something before it", () => {
  expect(allowedFileName(".txt", text)).toBeNull();
  expect(allowedFileName("notes", text)).toBeNull();
  expect(allowedFileName("notes.txt.exe", text)).toBeNull();
  expect(allowedFileName("notes.exe.txt", text)).toBe("notes.exe.txt");
});

test("a type with a signature needs it at the start, or at its place", () => {
  expect(allowedFileName("a.pdf", Buffer.from("%PDF-1.4"))).toBe("a.pdf");
  expect(allowedFileName("a.pdf", Buffer.from(" %PDF-1.4"))).toBeNull();
  expect(allowedFileName("a.mp4", Buffer.from("\x00\x00\x00\x20ftypmp42", "latin1"))).toBe("a.mp4");
  expect(allowedFileName("a.mp4", Buffer.from("ftypmp42"))).toBeNull();
});

test("a zip may be empty, or one part of a split archive", () => {
  expect(allowedFileName("a.zip", Buffer.from("PK\x05\x06\x00\x00", "latin1"))).toBe("a.zip");
  expect(allowedFileName("a.zip", Buffer.from("PK\x07\x08\x00\x00", "latin1"))).toBe("a.zip");
  expect(allowedFileName("a.zip", Buffer.from("PK\x01\x02\x00\x00", "latin1"))).toBeNull();
});
