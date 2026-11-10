import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { MEMBER_ERRORS, OPERATOR_WRITE_ERRORS, okContent, WIDGET_ERRORS } from "./errors.ts";
import type { LogoUrl } from "./logo.ts";
import { OPEN_WHILE_CLOSED } from "./member.ts";

// A client that stops sending, because of a crash or a lost network, expires after this long.
const DEFAULT_TTL_MS = 30_000;
const NO_CONVERSATION = "-";

const keyFor = (workspaceId: string) => `dinghy:presence:${workspaceId}`;
const memberFor = (operatorId: string, conversationId: string | null) =>
  `${operatorId}|${conversationId ?? NO_CONVERSATION}`;

interface PresenceState {
  online: boolean;
  /** Conversation ID to the operators who have it open. */
  viewers: Record<string, string[]>;
}

interface Presence {
  /** Marks the operator online and on this conversation. Returns null if Valkey cannot answer. */
  beat(
    workspaceId: string,
    operatorId: string,
    viewing: string | null,
    left: string | null,
  ): Promise<PresenceState | null>;
  leave(workspaceId: string, operatorId: string, conversationId: string | null): Promise<void>;
  /** Null means unknown, so a caller must not tell a visitor that the team is away. */
  online(workspaceId: string): Promise<boolean | null>;
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
    beat(workspaceId, operatorId, viewing, left) {
      return attempt(async (client) => {
        const key = keyFor(workspaceId);
        const now = Date.now();
        const expires = now + ttlMs;
        const batch = client.multi().zremrangebyscore(key, "-inf", now);
        if (left !== null && left !== viewing) batch.zrem(key, memberFor(operatorId, left));
        batch.zadd(key, expires, memberFor(operatorId, null));
        if (viewing !== null) batch.zadd(key, expires, memberFor(operatorId, viewing));
        // A workspace that everyone left does not keep its key.
        batch.pexpire(key, ttlMs * 2);
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
        return { online: true, viewers };
      });
    },
    async leave(workspaceId, operatorId, conversationId) {
      await attempt((client) => {
        const members = [memberFor(operatorId, null)];
        if (conversationId !== null) members.push(memberFor(operatorId, conversationId));
        return client.zrem(keyFor(workspaceId), ...members);
      });
    },
    online(workspaceId) {
      return attempt(
        async (client) => (await client.zcount(keyFor(workspaceId), Date.now(), "+inf")) > 0,
      );
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

const params = z.object({ workspaceId: z.uuid() });

const beatRoute = createRoute({
  method: "put",
  ...OPEN_WHILE_CLOSED,
  path: "/v1/operator/workspaces/{workspaceId}/presence",
  security: SESSION,
  summary: "Say that this operator is online, and which conversation is open",
  request: {
    params,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ viewing: z.uuid().nullable(), left: z.uuid().nullable() }),
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
  summary: "Say that this operator's app is no longer showing",
  request: {
    params,
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ conversationId: z.uuid().nullable() }) },
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
  summary: "Say whether the team is online. It names nobody.",
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: {
      description: "True or false, or null if this server cannot tell",
      content: {
        "application/json": {
          schema: z.object({
            online: z.boolean().nullable(),
            emailReplies: z.boolean(),
            // The workspace's own widget text. Null means the widget's default.
            texts: z.object({
              title: z.string().nullable(),
              greeting: z.string().nullable(),
              away: z.string().nullable(),
            }),
            // The workspace's logo, which the widget shows in place of its boat. Null with none.
            logoUrl: z.string().nullable(),
          }),
        },
      },
    },
    ...WIDGET_ERRORS,
  },
});

export function registerOperatorPresence(app: App, presence: Presence): void {
  app.openapi(beatRoute, async (c) => {
    const { viewing, left } = c.req.valid("json");
    const state = await presence.beat(
      c.get("memberWorkspaceId"),
      c.get("operatorId"),
      viewing,
      left,
    );
    return c.json({ viewers: state?.viewers ?? {} }, 200);
  });

  app.openapi(leaveRoute, async (c) => {
    const { conversationId } = c.req.valid("json");
    await presence.leave(c.get("memberWorkspaceId"), c.get("operatorId"), conversationId);
    return c.json({ ok: true as const }, 200);
  });
}

export function registerWidgetPresence(
  app: App,
  presence: Presence,
  emailReplies: boolean,
  logoUrl: LogoUrl,
): void {
  app.openapi(widgetRoute, async (c) => {
    const { id, texts, logoUpdatedAt } = c.get("workspace");
    const key = c.req.valid("param").key;
    return c.json(
      {
        online: await presence.online(id),
        emailReplies,
        texts,
        logoUrl: logoUrl(key, logoUpdatedAt),
      },
      200,
    );
  });
}
