import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// A text no code shows is dead weight, and the type checker cannot see it, because every key is
// valid. A key counts as used when its name appears in quotes, or after a dot, in the code that
// shows the texts. The operator app also shows keys that the widget's shared code returns.
const TEXTS = [
  {
    file: "apps/operator/src/text.ts",
    readers: ["apps/operator/src", "ee/operator", "packages/widget/src"],
  },
  { file: "packages/widget/src/text.ts", readers: ["packages/widget/src"] },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

test.each(TEXTS)("every key in $file is shown somewhere", ({ file, readers }) => {
  const keys = [...readFileSync(file, "utf8").matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map(
    (match) => match[1] ?? "",
  );
  const code = readers
    .flatMap(sourceFiles)
    .filter((path) => path !== file)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const unused = keys.filter((key) => !new RegExp(`["'\`.]${key}\\b|\\b${key}["'\`]`).test(code));
  expect(unused).toEqual([]);
});
