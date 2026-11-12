import { useCallback, useEffect, useRef, useState } from "react";
import type { OperatorNotice } from "../../server/src/live.ts";
import { ApiError, READ_ONLY_EVENT, type WorkspaceApi } from "./api.ts";

const RETRY_LIMIT_MS = 30_000;
/** A visitor's draft goes away this long after its last update, as they may have left. */
const TYPING_SHOWN_MS = 6000;
const PRESENCE_EVERY_MS = 10_000;

/**
 * Says which conversation is open, and learns who else has one open. This follows what is open, and
 * no operator's keystroke. A hidden tab keeps the operator online, as the inbox often waits in one,
 * and has no conversation open. A closing tab ends only its conversation's mark, as another tab can
 * keep the operator online, and the online mark expires on its own. `leave` is for a sign-out: it
 * ends the online mark too, and no beat follows it. Presence is best effort, so a failed request is
 * dropped: the next beat, or the expiry, puts it right.
 */
export function usePresence(api: WorkspaceApi, selected: string | null, visible: boolean) {
  const [viewers, setViewers] = useState<Record<string, string[]>>({});
  const open = useRef<string | null>(null);
  const signedOut = useRef(false);

  useEffect(() => {
    const left = open.current;
    const viewing = visible ? selected : null;
    open.current = viewing;
    let stopped = false;
    const beat = (previous: string | null) => {
      if (signedOut.current) return;
      api
        .beat(viewing, previous, !visible)
        .then((state) => {
          if (!stopped) setViewers(state.viewers);
        })
        .catch(() => {});
    };
    beat(left);
    const timer = setInterval(() => beat(null), PRESENCE_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, selected, visible]);

  useEffect(() => {
    const onHide = () => {
      if (open.current !== null) api.leave(open.current, false).catch(() => {});
    };
    addEventListener("pagehide", onHide);
    return () => removeEventListener("pagehide", onHide);
  }, [api]);

  const leave = useCallback(() => {
    signedOut.current = true;
    return api
      .leave(open.current, true)
      .then(() => {})
      .catch(() => {});
  }, [api]);

  return { viewers, leave };
}

export function useTabVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return visible;
}

/**
 * Holds the stream of changes, and counts them. Only a visible tab holds a stream, because browsers
 * allow about six HTTP/1.1 connections per origin. A tab catches up from its cursor when it becomes
 * visible again.
 */
export function useChanges(
  api: WorkspaceApi,
  visible: boolean,
  onSignedOut: () => void,
  /** A visitor's new message, live, after the stream has caught up. */
  onVisitorMessage: (conversationId: string | null) => void,
) {
  const [lost, setLost] = useState(false);
  const [version, setVersion] = useState(0);
  const [teamVersion, setTeamVersion] = useState(0);
  const [accountVersion, setAccountVersion] = useState(0);
  // A thread loads again only for its own conversation's changes, for a block of its visitor, or
  // for a change to the whole workspace.
  const [threads, setThreads] = useState<{ all: number; by: Record<string, number> }>({
    all: 0,
    by: {},
  });
  const cursor = useRef<string | null>(null);
  const { typing, notice, stopTyping } = useNotices();
  const [receipts, setReceipts] = useState<Record<string, number>>({});
  // Edits and deletes by conversation: they keep a message's position, so a thread loads it all.
  const [rewrites, setRewrites] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let retryMs = 1000;
    (async () => {
      while (!controller.signal.aborted) {
        let refusedMs: number | undefined;
        // What a stream replays before `ready` is catch-up, and makes no sound.
        let live = false;
        try {
          const reason = await api.stream(cursor.current, controller.signal, {
            notice(value) {
              if (value.kind === "receipts") {
                setReceipts((current) => ({
                  ...current,
                  [value.visitorId]: (current[value.visitorId] ?? 0) + 1,
                }));
              } else notice(value);
            },
            change(next, kind, conversationId, fromVisitor) {
              cursor.current = next;
              // The draft became this message.
              if (kind === "message.created" && fromVisitor && conversationId !== null) {
                stopTyping(conversationId);
              }
              if (live && kind === "message.created" && fromVisitor) {
                onVisitorMessage(conversationId);
              }
              // React batches these, so a long catch-up becomes few loads.
              setVersion((current) => current + 1);
              // A block or unblock is on the visitor, so it changes every one of their threads.
              setThreads((current) =>
                conversationId === null || kind === "conversation.moderated"
                  ? { ...current, all: current.all + 1 }
                  : {
                      ...current,
                      by: {
                        ...current.by,
                        [conversationId]: (current.by[conversationId] ?? 0) + 1,
                      },
                    },
              );
              if (
                (kind === "message.updated" || kind === "message.deleted") &&
                conversationId !== null
              ) {
                setRewrites((current) => ({
                  ...current,
                  [conversationId]: (current[conversationId] ?? 0) + 1,
                }));
              }
              if (kind === "team.changed") setTeamVersion((current) => current + 1);
              // Both change `me`: the billing state, a suspension, or the workspace's name or logo.
              if (kind === "billing.changed" || kind === "workspace.changed") {
                setAccountVersion((current) => current + 1);
              }
            },
            ready(next) {
              live = true;
              // A first stream starts at the present, so a billing change since `me` loaded is
              // not on it.
              if (cursor.current === null) setAccountVersion((current) => current + 1);
              cursor.current = next;
              setLost(false);
              retryMs = 1000;
              // Anything before this point is in these lists, and anything after is on the stream.
              setVersion((current) => current + 1);
              setThreads((current) => ({ ...current, all: current.all + 1 }));
              setTeamVersion((current) => current + 1);
            },
            resync(next) {
              cursor.current = next;
              // The events after the old cursor are gone, and a billing change may be among them.
              setAccountVersion((current) => current + 1);
            },
          });
          // Reading /me settles it: another workspace opens, or sign-in, or this session is fine and
          // the loop below connects again, as when another window signed in with a new cookie.
          if (reason === "unauthorized") onSignedOut();
          if (reason === "lifetime") continue;
        } catch (failure) {
          if (controller.signal.aborted) return;
          if (failure instanceof ApiError && (failure.status === 401 || failure.status === 404)) {
            onSignedOut();
          }
          if (failure instanceof ApiError) refusedMs = failure.retryMs;
        }
        if (controller.signal.aborted) return;
        setLost(true);
        // A refused stream waits as long as the server says, and anything else backs off.
        await new Promise((resolve) =>
          setTimeout(resolve, refusedMs ?? retryMs * (0.5 + Math.random() / 2)),
        );
        if (refusedMs === undefined) retryMs = Math.min(retryMs * 2, RETRY_LIMIT_MS);
      }
    })();
    return () => controller.abort();
  }, [api, onSignedOut, onVisitorMessage, visible, notice, stopTyping]);

  // A write refused as read-only means this page missed the change.
  useEffect(() => {
    const onReadOnly = () => setAccountVersion((current) => current + 1);
    addEventListener(READ_ONLY_EVENT, onReadOnly);
    return () => removeEventListener(READ_ONLY_EVENT, onReadOnly);
  }, []);

  const threadVersion = (id: string) => threads.all + (threads.by[id] ?? 0);
  /** Goes up when a visitor read replies or got a reply email. */
  const receiptsVersion = (visitorId: string) => receipts[visitorId] ?? 0;
  /** Goes up when a message in this conversation was edited or deleted. */
  const rewriteVersion = (conversationId: string) => rewrites[conversationId] ?? 0;
  return {
    lost,
    version,
    threadVersion,
    receiptsVersion,
    rewriteVersion,
    typing,
    teamVersion,
    accountVersion,
  };
}

/** Visitors' unsent drafts by conversation. Each goes after a while with no update. */
function useNotices() {
  const [typing, setTyping] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const stopTyping = useCallback((conversationId: string) => {
    clearTimeout(timers.current.get(conversationId));
    timers.current.delete(conversationId);
    setTyping((current) => {
      if (!(conversationId in current)) return current;
      const { [conversationId]: _gone, ...rest } = current;
      return rest;
    });
  }, []);
  const notice = useCallback(
    (value: Extract<OperatorNotice, { kind: "typing" }>) => {
      if (value.draft === "") return stopTyping(value.conversationId);
      clearTimeout(timers.current.get(value.conversationId));
      timers.current.set(
        value.conversationId,
        setTimeout(() => stopTyping(value.conversationId), TYPING_SHOWN_MS),
      );
      setTyping((current) => ({ ...current, [value.conversationId]: value.draft }));
    },
    [stopTyping],
  );
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running.values()) clearTimeout(timer);
    };
  }, []);
  return { typing, notice, stopTyping };
}
