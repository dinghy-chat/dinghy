import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  SAVED_REPLY_BODY_MAX,
  SAVED_REPLY_LIMIT,
  SAVED_REPLY_SHORTCUT,
} from "../../../packages/widget/src/shared.ts";
import { SESSION, SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { savedReply } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  jsonAnswer,
  jsonBody,
  KEY_LIMITED,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  okContent,
} from "./errors.ts";
import { boundedText } from "./inputs.ts";
import type { Live } from "./live.ts";
import { WORKSPACE_PREFIX } from "./member.ts";
import { changeWorkspace } from "./messages.ts";

const PREFIX = `${WORKSPACE_PREFIX}/{workspaceId}/saved-replies`;

const LIMIT = failure(
  "saved_reply_limit",
  `A workspace can have ${SAVED_REPLY_LIMIT} saved replies.`,
);
const SHORTCUT_TAKEN = failure(
  "saved_reply_shortcut_taken",
  "Another saved reply has this shortcut.",
);

const Shortcut = z.string().regex(SAVED_REPLY_SHORTCUT).openapi({
  description:
    "What an operator types after `/` to find it: up to 32 lowercase letters, digits and dashes, starting with a letter or digit. Unique in the workspace.",
  example: "refund-policy",
});
const ReplyBody = boundedText(SAVED_REPLY_BODY_MAX).openapi({
  description: "The text the composer inserts, in the same Markdown as a message",
});

const SavedReply = z
  .object({
    id: z.string(),
    shortcut: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .openapi("SavedReply", {
    example: {
      id: "3f6b2c1e-8d4a-4e7f-9b05-1a2c3d4e5f60",
      shortcut: "refund-policy",
      body: "You can get a full refund within 30 days. Reply here and we will start it.",
      updatedAt: "2026-11-13T10:00:00.000Z",
    },
  });

const workspaceParams = z.object({ workspaceId: z.uuid() });
const savedReplyParams = workspaceParams.extend({ savedReplyId: z.uuid() });

const WRITE_ERRORS = {
  ...MEMBER_WRITE_ERRORS,
  409: errorAnswer(
    `saved_reply_shortcut_taken: another saved reply has this shortcut. saved_reply_limit: the workspace has ${SAVED_REPLY_LIMIT} already`,
  ),
};

const listRoute = createRoute({
  method: "get",
  path: PREFIX,
  security: SESSION_OR_KEY,
  summary: "List the team's saved replies, by shortcut",
  request: { params: workspaceParams },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer("The saved replies", z.object({ savedReplies: z.array(SavedReply) })),
    ...MEMBER_ERRORS,
  },
});

const addRoute = createRoute({
  method: "post",
  path: PREFIX,
  security: SESSION,
  summary: `Add a saved reply. Any member can, up to ${SAVED_REPLY_LIMIT} per workspace`,
  request: {
    params: workspaceParams,
    body: jsonBody(z.object({ shortcut: Shortcut, body: ReplyBody })),
  },
  responses: { 201: jsonAnswer("The saved reply", SavedReply), ...WRITE_ERRORS },
});

const changeRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/{savedReplyId}`,
  security: SESSION,
  summary: "Change a saved reply's shortcut or text. Any member can",
  request: {
    params: savedReplyParams,
    body: jsonBody(z.object({ shortcut: Shortcut.optional(), body: ReplyBody.optional() })),
  },
  responses: { 200: jsonAnswer("The saved reply", SavedReply), ...WRITE_ERRORS },
});

const deleteRoute = createRoute({
  method: "delete",
  path: `${PREFIX}/{savedReplyId}`,
  security: SESSION,
  summary: "Delete a saved reply. Any member can",
  request: { params: savedReplyParams },
  responses: { 200: { description: "Deleted", content: okContent }, ...MEMBER_WRITE_ERRORS },
});

const columns = {
  id: savedReply.id,
  shortcut: savedReply.shortcut,
  body: savedReply.body,
  updatedAt: savedReply.updatedAt,
};

const view = (row: Omit<typeof savedReply.$inferSelect, "workspaceId">) => ({
  ...row,
  updatedAt: row.updatedAt.toISOString(),
});

/** The workspace's saved replies, by shortcut. */
export async function listSavedReplies(tx: Transaction, workspaceId: string) {
  const rows = await tx
    .select(columns)
    .from(savedReply)
    .where(eq(savedReply.workspaceId, workspaceId))
    .orderBy(asc(savedReply.shortcut));
  return rows.map(view);
}

/**
 * Takes the workspace's saved-reply lock and refuses what would pass the limit or repeat a
 * shortcut. Two writes at once take turns, so neither can slip past the other's check. The saved
 * reply that changes is null for a new one.
 */
async function refusal(
  tx: Transaction,
  workspaceId: string,
  shortcut: string | undefined,
  savedReplyId: string | null,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`saved-replies:${workspaceId}`}))`);
  const rows = await tx
    .select({ id: savedReply.id, shortcut: savedReply.shortcut })
    .from(savedReply)
    .where(eq(savedReply.workspaceId, workspaceId));
  if (savedReplyId === null && rows.length >= SAVED_REPLY_LIMIT) return LIMIT;
  const taken = rows.some((row) => row.shortcut === shortcut && row.id !== savedReplyId);
  return taken ? SHORTCUT_TAKEN : null;
}

/**
 * The saved replies routes. Each write records `workspace.changed` and wakes the open operator apps,
 * which then load the saved replies again. A lost wake only delays it until the next one.
 */
export function registerSavedReplyRoutes(app: App, db: Database, live: Live): void {
  const thisReply = (workspaceId: string, savedReplyId: string) =>
    and(eq(savedReply.workspaceId, workspaceId), eq(savedReply.id, savedReplyId));

  app.openapi(listRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const savedReplies = await withWorkspace(db, id, (tx) => listSavedReplies(tx, id));
    return c.json({ savedReplies }, 200);
  });

  app.openapi(addRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const input = c.req.valid("json");
    const outcome = await changeWorkspace(db, live, id, async (tx) => {
      const refused = await refusal(tx, id, input.shortcut, null);
      if (refused !== null) return refused;
      const [row] = await tx
        .insert(savedReply)
        .values({ workspaceId: id, ...input })
        .returning(columns);
      if (row === undefined) throw new Error("The saved reply insert returned no row");
      return view(row);
    });
    if ("error" in outcome) return c.json(outcome, 409);
    return c.json(outcome, 201);
  });

  app.openapi(changeRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { savedReplyId } = c.req.valid("param");
    const input = c.req.valid("json");
    const outcome = await changeWorkspace(db, live, id, async (tx) => {
      const refused = await refusal(tx, id, input.shortcut, savedReplyId);
      if (refused !== null) return refused;
      const [row] = await tx
        .update(savedReply)
        .set({ ...input, updatedAt: sql`now()` })
        .where(thisReply(id, savedReplyId))
        .returning(columns);
      return row === undefined ? null : view(row);
    });
    if (outcome === null) return c.json(NOT_FOUND, 404);
    if ("error" in outcome) return c.json(outcome, 409);
    return c.json(outcome, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { savedReplyId } = c.req.valid("param");
    const outcome = await changeWorkspace(db, live, id, async (tx) => {
      const deleted = await tx
        .delete(savedReply)
        .where(thisReply(id, savedReplyId))
        .returning({ id: savedReply.id });
      return deleted.length === 0 ? null : { ok: true as const };
    });
    if (outcome === null) return c.json(NOT_FOUND, 404);
    return c.json(outcome, 200);
  });
}
