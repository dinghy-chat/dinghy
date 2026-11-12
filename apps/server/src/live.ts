import { setTimeout as delay } from "node:timers/promises";
import { Redis } from "iovalkey";
import type { Logger } from "pino";

/** The subscriber that wakes every operator stream in a workspace. */
export const OPERATORS = "operators";
/** A revoke for this closes every visitor's stream in a workspace, as a suspension does. */
export const VISITORS = "visitors";

export type CloseReason =
  | "lifetime"
  | "expired"
  | "revoked"
  | "unauthorized"
  | "stopping"
  | "error"
  | "aborted";

export interface Session {
  /** Runs one ordered read from Postgres. A signal never carries the data itself. */
  wake(): void;
  close(reason: CloseReason): void;
  /** Passes on a notice to an operator stream. A visitor's stream has none. */
  tell?(notice: string): void;
}

/**
 * Something live that operators may see, and that nothing stores, so losing one loses nothing: a
 * visitor's unsent draft, or a sign that a visitor's read position or reply email changed, whose
 * truth is in Postgres for the next load.
 */
export type OperatorNotice =
  | { kind: "typing"; conversationId: string; visitorId: string; draft: string }
  | { kind: "receipts"; visitorId: string };

export interface Live {
  /** `subscriber` is a visitor's ID, or OPERATORS. */
  wake(workspaceId: string, subscriber: string): void;
  revoke(workspaceId: string, subscriber: string): void;
  /** Sends a notice to every operator stream in the workspace. */
  tell(workspaceId: string, notice: OperatorNotice): void;
  /** Resolves once the subscription is active, or after a short wait if Valkey is down. */
  subscribe(workspaceId: string, subscriber: string, session: Session): Promise<() => void>;
  stop(): void;
}

/** Sends signals, for a process such as the worker that holds no streams. */
export type Signals = Pick<Live, "wake" | "revoke" | "tell">;

/** For the OpenAPI document and for tests that need no live delivery. */
export const noLive: Live = {
  wake() {},
  revoke() {},
  tell() {},
  async subscribe() {
    return () => {};
  },
  stop() {},
};

const SUBSCRIBE_WAIT_MS = 2000;
/** After a reconnect, streams wake 500 a second: 1,000 streams take 2 s, 20,000 take 40 s. */
const WAKE_BATCH = 50;
const WAKE_BATCH_MS = 100;

const channelFor = (workspaceId: string) => `dinghy:signals:${workspaceId}`;

/** Publishes signals. Each one follows a commit, so a failure only delays delivery. */
export function createSignals(publisher: Redis, logger: Logger): Signals {
  const publish = (workspaceId: string, payload: string) => {
    publisher.publish(channelFor(workspaceId), payload).catch((err: unknown) => {
      logger.warn({ err }, "could not publish a signal");
    });
  };
  return {
    wake(workspaceId, subscriber) {
      publish(workspaceId, `wake:${subscriber}`);
    },
    revoke(workspaceId, subscriber) {
      publish(workspaceId, `revoke:${subscriber}`);
    },
    tell(workspaceId, notice) {
      publish(workspaceId, `${TELL}${JSON.stringify(notice)}`);
    },
  };
}

/** A notice's prefix. Its JSON holds colons, so it is read before the other signals are split. */
const TELL = "tell:";

interface WorkspaceEntry {
  visitors: Map<string, Set<Session>>;
  /** Settles when this instance is subscribed, or after a short wait if Valkey is down. */
  subscribed: Promise<void>;
}

/**
 * Connects streams on this instance to signals from every instance. Valkey Pub/Sub has no replay,
 * so a signal can be lost at any time: it only wakes a stream, which then reads from Postgres.
 */
export function createLive(publisher: Redis, url: string, logger: Logger): Live {
  // A subscriber waits through an outage, and autoResubscribe restores its channels afterward.
  const subscriber = new Redis(url, { maxRetriesPerRequest: null });
  const workspaces = new Map<string, WorkspaceEntry>();

  const allSessions = () =>
    [...workspaces.values()].flatMap(({ visitors }) =>
      [...visitors.values()].flatMap((sessions) => [...sessions]),
    );

  subscriber.on("error", (err) => logger.error({ err }, "valkey subscriber error"));
  subscriber.on("ready", () => {
    // autoResubscribe restores only acknowledged channels, and a fatal error can reject a queued
    // subscribe. Subscribing twice is harmless.
    const channels = [...workspaces.keys()].map(channelFor);
    if (channels.length > 0) {
      subscriber.subscribe(...channels).catch((err: unknown) => {
        logger.warn({ err }, "could not subscribe");
      });
    }
    // Signals sent while it was away are gone, so every stream reads again. This includes the
    // first connection, because streams can open while Valkey is down.
    // A few at a time, because each wake runs reads, and all at once would take every connection.
    const sessions = allSessions();
    const next = () => {
      for (const session of sessions.splice(0, WAKE_BATCH)) session.wake();
      if (sessions.length > 0) setTimeout(next, WAKE_BATCH_MS).unref();
    };
    setImmediate(next);
  });
  subscriber.on("message", (channel: string, payload: string) => {
    const workspaceId = channel.slice(channelFor("").length);
    const visitors = workspaces.get(workspaceId)?.visitors;
    if (payload.startsWith(TELL)) {
      for (const session of visitors?.get(OPERATORS) ?? [])
        session.tell?.(payload.slice(TELL.length));
      return;
    }
    const [type, visitorId = ""] = payload.split(":");
    if (type === "revoke" && visitorId === VISITORS) {
      for (const [id, sessions] of visitors ?? []) {
        if (id !== OPERATORS) for (const session of sessions) session.close("revoked");
      }
      return;
    }
    for (const session of visitors?.get(visitorId) ?? []) {
      if (type === "wake") session.wake();
      if (type === "revoke") session.close("revoked");
    }
  });

  const signals = createSignals(publisher, logger);

  const subscribeChannel = async (workspaceId: string) => {
    await Promise.race([
      // A rejection must not stay in the shared promise, or it would refuse every later stream.
      subscriber.subscribe(channelFor(workspaceId)).catch((err: unknown) => {
        logger.warn({ err }, "could not subscribe");
      }),
      delay(SUBSCRIBE_WAIT_MS, undefined, { ref: false }),
    ]);
  };

  return {
    ...signals,
    async subscribe(workspaceId, visitorId, session) {
      let entry = workspaces.get(workspaceId);
      if (entry === undefined) {
        entry = { visitors: new Map(), subscribed: subscribeChannel(workspaceId) };
        workspaces.set(workspaceId, entry);
      }
      const { visitors } = entry;
      let sessions = visitors.get(visitorId);
      if (sessions === undefined) {
        sessions = new Set();
        visitors.set(visitorId, sessions);
      }
      // Register before waiting, so another stream's cleanup cannot drop this workspace's entry.
      sessions.add(session);
      await entry.subscribed;
      return () => {
        sessions.delete(session);
        if (sessions.size === 0) visitors.delete(visitorId);
        if (visitors.size === 0) {
          workspaces.delete(workspaceId);
          subscriber.unsubscribe(channelFor(workspaceId)).catch((err: unknown) => {
            logger.warn({ err }, "could not unsubscribe");
          });
        }
      };
    },
    stop() {
      for (const session of allSessions()) session.close("stopping");
      subscriber.disconnect();
    },
  };
}

/** After a new message: wakes the visitor's streams and every operator stream. */
export function wakeConversation(live: Signals, workspaceId: string, visitorId: string): void {
  live.wake(workspaceId, visitorId);
  live.wake(workspaceId, OPERATORS);
}
