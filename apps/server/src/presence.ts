import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { operator } from "./db/schema.ts";
import { type Database, operatorWorkspaces } from "./db/tenant.ts";
import {
  MEMBER_ERRORS,
  OPERATOR_POST_ERRORS,
  OPERATOR_WRITE_ERRORS,
  okContent,
  WIDGET_ERRORS,
} from "./errors.ts";
import { visitorAuthorId } from "./identity.ts";
import { OPEN_WHILE_CLOSED, workspaceParams } from "./member.ts";
import { headerReplySeconds } from "./widget-settings.ts";

// A client that stops sending, because of a crash or a lost network, expires after this long.
const DEFAULT_TTL_MS = 30_000;
// Browsers run a hidden tab's timers about once a minute, so its beats come further apart: 2 minutes
// with the default.
const HIDDEN_TTL_FACTOR = 4;
const NO_CONVERSATION = "-";

const keyFor = (workspaceId: string) => `dinghy:presence:${workspaceId}`;
const memberFor = (operatorId: string, conversationId: string | null) =>
  `${operatorId}|${conversationId ?? NO_CONVERSATION}`;

interface PresenceState {
  /** Conversation ID to the operators who have it open. */
  viewers: Record<string, string[]>;
}

interface Beat {
  /** The conversation open now. A hidden tab has none. */
  viewing: string | null;
  /** The conversation open before, which this beat leaves. */
  left: string | null;
  /** A hidden tab, which beats less often, so its mark lasts longer. */
  hidden: boolean;
  /** The operator set Away: the beat says what they view, and does not count them online. */
  away: boolean;
}

export interface Presence {
  /** Marks the operator on this conversation, and online unless away. Null if Valkey cannot answer. */
  beat(workspaceId: string, operatorId: string, beat: Beat): Promise<PresenceState | null>;
  /** Ends the operator's online mark, and their mark on this conversation. */
  leave(workspaceId: string, operatorId: string, conversationId: string | null): Promise<void>;
  /** Ends only the mark on this conversation: another tab may keep the operator online. */
  close(workspaceId: string, operatorId: string, conversationId: string): Promise<void>;
  /**
   * The operators online now, who are not away. Null means unknown, so a caller must not tell a
   * visitor that the team is away.
   */
  online(workspaceId: string): Promise<string[] | null>;
}

/** Presence lives only in Valkey. Losing it loses nothing, and every read and write can fail. */
export function createPresence(
  valkey: Redis | null,
  logger: Logger,
  ttlMs = DEFAULT_TTL_MS,
): Presence {
  const attempt = async <T>(work: (client: Redis) => Promise<T>): Promise<T | null> => {
    if (valkey === null) return null;
    try {
      return await work(valkey);
    } catch (err) {
      logger.warn({ err }, "presence is unavailable");
      return null;
    }
  };

  return {
    beat(workspaceId, operatorId, { viewing, left, hidden, away }) {
      return attempt(async (client) => {
        const key = keyFor(workspaceId);
        const now = Date.now();
        const expires = now + (hidden ? ttlMs * HIDDEN_TTL_FACTOR : ttlMs);
        const online = memberFor(operatorId, null);
        const batch = client.multi().zremrangebyscore(key, "-inf", now);
        if (left !== null && left !== viewing) batch.zrem(key, memberFor(operatorId, left));
        // GT: another of the operator's tabs, hidden and so marked for longer, keeps its mark.
        if (away) batch.zrem(key, online);
        else batch.zadd(key, "GT", expires, online);
        if (viewing !== null) batch.zadd(key, expires, memberFor(operatorId, viewing));
        // A workspace that everyone left does not keep its key. Twice the longest mark, so the key
        // outlives every mark in it.
        batch.pexpire(key, ttlMs * HIDDEN_TTL_FACTOR * 2);
        batch.zrange(key, 0, -1);
        const results = await batch.exec();
        const last = results?.at(-1);
        if (last === undefined || last[0] !== null) throw new Error("The presence write failed");
        const viewers: Record<string, string[]> = {};
        for (const member of last[1] as string[]) {
          const [operator = "", conversation = NO_CONVERSATION] = member.split("|");
          if (conversation !== NO_CONVERSATION) {
            viewers[conversation] = [...(viewers[conversation] ?? []), operator];
          }
        }
        return { viewers };
      });
    },
    async leave(workspaceId, operatorId, conversationId) {
      await attempt((client) => {
        const members = [memberFor(operatorId, null)];
        if (conversationId !== null) members.push(memberFor(operatorId, conversationId));
        return client.zrem(keyFor(workspaceId), ...members);
      });
    },
    async close(workspaceId, operatorId, conversationId) {
      await attempt((client) =>
        client.zrem(keyFor(workspaceId), memberFor(operatorId, conversationId)),
      );
    },
    online(workspaceId) {
      return attempt(async (client) => {
        const members = await client.zrangebyscore(keyFor(workspaceId), Date.now(), "+inf");
        const suffix = `|${NO_CONVERSATION}`;
        return members.flatMap((member) =>
          member.endsWith(suffix) ? [member.slice(0, -suffix.length)] : [],
        );
      });
    },
  };
}

/** A visitor counts as online while one of their widget streams is open. */
export interface VisitorPresence {
  /** Marks one open stream until `release`. It refreshes itself, so a dead instance's mark lapses. */
  open(workspaceId: string, visitorId: string): { release(): void };
  /** Null means unknown, so the operator app shows nothing rather than a wrong state. */
  online(workspaceId: string, visitorId: string): Promise<boolean | null>;
}

const visitorKey = (workspaceId: string, visitorId: string) =>
  `dinghy:visitor-online:${workspaceId}:${visitorId}`;

/** Each open stream is one member of a sorted set, scored by when it lapses, as operators are. */
export function createVisitorPresence(
  valkey: Redis | null,
  logger: Logger,
  ttlMs = DEFAULT_TTL_MS,
): VisitorPresence {
  const write = (work: (client: Redis) => Promise<unknown>) => {
    if (valkey === null) return;
    work(valkey).catch((err: unknown) => logger.warn({ err }, "visitor presence is unavailable"));
  };
  return {
    open(workspaceId, visitorId) {
      const key = visitorKey(workspaceId, visitorId);
      const member = randomUUID();
      const mark = () =>
        write((client) =>
          client
            .multi()
            .zremrangebyscore(key, "-inf", Date.now())
            .zadd(key, Date.now() + ttlMs, member)
            .pexpire(key, ttlMs * 2)
            .exec(),
        );
      mark();
      const timer = setInterval(mark, ttlMs / 3);
      timer.unref();
      return {
        release() {
          clearInterval(timer);
          write((client) => client.zrem(key, member));
        },
      };
    },
    async online(workspaceId, visitorId) {
      if (valkey === null) return null;
      try {
        return (await valkey.zcount(visitorKey(workspaceId, visitorId), Date.now(), "+inf")) > 0;
      } catch (err) {
        logger.warn({ err }, "visitor presence is unavailable");
        return null;
      }
    },
  };
}

const beatRoute = createRoute({
  method: "put",
  ...OPEN_WHILE_CLOSED,
  path: "/v1/operator/workspaces/{workspaceId}/presence",
  security: SESSION,
  summary: "Say that this operator is online, and which conversation is open",
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: {
        "application/json": {
          // A hidden tab is not looking at a conversation.
          schema: z
            .object({
              viewing: z.uuid().nullable(),
              left: z.uuid().nullable(),
              hidden: z.boolean(),
            })
            .refine((beat) => !beat.hidden || beat.viewing === null),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Who has each conversation open. It is empty if Valkey cannot answer.",
      content: {
        "application/json": {
          schema: z.object({ viewers: z.record(z.string(), z.array(z.string())) }),
        },
      },
    },
    ...MEMBER_ERRORS,
    ...OPERATOR_WRITE_ERRORS,
  },
});

const leaveRoute = createRoute({
  method: "post",
  ...OPEN_WHILE_CLOSED,
  path: "/v1/operator/workspaces/{workspaceId}/presence/leave",
  security: SESSION,
  summary: "Say that a tab of this operator's app closed, or that the operator signed out",
  description:
    "A closing tab ends only its mark on the conversation it showed, as another tab may still keep the operator online, and the online mark expires on its own. A sign-out ends the online mark too.",
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ conversationId: z.uuid().nullable(), signingOut: z.boolean() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Done",
      content: okContent,
    },
    ...MEMBER_ERRORS,
    ...OPERATOR_WRITE_ERRORS,
  },
});

const widgetRoute = createRoute({
  method: "get",
  path: "/v1/widget/{key}/presence",
  summary: "Say whether the team is online, and which of the header's members are",
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: {
      description: "True or false, or null if this server cannot tell",
      content: {
        "application/json": {
          schema: z.object({
            online: z.boolean().nullable(),
            // The members online now, by the same hash as `authorId` on their replies, so the
            // header can mark their faces. Empty when this server cannot tell.
            members: z.array(z.string()),
            emailReplies: z.boolean(),
            // The header's usual reply time: the 30-day median first reply, in seconds. Null when
            // nobody is online, when the header shows "Online" instead, or with no reply to measure.
            replySeconds: z.number().nullable(),
          }),
        },
      },
    },
    ...WIDGET_ERRORS,
  },
});

const statusRoute = createRoute({
  method: "put",
  path: "/v1/operator/me/status",
  security: SESSION,
  summary:
    "Set yourself available or away, in every workspace. While away, the widget does not count you online.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.strictObject({ away: z.boolean() }) } },
    },
  },
  responses: {
    200: {
      description: "The status now",
      content: { "application/json": { schema: z.object({ away: z.boolean() }) } },
    },
    ...OPERATOR_POST_ERRORS,
  },
});

export function registerOperatorPresence(app: App, db: Database, presence: Presence): void {
  app.openapi(beatRoute, async (c) => {
    const state = await presence.beat(c.get("memberWorkspaceId"), c.get("operatorId"), {
      ...c.req.valid("json"),
      away: c.get("operatorAway"),
    });
    return c.json({ viewers: state?.viewers ?? {} }, 200);
  });

  app.openapi(statusRoute, async (c) => {
    const { away } = c.req.valid("json");
    const id = c.get("operatorId");
    await db.update(operator).set({ away }).where(eq(operator.id, id));
    // At once, so the widget says away at its next ask. Being available waits for the next beat.
    if (away) {
      const memberships = await operatorWorkspaces(db, id);
      await Promise.all(
        memberships.map(({ workspaceId }) => presence.leave(workspaceId, id, null)),
      );
    }
    return c.json({ away }, 200);
  });

  app.openapi(leaveRoute, async (c) => {
    const { conversationId, signingOut } = c.req.valid("json");
    const workspaceId = c.get("memberWorkspaceId");
    const operatorId = c.get("operatorId");
    if (signingOut) await presence.leave(workspaceId, operatorId, conversationId);
    else if (conversationId !== null) await presence.close(workspaceId, operatorId, conversationId);
    return c.json({ ok: true as const }, 200);
  });
}

/** Only an open panel asks, every 30 seconds, so the reply time costs a page view nothing. */
export function registerWidgetPresence(
  app: App,
  db: Database,
  presence: Presence,
  emailReplies: boolean,
): void {
  app.openapi(widgetRoute, async (c) => {
    const workspaceId = c.get("workspace").id;
    const members = await presence.online(workspaceId);
    const isOnline = members === null ? null : members.length > 0;
    return c.json(
      {
        online: isOnline,
        members: (members ?? []).map(visitorAuthorId),
        emailReplies,
        replySeconds: isOnline === true ? await headerReplySeconds(db, workspaceId) : null,
      },
      200,
    );
  });
}
