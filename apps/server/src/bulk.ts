import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { BULK_MAX } from "../../../packages/widget/src/shared.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { label } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace, writable } from "./db/tenant.ts";
import {
  errorAnswer,
  type failure,
  jsonAnswer,
  jsonBody,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
} from "./errors.ts";
import { setLabel } from "./labels.ts";
import { type Live, OPERATORS } from "./live.ts";
import { closedFailure, OPEN_WHILE_CLOSED, WORKSPACE_PREFIX, workspaceParams } from "./member.ts";
import {
  type ConversationRow,
  findConversations,
  lockWorkspace,
  markConversationsRead,
  setConversationStatus,
} from "./messages.ts";
import { deleteConversations } from "./moderation.ts";
import { allowed, assignIn, isActiveMember, NOT_A_MEMBER } from "./team.ts";

/**
 * Conversations per transaction. Each change takes the workspace lock until its commit, so a short
 * batch lets visitors' messages in between.
 */
const BATCH = 25;

const RESULTS = ["ok", "not_found", "not_allowed", "unchanged"] as const;
type Result = (typeof RESULTS)[number];

const Ids = z
  .array(z.uuid())
  .min(1)
  .max(BULK_MAX)
  .openapi({ description: `1 to ${BULK_MAX} conversation IDs. A repeated ID counts once.` });

const BulkRequest = z
  .discriminatedUnion("action", [
    z.strictObject({ action: z.literal("close"), conversationIds: Ids }),
    z.strictObject({
      action: z.literal("assign"),
      conversationIds: Ids,
      operatorId: z.uuid().nullable().openapi({ description: "A member, or null for nobody" }),
    }),
    z.strictObject({ action: z.literal("label"), conversationIds: Ids, labelId: z.uuid() }),
    z.strictObject({ action: z.literal("mark_read"), conversationIds: Ids }),
    z.strictObject({ action: z.literal("delete"), conversationIds: Ids }),
  ])
  .openapi("BulkRequest", {
    example: {
      action: "close",
      conversationIds: ["5d0c1f7e-8a3b-4e52-b1f4-2c9e7a6d4b10"],
    },
  });
type BulkAction = z.infer<typeof BulkRequest>;

const BulkResults = z
  .object({
    // One per ID, in the request's order. `unchanged`: it already was as asked, or for `mark_read`
    // it was read up to its newest message already. `not_allowed`: a member's delete, which only
    // owners and admins may do.
    results: z.array(z.object({ conversationId: z.string(), result: z.enum(RESULTS) })),
  })
  .openapi("BulkResults");

const bulkRoute = createRoute({
  method: "post",
  // Reading stays allowed while the workspace is read-only or suspended, so the handler refuses
  // every other action itself.
  ...OPEN_WHILE_CLOSED,
  path: `${WORKSPACE_PREFIX}/{workspaceId}/conversations/bulk`,
  security: SESSION,
  summary: "Close, assign, label, mark read or delete several conversations",
  description: `Each conversation changes as the single action would, with its own event, so webhooks and alerts behave as if done one by one. They change in transactions of ${BATCH}, so a failure partway keeps the batches before it. \`mark_read\` reads each one up to its newest message, for the signed-in operator, and is the only action a read-only or suspended workspace allows. \`delete\` is for owners and admins: for a member, every result is \`not_allowed\`. There is no bulk reply.`,
  request: { params: workspaceParams, body: jsonBody(BulkRequest) },
  responses: {
    200: jsonAnswer("A result for each conversation", BulkResults),
    ...MEMBER_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid. not_a_member: the assignee is not a member",
    ),
    404: errorAnswer("not_found: the label does not exist, or this operator is not a member"),
  },
});

/** Changes the batch's conversations that exist, and answers a result for each of them, in order. */
type BatchChange = (tx: Transaction, found: ConversationRow[]) => Promise<Result[]>;

/** A change that runs each conversation through the single action's function. */
const eachOne =
  (change: (tx: Transaction, row: ConversationRow) => Promise<Result>): BatchChange =>
  async (tx, found) => {
    const results: Result[] = [];
    for (const row of found) results.push(await change(tx, row));
    return results;
  };

const okIf = (changed: boolean): Result => (changed ? "ok" : "unchanged");

interface Done {
  result: Result;
  visitorId: string;
}

/**
 * Runs the change on each batch in its own transaction, and announces each batch once it commits,
 * so a later batch's failure leaves the earlier ones announced. Each change takes the workspace lock
 * before it writes, so two requests that share conversations take turns. The results, by ID.
 */
async function inBatches(
  db: Database,
  workspaceId: string,
  ids: string[],
  change: BatchChange,
  announce: (batch: Done[]) => void,
): Promise<Map<string, Done>> {
  const done = new Map<string, Done>();
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH);
    const batchDone = await withWorkspace(db, workspaceId, async (tx) => {
      const found = await findConversations(tx, workspaceId, batch);
      const rows = batch.flatMap((id) => found.get(id) ?? []);
      const results = await change(tx, rows);
      return rows.map((row, index) => {
        const one = { result: results[index] ?? "unchanged", visitorId: row.visitorId };
        done.set(row.id, one);
        return one;
      });
    });
    announce(batchDone);
  }
  return done;
}

async function labelExists(db: Database, workspaceId: string, labelId: string) {
  const [found] = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ id: label.id })
      .from(label)
      .where(and(eq(label.workspaceId, workspaceId), eq(label.id, labelId))),
  );
  return found !== undefined;
}

interface Caller {
  operatorId: string;
  mayDelete: boolean;
}

/** The change for an action, or an error answer for the whole request. */
async function changeFor(
  db: Database,
  workspaceId: string,
  request: BulkAction,
  caller: Caller,
): Promise<BatchChange | { refused: ReturnType<typeof failure>; status: 400 | 404 }> {
  const { operatorId } = caller;
  switch (request.action) {
    case "close":
      return eachOne(async (tx, row) =>
        okIf(
          await setConversationStatus(tx, workspaceId, row.id, "closed", {
            kind: "operator",
            operatorId,
          }),
        ),
      );
    case "assign": {
      const assignee = request.operatorId;
      if (assignee !== null) {
        const isMember = await withWorkspace(db, workspaceId, (tx) =>
          isActiveMember(tx, workspaceId, assignee),
        );
        if (!isMember) return { refused: NOT_A_MEMBER, status: 400 };
      }
      // As a signed-in assign does, each one gets the assignee and a person handles it from now.
      // The rows were read before the workspace lock, so their assignee may be stale by now.
      return eachOne(async (tx, row) =>
        okIf(await assignIn(tx, workspaceId, row.id, assignee, true)),
      );
    }
    case "label": {
      const { labelId } = request;
      if (!(await labelExists(db, workspaceId, labelId)))
        return { refused: NOT_FOUND, status: 404 };
      return eachOne(async (tx, row) => {
        const outcome = await setLabel(tx, workspaceId, {
          conversationId: row.id,
          labelId,
          added: true,
        });
        return outcome === "missing" ? "not_found" : okIf(outcome === "changed");
      });
    }
    case "mark_read":
      // A read position names its conversation, so it holds the conversation's row while a delete
      // waits for it. The workspace lock first, as a delete takes it before any conversation, so the
      // two take turns.
      return async (tx, found) => {
        await lockWorkspace(tx, workspaceId);
        const ids = found.map((row) => row.id);
        const moved = await markConversationsRead(tx, workspaceId, ids, operatorId);
        return found.map((row) => okIf(moved.has(row.id)));
      };
    case "delete":
      // Once per batch: it locks the visitors in ID order before the workspace, as a visitor's
      // message does. One delete per conversation would lock a visitor after the workspace, and
      // deadlock with a message.
      return async (tx, found) => {
        if (!caller.mayDelete) return found.map(() => "not_allowed");
        await deleteConversations(tx, workspaceId, found);
        return found.map(() => "ok");
      };
  }
}

/** Wakes the operators, and the visitors' streams for a close's status line or a delete. */
function wakeAfter(live: Live, workspaceId: string, action: BulkAction["action"], batch: Done[]) {
  const changed = batch.filter((one) => one.result === "ok");
  if (changed.length === 0) return;
  live.wake(workspaceId, OPERATORS);
  if (action !== "close" && action !== "delete") return;
  for (const visitorId of new Set(changed.map((one) => one.visitorId))) {
    live.wake(workspaceId, visitorId);
  }
}

export function registerBulkRoute(app: App, db: Database, live: Live): void {
  app.openapi(bulkRoute, async (c) => {
    const workspaceId = c.get("memberWorkspaceId");
    const request = c.req.valid("json");
    const access = c.get("memberAccess");
    if (request.action !== "mark_read" && !writable(access)) {
      const refused = closedFailure(access);
      return c.json(refused.body, refused.status);
    }
    const caller = {
      operatorId: c.get("operatorId"),
      mayDelete: allowed.settings(c.get("memberRole")),
    };
    const change = await changeFor(db, workspaceId, request, caller);
    if (typeof change !== "function") return c.json(change.refused, change.status);
    const ids = [...new Set(request.conversationIds)];
    const done = await inBatches(db, workspaceId, ids, change, (batch) =>
      wakeAfter(live, workspaceId, request.action, batch),
    );
    const results = ids.map((conversationId) => ({
      conversationId,
      result: done.get(conversationId)?.result ?? ("not_found" as const),
    }));
    return c.json({ results }, 200);
  });
}
