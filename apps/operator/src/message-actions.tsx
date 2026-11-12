/** @jsxImportSource react */
import { useState } from "react";
import { plainText } from "../../../packages/widget/src/markdown.ts";
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
  text: plainText(line.body),
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

/** Who looks at the thread, and what they may do to its messages. */
export interface Rights {
  meId: string;
  mayDeleteAnyone: boolean;
  canWrite: boolean;
  canReply: boolean;
}

/** A line's menu, in its fixed order, without the items that do not apply. */
export function lineMenu(
  line: Line,
  who: Rights,
  receipts: ReplyReceipts | null,
  act: LineActions,
): MenuItem[] {
  if (line.seq === null || line.note !== undefined) return [];
  const item = (label: TextId, icon: IconName, onSelect: () => void): MenuItem => ({
    label: t(label),
    lead: <Icon name={icon} size={16} />,
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
  if ((isMine || who.mayDeleteAnyone) && who.canWrite) {
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

/**
 * Runs a change, and tells the operator when it fails, so a click never just does nothing. The
 * failure is `fallback` when the server gives no reason, and shows where `report` puts it. True when
 * the change worked.
 */
export type Act = (
  work: () => Promise<unknown>,
  options?: { fallback?: TextId; report?: (text: TextId) => void },
) => Promise<boolean>;

/** The line being edited, its text, and why its last save failed. */
interface Editing {
  id: string;
  draft: string;
  problem: TextId | null;
}

/**
 * The editor once `body` is saved for line `id`: closed, unless the operator typed on while it
 * saved, so the newer text stays open to save again.
 */
export const editorAfterSave = (current: Editing | null, id: string, body: string) =>
  current?.id === id && current.draft.trim() === body ? null : current;

/**
 * What the operator does to one message: quote it in the next reply, edit it, read its info, copy
 * it or delete it. `act` runs a change and reports its failure.
 */
export function useMessageActions({
  api,
  conversationId,
  act,
  keep,
}: {
  api: WorkspaceApi;
  conversationId: string;
  act: Act;
  keep(message: Message): void;
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
    const saved = await act(async () => keep(await api.editMessage(conversationId, id, body)), {
      report,
    });
    if (saved) setEditing((current) => editorAfterSave(current, id, body));
  };

  // Every quote of it changes too: the `message.deleted` event loads the whole thread again.
  const removeMessage = async (line: Line) => {
    setDeleting(null);
    await act(() => api.deleteMessage(conversationId, line.id), {
      fallback: "messageDeleteFailed",
    });
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

export type MessageActions = ReturnType<typeof useMessageActions>;
