import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { confirmUrl, LINK_MINUTES } from "./auth.ts";
import {
  account,
  operator,
  pushSubscription,
  session,
  verification,
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
const soleOwner = (workspaceIds: string[]) => ({
  error: {
    code: "sole_owner" as const,
    message: "Delete these workspaces or make someone else an owner first.",
    workspaceIds,
  },
});

const SoleOwnerAnswer = {
  description:
    "sole_owner: the operator is the only owner of the workspaces in `workspaceIds`. Delete each one, or make someone else an owner, first",
  content: {
    "application/json": {
      schema: z.object({
        error: z.object({
          code: z.literal("sole_owner"),
          message: z.string(),
          workspaceIds: z.array(z.string()),
        }),
      }),
    },
  },
};

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
    409: SoleOwnerAnswer,
    ...RATE_LIMITED,
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
    409: SoleOwnerAnswer,
    ...RATE_LIMITED,
  },
});

/**
 * Whether a member with this role is the workspace's only active owner, who cannot leave it or
 * delete their account yet. Run it in the workspace's context.
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

/** The workspaces that would have no owner if this operator left. */
async function soleOwnerWorkspaces(db: Database, operatorId: string): Promise<string[]> {
  const owned = (await operatorWorkspaces(db, operatorId)).filter((one) => one.role === "owner");
  const sole = await Promise.all(
    owned.map(({ workspaceId, role }) =>
      withWorkspace(db, workspaceId, (tx) => isSoleOwner(tx, workspaceId, role)),
    ),
  );
  return owned.filter((_, index) => sole[index]).map((one) => one.workspaceId);
}

/** The operator is the only owner of these workspaces. Its transaction rolls back. */
class SoleOwnerError extends Error {
  readonly workspaceIds: string[];
  constructor(workspaceIds: string[]) {
    super("The operator is a workspace's only owner");
    this.workspaceIds = workspaceIds;
  }
}

type Deletion =
  | { kind: "deleted"; leftWorkspaceIds: string[] }
  | { kind: "sole_owner"; workspaceIds: string[] }
  | { kind: "gone" };

/**
 * Deletes an account in one transaction. It leaves every workspace as a member who leaves does,
 * ends its sessions, removes its links and devices, and erases the row's personal data. The row
 * stays, because messages and member rows point to it. A sole owner's delete rolls back.
 */
async function deleteAccount(db: Database, operatorId: string): Promise<Deletion> {
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
      const blocked: string[] = [];
      for (const { workspaceId } of await operatorWorkspaces(tx, operatorId)) {
        await enterWorkspace(tx, workspaceId);
        const result = await leaveWorkspace(tx, workspaceId, operatorId);
        (result === "last_owner" ? blocked : left).push(workspaceId);
      }
      if (blocked.length > 0) throw new SoleOwnerError(blocked);
      await tx.delete(session).where(eq(session.userId, operatorId));
      await tx.delete(account).where(eq(account.userId, operatorId));
      await tx.delete(pushSubscription).where(eq(pushSubscription.operatorId, operatorId));
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
          deletedAt: new Date(),
        })
        .where(eq(operator.id, operatorId));
      return { kind: "deleted" as const, leftWorkspaceIds: left };
    });
  } catch (error) {
    if (error instanceof SoleOwnerError) {
      return { kind: "sole_owner", workspaceIds: error.workspaceIds };
    }
    throw error;
  }
}

interface AccountDeleteOptions {
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
  { db, live, logger, mailer, publicUrl, rateLimit }: AccountDeleteOptions,
) {
  const publicOrigin = new URL(publicUrl).origin;

  /** Deletes the account, then sends the signals and audit lines that its removals call for. */
  const remove = async (operatorId: string) => {
    const deletion = await deleteAccount(db, operatorId);
    if (deletion.kind !== "deleted") return deletion;
    for (const workspaceId of deletion.leftWorkspaceIds) {
      // Open inboxes load the team again, and the next drain ends this operator's streams.
      live.wake(workspaceId, OPERATORS);
      audit(logger, "member.removed", { workspaceId, operatorId, targetId: operatorId });
    }
    audit(logger, "account.deleted", { operatorId });
    return deletion;
  };

  app.openapi(requestRoute, async (c) => {
    const operatorId = c.get("operatorId");
    const wait = await rateLimit.hit("account-delete", operatorId, REQUESTS_PER_HOUR, HOUR_SECONDS);
    if (wait !== null) return tooManyRequests(c, wait);
    const blocked = await soleOwnerWorkspaces(db, operatorId);
    if (blocked.length > 0) return c.json(soleOwner(blocked), 409);
    const email = c.get("operatorEmail");
    if (mailer === undefined) {
      // The operator is signed in, and a server with no mail server has no other channel.
      if (c.req.valid("json").email?.trim().toLowerCase() !== email.toLowerCase()) {
        return c.json(EMAIL_MISMATCH, 400);
      }
      const deletion = await remove(operatorId);
      if (deletion.kind === "sole_owner") return c.json(soleOwner(deletion.workspaceIds), 409);
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
    // once. A refused delete keeps it, for after the owner hands over their workspaces.
    const deletion = await remove(operatorId);
    if (deletion.kind === "sole_owner") return c.json(soleOwner(deletion.workspaceIds), 409);
    if (deletion.kind === "gone") return c.json(LINK_INVALID, 400);
    return c.json({ ok: true as const }, 200);
  });
}
