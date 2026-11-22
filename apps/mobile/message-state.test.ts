import { expect, test } from "vitest";
import { canDeleteMessage, editAvailability, receiptOf, shownReceipts } from "./src/message-state";
import type { Message, ReplyReceipts } from "./src/types";

const receipts: ReplyReceipts = {
  readSeq: "2",
  emails: [
    { fromSeq: "3", toSeq: "4", sent: true },
    { fromSeq: "5", toSeq: "5", sent: false },
  ],
  notEmailed: ["4"],
};

function message(id: string, seq: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: "conversation",
    seq,
    kind: "text",
    fromVisitor: false,
    authorOperatorId: "ana",
    authorApiKeyId: null,
    authorName: "Ana",
    clientId: id,
    body: id,
    attachment: null,
    replyTo: null,
    editedAt: null,
    readAt: null,
    mentions: [],
    createdAt: "2026-11-19T10:00:00.000Z",
    deleted: false,
    via: null,
    ...extra,
  };
}

test("receipt state matches the web receipt ranges", () => {
  expect(receiptOf("2", receipts)).toBe("read");
  expect(receiptOf("3", receipts)).toBe("emailed");
  expect(receiptOf("4", receipts)).toBe("sent");
  expect(receiptOf("5", receipts)).toBe("emailFailed");
  expect(receiptOf("6", receipts)).toBe("sent");
});

test("the log shows the same compact receipt subset as the web app", () => {
  expect([...shownReceipts([message("read", "2"), message("emailed", "3")], receipts)]).toEqual([
    ["read", "read"],
    ["emailed", "emailed"],
  ]);
  expect([...shownReceipts([message("failed", "5"), message("sent", "6")], receipts)]).toEqual([
    ["failed", "emailFailed"],
    ["sent", "sent"],
  ]);
});

test("only an unseen reply by this operator can be edited", () => {
  expect(editAvailability(message("mine", "6"), "ana", receipts, true)).toBe("available");
  expect(editAvailability(message("read", "2"), "ana", receipts, true)).toBe("read");
  expect(editAvailability(message("email", "3"), "ana", receipts, true)).toBe("emailed");
  expect(editAvailability(message("other", "6"), "jo", receipts, true)).toBe("unavailable");
  expect(editAvailability(message("note", "2", { kind: "note" }), "ana", receipts, true)).toBe(
    "available",
  );
});

test("admins can delete any message and members can delete their own", () => {
  const visitor = message("visitor", "1", { fromVisitor: true, authorOperatorId: null });
  expect(canDeleteMessage(visitor, "ana", true, false)).toBe(false);
  expect(canDeleteMessage(visitor, "ana", true, true)).toBe(true);
  expect(canDeleteMessage(message("mine", "2"), "ana", true, false)).toBe(true);
  expect(canDeleteMessage(message("readonly", "2"), "ana", false, true)).toBe(false);
});
