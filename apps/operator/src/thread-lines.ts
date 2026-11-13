import { useEffect, useRef, useState } from "react";
import {
  inCommitOrder,
  isImage,
  newClientId,
  REFRESH_LIMIT_MS,
  REFUSED,
  refusalProblem,
  uploadProblem,
} from "../../../packages/widget/src/compose.ts";
import {
  ApiError,
  type Conversation,
  type Message,
  type PageView,
  type Quote,
  type ReplyReceipts,
  type WelcomeChat,
  type WorkspaceApi,
} from "./api.ts";
import { useLatestLoad } from "./load.ts";
import type { TextId } from "./text.ts";
import { failureText } from "./ui.tsx";

export interface Line {
  id: string;
  /** Null until the server confirms it. Confirmed lines sort by this, and pending ones go last. */
  seq: bigint | null;
  body: string;
  image: Message["image"];
  /** The image was deleted after 12 months, and the line says so. */
  imageRemoved: boolean;
  download: Message["file"];
  /** The file was deleted after 12 months, and the line says so. */
  fileRemoved: boolean;
  /** Held until the server confirms it, so a retry can send it again. */
  file?: File;
  fromVisitor: boolean;
  /** `closed` and `reopened` are status lines, and a `note` is the team's own. */
  kind: Message["kind"];
  /** When the server saved it. A pending line has none yet. */
  createdAt?: string;
  /** The operator who sent it. A pending line is this operator's own. */
  authorOperatorId: string | null;
  /** The API key that sent it, instead of an operator. */
  authorApiKeyId: string | null;
  authorName: string | null;
  status: "sent" | "sending" | "failed";
  /** The message this one quotes. */
  replyTo: Quote | null;
  editedAt: string | null;
  deleted: boolean;
  via: Message["via"];
  /** A bot's handoff note: whom it handed the conversation to, with null for the team. */
  handoff: Message["handoff"];
  /** The members a note mentions. */
  mentions: string[];
}

/** Adds a confirmed message in commit order, and replaces its pending line if it has one. */
function merge(lines: Line[], message: Message): Line[] {
  const line: Line = {
    id: message.id,
    seq: BigInt(message.seq),
    body: message.body ?? "",
    image: message.image,
    imageRemoved: message.imageRemoved,
    download: message.file,
    fileRemoved: message.fileRemoved,
    fromVisitor: message.fromVisitor,
    kind: message.kind,
    createdAt: message.createdAt,
    authorOperatorId: message.authorOperatorId,
    authorApiKeyId: message.authorApiKeyId,
    authorName: message.authorName,
    status: "sent",
    replyTo: message.replyTo,
    editedAt: message.editedAt,
    deleted: message.deleted,
    via: message.via,
    handoff: message.handoff,
    mentions: message.mentions,
  };
  const others = lines.filter(
    (other) => other.id !== message.id && !(other.seq === null && other.id === message.clientId),
  );
  return inCommitOrder(others, line);
}

/** A visitor's online state changes with no event, so views that show it read it this often. */
export const ONLINE_EVERY_MS = 30_000;

/**
 * A thread's conversation and its lines: it loads what it has not seen on each version, keeps the
 * visitor's online state fresh, and sends this operator's replies with a pending line each.
 */
export function useThreadLines({
  api,
  conversationId,
  meId,
  version,
  receiptsVersion,
  rewriteVersion,
  setProblem,
  onBack,
  onChanged,
  onLoaded,
}: {
  api: WorkspaceApi;
  conversationId: string;
  meId: string;
  version: number;
  receiptsVersion(visitorId: string): number;
  rewriteVersion: number;
  setProblem(problem: TextId | null): void;
  onBack(): void;
  onChanged(): void;
  onLoaded(conversation: Conversation): void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [pages, setPages] = useState<PageView[]>([]);
  const [welcome, setWelcome] = useState<WelcomeChat | null>(null);
  const [receipts, setReceipts] = useState<ReplyReceipts | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  // Why the last load failed, shown only while nothing has loaded yet.
  const [loadFailure, setLoadFailure] = useState<TextId | null>(null);
  const lastRefresh = useRef(0);
  const position = useRef("0");

  const load = useLatestLoad(async () => {
    for (let more = true; more; ) {
      const page = await api.messages(conversationId, position.current).catch((failure) => {
        // Another operator deleted this conversation.
        if (failure instanceof ApiError && failure.status === 404) onBack();
        setLoadFailure(failureText(failure, {}, "actionFailed"));
        throw failure;
      });
      setLoadFailure(null);
      setConversation(page.conversation);
      onLoaded(page.conversation);
      setOnline(page.visitorOnline);
      setPages(page.visitorPages);
      setWelcome(page.welcome);
      setReceipts(page.receipts);
      setLines((current) => page.messages.reduce(merge, current));
      const last = page.messages.at(-1);
      if (last !== undefined) position.current = last.seq;
      more = page.hasMore;
    }
  });
  /** Loads every message again: an edit or a delete keeps the message's position. */
  const reloadAll = () => {
    position.current = "0";
    load();
  };
  const receiptsSeen = conversation === null ? 0 : receiptsVersion(conversation.visitor.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each version asks for a load.
  useEffect(load, [load, version, receiptsSeen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rewriteVersion asks for a full load.
  useEffect(() => {
    if (rewriteVersion !== 0) reloadAll();
  }, [load, rewriteVersion]);
  useEffect(() => {
    const timer = setInterval(load, ONLINE_EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);

  // An image's URL expires after 15 minutes. Loading from the start gives every line a new one.
  const refreshImages = () => {
    if (Date.now() - lastRefresh.current < REFRESH_LIMIT_MS) return;
    lastRefresh.current = Date.now();
    reloadAll();
  };

  const deliver = async ({ id, body, file, replyTo, kind, mentions }: Line) => {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, status: "sending" } : line)),
    );
    const replyToId = replyTo?.id ?? undefined;
    try {
      const sent =
        file === undefined
          ? await api.reply(conversationId, id, body, replyToId, kind === "note", mentions)
          : await api.replyUpload(conversationId, id, file, replyToId);
      setLines((current) => merge(current, sent));
      onChanged();
    } catch (error) {
      if (file !== undefined && error instanceof ApiError && REFUSED.includes(error.status)) {
        setProblem(
          error.code === "storage_full" ? "storageFull" : refusalProblem(error.code, file),
        );
        setLines((current) => current.filter((line) => line.id !== id));
        return;
      }
      if (error instanceof ApiError && error.code === "invalid_reply_to")
        setProblem("quoteInvalid");
      setLines((current) =>
        current.map((line) => (line.id === id ? { ...line, status: "failed" } : line)),
      );
    }
  };

  /** A line this operator is sending, before the server confirms it. */
  const pending = (
    body: string,
    replyTo: Quote | null,
    kind: "text" | "image" | "file" | "note",
    mentions: string[] = [],
  ): Line => ({
    id: newClientId(),
    seq: null,
    body,
    image: null,
    imageRemoved: false,
    download: null,
    fileRemoved: false,
    fromVisitor: false,
    kind,
    authorOperatorId: meId,
    authorApiKeyId: null,
    authorName: null,
    status: "sending",
    replyTo,
    editedAt: null,
    deleted: false,
    via: null,
    handoff: null,
    mentions,
  });

  /** Sends a reply, or a note that only the team sees, which alerts the members it mentions. */
  const sendText = (body: string, quote: Quote | null, isNote: boolean, mentions: string[]) => {
    const line = pending(body, quote, isNote ? "note" : "text", mentions);
    setLines((current) => [...current, line]);
    void deliver(line);
  };

  const sendFiles = (files: Iterable<File>) => {
    // Once, before the loop, so a good file cannot erase the warning about the one before it.
    setProblem(null);
    for (const file of files) {
      const problem = uploadProblem(file, true);
      if (problem !== null) {
        setProblem(problem);
        continue;
      }
      const line = { ...pending("", null, isImage(file) ? "image" : "file"), file };
      setLines((current) => [...current, line]);
      void deliver(line);
    }
  };

  /** Puts a line the server sent back in its place. */
  const keep = (message: Message) => setLines((current) => merge(current, message));

  return {
    conversation,
    setConversation,
    online,
    pages,
    welcome,
    receipts,
    lines,
    loadFailure,
    refreshImages,
    retry: (line: Line) => void deliver(line),
    sendText,
    sendFiles,
    keep,
  };
}
