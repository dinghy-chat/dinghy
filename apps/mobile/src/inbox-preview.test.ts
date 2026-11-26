import { expect, test } from "vitest";
import { inboxPreview } from "./inbox-preview.ts";
import type { Conversation } from "./types.ts";

const lastMessage = {
  body: "**Bonjour,**\n\nThe fix works now.",
  kind: "text",
  fromVisitor: false,
  createdAt: "2026-11-26T15:00:00Z",
} satisfies Conversation["lastMessage"];

test("the preview keeps the latest message's first line and joins the rest", () => {
  expect(inboxPreview(lastMessage)).toBe("Bonjour, The fix works now.");
});

test("the preview shows an attachment label when the latest message has no text", () => {
  expect(inboxPreview({ ...lastMessage, body: null, kind: "image" })).toBe("Attachment");
});

test("a conversation without a message has no preview", () => {
  expect(inboxPreview(null)).toBeNull();
});
