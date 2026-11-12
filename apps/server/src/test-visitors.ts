import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { KEY_REQUESTS_PER_MINUTE } from "./api-keys.ts";
import { SESSION_OR_SETUP_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { deleteContacts } from "./contacts.ts";
import { conversation, visitor } from "./db/schema.ts";
import {
  type Database,
  type Transaction,
  type WorkspaceAccess,
  withWorkspace,
} from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  jsonAnswer,
  jsonBody,
  KEY_LIMITED,
  NOT_FOUND,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { newBrowserToken, sha256Hex } from "./identity.ts";
import { InboxMessage, messageView } from "./inbox.ts";
import { Body } from "./inputs.ts";
import { type Live, OPERATORS, wakeConversation } from "./live.ts";
import { closedFailure, OPEN_WHILE_CLOSED, WORKSPACE_PREFIX } from "./member.ts";
import { appendMessage, catchClosed, joinVisitor, WorkspaceClosedError } from "./messages.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { requireSetUp } from "./team.ts";
import { MINUTE_SECONDS } from "./time.ts";

/** Simulated visitor messages a workspace may send in a minute. */
export const TEST_MESSAGES_PER_MINUTE = 10;

/** The answer to a test message over the limit. */
export const testMessagesLimited = (waitSeconds: number) =>
  failure(
    "too_many_requests",
    `Over ${TEST_MESSAGES_PER_MINUTE} test messages a minute. Retry in ${waitSeconds} seconds.`,
  );

export const TestMessageInput = z.object({
  body: Body.describe("What the test visitor writes"),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u)
    .optional()
    .describe("The test visitor's name, as operators see it"),
  conversationId: z
    .uuid()
    .optional()
    .describe(
      "A test conversation to write in again, from an earlier answer. Without it, a new test visitor starts a new conversation",
    ),
});
type TestMessage = z.output<typeof TestMessageInput>;

type Simulated =
  | {
      kind: "sent";
      visitorId: string;
      conversationId: string;
      message: ReturnType<typeof messageView>;
    }
  | { kind: "missing" }
  | { kind: "limited"; waitSeconds: number }
  | { kind: "closed"; access: WorkspaceAccess };

/** The test visitor of a test conversation, or a new one. Null for a conversation that is not a test's. */
async function testVisitor(tx: Transaction, workspaceId: string, input: TestMessage) {
  if (input.conversationId === undefined) {
    const [made] = await tx
      .insert(visitor)
      // Signed out, with a token nobody holds, so no browser can read this chat.
      .values({
        workspaceId,
        tokenHash: sha256Hex(newBrowserToken()),
        isTest: true,
        name: input.name,
      })
      .returning({ id: visitor.id });
    return made?.id ?? null;
  }
  const [found] = await tx
    .select({ id: visitor.id })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.id, input.conversationId),
        eq(visitor.isTest, true),
      ),
    );
  if (found !== undefined && input.name !== undefined) {
    await tx
      .update(visitor)
      .set({ name: input.name })
      .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, found.id)));
  }
  return found?.id ?? null;
}

/**
 * A bot's test visitors: they write through the widget's own send, so events, webhooks and the
 * operator app see them, with `visitor.isTest` set. Analytics, contacts and alerts leave them out.
 */
export function createTestVisitors({
  db,
  live,
  rateLimit,
}: {
  db: Database;
  live: Live;
  rateLimit: RateLimit;
}) {
  return {
    async send(workspaceId: string, input: TestMessage): Promise<Simulated> {
      const wait = await rateLimit.hit(
        "test-visitor",
        workspaceId,
        TEST_MESSAGES_PER_MINUTE,
        MINUTE_SECONDS,
      );
      if (wait !== null) return { kind: "limited", waitSeconds: wait };
      const result = await catchClosed(
        withWorkspace(db, workspaceId, async (tx) => {
          const visitorId = await testVisitor(tx, workspaceId, input);
          if (visitorId === null) return null;
          const sent = await appendMessage(
            tx,
            workspaceId,
            { kind: "visitor", visitorId },
            { clientId: randomUUID(), body: input.body, page: null },
          );
          return { visitorId, message: sent.message };
        }),
      );
      if (result instanceof WorkspaceClosedError) return { kind: "closed", access: result.access };
      if (result === null) return { kind: "missing" };
      wakeConversation(live, workspaceId, result.visitorId);
      return {
        kind: "sent",
        visitorId: result.visitorId,
        conversationId: result.message.conversationId,
        // A test message is text only, so it needs no image addresses.
        message: messageView(undefined, workspaceId, new Map(), result.message),
      };
    },

    /** Deletes every test visitor, with their conversations, messages and images. */
    async deleteAll(workspaceId: string): Promise<number> {
      const deleted = await withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select({ id: visitor.id })
          .from(visitor)
          .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.isTest, true)));
        return deleteContacts(
          tx,
          workspaceId,
          rows.map((row) => row.id),
        );
      });
      if (deleted > 0) live.wake(workspaceId, OPERATORS);
      return deleted;
    },
  };
}
export type TestVisitors = ReturnType<typeof createTestVisitors>;

// Routes ------------------------------------------------------------------------------------------

const PREFIX = `${WORKSPACE_PREFIX}/{workspaceId}/test-visitors`;
const workspaceParams = z.object({ workspaceId: z.uuid() });

const sendRoute = createRoute({
  method: "post",
  path: `${PREFIX}/messages`,
  security: SESSION_OR_SETUP_KEY,
  summary: `Send a message as a test visitor, to test a bot from end to end. At most ${TEST_MESSAGES_PER_MINUTE} a minute per workspace`,
  request: {
    params: workspaceParams,
    body: jsonBody(TestMessageInput),
  },
  responses: {
    201: jsonAnswer(
      "The test visitor, its conversation and the message",
      z.object({ visitorId: z.string(), conversationId: z.string(), message: InboxMessage }),
    ),
    ...ROLE_WRITE_ERRORS,
    404: errorAnswer("not_found: the conversation is not a test visitor's"),
    429: errorAnswer(
      `too_many_requests: over an API key's ${KEY_REQUESTS_PER_MINUTE} requests a minute, or the workspace's ${TEST_MESSAGES_PER_MINUTE} test messages a minute. Retry after \`retry-after\``,
    ),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  ...OPEN_WHILE_CLOSED,
  path: PREFIX,
  security: SESSION_OR_SETUP_KEY,
  summary: "Delete every test visitor, with their conversations, messages and images",
  request: { params: workspaceParams },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer("How many test visitors were deleted", z.object({ deleted: z.number().int() })),
    ...ROLE_WRITE_ERRORS,
  },
});

export function registerTestVisitorRoutes(app: App, testVisitors: TestVisitors): void {
  requireSetUp(app, [sendRoute, deleteRoute]);
  app.openapi(sendRoute, async (c) => {
    const sent = await testVisitors.send(c.get("memberWorkspaceId"), c.req.valid("json"));
    if (sent.kind === "limited") return tooManyRequests(c, sent.waitSeconds);
    if (sent.kind === "missing") return c.json(NOT_FOUND, 404);
    if (sent.kind === "closed") {
      const refused = closedFailure(sent.access);
      return c.json(refused.body, refused.status);
    }
    const { kind: _kind, ...answer } = sent;
    return c.json(answer, 201);
  });

  app.openapi(deleteRoute, async (c) => {
    return c.json({ deleted: await testVisitors.deleteAll(c.get("memberWorkspaceId")) }, 200);
  });
}
