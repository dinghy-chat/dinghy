import { markdownText } from "../../../packages/widget/src/markdown.ts";
import { t } from "../../operator/src/text.ts";
import type { Conversation } from "./types";

export function inboxPreview(message: Conversation["lastMessage"]): string | null {
  if (message === null) return null;
  const text = markdownText(message.body ?? "");
  return text || (message.kind === "text" ? null : t("mobileAttachment"));
}
