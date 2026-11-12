import { expect, test } from "vitest";
import { quoteOfReply } from "./quote.ts";

test("a quoted reply shows plain words at once, never its Markdown", () => {
  const body = `**Thanks!** See [the docs](https://example.com) and \`npm i\`.\n- one\n${"x".repeat(200)}`;
  const quote = quoteOfReply({ id: "r1", body, author: { name: "Ana" } });
  expect(quote).toMatchObject({ id: "r1", authorName: "Ana", fromVisitor: false, hasImage: false });
  expect(quote.text).toBe(`Thanks! See the docs and npm i.\none\n${"x".repeat(200)}`);
});
