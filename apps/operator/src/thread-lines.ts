import { useEffect, useRef, useState } from "react";
import {
  imageProblem,
  inCommitOrder,
  newClientId,
  REFRESH_LIMIT_MS,
  REFUSED,
} from "../../../packages/widget/src/compose.ts";
import {
  ApiError,
  type Conversation,
  type Message,
  type Note,
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
  /** Held until the server confirms it, so a retry can send it again. */
  file?: File;
  fromVisitor: boolean;
  /** When the server saved it. A pending line has none yet. */
  createdAt?: string;
  /** The operator who sent it. A pending line is this operator's own. */
  authorOperatorId: string | null;
  /** The API key that sent it, instead of an operator. */
  authorApiKeyId: string | null;
  authorName: string | null;
  status: "sent" | "sending" | "failed";
  /** A status line: someone closed or reopened the conversation. */
  note?: "closed" | "reopened";
  /** The message this one quotes. */
  replyTo: Quote | null;
  editedAt: string | null;
  deleted: boolean;
  via: Message["via"];
}

/** Adds a confirmed message in commit order, and replaces its pending line if it has one. */
function merge(lines: Line[], message: Message): Line[] {
  const { kind } = message;
  const line: Line = {
    ...((kind === "closed" || kind === "reopened") && { note: kind }),
    id: message.id,
    seq: BigInt(message.seq),
    body: message.body ?? "",
    image: message.image,
    imageRemoved: message.imageRemoved,
    fromVisitor: message.fromVisitor,
    createdAt: message.createdAt,
    authorOperatorId: message.authorOperatorId,
    authorApiKeyId: message.authorApiKeyId,
    authorName: message.authorName,
    status: "sent",
    replyTo: message.replyTo,
    editedAt: message.editedAt,
    deleted: message.deleted,
    via: message.via,
  };
  const others = lines.filter(
    (other) => other.id !== message.id && !(other.seq === null && other.id === message.clientId),
  );
  return inCommitOrder(others, line);
}

/** Adds notes that are not there yet, in order. */
const withNotes = (current: Note[], added: Note[]) =>
  [...current.filter((one) => !added.some((other) => other.id === one.id)), ...added].sort(
    (one, other) => (BigInt(one.seq) < BigInt(other.seq) ? -1 : 1),
  );

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
  const [notes, setNotes] = useState<Note[]>([]);
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
      setNotes((current) => withNotes(current, page.notes));
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

  const deliver = async (id: string, body: string, file?: File, replyToId?: string) => {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, status: "sending" } : line)),
    );
    try {
      const sent =
        file === undefined
          ? await api.reply(conversationId, id, body, replyToId)
          : await api.replyImage(conversationId, id, file, replyToId);
      setLines((current) => merge(current, sent));
      onChanged();
    } catch (error) {
      if (file !== undefined && error instanceof ApiError && REFUSED.includes(error.status)) {
        setProblem(error.status === 507 ? "imageNoRoom" : "imageFailed");
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
  const pending = (id: string, body: string, replyTo: Quote | null): Line => ({
    id,
    seq: null,
    body,
    image: null,
    imageRemoved: false,
    fromVisitor: false,
    authorOperatorId: meId,
    authorApiKeyId: null,
    authorName: null,
    status: "sending",
    replyTo,
    editedAt: null,
    deleted: false,
    via: null,
  });

  const sendText = (body: string, quote: Quote | null) => {
    const id = newClientId();
    setLines((current) => [...current, pending(id, body, quote)]);
    void deliver(id, body, undefined, quote?.id ?? undefined);
  };

  const sendFiles = (files: Iterable<File>) => {
    // Once, before the loop, so a good file cannot erase the warning about the one before it.
    setProblem(null);
    for (const file of files) {
      const problem = imageProblem(file);
      if (problem !== null) {
        setProblem(problem);
        continue;
      }
      const id = newClientId();
      setLines((current) => [...current, { ...pending(id, "", null), file }]);
      void deliver(id, "", file);
    }
  };

  /** Puts a line the server sent back in its place. */
  const keep = (message: Message) => setLines((current) => merge(current, message));

  /** Saves a note for the team. False when it failed, so the composer gets its text back. */
  const addNote = async (body: string) => {
    try {
      const note = await api.addNote(conversationId, newClientId(), body);
      setNotes((current) => withNotes(current, [note]));
      return true;
    } catch (failure) {
      setProblem(failureText(failure, {}, "noteFailed"));
      return false;
    }
  };

  return {
    conversation,
    setConversation,
    online,
    pages,
    welcome,
    receipts,
    lines,
    notes,
    loadFailure,
    refreshImages,
    retry: (line: Line) =>
      void deliver(line.id, line.body, line.file, line.replyTo?.id ?? undefined),
    sendText,
    sendFiles,
    keep,
    addNote,
  };
}
