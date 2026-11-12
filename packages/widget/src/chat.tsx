import { Fragment, render } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ChatMessage, createClient } from "./client.ts";
import { imageProblem, inCommitOrder, newClientId, REFRESH_LIMIT_MS, REFUSED } from "./compose.ts";
import { cleanContext } from "./context.ts";
import "./globals.ts";
import { emit, reportConversation } from "./page-events.ts";
import { useDraftPreview, usePageReports } from "./page-reports.ts";
import {
  Branding,
  ChatHead,
  ChatLine,
  Composer,
  CSS,
  EmailCard,
  EmailSaved,
  EmptyLog,
  emailLayout,
  type Line,
  type SceneState,
  sayer,
  startsRun,
} from "./panel.tsx";
import { usePresence } from "./presence.ts";
import { type Quote, quoteOfReply } from "./quote.ts";
import {
  CONTEXT_VERSION,
  MESSAGE_MAX,
  type QueuedCall,
  readToken,
  rememberOpen,
  type SavedAppearance,
  WIDGET_DEFAULTS,
  type WidgetContext,
  wasOpen,
  writeToken,
} from "./shared.ts";
import { chime, prepareSound } from "./sound.ts";
import { t } from "./text.ts";
import { larger, useUnread } from "./use-unread.ts";

const NEW_REPLY_SHOWN_MS = 5000;
const RETRY_LIMIT_MS = 30_000;

/**
 * Adds a confirmed message in commit order. A pending line with the same client ID becomes this
 * message, so a send whose response was lost cannot stay marked as failed or appear twice.
 */
function merge(lines: Line[], message: ChatMessage): Line[] {
  const { kind } = message;
  const note = kind === "closed" || kind === "reopened" ? kind : undefined;
  const line: Line = {
    ...(note && { note }),
    id: message.id,
    seq: BigInt(message.seq),
    // A removed image or a deleted message reads as a note where it was.
    body: message.deleted
      ? t("messageDeleted")
      : message.imageRemoved
        ? t("imageRemoved")
        : (message.body ?? ""),
    image: message.image,
    quote: message.replyTo,
    gone: message.deleted,
    fromVisitor: message.fromVisitor,
    author:
      note || message.authorId === null || message.authorName === null
        ? null
        : {
            id: message.authorId,
            name: message.authorName,
            pictureUrl: message.authorPictureUrl,
            bot: message.fromBot,
          },
    status: "sent",
  };
  const others = lines.filter((other) => other.id !== message.id && other.id !== message.clientId);
  return inCommitOrder(others, line);
}

/** The page's data attribute when it has one, as data-mascot="false", or else the saved setting. */
const pageOr = (attribute: string | undefined, saved: boolean) =>
  attribute === undefined ? saved : attribute !== "false";

interface ChatProps {
  context: WidgetContext;
  open: boolean;
  setOpen(open: boolean): void;
  /** Opened again after a reload, so it does not take the page's focus. */
  quiet: boolean;
  /** The chat was open in this tab before a reload, and the server has not said yet whether it reopens. */
  restoring: boolean;
  /** Ends the restore: the chat reopens only with an open conversation or a new, empty chat. */
  restored(reopen: boolean): void;
  /** A message that open({ message }) puts in the composer. */
  prefill: { text: string } | null;
  /** Drops the pre-filled message once the visitor sends, so a remount does not bring it back. */
  clearPrefill(value: null): void;
  /** Grows with each setContext(). */
  contextVersion: number;
  /** Undefined until the loader's request for it ends. */
  saved: SavedAppearance | undefined;
}

/**
 * One visitor's session. identify() and reset() remount this component, so nothing from the old
 * identity survives: its stream closes, and a late response updates a component that is gone.
 */
function Chat({
  context,
  open,
  setOpen,
  quiet,
  restoring,
  restored,
  prefill,
  clearPrefill,
  contextVersion,
  saved,
}: ChatProps) {
  const { publicKey, base } = context;
  const fullPage = context.page === true;
  const [client] = useState(() => createClient(base, publicKey, undefined, !fullPage));
  const [identity] = useState(() => context.identity);
  const [token, setToken] = useState(() =>
    identity === null ? readToken(publicKey) : typeof identity === "string" ? identity : null,
  );
  const [openConversation, setOpenConversation] = useState(false);
  // Has a conversation, open or closed. Only such a visitor's pages are reported.
  const [chatted, setChatted] = useState(false);
  // Whether the visitor gave an email, from the server. Undefined until it answers.
  const [hasEmail, setHasEmail] = useState<boolean>();
  const [loaded, setLoaded] = useState(false);
  // The newest position the stream has delivered. A send's own response does not move this, so a
  // reply that has not arrived yet cannot be marked as read.
  const [delivered, setDelivered] = useState(0n);
  const [renewing, setRenewing] = useState(typeof identity === "function");
  const [renewAttempt, setRenewAttempt] = useState(0);
  const [tokenEpoch, setTokenEpoch] = useState(0);
  const renewDelay = useRef(0);
  const sends = useRef(0);
  // The newest message this chat sent. A reply after it is new even inside a stream's first replay,
  // which can hold an answer to the message that started the conversation.
  const lastSent = useRef<bigint | null>(null);
  // The highest position the stream has sent, so a message sent again for an edit is not news.
  const highest = useRef(0n);
  const alive = useRef(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  // The quote the next message carries. It shows at once, and the server's copy replaces it.
  const [quoting, setQuoting] = useState<Quote | null>(null);
  const [lost, setLost] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [newReply, setNewReply] = useState(false);
  // True once the replay of history has ended, so only a message that arrives later is "new".
  const replayed = useRef(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const viewer = useRef<HTMLDialogElement>(null);
  const lastRefresh = useRef(0);
  const [emailDraft, setEmailDraft] = useState("");
  // Or why the last save failed.
  const [emailState, setEmailState] = useState<"idle" | "saved" | "emailInvalid" | "emailFailed">(
    "idle",
  );
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const cursor = useRef<string | null>(null);
  // A closed panel needs only the unread messages, so its stream starts at the read position. The
  // panel's first open then replays the whole history once.
  const readCursor = useRef<string | null>(null);
  const partial = useRef(false);
  // Set when the panel opens on a partial stream. The next stream resets the cursor itself, after
  // the old stream is aborted, so a late event of the old one cannot move the cursor back.
  const wantsReplay = useRef(false);
  const [replay, setReplay] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  // Read by the stream's handler, which outlives a render: whether a live reply chimes now.
  const wantsChime = useRef(false);
  wantsChime.current = saved?.sound === true && (!open || !visible);
  const creatingVisitor = useRef<Promise<string> | null>(null);

  useEffect(() => {
    alive.current = true;
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    // Another tab may have started a chat, so this tab joins it instead of starting a second one.
    const onStorage = () => {
      // Only a stored token replaces this one. A token held in memory survives a full storage.
      const stored = identity === null ? readToken(publicKey) : null;
      if (stored !== null) setToken(stored);
    };
    addEventListener("storage", onStorage);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("storage", onStorage);
    };
  }, [identity, publicKey]);

  /** Asks the host for a new token now, for a send. It returns null if this identity cannot renew. */
  const renewToken = async (): Promise<string | null> => {
    if (typeof identity !== "function") return null;
    const next = await identity();
    if (alive.current) setToken(next);
    return next;
  };

  // The only background path to a new token. A rejected or failed renewal waits longer each time,
  // so a rotated secret cannot make every tab call the host and this server in a loop. The delay
  // resets only when a token works.
  // biome-ignore lint/correctness/useExhaustiveDependencies: renewAttempt asks for another try.
  useEffect(() => {
    // A hidden tab holds no stream, so it has no use for a token until it returns.
    if (!renewing || !visible || typeof identity !== "function") return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const next = await identity();
        if (stopped) return;
        setToken(next);
        setTokenEpoch((current) => current + 1);
        setRenewing(false);
      } catch {
        if (stopped) return;
        setLost(true);
        setRenewAttempt((current) => current + 1);
      }
    }, renewDelay.current);
    renewDelay.current = Math.min(Math.max(1000, renewDelay.current * 2), RETRY_LIMIT_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [identity, renewing, renewAttempt, visible]);

  // The page's message fills an empty box, or takes the place of the page's last message. A draft
  // the visitor typed or changed stays.
  const pageMessage = useRef<string | null>(null);
  useEffect(() => {
    if (prefill === null) return;
    setDraft((current) => {
      if (current.trim() !== "" && current !== pageMessage.current) return current;
      // Only a message that filled the box counts as the page's, so one it ignored never makes
      // the visitor's words replaceable.
      pageMessage.current = prefill.text;
      return prefill.text;
    });
  }, [prefill]);

  // Only a visitor with a token has the flag, so one who never chatted stores nothing.
  // While a restore waits for the server, the flag stays, so another reload can still restore.
  useEffect(() => {
    if (!fullPage && !restoring) rememberOpen(publicKey, open && token !== null);
  }, [fullPage, open, publicKey, restoring, token]);

  // The panel waits for the saved look, so its words never change after it shows.
  const shown = open && saved !== undefined;

  useEffect(() => {
    if (!shown || quiet) return;
    // On a touch screen the keyboard would cover the panel before the visitor reads it, so focus
    // goes to the panel, and a tap on the field opens the keyboard.
    if (matchMedia("(pointer: fine)").matches) input.current?.focus();
    else panel.current?.focus();
  }, [shown, quiet]);

  useEffect(() => {
    if (!newReply) return;
    const timer = setTimeout(() => setNewReply(false), NEW_REPLY_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [newReply]);

  const { online, members, emailReplies } = usePresence(
    client,
    fullPage ? token : null,
    open && visible,
  );
  usePageReports(client, token, chatted && !fullPage);
  // Only into an open conversation, and only when the workspace shows drafts.
  useDraftPreview(client, token, openConversation && saved?.typingPreview === true, draft);

  // Like the pages, the page's context goes only for a visitor who has chatted: after the first
  // message, on each load after that, and on each setContext().
  // biome-ignore lint/correctness/useExhaustiveDependencies: contextVersion asks for a report.
  useEffect(() => {
    if (token === null || !chatted || fullPage) return;
    const data = cleanContext(context.pageContext);
    if (data === null) return;
    client.reportContext(token, data).catch(() => {
      // Only a detail for operators. The next setContext() or page load tries again.
    });
  }, [chatted, client, context, contextVersion, fullPage, token]);

  const serverSaid = useUnread(
    context,
    client,
    token,
    lines,
    loaded && (open || openConversation),
    shown && visible && loaded,
    delivered,
    saved,
  );

  // One request when a visible tab has a token gives the unread count and says whether a stream is
  // needed. A visitor with only closed conversations holds no stream. It runs again when a tab
  // becomes visible, because another tab may have read messages or started a conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokenEpoch asks for a request.
  useEffect(() => {
    if (token === null || !visible) return;
    // A newer request replaces this one, so a late 401 cannot erase a replacement token.
    let replaced = false;
    const sendsAtStart = sends.current;
    client
      .me(token)
      .then((me) => {
        if (replaced) return;
        renewDelay.current = 0;
        // A send during this request leaves a conversation open that this response may not show.
        const hasOpenConversation = me.openConversation || sends.current !== sendsAtStart;
        setOpenConversation(hasOpenConversation);
        // Only closed conversations keep the chat closed, so a closed one does not pop up again.
        if (restoring) restored(hasOpenConversation || !me.chatted);
        setChatted((current) => current || me.chatted);
        setHasEmail(me.hasEmail);
        serverSaid(me.unread, BigInt(me.lastReadSeq));
        readCursor.current = me.readCursor;
      })
      .catch((error: unknown) => {
        if (replaced) return;
        if (!(error instanceof ApiError) || error.status !== 401) {
          // With no answer, the widget asks for an email rather than wait for it forever.
          setHasEmail((current) => current ?? false);
          if (restoring) restored(false);
          return;
        }
        if (identity === null) {
          writeToken(publicKey, null);
          setToken(null);
        } else if (typeof identity === "function") {
          setRenewing(true);
        }
      });
    return () => {
      replaced = true;
    };
  }, [client, identity, publicKey, restored, restoring, token, tokenEpoch, visible]);

  // A new session after reset() starts with none, so the page hears false at once.
  useEffect(() => reportConversation(context, openConversation), [context, openConversation]);

  // Only the visible tab holds a stream, because browsers allow about six HTTP/1.1 connections per
  // origin across all tabs. A tab catches up from its cursor when it becomes visible again.
  const wantsStream = token !== null && visible && (open || openConversation);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokenEpoch asks for a new stream.
  useEffect(() => {
    if (!wantsStream || token === null) return;
    const controller = new AbortController();
    let retryMs = 1000;
    if (wantsReplay.current) {
      wantsReplay.current = false;
      cursor.current = null;
      // The history is not new, so it raises no "new reply" notice.
      replayed.current = false;
    }
    if (cursor.current === null && !open && readCursor.current !== null) {
      cursor.current = readCursor.current;
      partial.current = true;
    }
    (async () => {
      while (!controller.signal.aborted) {
        let refusedMs: number | undefined;
        try {
          const reason = await client.stream(token, cursor.current, controller.signal, {
            message(message, next) {
              if (controller.signal.aborted) return;
              cursor.current = next;
              const seq = BigInt(message.seq);
              // An edit or a delete sends a message again, at or below what came before.
              const isNew = seq > highest.current;
              if (isNew) highest.current = seq;
              setDelivered((current) => larger(current, seq));
              const fresh =
                isNew &&
                (replayed.current || (lastSent.current !== null && seq > lastSent.current));
              const { kind } = message;
              // A close ends the conversation, and a reopen brings it back, with no notice.
              if (fresh && (kind === "closed" || kind === "reopened")) {
                setOpenConversation(kind === "reopened");
              } else if (fresh && !message.fromVisitor) {
                // Only a reply that arrives now, as history replays before ready.
                if (replayed.current && wantsChime.current) chime();
                setNewReply(true);
                emit(context, "message:received", { body: message.body });
              }
              setLines((current) => merge(current, message));
            },
            ready(next) {
              if (controller.signal.aborted) return;
              if (next !== null) cursor.current = next;
              replayed.current = true;
              renewDelay.current = 0;
              setLost(false);
              setLoaded(true);
              retryMs = 1000;
            },
            resync(next) {
              if (controller.signal.aborted) return;
              cursor.current = next;
              // It reads from the start now, so the history is whole.
              partial.current = false;
              highest.current = 0n;
              setLines((current) => current.filter((line) => line.seq === null));
            },
          });
          if (reason === "revoked" || reason === "unauthorized") return;
          if (reason === "expired") {
            // A new token restarts this effect. A plain string cannot renew, so the stream stays
            // closed until the page calls identify() again.
            if (typeof identity === "function") setRenewing(true);
            return;
          }
          if (reason === "lifetime") continue;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 401) {
            if (typeof identity === "function") setRenewing(true);
            return;
          }
          if (error instanceof ApiError) refusedMs = error.retryMs;
        }
        if (controller.signal.aborted) return;
        setLost(true);
        // A refused stream waits as long as the server says. Otherwise, jitter, so clients do not all
        // return at once after an outage.
        await new Promise((resolve) =>
          setTimeout(resolve, refusedMs ?? retryMs * (0.5 + Math.random() / 2)),
        );
        if (refusedMs === undefined) retryMs = Math.min(retryMs * 2, RETRY_LIMIT_MS);
      }
    })();
    return () => controller.abort();
  }, [client, identity, token, tokenEpoch, wantsStream, replay]);

  // The panel opens on a stream that skipped the read history, so it replays it from the start.
  useEffect(() => {
    if (!open || !partial.current) return;
    partial.current = false;
    wantsReplay.current = true;
    setReplay((current) => current + 1);
  }, [open]);

  // Only a new line scrolls down, because a refresh of the image URLs must not move the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line or a shown chat asks for a scroll.
  useEffect(() => {
    if (log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [lines.length, shown]);

  const ensureToken = async (): Promise<string> => {
    if (identity !== null) {
      if (token !== null) return token;
      const renewed = await renewToken();
      if (renewed === null) throw new ApiError(401);
      return renewed;
    }
    const known = token ?? readToken(publicKey);
    if (known !== null) {
      setToken(known);
      return known;
    }
    // Sends made before the first response share one visitor.
    creatingVisitor.current ??= client
      .newVisitor()
      .then((created) => {
        // After reset(), this token belongs to a session that has ended.
        if (alive.current) {
          writeToken(publicKey, created.token);
          setToken(created.token);
        }
        return created.token;
      })
      .finally(() => {
        creatingVisitor.current = null;
      });
    return creatingVisitor.current;
  };

  const markLine = (lineId: string, status: Line["status"]) =>
    setLines((current) => current.map((line) => (line.id === lineId ? { ...line, status } : line)));

  // The line's first ID is its client ID, so a manual retry cannot create a duplicate.
  const deliver = async (lineId: string, body: string, file?: File, quoteId?: string | null) => {
    markLine(lineId, "sending");
    try {
      const first = await ensureToken();
      const post = (token: string) =>
        file === undefined
          ? client.send(token, lineId, body, quoteId ?? undefined)
          : client.sendImage(token, lineId, file);
      const sent = await post(first).catch(async (error: unknown) => {
        // A tab open past the token's expiry asks the host for a new one and tries once more.
        // The client ID makes this safe.
        const renewed =
          error instanceof ApiError && error.status === 401 ? await renewToken() : null;
        if (renewed === null) throw error;
        return post(renewed);
      });
      sends.current += 1;
      const seq = BigInt(sent.seq);
      lastSent.current = lastSent.current === null ? seq : larger(lastSent.current, seq);
      emit(context, "message:sent", { body: file === undefined ? body : null });
      // The server's answer, because a stream copy or a close from the inbox can race the send.
      if (sent.conversationStarted) emit(context, "conversation:started", undefined);
      setOpenConversation(true);
      setChatted(true);
      // A send that worked means a block was lifted, or the site was allowed again. Another warning,
      // such as an image that was too large, is about something else and stays.
      setProblem((current) =>
        current === t("blocked") || current === t("notHere") ? null : current,
      );
      setLines((current) => merge(current, sent));
    } catch (error) {
      if (file !== undefined && error instanceof ApiError && REFUSED.includes(error.status)) {
        setProblem(t(error.status === 507 ? "imageNoRoom" : "imageFailed"));
        setLines((current) => current.filter((line) => line.id !== lineId));
        return;
      }
      // A block, or a site the workspace no longer serves: its allowed sites changed, or the
      // workspace became read-only or suspended during this visit.
      if (error instanceof ApiError && error.status === 403) {
        setProblem(t(error.code === "origin_not_allowed" ? "notHere" : "blocked"));
      }
      markLine(lineId, "failed");
    }
  };

  /** Shows the visitor's new line at once, before the server confirms it, and sends it. */
  const sendLine = (body: string, extra: Pick<Line, "file" | "quote">) => {
    const id = newClientId();
    setLines((current) => [
      ...current,
      {
        id,
        seq: null,
        body,
        image: null,
        fromVisitor: true,
        author: null,
        status: "sending",
        ...extra,
      },
    ]);
    void deliver(id, body, extra.file, extra.quote?.id);
  };

  // An image's URL expires after 15 minutes. Replaying from the start gives every line a new one.
  const refreshImages = () => {
    if (Date.now() - lastRefresh.current < REFRESH_LIMIT_MS) return;
    lastRefresh.current = Date.now();
    cursor.current = null;
    setTokenEpoch((current) => current + 1);
  };

  useEffect(() => {
    if (viewing !== null) viewer.current?.showModal();
  }, [viewing]);

  const submit = (event: Event) => {
    event.preventDefault();
    const body = draft.trim();
    if (body === "") return;
    setDraft("");
    clearPrefill(null);
    sendLine(body, { quote: quoting });
    setQuoting(null);
  };

  const sendFiles = (files: Iterable<File>) => {
    // Once, before the loop, so a good file cannot erase the warning about the one before it.
    setProblem(null);
    for (const file of files) {
      const problem = imageProblem(file);
      if (problem !== null) {
        setProblem(t(problem));
        continue;
      }
      sendLine("", { file });
    }
  };

  const saveEmail = async (event: Event) => {
    event.preventDefault();
    try {
      await client.saveEmail(await ensureToken(), emailDraft.trim());
      setEmailState("saved");
    } catch (error) {
      // The server checked the address, so only a 400 means it is wrong.
      setEmailState(
        error instanceof ApiError && error.status === 400 ? "emailInvalid" : "emailFailed",
      );
    }
  };

  if (!shown) return null;
  // In this order, because a lost connection matters most and an empty chat matters least.
  const sceneState: SceneState = lost
    ? "lost"
    : lines.some((line) => line.status === "sending")
      ? "sending"
      : newReply
        ? "reply"
        : online === false
          ? "away"
          : lines.length === 0 && online === null
            ? "empty"
            : "waiting";
  const say = sayer(saved);
  const mascot = pageOr(context.attribute("mascot"), saved.mascot);
  // Only a visitor the host site did not sign in, only when this server sends email, and never
  // again once the server holds an email. A failed save keeps the form and its error, even when
  // it made the visitor, so its result is known without the server.
  const email = emailLayout(saved.emailAsk, {
    mayAsk: emailReplies && identity === null && emailState !== "saved" && hasEmail !== true,
    chatted: chatted || lines.length > 0,
    known: token === null || hasEmail !== undefined || emailState !== "idle",
  });
  const emailCard = (
    <EmailCard
      face={saved.team[0] ?? null}
      lead={email.composer ? "emailAfterFirst" : "emailBeforeFirst"}
      email={emailDraft}
      bad={emailState === "idle" || emailState === "saved" ? null : emailState}
      onInput={setEmailDraft}
      onSubmit={saveEmail}
    />
  );
  // After the first message, the card, then the line that replaces it, stays in the conversation
  // right after the visitor's first message, so it never reads as a second message box.
  const emailInLog =
    emailState === "saved" ? (
      <EmailSaved email={emailDraft.trim()} />
    ) : (
      email.form && email.composer && emailCard
    );
  const emailAt = lines.findIndex((line) => line.fromVisitor);

  return (
    <section
      ref={panel}
      tabIndex={-1}
      class={`panel${fullPage ? " page" : ""}${dropping ? " drop" : ""}`}
      onDragOver={(event) => {
        // A drag of selected text keeps its normal behavior.
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        sendFiles(event.dataTransfer.files);
      }}
      aria-label={say("title")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !fullPage) setOpen(false);
      }}
    >
      <ChatHead
        scene={sceneState}
        online={online}
        members={members}
        mascot={mascot}
        saved={saved}
        say={say}
        {...(fullPage ? {} : { onClose: () => setOpen(false) })}
      />
      <div class="log" role="log" aria-live="polite" ref={log}>
        {lines.length === 0 && <EmptyLog mascot={mascot} greeting={say("empty")} />}
        {lines.map((line, index) => (
          <Fragment key={line.id}>
            <ChatLine
              line={line}
              showAuthor={startsRun(lines, index)}
              onView={() => setViewing(line.id)}
              onImageError={refreshImages}
              onRetry={() => void deliver(line.id, line.body, line.file, line.quote?.id)}
              onReply={
                line.fromVisitor || line.note || line.gone || line.seq === null || !openConversation
                  ? undefined
                  : () => {
                      setQuoting(quoteOfReply(line));
                      input.current?.focus();
                    }
              }
            />
            {index === emailAt && emailInLog}
          </Fragment>
        ))}
        {emailAt === -1 && emailInLog}
      </div>
      {viewing !== null && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a dialog.
        <dialog
          ref={viewer}
          onClose={() => setViewing(null)}
          onClick={() => viewer.current?.close()}
        >
          <img
            src={lines.find((line) => line.id === viewing)?.image?.url}
            alt={t("imageAlt")}
            onError={refreshImages}
          />
        </dialog>
      )}
      {problem !== null && (
        <div class="notice bad" role="alert">
          {problem}
        </div>
      )}
      {email.form && !email.composer && emailCard}
      {email.composer && (
        <Composer
          draft={draft}
          inputRef={input}
          onDraft={setDraft}
          onSubmit={submit}
          onFiles={sendFiles}
          quoting={quoting}
          onUnquote={() => setQuoting(null)}
        />
      )}
      {pageOr(context.attribute("branding"), saved.branding) && <Branding />}
    </section>
  );
}

function Root({ context }: { context: WidgetContext }) {
  const { publicKey } = context;
  // A visitor with a token who had the chat open in this tab finds it open after a reload, once the
  // server says it holds an open conversation. It starts closed, so it never flashes open and shut.
  const [remembered] = useState(
    () =>
      context.page !== true &&
      (context.identity !== null || readToken(publicKey) !== null) &&
      wasOpen(publicKey),
  );
  const [open, setOpenState] = useState(false);
  const [restoring, setRestoring] = useState(remembered);
  const restored = useCallback(
    (reopen: boolean) => {
      setRestoring(false);
      if (!reopen) return;
      context.state.open = true;
      setOpenState(true);
    },
    [context],
  );
  // The state changes at once, so a toggle() right after a close() sees it closed.
  const setOpen = (next: boolean) => {
    context.state.open = next;
    setOpenState(next);
  };
  const [quiet, setQuiet] = useState(remembered);
  const [session, setSession] = useState(0);
  const [prefill, setPrefill] = useState<{ text: string } | null>(null);
  const [contextVersion, setContextVersion] = useState(0);
  const [saved, setSaved] = useState<SavedAppearance>();
  // The loader's answer, which also gave the launcher its look. The theme is the panel's alone.
  // With no answer the defaults apply, as on the launcher. A workspace that serves no widget has
  // no launcher, but its chat link's page still needs words.
  useEffect(() => {
    context.appearance.then((answer) => {
      const found = answer ?? WIDGET_DEFAULTS;
      context.shadow.host.setAttribute("data-theme", found.theme);
      setSaved(found);
    });
  }, [context]);
  // A layout effect, so identify() or reset() right after the first render still reaches this.
  useLayoutEffect(() => {
    const handlers = {
      open(message: string | undefined) {
        setRestoring(false);
        context.state.open = true;
        setOpenState(true);
        setQuiet(false);
        if (typeof message === "string") setPrefill({ text: message.slice(0, MESSAGE_MAX) });
      },
      close: () => {
        setRestoring(false);
        context.state.open = false;
        setOpenState(false);
      },
      session: () => {
        // A reset leaves no identity, and the next visitor must not get this one's draft.
        if (context.identity === null) setPrefill(null);
        setSession((current) => current + 1);
      },
      context: () => setContextVersion((current) => current + 1),
    };
    context.chat = handlers;
    context.state.ready = true;
    emit(context, "ready", undefined);
    const { wanted } = context;
    context.wanted = undefined;
    if (wanted !== undefined) handlers.open(wanted[0]);
  }, [context]);
  const shown = useRef(false);
  useEffect(() => {
    if (open === shown.current) return;
    shown.current = open;
    context.state.open = open;
    const launcher = context.shadow.querySelector<HTMLElement>(".launcher");
    launcher?.classList.toggle("opened", open);
    // The focused element is gone after a close, so a keyboard user returns to the launcher.
    if (!open) launcher?.focus();
    emit(context, open ? "open" : "close", undefined);
  }, [context, open]);
  return (
    <Chat
      key={session}
      context={context}
      open={open}
      setOpen={setOpen}
      quiet={quiet}
      restoring={restoring}
      restored={restored}
      prefill={prefill}
      clearPrefill={setPrefill}
      contextVersion={contextVersion}
      saved={saved}
    />
  );
}

/** What every released loader puts on its context, and all that replaceLoader reads. */
type OlderContext = Pick<
  WidgetContext,
  "publicKey" | "base" | "shadow" | "identity" | "pageContext" | "wanted" | "listeners"
>;

/**
 * A tab that stayed open through a release still runs the loader it started with, and its context
 * may not fit this bundle. The current loader takes its place, with the page's identity, page
 * context, callbacks and pending open, and loads this bundle again. A configure() or hide() call
 * the page made is lost until the page makes it again.
 */
function replaceLoader(old: OlderContext) {
  // A loader that adds its host once the saved look arrives may still add it, so it goes empty.
  old.shadow.replaceChildren();
  old.shadow.host.remove();
  const calls: QueuedCall[] = [];
  if (old.identity !== null) calls.push(["identify", old.identity]);
  if (old.pageContext !== null) calls.push(["setContext", old.pageContext]);
  for (const [event, callbacks] of Object.entries(old.listeners)) {
    for (const callback of callbacks ?? []) calls.push(["on", event, callback]);
  }
  if (old.wanted !== undefined) calls.push(["open", { message: old.wanted[0] }]);
  globalThis.Dinghy = { q: calls };
  const original = [...document.scripts].find((script) => script.dataset.key === old.publicKey);
  const script = document.createElement("script");
  Object.assign(script.dataset, original?.dataset, { key: old.publicKey });
  // An address of its own, so the browser cannot answer with the old loader from its cache.
  script.src = `${old.base}loader.js?v=${CONTEXT_VERSION}`;
  document.head.append(script);
}

const context = globalThis.__dinghy;
if (context !== undefined && context.version !== CONTEXT_VERSION) replaceLoader(context);
else if (context !== undefined) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  context.shadow.adoptedStyleSheets = [...context.shadow.adoptedStyleSheets, sheet];
  // A modal's focus trap listens on the document, so it must not see focus move inside the chat.
  // The same goes for a site's keyboard shortcuts, which cannot see that the target is a textarea.
  for (const type of ["focusin", "focusout", "keydown", "keypress", "keyup"]) {
    context.shadow.host.addEventListener(type, (event) => event.stopPropagation());
  }
  prepareSound(context.shadow);
  const mount = document.createElement("div");
  context.shadow.append(mount);
  render(<Root context={context} />, mount);
}
