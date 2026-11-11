import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "pino";
import type { CloseReason, Live, Session } from "./live.ts";
import { type Cursor, formatCursor } from "./messages.ts";

export interface StreamOptions {
  heartbeatMs: number;
  lifetimeMs: number;
}

export const DEFAULT_STREAM: StreamOptions = {
  // Cloudflare drops an idle proxied connection after about 100 seconds.
  heartbeatMs: 25_000,
  // A cap, so a client recovers from any lost signal and its access gets checked again.
  lifetimeMs: 15 * 60_000,
};

/**
 * How long a stream's slot in the workspace's stream limit lasts. A stream ends within lifetimeMs,
 * so a minute more means a slot never expires under an open stream, and the slots of an instance
 * that crashed free themselves soon after.
 */
export const streamLeaseMs = (options: StreamOptions) => options.lifetimeMs + 60_000;

const CLOSE_WRITE_WAIT_MS = 1000;

/** The `close` event's reasons, for the two streams' OpenAPI descriptions. */
export const CLOSE_REASONS_TEXT =
  "A `close` event's data is `{ reason }`: `lifetime` (the stream reached its 15-minute cap), " +
  "`expired` (the host token expired), `revoked` (access was taken away, such as a block, a " +
  "suspension or a removal), `unauthorized` (the token or session is no longer valid), " +
  "`stopping` (the server is shutting down) or `error`. Reconnect from the last cursor, except " +
  "after `unauthorized`, which needs a new token or sign-in.";

interface FeedPage {
  items: { event: string; seq: bigint; data: unknown }[];
  cursor: Cursor;
  hasMore: boolean;
  /** The cursor is from before a restore or an import, so the client must load from the start. */
  resync: boolean;
}

interface LiveStream {
  live: Live;
  logger: Logger;
  options: StreamOptions;
  workspaceId: string;
  /** Whose signals wake this stream: a visitor's ID, or OPERATORS. */
  subscriber: string;
  expiresAt: Date | undefined;
  after: Cursor | undefined;
  /** Passes on operator notices as `notice` events, which carry no cursor. */
  notices?: boolean;
  /** Frees this stream's place in the plan's count when it ends. */
  release?: (() => void) | undefined;
  /**
   * Checks that this client may still read, before each page. It must read current data, not a
   * cached answer. A stream that checks inside its read leaves this out.
   */
  authorized?: () => Promise<boolean>;
  /** A page, or null when the client may no longer read. */
  read(after: Cursor | undefined): Promise<FeedPage | null>;
}

/**
 * A live feed. Each wake runs one ordered read from the stream's last delivered
 * cursor, and only one read runs at a time. Publication order therefore never matters. No read
 * holds a transaction between wakes, so an open stream uses no database connection.
 */
export function openLiveStream(c: Context, stream: LiveStream): Response {
  const { live, logger, options, workspaceId, subscriber } = stream;
  c.header("cache-control", "no-store");
  // nginx and some other proxies hold a response until it ends, unless this says not to.
  c.header("x-accel-buffering", "no");
  return streamSSE(c, async (sse) => {
    let cursor = stream.after;
    let closed = false;
    // True until the first read, so a wake during the subscribe wait cannot start it early.
    let reading = true;
    let wakeAgain = false;
    const { promise: finished, resolve: finish } = Promise.withResolvers<void>();

    const close = async (reason: CloseReason) => {
      // A client that stopped reading can block a write forever, so nothing waits on the client:
      // a disconnect ends the stream at once, and the close event gets a short wait.
      if (reason === "aborted") finish();
      if (closed) return;
      closed = true;
      if (reason === "aborted") return;
      await Promise.race([
        sse.writeSSE({ event: "close", data: JSON.stringify({ reason }) }).catch(() => undefined),
        delay(CLOSE_WRITE_WAIT_MS, undefined, { ref: false }),
      ]);
      finish();
    };

    const readOnce = async () => {
      for (let more = true; more && !closed; ) {
        // Before each page, because a long replay can outlast a session or a membership.
        const page =
          stream.authorized === undefined || (await stream.authorized())
            ? await stream.read(cursor)
            : null;
        if (page === null) {
          await close("unauthorized");
          return;
        }
        if (page.resync) {
          cursor = page.cursor;
          await sse.writeSSE({
            event: "resync",
            data: JSON.stringify({ cursor: formatCursor(cursor) }),
          });
          continue;
        }
        for (const item of page.items) {
          if (closed) return;
          await sse.writeSSE({
            event: item.event,
            id: formatCursor({ generation: page.cursor.generation, seq: item.seq }),
            data: JSON.stringify(item.data),
          });
        }
        cursor = page.cursor;
        more = page.hasMore;
      }
    };

    const wake = async () => {
      if (reading) {
        wakeAgain = true;
        return;
      }
      reading = true;
      try {
        do {
          wakeAgain = false;
          await readOnce();
        } while (wakeAgain && !closed);
      } catch (err) {
        // The client reconnects from its last cursor, so nothing is lost.
        if (!closed) logger.error({ err: safeName(err) }, "stream read failed");
        await close("error");
      } finally {
        reading = false;
      }
    };

    const session: Session = {
      wake: () => void wake(),
      close: (reason) => void close(reason),
      ...(stream.notices && {
        tell: (notice) => {
          // A notice that cannot be written is lost, which a notice may be.
          if (!closed) sse.writeSSE({ event: "notice", data: notice }).catch(() => undefined);
        },
      }),
    };
    sse.onAbort(() => void close("aborted"));

    // Subscribe before the first read, or a message between the two would wait for the next wake.
    const unsubscribe = await live.subscribe(workspaceId, subscriber, session);

    const heartbeat = setInterval(() => {
      if (!closed) sse.write(": ping\n\n").catch(() => void close("aborted"));
    }, options.heartbeatMs);
    // Jitter, so streams opened together do not all reconnect together.
    const lifetime = setTimeout(
      () => void close("lifetime"),
      options.lifetimeMs * (0.8 + Math.random() * 0.2),
    );
    const expiry =
      stream.expiresAt === undefined
        ? undefined
        : setTimeout(
            () => void close("expired"),
            Math.max(0, stream.expiresAt.getTime() - Date.now()),
          );

    const firstRead = async () => {
      reading = false;
      await wake();
      if (!closed) {
        await sse.writeSSE({
          event: "ready",
          data: JSON.stringify({ cursor: cursor === undefined ? null : formatCursor(cursor) }),
        });
      }
    };

    try {
      // A stalled client can block the first read, and it must not hold back the cleanup below.
      void firstRead().catch(() => close("error"));
      await finished;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      clearTimeout(expiry);
      unsubscribe();
      stream.release?.();
    }
  });
}

/** A read error can hold query parameters, which can hold chat text. */
function safeName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
