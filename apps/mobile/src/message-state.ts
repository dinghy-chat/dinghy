import type { Message, ReplyReceipts } from "./types";

export type ReceiptState = "sent" | "emailed" | "emailFailed" | "read";

export function hasReceipt(message: Message): boolean {
  return (
    !message.fromVisitor &&
    message.kind !== "note" &&
    message.kind !== "closed" &&
    message.kind !== "reopened"
  );
}

export function receiptOf(seq: string, receipts: ReplyReceipts): ReceiptState {
  const position = BigInt(seq);
  if (position <= BigInt(receipts.readSeq)) return "read";
  if (receipts.notEmailed.includes(seq)) return "sent";
  const carried = receipts.emails.filter(
    (email) => BigInt(email.fromSeq) <= position && position <= BigInt(email.toSeq),
  );
  if (carried.some((email) => email.sent)) return "emailed";
  return carried.length > 0 ? "emailFailed" : "sent";
}

export function shownReceipts(
  messages: Message[],
  receipts: ReplyReceipts | null,
): Map<string, ReceiptState> {
  const shown = new Map<string, ReceiptState>();
  if (receipts === null) return shown;
  let lastRead: string | null = null;
  let last: [string, ReceiptState] | null = null;
  for (const message of messages) {
    if (!hasReceipt(message)) continue;
    const receipt = receiptOf(message.seq, receipts);
    if (receipt === "emailFailed") shown.set(message.id, receipt);
    if (receipt === "read") lastRead = message.id;
    last = [message.id, receipt];
  }
  if (lastRead !== null) shown.set(lastRead, "read");
  if (last !== null) shown.set(...last);
  return shown;
}

export type EditAvailability = "available" | "read" | "emailed" | "unavailable";

export function editAvailability(
  message: Message,
  meId: string,
  receipts: ReplyReceipts | null,
  canWrite: boolean,
): EditAvailability {
  const isText = message.kind === "text" || message.kind === "note";
  if (!canWrite || message.authorOperatorId !== meId || !isText || message.deleted) {
    return "unavailable";
  }
  if (message.kind === "note" || receipts === null) return "available";
  const receipt = receiptOf(message.seq, receipts);
  if (receipt === "read") return "read";
  if (receipt === "emailed") return "emailed";
  return "available";
}

export function canDeleteMessage(
  message: Message,
  meId: string,
  canWrite: boolean,
  mayDeleteAnyone: boolean,
): boolean {
  return !message.deleted && canWrite && (message.authorOperatorId === meId || mayDeleteAnyone);
}
