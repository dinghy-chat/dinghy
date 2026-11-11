/** @jsxImportSource react */
import { useState } from "react";
import { quoteExcerpt } from "../../../packages/widget/src/markdown.ts";
import type { Message, Quote, ReplyReceipts, WorkspaceApi } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import type { MenuItem } from "./popup.tsx";
import { seenReason } from "./receipts.tsx";
import { type TextId, t } from "./text.ts";
import type { Line } from "./thread-lines.ts";
import { toast } from "./toast.tsx";

/** The quote a reply to this line carries, as the server will show it. */
export const quoteOf = (line: Line, author: string): Quote => ({
  id: line.id,
  authorName: line.fromVisitor ? null : author,
  fromVisitor: line.fromVisitor,
  excerpt: quoteExcerpt(line.body),
  hasImage: line.image !== null,
});

interface LineActions {
  reply(): void;
  copyText(): void;
  edit(): void;
  info(): void;
  copyLink(): void;
  remove(): void;
}

/** A line's menu, in its fixed order, without the items that do not apply. */
export function lineMenu(
  line: Line,
  who: { meId: string; mayDeleteAny: boolean; canWrite: boolean; canReply: boolean },
  receipts: ReplyReceipts | null,
  act: LineActions,
): MenuItem[] {
  if (line.seq === null || line.note !== undefined) return [];
  const item = (label: TextId, icon: IconName, onSelect: () => void): MenuItem => ({
    label: t(label),
    lead: <Icon name={icon} size={18} />,
    onSelect,
  });
  const info = item("messageInfo", "info", act.info);
  if (line.deleted) return [info];
  const isText = line.image === null && !line.imageRemoved && line.body !== "";
  const isMine = line.authorOperatorId === who.meId;
  const items: MenuItem[] = [];
  if (who.canReply) items.push(item("messageReply", "reply", act.reply));
  if (isText) items.push(item("messageCopyText", "copy", act.copyText));
  if (isMine && isText && who.canWrite) {
    const seen = seenReason(line, receipts);
    items.push({
      ...item("messageEdit", "pencil", act.edit),
      ...(seen !== null && { unavailable: t(seen) }),
    });
  }
  items.push(info, item("messageCopyLink", "link", act.copyLink));
  if ((isMine || who.mayDeleteAny) && who.canWrite) {
    items.push({ ...item("messageDelete", "trash", act.remove), danger: true, divider: true });
  }
  return items;
}

/** Copies text, and says so. A browser that refuses says nothing, as the copy did not happen. */
const copy = (text: string, done: TextId) =>
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast(done))
    .catch(() => {});

/** The line being edited, its text, and why its last save failed. */
interface Editing {
  id: string;
  draft: string;
  problem: TextId | null;
}

/**
 * What the operator does to one message: quote it in the next reply, edit it, read its info, copy
 * it or delete it. `act` runs a change and reports its failure.
 */
export function useMessageActions({
  api,
  conversationId,
  act,
  keep,
  reloadAll,
  onChanged,
}: {
  api: WorkspaceApi;
  conversationId: string;
  act(
    work: () => Promise<unknown>,
    fallback?: TextId,
    report?: (text: TextId) => void,
  ): Promise<boolean>;
  keep(message: Message): void;
  reloadAll(): void;
  onChanged(): void;
}) {
  // The message the next reply quotes, the reply being edited, and the dialogs about one message.
  const [quoting, setQuoting] = useState<Line | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [info, setInfo] = useState<Line | null>(null);
  const [deleting, setDeleting] = useState<Line | null>(null);

  /** Saves an edit. The editor and its text stay until it is saved, and a failure shows in it. */
  const saveEdit = async (id: string, body: string) => {
    const report = (problem: TextId) =>
      setEditing((current) => (current?.id === id ? { ...current, problem } : current));
    const saved = await act(
      async () => keep(await api.editMessage(conversationId, id, body)),
      "actionFailed",
      report,
    );
    if (saved) setEditing((current) => (current?.id === id ? null : current));
  };

  const removeMessage = async (line: Line) => {
    setDeleting(null);
    if (!(await act(() => api.deleteMessage(conversationId, line.id), "messageDeleteFailed"))) {
      return;
    }
    // Every quote of it changes too, so the whole thread loads again.
    reloadAll();
    onChanged();
  };

  const actionsFor = (line: Line): LineActions => ({
    reply: () => {
      setEditing(null);
      setQuoting(line);
    },
    copyText: () => void copy(line.body, "copied"),
    edit: () => {
      setQuoting(null);
      setEditing({ id: line.id, draft: line.body, problem: null });
    },
    info: () => setInfo(line),
    copyLink: () => {
      const url = new URL("/", location.origin);
      url.searchParams.set("workspace", api.workspaceId);
      url.searchParams.set("conversation", conversationId);
      url.hash = `message-${line.id}`;
      void copy(url.href, "linkCopied");
    },
    remove: () => setDeleting(line),
  });

  return {
    quoting,
    setQuoting,
    editing,
    setEditing,
    info,
    setInfo,
    deleting,
    setDeleting,
    saveEdit,
    removeMessage,
    actionsFor,
  };
}
