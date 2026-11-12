/** @jsxImportSource react */
import type { ReplyReceipts } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { type TextId, t } from "./text.ts";
import type { Line } from "./thread-lines.ts";

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
 * The small line under a reply: a check and what happened to it. Under the last reply it always
 * shows. An earlier one shows beside its bubble while the pointer is on it, and screen readers
 * read it either way.
 */
export function ReceiptLine({ receipt, later }: { receipt: Receipt; later: boolean }) {
  const { text, icon } = RECEIPTS[receipt];
  return (
    <div className={`receipt ${receipt}${later ? " later" : ""}`}>
      <Icon name={icon} size={14} />
      {t(text)}
    </div>
  );
}

/** Why the visitor may have seen this reply, so it can no longer change, or null. */
export function seenReason(line: Line, receipts: ReplyReceipts | null): TextId | null {
  if (receipts === null || line.seq === null) return null;
  const receipt = receiptOf(line.seq, receipts);
  if (receipt === "read") return "messageAlreadyRead";
  return receipt === "emailed" ? "messageAlreadyEmailed" : null;
}
