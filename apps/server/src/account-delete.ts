import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { confirmUrl, LINK_MINUTES } from "./auth.ts";
import {
  account,
  invite,
  operator,
  operatorPicture,
  pushSubscription,
  session,
  verification,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import {
  type Database,
  enterWorkspace,
  operatorWorkspaces,
  type Transaction,
  withWorkspace,
} from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  LINK_INVALID,
  OPERATOR_WRITE_ERRORS,
  RATE_LIMITED,
  safeErrorFields,
  WRONG_ORIGIN,
} from "./errors.ts";
import { sha256Hex } from "./identity.ts";
import { deleteAccountMail } from "./letter.ts";
import { type Live, OPERATORS } from "./live.ts";
import type { Mailer } from "./mailer.ts";
import { limitByIp, type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { leaveWorkspace, type Role } from "./team.ts";
import { isOnlyWorkspace } from "./workspace-delete.ts";

/** The name a deleted account's old replies show. */
export const FORMER_MEMBER_NAME = "Former team member";
/** A deleted account's email: unique, and in a domain that can never receive mail (RFC 2606). */
const erasedEmail = (operatorId: string) => `deleted-${operatorId}@invalid`;

/** A delete link, in BetterAuth's verification table until it is used or expires. */
const DELETE_LINK = "account-delete:";
const PendingDelete = z.object({ operatorId: z.uuid(), email: z.string() });
const HOUR_SECONDS = 3600;
/** Delete requests one operator may make in an hour. Each one can send an email. */
const REQUESTS_PER_HOUR = 5;

const EMAIL_MISMATCH = failure("email_mismatch", "Type your account's email to confirm.");
const LAST_WORKSPACE = failure(
  "last_workspace",
  "You are the only member of this server's last workspace, so your account stays.",
);
const BILLING_UNAVAILABLE = failure(
  "billing_unavailable",
  "A subscription could not be canceled, so your account stays. Try again.",
);
const TEAM_CHANGED = failure(
  "team_changed",
  "Someone left one of your workspaces while your account was being deleted. Try again.",
);

const requestRoute = createRoute({
  method: "post",
  path: "/v1/operator/account/delete",
  security: SESSION,
  summary:
    "Delete your account. With a mail server, this emails a link that deletes it. Without one, send the account's email to delete it now",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ email: z.string().max(254).optional() }) },
      },
    },
  },
  responses: {
    200: {
      description:
        "`deleted` is true when the account is gone, and false when a link went to its email, which works once for 15 minutes",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    ...OPERATOR_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid. email_mismatch: on a server with no mail server, the email sent is not the account's",
    ),
    409: errorAnswer(
      "last_workspace: on a self-hosted server, the operator is the only member of the last workspace. team_changed: someone left a workspace during the delete. Try again",
    ),
    ...RATE_LIMITED,
    502: errorAnswer(
      "billing_unavailable: a subscription could not be canceled, so nothing was deleted",
    ),
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/v1/account/delete",
  summary: "Use a delete link's token, from the button on the page the link opens",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ token: z.string().max(200) }) } },
    },
  },
  responses: {
    200: {
      description: "The account is deleted, and every session it had ended",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: errorAnswer(
      "invalid_request: the request is not valid. link_invalid: the link expired or was already used",
    ),
    403: errorAnswer("origin_not_allowed: another site sent this"),
    409: errorAnswer(
      "last_workspace: on a self-hosted server, the operator is the only member of the last workspace. team_changed: someone left a workspace during the delete. Try again",
    ),
    ...RATE_LIMITED,
    502: errorAnswer(
      "billing_unavailable: a subscription could not be canceled, so nothing was deleted",
    ),
  },
});

/**
 * Whether a member with this role is the workspace's only active owner, who cannot leave it from
 * the Team page. Run it in the workspace's context.
 */
export async function isSoleOwner(tx: Transaction, workspaceId: string, role: Role) {
  if (role !== "owner") return false;
  const owners = await tx.$count(
    workspaceMember,
    and(
      eq(workspaceMember.workspaceId, workspaceId),
      eq(workspaceMember.role, "owner"),
      isNull(workspaceMember.removedAt),
    ),
  );
  return owners === 1;
}

/**
 * Who becomes the owner when the only owner deletes their account: the admin who joined first,
 * or else the member who joined first. Null when nobody else is in the workspace, which then goes
 * with the account. Run it in the workspace's context.
 */
export async function heirOf(
  tx: Transaction,
  workspaceId: string,
  operatorId: string,
): Promise<{ id: string; name: string } | null> {
  const [found] = await tx
    .select({ id: workspaceMember.operatorId, name: operator.name, email: operator.email })
    .from(workspaceMember)
    .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.removedAt),
        ne(workspaceMember.operatorId, operatorId),
      ),
    )
    .orderBy(
      sql`${workspaceMember.role} = 'admin' desc`,
      asc(workspaceMember.createdAt),
      asc(workspaceMember.operatorId),
    )
    .limit(1);
  return found === undefined ? null : { id: found.id, name: found.name || found.email };
}

/** The account cannot go, and its transaction rolls back. */
class Refusal extends Error {
  readonly code: "last_workspace" | "billing_unavailable" | "team_changed";
  constructor(code: Refusal["code"]) {
    super(code);
    this.code = code;
  }
}

type Deletion =
  | { kind: "deleted"; leftWorkspaceIds: string[]; deletedWorkspaceIds: string[] }
  | { kind: "refused"; code: Refusal["code"] }
  | { kind: "gone" };

/**
 * The workspaces whose only owner is this operator, with nobody else in them. They go with the
 * account, so their subscriptions end before its transaction starts.
 */
async function aloneIn(db: Database, operatorId: string): Promise<string[]> {
  const owned = (await operatorWorkspaces(db, operatorId)).filter((one) => one.role === "owner");
  const alone = await Promise.all(
    owned.map(({ workspaceId, role }) =>
      withWorkspace(
        db,
        workspaceId,
        async (tx) =>
          (await isSoleOwner(tx, workspaceId, role)) &&
          (await heirOf(tx, workspaceId, operatorId)) === null,
      ),
    ),
  );
  return owned.filter((_, index) => alone[index]).map((one) => one.workspaceId);
}

interface DeleteRules {
  /** Cancels a workspace's subscription before it goes. A throw stops the delete. */
  beforeDelete: ((workspaceId: string) => Promise<void>) | undefined;
  /** True on a self-hosted server, which keeps its last workspace. */
  keepsLastWorkspace: boolean;
}

/**
 * Deletes an account in one transaction. It leaves every workspace as a member who leaves does,
 * ends its sessions, removes its links and devices, and erases the row's personal data. The row
 * stays, because messages and member rows point to it. Where the operator is the only owner, the
 * heir becomes the owner first, and a workspace with nobody else in it is deleted.
 */
async function deleteAccount(
  db: Database,
  logger: Logger,
  operatorId: string,
  { beforeDelete, keepsLastWorkspace }: DeleteRules,
): Promise<Deletion> {
  // Stripe cannot roll back, so its calls come before the transaction, as in a workspace's own
  // delete. A retry after a failure cancels again, which changes nothing that already ended.
  const alone = await aloneIn(db, operatorId);
  if (beforeDelete !== undefined) {
    for (const workspaceId of alone) {
      try {
        await beforeDelete(workspaceId);
      } catch (err) {
        logger.error({ err, workspaceId }, "an account's delete could not cancel a subscription");
        return { kind: "refused", code: "billing_unavailable" };
      }
    }
  }
  try {
    return await db.transaction(async (tx) => {
      // Locked, so two links used at once take turns, and the second finds the account gone.
      const [found] = await tx
        .select({ email: operator.email })
        .from(operator)
        .where(and(eq(operator.id, operatorId), isNull(operator.deletedAt)))
        .for("update");
      if (found === undefined) return { kind: "gone" as const };
      const left: string[] = [];
      const deleted: string[] = [];
      for (const { workspaceId, role } of await operatorWorkspaces(tx, operatorId)) {
        await enterWorkspace(tx, workspaceId);
        if (await isSoleOwner(tx, workspaceId, role)) {
          let heir = await heirOf(tx, workspaceId, operatorId);
          if (heir === null) {
            // It goes with the account. Its unused invites end first, so a join either committed
            // before, and the second look finds the new member, or waits on the invite's row and
            // then finds it revoked.
            await revokeInvites(tx, workspaceId);
            heir = await heirOf(tx, workspaceId, operatorId);
          }
          if (heir === null) {
            // Someone left after the subscriptions were canceled, so this one still has its own.
            if (!alone.includes(workspaceId) && beforeDelete !== undefined) {
              throw new Refusal("team_changed");
            }
            if (keepsLastWorkspace) {
              // As in the workspace's own delete, two deletes of the last two take turns.
              await tx.execute(sql`select pg_advisory_xact_lock(hashtext('workspace-delete'))`);
              if (await isOnlyWorkspace(tx, workspaceId)) throw new Refusal("last_workspace");
            }
            await tx
              .update(workspace)
              .set({ deletedAt: new Date() })
              .where(eq(workspace.id, workspaceId));
            deleted.push(workspaceId);
            continue;
          }
          // A member who joined after the subscriptions were canceled becomes the owner too. The
          // workspace keeps its data, and the lifecycle emails tell them how to pay again.
          await tx
            .update(workspaceMember)
            .set({ role: "owner" })
            .where(
              and(
                eq(workspaceMember.workspaceId, workspaceId),
                eq(workspaceMember.operatorId, heir.id),
              ),
            );
        }
        // A co-owner who left at the same moment makes this the last owner. The delete then fails
        // and the operator tries again, which finds the heir.
        if ((await leaveWorkspace(tx, workspaceId, operatorId)) !== "ok") {
          throw new Error("An account's delete could not leave a workspace");
        }
        left.push(workspaceId);
      }
      await tx.delete(session).where(eq(session.userId, operatorId));
      await tx.delete(account).where(eq(account.userId, operatorId));
      await tx.delete(pushSubscription).where(eq(pushSubscription.operatorId, operatorId));
      await tx.delete(operatorPicture).where(eq(operatorPicture.operatorId, operatorId));
      // Sign-in and join links name the email, so a link sent before cannot make a new account.
      await tx.delete(verification).where(
        sql`case when pg_input_is_valid(${verification.value}, 'jsonb')
            then ${verification.value}::jsonb ->> 'email' else ${verification.value} end = ${found.email}`,
      );
      await tx
        .update(operator)
        .set({
          name: FORMER_MEMBER_NAME,
          email: erasedEmail(operatorId),
          image: null,
          pictureUpdatedAt: null,
          deletedAt: new Date(),
        })
        .where(eq(operator.id, operatorId));
      return {
        kind: "deleted" as const,
        leftWorkspaceIds: left,
        deletedWorkspaceIds: deleted,
      };
    });
  } catch (error) {
    if (error instanceof Refusal) return { kind: "refused", code: error.code };
    throw error;
  }
}

/** Ends a workspace's invites that nobody used. Run it in the workspace's context. */
const revokeInvites = (tx: Transaction, workspaceId: string) =>
  tx
    .update(invite)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(invite.workspaceId, workspaceId), isNull(invite.usedAt), isNull(invite.revokedAt)),
    );

/** Whether the delete would stop at this server's last workspace, checked before a link goes. */
async function keepsAccount(db: Database, operatorId: string): Promise<boolean> {
  for (const { workspaceId, role } of await operatorWorkspaces(db, operatorId)) {
    const stays = await withWorkspace(
      db,
      workspaceId,
      async (tx) =>
        (await isSoleOwner(tx, workspaceId, role)) &&
        (await heirOf(tx, workspaceId, operatorId)) === null &&
        (await isOnlyWorkspace(tx, workspaceId)),
    );
    if (stays) return true;
  }
  return false;
}

interface AccountDeleteOptions extends DeleteRules {
  db: Database;
  live: Live;
  logger: Logger;
  /** Sends the delete link. Without one, the operator types their email to confirm. */
  mailer: Mailer | undefined;
  publicUrl: string;
  rateLimit: RateLimit;
}

/** An operator deletes their own account. Call this after the operator routes' session check. */
export function registerAccountDelete(
  app: App,
  { db, live, logger, mailer, publicUrl, rateLimit, ...rules }: AccountDeleteOptions,
) {
  const publicOrigin = new URL(publicUrl).origin;

  /** Deletes the account, then sends the signals and audit lines that its removals call for. */
  const remove = async (operatorId: string) => {
    const deletion = await deleteAccount(db, logger, operatorId, rules);
    if (deletion.kind !== "deleted") return deletion;
    for (const workspaceId of deletion.leftWorkspaceIds) {
      // Open inboxes load the team again, and the next drain ends this operator's streams.
      live.wake(workspaceId, OPERATORS);
      audit(logger, "member.removed", { workspaceId, operatorId, targetId: operatorId });
    }
    for (const workspaceId of deletion.deletedWorkspaceIds) {
      live.wake(workspaceId, OPERATORS);
      audit(logger, "workspace.deleted", { workspaceId, operatorId });
    }
    audit(logger, "account.deleted", { operatorId });
    return deletion;
  };

  app.openapi(requestRoute, async (c) => {
    const operatorId = c.get("operatorId");
    const wait = await rateLimit.hit("account-delete", operatorId, REQUESTS_PER_HOUR, HOUR_SECONDS);
    if (wait !== null) return tooManyRequests(c, wait);
    if (rules.keepsLastWorkspace && (await keepsAccount(db, operatorId))) {
      return c.json(LAST_WORKSPACE, 409);
    }
    const email = c.get("operatorEmail");
    if (mailer === undefined) {
      // The operator is signed in, and a server with no mail server has no other channel.
      if (c.req.valid("json").email?.trim().toLowerCase() !== email.toLowerCase()) {
        return c.json(EMAIL_MISMATCH, 400);
      }
      const deletion = await remove(operatorId);
      if (deletion.kind === "refused") {
        if (deletion.code === "billing_unavailable") return c.json(BILLING_UNAVAILABLE, 502);
        return c.json(deletion.code === "last_workspace" ? LAST_WORKSPACE : TEAM_CHANGED, 409);
      }
      return c.json({ deleted: true }, 200);
    }
    const token = randomBytes(32).toString("base64url");
    const pending: z.infer<typeof PendingDelete> = { operatorId, email };
    await db.insert(verification).values({
      identifier: `${DELETE_LINK}${sha256Hex(token)}`,
      value: JSON.stringify(pending),
      expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000),
    });
    const mail = deleteAccountMail(confirmUrl(publicUrl, "delete-account", token));
    mailer.send(email, mail.subject, mail.body).catch((err: unknown) => {
      logger.error(safeErrorFields(err), "could not send an account delete link");
    });
    audit(logger, "account.delete_link_sent", { operatorId });
    return c.json({ deleted: false }, 200);
  });

  app.use("/v1/account/*", limitByIp(rateLimit, "account-delete-link", 20, 60));
  app.use("/v1/account/*", bodyLimit({ maxSize: 8 * 1024 }));
  app.openapi(confirmRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const identifier = `${DELETE_LINK}${sha256Hex(c.req.valid("json").token)}`;
    const [row] = await db
      .select({ value: verification.value })
      .from(verification)
      .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, sql`now()`)));
    if (row === undefined) return c.json(LINK_INVALID, 400);
    const { operatorId } = PendingDelete.parse(JSON.parse(row.value));
    // The link names the account's email, so the delete removes it with the other links: it works
    // once. A refused delete keeps it, so the operator can try again.
    const deletion = await remove(operatorId);
    if (deletion.kind === "refused") {
      if (deletion.code === "billing_unavailable") return c.json(BILLING_UNAVAILABLE, 502);
      return c.json(deletion.code === "last_workspace" ? LAST_WORKSPACE : TEAM_CHANGED, 409);
    }
    if (deletion.kind === "gone") return c.json(LINK_INVALID, 400);
    return c.json({ ok: true as const }, 200);
  });
}
