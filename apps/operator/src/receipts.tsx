/** @jsxImportSource react */
import type { ReplyReceipts } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { type TextId, t } from "./text.ts";
import type { Line } from "./thread-lines.ts";

/** A team reply that the visitor may have seen, so it has a receipt. Not a note, which they never see. */
export const hasReceipt = (line: Line): line is Line & { seq: bigint } =>
  !line.fromVisitor && line.seq !== null && (line.kind === "text" || line.kind === "image");

export type Receipt = "sent" | "emailed" | "emailFailed" | "read";

const RECEIPTS: Record<Receipt, { text: TextId; icon: IconName }> = {
  sent: { text: "receiptSent", icon: "checkThin" },
  emailed: { text: "receiptEmailed", icon: "checks" },
  emailFailed: { text: "receiptEmailFailed", icon: "warningCircle" },
  read: { text: "receiptRead", icon: "checks" },
};

/** How far the visitor has seen a stored reply at this position. */
export function receiptOf(seq: bigint, receipts: ReplyReceipts): Receipt {
  if (seq <= BigInt(receipts.readSeq)) return "read";
  const carried = receipts.emails.filter(
    (email) => BigInt(email.fromSeq) <= seq && seq <= BigInt(email.toSeq),
  );
  if (carried.some((email) => email.sent)) return "emailed";
  return carried.length > 0 ? "emailFailed" : "sent";
}

/**
 * The replies that show a receipt line, by message id: the last reply, the last one read in the
 * chat, and any whose email failed. The visitor reads in order, so the read line marks every reply
 * above it as read too. Each reply's Info gives its own times.
 */
export function shownReceipts(lines: Line[], receipts: ReplyReceipts | null): Map<string, Receipt> {
  const shown = new Map<string, Receipt>();
  if (receipts === null) return shown;
  let lastRead: string | null = null;
  let last: [string, Receipt] | null = null;
  for (const line of lines) {
    if (!hasReceipt(line)) continue;
    const receipt = receiptOf(line.seq, receipts);
    if (receipt === "emailFailed") shown.set(line.id, receipt);
    if (receipt === "read") lastRead = line.id;
    last = [line.id, receipt];
  }
  if (lastRead !== null) shown.set(lastRead, "read");
  if (last !== null) shown.set(...last);
  return shown;
}

/** The small line under a reply: a check and what happened to it. */
export function ReceiptLine({ receipt }: { receipt: Receipt }) {
  const { text, icon } = RECEIPTS[receipt];
  return (
    <div className={`receipt ${receipt}`}>
      <Icon name={icon} size={14} />
      {t(text)}
    </div>
  );
}

/** Why the visitor may have seen this reply, so it can no longer change, or null. */
export function seenReason(line: Line, receipts: ReplyReceipts | null): TextId | null {
  if (receipts === null || !hasReceipt(line)) return null;
  const receipt = receiptOf(line.seq, receipts);
  if (receipt === "read") return "messageAlreadyRead";
  return receipt === "emailed" ? "messageAlreadyEmailed" : null;
}
