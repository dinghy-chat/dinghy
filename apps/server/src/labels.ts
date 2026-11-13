import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { SESSION, SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import {
  conversation,
  conversationLabel,
  event,
  LABEL_COLORS,
  LABEL_NAME_MAX,
  type LabeledPayload,
  label,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  jsonAnswer,
  jsonBody,
  KEY_LIMITED,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { boundedText } from "./inputs.ts";
import { type Live, OPERATORS } from "./live.ts";
import { WORKSPACE_PREFIX } from "./member.ts";
import { lockWorkspace, nextSeq, recordWorkspaceChange, wantsWebhook } from "./messages.ts";
import { allowed } from "./team.ts";

const LABEL_LIMIT = 100;
const PREFIX = `${WORKSPACE_PREFIX}/{workspaceId}/labels`;
const ON_CONVERSATION = `${WORKSPACE_PREFIX}/{workspaceId}/conversations/{conversationId}/labels/{labelId}`;

const LIMIT = failure(
  "label_limit",
  `A workspace can have ${LABEL_LIMIT} labels. An owner or admin can delete one.`,
);
const NAME_TAKEN = failure("label_name_taken", "Another label has this name.");

const Name = boundedText(LABEL_NAME_MAX)
  .regex(/^[^\r\n]*$/)
  .openapi({
    description: `Up to ${LABEL_NAME_MAX} characters on one line. Unique in the workspace, ignoring case.`,
    example: "Billing",
  });
const Color = z.enum(LABEL_COLORS);

const Label = z.object({ id: z.string(), name: z.string(), color: Color }).openapi("Label", {
  example: { id: "9b1f4c2e-6d3a-4e8b-a7c5-2f0d1e3b4a69", name: "Billing", color: "blue" },
});

const workspaceParams = z.object({ workspaceId: z.uuid() });
const labelParams = workspaceParams.extend({ labelId: z.uuid() });
const conversationLabelParams = labelParams.extend({ conversationId: z.uuid() });

const WRITE_ERRORS = {
  409: errorAnswer(
    `label_name_taken: another label has this name. label_limit: the workspace has ${LABEL_LIMIT} already`,
  ),
};

const listRoute = createRoute({
  method: "get",
  path: PREFIX,
  security: SESSION_OR_KEY,
  summary: "List the workspace's labels, by name",
  request: { params: workspaceParams },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer("The labels", z.object({ labels: z.array(Label) })),
    ...MEMBER_ERRORS,
  },
});

const addRoute = createRoute({
  method: "post",
  path: PREFIX,
  security: SESSION,
  summary: `Add a label. Any member can, up to ${LABEL_LIMIT} per workspace`,
  request: {
    params: workspaceParams,
    body: jsonBody(z.object({ name: Name, color: Color.default("gray") })),
  },
  responses: {
    201: jsonAnswer("The label", Label),
    ...MEMBER_WRITE_ERRORS,
    ...WRITE_ERRORS,
  },
});

const changeRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/{labelId}`,
  security: SESSION,
  summary: "Rename or recolor a label. Owners and admins can",
  request: {
    params: labelParams,
    body: jsonBody(
      z
        .object({ name: Name.optional(), color: Color.optional() })
        .refine((change) => change.name !== undefined || change.color !== undefined, {
          message: "Send a name, a color or both.",
        }),
    ),
  },
  responses: {
    200: jsonAnswer("The label", Label),
    ...ROLE_WRITE_ERRORS,
    ...WRITE_ERRORS,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: `${PREFIX}/{labelId}`,
  security: SESSION,
  summary: "Delete a label, which leaves every conversation. Owners and admins can",
  request: { params: labelParams },
  responses: { 200: { description: "Deleted", content: okContent }, ...ROLE_WRITE_ERRORS },
});

const putRoute = createRoute({
  method: "put",
  path: ON_CONVERSATION,
  security: SESSION_OR_KEY,
  summary:
    "Put a label on a conversation. It changes this label only, and a repeat changes nothing",
  request: { params: conversationLabelParams },
  responses: {
    ...KEY_LIMITED,
    200: { description: "The conversation has the label", content: okContent },
    ...MEMBER_WRITE_ERRORS,
  },
});

const removeRoute = createRoute({
  method: "delete",
  path: ON_CONVERSATION,
  security: SESSION_OR_KEY,
  summary:
    "Take a label off a conversation. It changes this label only, and a repeat changes nothing",
  request: { params: conversationLabelParams },
  responses: {
    ...KEY_LIMITED,
    200: { description: "The conversation does not have the label", content: okContent },
    ...MEMBER_WRITE_ERRORS,
  },
});

const columns = { id: label.id, name: label.name, color: label.color };

/** The workspace's labels, by name. */
export function listLabels(tx: Transaction, workspaceId: string) {
  return tx
    .select(columns)
    .from(label)
    .where(eq(label.workspaceId, workspaceId))
    .orderBy(sql`lower(${label.name})`);
}

/**
 * Takes the workspace lock and refuses what would pass the limit or repeat a name. Every label write
 * takes this lock first, as a label's change to a conversation does, so two writes take turns in one
 * order and neither can slip past the other's check. The label that changes is null for a new one.
 * Names compare with Postgres's lower(), as the unique index does, so the two always agree.
 */
async function refusal(
  tx: Transaction,
  workspaceId: string,
  name: string | undefined,
  labelId: string | null,
) {
  await lockWorkspace(tx, workspaceId);
  const nameTaken =
    name === undefined
      ? sql`false`
      : sql`lower(${label.name}) = lower(${name})
          and ${labelId === null ? sql`true` : sql`${label.id} <> ${labelId}`}`;
  const [counts] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      taken: sql<number>`count(*) filter (where ${nameTaken})::int`,
    })
    .from(label)
    .where(eq(label.workspaceId, workspaceId));
  if (labelId === null && (counts?.total ?? 0) >= LABEL_LIMIT) return LIMIT;
  return (counts?.taken ?? 0) > 0 ? NAME_TAKEN : null;
}

/** What putting a label on a conversation, or taking it off, did. */
type LabelOutcome = "changed" | "unchanged" | "missing";

/**
 * Puts a label on a conversation with `added`, or takes it off, in the caller's transaction. A change
 * writes a `conversation.labeled` event. The workspace lock comes first, as a conversation's or a
 * label's delete takes it too, so neither can go between the check and the write. The event's seq
 * is taken only for a change, so a repeat leaves the counter alone.
 */
export async function setLabel(
  tx: Transaction,
  workspaceId: string,
  change: LabeledPayload,
): Promise<LabelOutcome> {
  const { conversationId, labelId, added } = change;
  await lockWorkspace(tx, workspaceId);
  const [found] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .innerJoin(label, and(eq(label.workspaceId, workspaceId), eq(label.id, labelId)))
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  if (found === undefined) return "missing";
  const target = and(
    eq(conversationLabel.workspaceId, workspaceId),
    eq(conversationLabel.conversationId, conversationId),
    eq(conversationLabel.labelId, labelId),
  );
  const changed = added
    ? await tx
        .insert(conversationLabel)
        .values({ workspaceId, conversationId, labelId })
        .onConflictDoNothing()
        .returning({ id: conversationLabel.labelId })
    : await tx.delete(conversationLabel).where(target).returning({ id: conversationLabel.labelId });
  if (changed.length === 0) return "unchanged";
  await tx.insert(event).values({
    workspaceId,
    seq: await nextSeq(tx, workspaceId),
    kind: "conversation.labeled",
    payload: { conversationId, labelId, added } satisfies LabeledPayload,
    needsWebhook: wantsWebhook(workspaceId),
  });
  return "changed";
}

/** Puts a label on a conversation or takes it off, and wakes the inboxes. The route and MCP share it. */
export async function labelConversation(
  db: Database,
  live: Live,
  workspaceId: string,
  change: LabeledPayload,
): Promise<LabelOutcome> {
  const outcome = await withWorkspace(db, workspaceId, (tx) => setLabel(tx, workspaceId, change));
  if (outcome === "changed") live.wake(workspaceId, OPERATORS);
  return outcome;
}

/**
 * The label routes. Each change to a label records `workspace.changed` and wakes the open operator
 * apps, which then load the labels again. A lost wake only delays it until the next one.
 */
export function registerLabelRoutes(app: App, db: Database, live: Live): void {
  const thisLabel = (workspaceId: string, labelId: string) =>
    and(eq(label.workspaceId, workspaceId), eq(label.id, labelId));

  app.openapi(listRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const labels = await withWorkspace(db, id, (tx) => listLabels(tx, id));
    return c.json({ labels }, 200);
  });

  app.openapi(addRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const input = c.req.valid("json");
    const outcome = await withWorkspace(db, id, async (tx) => {
      const refused = await refusal(tx, id, input.name, null);
      if (refused !== null) return refused;
      const [row] = await tx
        .insert(label)
        .values({ workspaceId: id, ...input })
        .returning(columns);
      if (row === undefined) throw new Error("The label insert returned no row");
      await recordWorkspaceChange(tx, id);
      return row;
    });
    if ("error" in outcome) return c.json(outcome, 409);
    live.wake(id, OPERATORS);
    return c.json(outcome, 201);
  });

  app.openapi(changeRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { labelId } = c.req.valid("param");
    const input = c.req.valid("json");
    const outcome = await withWorkspace(db, id, async (tx) => {
      const refused = await refusal(tx, id, input.name, labelId);
      if (refused !== null) return refused;
      const [row] = await tx
        .update(label)
        .set(input)
        .where(thisLabel(id, labelId))
        .returning(columns);
      if (row === undefined) return null;
      await recordWorkspaceChange(tx, id);
      return row;
    });
    if (outcome === null) return c.json(NOT_FOUND, 404);
    if ("error" in outcome) return c.json(outcome, 409);
    live.wake(id, OPERATORS);
    return c.json(outcome, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { labelId } = c.req.valid("param");
    const isDeleted = await withWorkspace(db, id, async (tx) => {
      // The workspace lock first, as in every label write.
      await lockWorkspace(tx, id);
      const deleted = await tx
        .delete(label)
        .where(thisLabel(id, labelId))
        .returning({ id: label.id });
      if (deleted.length === 0) return false;
      await recordWorkspaceChange(tx, id);
      return true;
    });
    if (!isDeleted) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(putRoute, async (c) => {
    const { conversationId, labelId } = c.req.valid("param");
    const change = { conversationId, labelId, added: true };
    const outcome = await labelConversation(db, live, c.get("memberWorkspaceId"), change);
    if (outcome === "missing") return c.json(NOT_FOUND, 404);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(removeRoute, async (c) => {
    const { conversationId, labelId } = c.req.valid("param");
    const change = { conversationId, labelId, added: false };
    const outcome = await labelConversation(db, live, c.get("memberWorkspaceId"), change);
    if (outcome === "missing") return c.json(NOT_FOUND, 404);
    return c.json({ ok: true as const }, 200);
  });
}
