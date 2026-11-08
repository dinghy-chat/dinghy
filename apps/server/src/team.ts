import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { type Auth, confirmUrl, LINK_MINUTES, signInNow } from "./auth.ts";
import { invite, operator, verification, workspace, workspaceMember } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  INVALID,
  LINK_INVALID,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  OPERATOR_WRITE_ERRORS,
  okContent,
  RATE_LIMITED,
  ROLE_WRITE_ERRORS,
  safeErrorFields,
  WRONG_ORIGIN,
} from "./errors.ts";
import { emailAddressHash, normalizeOrigin, sha256Hex } from "./identity.ts";
import { joinMail } from "./letter.ts";
import { type Limits, OPERATOR_LIMIT, OperatorLimitError } from "./limits.ts";
import { type Live, OPERATORS } from "./live.ts";
import type { Mailer } from "./mailer.ts";
import { OPEN_WHILE_CLOSED } from "./member.ts";
import { assignConversation, recordTeamChange } from "./messages.ts";
import { limitByIp, type RateLimit, tooManyRequests } from "./rate-limit.ts";

export type Role = "owner" | "admin" | "agent";

const PREFIX = "/v1/operator/workspaces/{workspaceId}";
const INVITE_LIFETIME_MS = 7 * 24 * 3_600_000;
const MAX_ORIGINS = 20;

const LAST_OWNER = failure(
  "last_owner",
  "A workspace needs an owner. Make someone else owner first.",
);
const BAD_INVITE = failure("invite_invalid", "This invite has expired or was already used.");
const EMAIL_TAKEN = failure(
  "email_taken",
  "This email already has an account. Sign in, then open the invite again.",
);
const ALREADY_MEMBER = failure("already_member", "You are already in this workspace.");

const RANK: Record<Role, number> = { agent: 0, admin: 1, owner: 2 };

/** The rules in one place, so a route cannot apply a looser version of them. */
export const allowed = {
  settings: (role: Role) => role === "owner" || role === "admin",
  invite: (role: Role, invited: Role) =>
    invited !== "owner" && (role === "owner" || (role === "admin" && invited === "agent")),
  changeRole: (role: Role) => role === "owner",
  remove: (role: Role, target: Role, isSelf: boolean) =>
    isSelf || role === "owner" || (role === "admin" && target === "agent"),
};

const ok = {
  description: "Done",
  content: okContent,
};
/** A read that only an owner or admin may do. */
const denied = {
  ...MEMBER_ERRORS,
  403: errorAnswer("forbidden: this role may not do this"),
};
const INVITE_INVALID = { 404: errorAnswer("invite_invalid: the invite expired or was used") };
/** The invite routes a visitor to the sign-up page calls, with no session. */
const inviteErrors = {
  ...INVALID,
  403: errorAnswer("origin_not_allowed: another site sent this"),
  ...INVITE_INVALID,
  413: errorAnswer("too_large: the body is over 8 KB"),
  ...RATE_LIMITED,
};

const roleEnum = z.enum(["owner", "admin", "agent"]);
const invitedRole = z.enum(["admin", "agent"]);
const workspaceParams = z.object({ workspaceId: z.uuid() });
const memberParams = workspaceParams.extend({ operatorId: z.uuid() });
const inviteParams = workspaceParams.extend({ inviteId: z.uuid() });
const json = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const reply = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});

const Member = z
  .object({ id: z.string(), name: z.string(), email: z.string(), role: roleEnum })
  .openapi("Member");
const PendingInvite = z
  .object({ id: z.string(), role: invitedRole, expiresAt: z.string() })
  .openapi("PendingInvite");
const Settings = z
  .object({
    publicKey: z.string(),
    allowedOrigins: z.array(z.string()),
    signingSecret: z.string(),
    // The plan's limits and how much of each is used, on Dinghy Cloud. Null with no limits.
    usage: z
      .object({
        operators: z.object({ used: z.number(), limit: z.number() }),
        imageBytes: z.object({ used: z.number(), limit: z.number() }),
      })
      .nullable(),
  })
  .openapi("WorkspaceSettings");

const listMembersRoute = createRoute({
  method: "get",
  path: `${PREFIX}/members`,
  security: SESSION,
  summary: "List the workspace's members",
  request: { params: workspaceParams },
  responses: {
    200: reply("The members", z.object({ members: z.array(Member) })),
    ...MEMBER_ERRORS,
  },
});

const changeMemberRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/members/{operatorId}`,
  security: SESSION,
  summary: "Change a member's role",
  request: { params: memberParams, body: json(z.object({ role: roleEnum })) },
  responses: {
    200: ok,
    ...ROLE_WRITE_ERRORS,
    409: errorAnswer("last_owner: this is the last owner"),
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  ...OPEN_WHILE_CLOSED,
  path: `${PREFIX}/members/{operatorId}`,
  security: SESSION,
  summary: "Remove a member, or leave the workspace",
  request: { params: memberParams },
  responses: {
    200: ok,
    ...ROLE_WRITE_ERRORS,
    409: errorAnswer("last_owner: this is the last owner"),
  },
});

const listInvitesRoute = createRoute({
  method: "get",
  path: `${PREFIX}/invites`,
  security: SESSION,
  summary: "List invites that can still be used",
  request: { params: workspaceParams },
  responses: {
    200: reply("The invites", z.object({ invites: z.array(PendingInvite) })),
    ...denied,
  },
});

const createInviteRoute = createRoute({
  method: "post",
  path: `${PREFIX}/invites`,
  security: SESSION,
  summary: "Create an invite link. Its token is shown only in this response.",
  request: { params: workspaceParams, body: json(z.object({ role: invitedRole })) },
  responses: {
    201: reply("The invite", PendingInvite.extend({ token: z.string() })),
    ...ROLE_WRITE_ERRORS,
    409: errorAnswer("operator_limit: the workspace has as many operators as its plan allows"),
  },
});

const revokeInviteRoute = createRoute({
  method: "delete",
  ...OPEN_WHILE_CLOSED,
  path: `${PREFIX}/invites/{inviteId}`,
  security: SESSION,
  summary: "Revoke an invite",
  request: { params: inviteParams },
  responses: { 200: ok, ...ROLE_WRITE_ERRORS },
});

const getSettingsRoute = createRoute({
  method: "get",
  path: `${PREFIX}/settings`,
  security: SESSION,
  summary: "Get the allowed origins, the public key and the signing secret",
  request: { params: workspaceParams },
  responses: { 200: reply("The settings", Settings), ...denied },
});

const patchSettingsRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/settings`,
  security: SESSION,
  summary: "Replace the allowed origins",
  request: {
    params: workspaceParams,
    body: json(z.object({ allowedOrigins: z.array(z.string().max(300)).max(MAX_ORIGINS) })),
  },
  responses: {
    200: reply("The settings", Settings),
    ...ROLE_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid. bad_origin: an origin is not valid",
    ),
  },
});

const rotateSecretRoute = createRoute({
  method: "post",
  path: `${PREFIX}/settings/rotate-secret`,
  security: SESSION,
  summary: "Replace the signing secret. Tokens signed with the old one stop at once.",
  request: { params: workspaceParams },
  responses: { 200: reply("The settings", Settings), ...ROLE_WRITE_ERRORS },
});

const assignRoute = createRoute({
  method: "put",
  path: `${PREFIX}/conversations/{conversationId}/assignee`,
  security: SESSION,
  summary: "Assign a conversation to a member, or clear it with null",
  request: {
    params: workspaceParams.extend({ conversationId: z.uuid() }),
    body: json(z.object({ operatorId: z.uuid().nullable() })),
  },
  responses: {
    200: ok,
    ...MEMBER_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid. not_a_member: this person is not a member",
    ),
  },
});

const tokenBody = z.object({ token: z.string().max(200) });

const previewRoute = createRoute({
  method: "post",
  path: "/v1/invites/preview",
  summary: "Read what an invite link offers",
  request: { body: json(tokenBody) },
  responses: {
    200: reply("The invite", z.object({ workspaceName: z.string(), role: invitedRole })),
    ...inviteErrors,
  },
});

const joinRoute = createRoute({
  method: "post",
  path: "/v1/invites/join",
  summary: "Ask for the link that creates an account, or signs in to one, and joins with an invite",
  request: {
    body: json(
      tokenBody.extend({
        name: z.string().trim().min(1).max(100),
        email: z.email().max(254),
      }),
    ),
  },
  responses: {
    200: reply(
      "With a mail server, the link went to the email, and `signInUrl` is null: the answer is the same whether or not the email has an account. Without one, open `signInUrl`",
      z.object({ ok: z.literal(true), signInUrl: z.string().nullable() }),
    ),
    ...inviteErrors,
    409: errorAnswer(
      "email_taken: on a server with no mail server, the email has an account. Sign in, then accept the invite",
    ),
  },
});

const openRoute = createRoute({
  method: "post",
  path: "/v1/invites/open",
  summary:
    "Use a join link's token, from the button on the page the link opens: create the account if needed, join, and sign in",
  request: { body: json(tokenBody) },
  responses: {
    200: reply(
      "Signed in, with the session cookie set. Open the workspace",
      z.object({ workspaceId: z.uuid() }),
    ),
    ...inviteErrors,
    400: errorAnswer(
      "invalid_request: the request is not valid. link_invalid: the link expired or was already used",
    ),
    409: errorAnswer(
      "operator_limit: the workspace has the most operators its plan allows. email_taken: on a server with no mail server, the email has an account",
    ),
  },
});

/** What a join link carries, in BetterAuth's verification table until it is opened or expires. */
const PendingJoin = z.object({
  workspaceId: z.uuid(),
  inviteHash: z.string(),
  name: z.string(),
  email: z.string(),
  // False on a server with no mail server, where nobody proved the email: it joins only as a new
  // account, so an invite cannot sign anyone in to an account that exists.
  proven: z.boolean(),
});
const JOIN_LINK = "invite-join:";

const acceptRoute = createRoute({
  method: "post",
  path: "/v1/operator/invites/accept",
  security: SESSION,
  summary: "Join with an invite, using the signed-in account",
  request: { body: json(tokenBody) },
  responses: {
    200: reply("The workspace", z.object({ workspaceId: z.string() })),
    ...OPERATOR_WRITE_ERRORS,
    ...INVITE_INVALID,
    409: errorAnswer(
      "already_member: already in this workspace. operator_limit: the workspace has as many operators as its plan allows",
    ),
  },
});

/** The token names its workspace, so a lookup needs no function that bypasses the policies. */
function parseToken(token: string): { workspaceId: string; tokenHash: string } | null {
  const workspaceId = token.split(".")[0] ?? "";
  if (!z.uuid().safeParse(workspaceId).success) return null;
  return { workspaceId, tokenHash: sha256Hex(token) };
}

const usable = (workspaceId: string, tokenHash: string) =>
  and(
    eq(invite.workspaceId, workspaceId),
    eq(invite.tokenHash, tokenHash),
    isNull(invite.usedAt),
    isNull(invite.revokedAt),
    gt(invite.expiresAt, sql`now()`),
  );

/** This person became an active member while the invite was used. Its transaction rolls back. */
class AlreadyMemberError extends Error {}
/** The invite was used, revoked or expired. Its transaction rolls back. */
class InviteUnusableError extends Error {}

/**
 * Uses the invite and adds the member together, so a token works once. It throws
 * InviteUnusableError if the invite cannot be used, and AlreadyMemberError if this person became a
 * member in the meantime, so a second invite cannot change an active member's role and stays
 * usable. It throws OperatorLimitError if the workspace would have too many operators.
 */
async function consumeInvite(
  tx: Transaction,
  limits: Limits,
  workspaceId: string,
  tokenHash: string,
  operatorId: string,
): Promise<void> {
  const [used] = await tx
    .update(invite)
    .set({ usedAt: new Date(), usedBy: operatorId })
    .where(usable(workspaceId, tokenHash))
    .returning({ role: invite.role });
  if (used === undefined) throw new InviteUnusableError();
  // A removed member's row stays for history, so joining again brings it back with the new role.
  const [joined] = await tx
    .insert(workspaceMember)
    .values({ workspaceId, operatorId, role: used.role })
    .onConflictDoUpdate({
      target: [workspaceMember.workspaceId, workspaceMember.operatorId],
      set: { role: used.role, removedAt: null, alertEmail: false },
      setWhere: isNotNull(workspaceMember.removedAt),
    })
    .returning({ operatorId: workspaceMember.operatorId });
  if (joined === undefined) throw new AlreadyMemberError();
  if (!(await limits.operatorsFit(tx, workspaceId))) throw new OperatorLimitError();
  await recordTeamChange(tx, workspaceId);
}

async function readSettings(tx: Transaction, limits: Limits, workspaceId: string) {
  const [row] = await tx
    .select({
      publicKey: workspace.publicKey,
      allowedOrigins: workspace.allowedOrigins,
      signingSecret: workspace.signingSecret,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (row === undefined) throw new Error("The workspace row is missing");
  return { ...row, usage: await limits.usage(tx, workspaceId) };
}

type MemberChange = { kind: "role"; role: Role } | { kind: "remove" };

/**
 * Locks every member in one order and reads the roles here, not from the request's start. Two owners
 * who demote each other at once then take turns, and the second finds the last owner.
 */
async function changeMember(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  targetId: string,
  change: MemberChange,
): Promise<"ok" | "forbidden" | "not_found" | "last_owner"> {
  const members = await tx
    .select({ id: workspaceMember.operatorId, role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), isNull(workspaceMember.removedAt)))
    .orderBy(asc(workspaceMember.operatorId))
    // Not FOR UPDATE: a reply holds the workspace row and then checks its author's row with a foreign
    // key. FOR UPDATE would block that check while this waits for the workspace row, a deadlock.
    .for("no key update");
  const actor = members.find((member) => member.id === actorId);
  const target = members.find((member) => member.id === targetId);
  if (actor === undefined) return "forbidden";
  if (target === undefined) return "not_found";
  const permitted =
    change.kind === "role"
      ? allowed.changeRole(actor.role)
      : allowed.remove(actor.role, target.role, actorId === targetId);
  if (!permitted) return "forbidden";
  const leavesOwner = change.kind === "remove" || change.role !== "owner";
  const owners = members.filter((member) => member.role === "owner");
  if (target.role === "owner" && leavesOwner && owners.length === 1) return "last_owner";
  await tx
    .update(workspaceMember)
    .set(change.kind === "role" ? { role: change.role } : { removedAt: new Date() })
    .where(
      and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.operatorId, targetId)),
    );
  // A link they kept would bring them back, or give back the role they just lost.
  if (change.kind === "remove" || RANK[change.role] < RANK[target.role]) {
    await tx
      .update(invite)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invite.workspaceId, workspaceId),
          eq(invite.createdBy, targetId),
          isNull(invite.usedAt),
          isNull(invite.revokedAt),
        ),
      );
  }
  await recordTeamChange(tx, workspaceId);
  return "ok";
}

interface TeamOptions {
  auth: Auth;
  db: Database;
  limits: Limits;
  live: Live;
  logger: Logger;
  /** Sends join links. Without one, a new operator signs in from the join's answer. */
  mailer: Mailer | undefined;
  rateLimit: RateLimit;
}

export function registerTeamRoutes(
  app: App,
  { auth, db, limits, live, logger, mailer, rateLimit }: TeamOptions,
): void {
  const publicUrl = String(auth.options.baseURL);
  const publicOrigin = new URL(publicUrl).origin;
  const auditChange = (event: string, workspaceId: string, operatorId: string, fields = {}) =>
    audit(logger, event, { workspaceId, operatorId, ...fields });
  app.openapi(listMembersRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const members = await withWorkspace(db, id, (tx) =>
      tx
        .select({
          id: operator.id,
          name: operator.name,
          email: operator.email,
          role: workspaceMember.role,
        })
        .from(workspaceMember)
        .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
        .where(and(eq(workspaceMember.workspaceId, id), isNull(workspaceMember.removedAt)))
        .orderBy(asc(operator.name)),
    );
    return c.json({ members }, 200);
  });

  const applyChange = async (
    workspaceId: string,
    actorId: string,
    targetId: string,
    change: MemberChange,
  ) => {
    const result = await withWorkspace(db, workspaceId, (tx) =>
      changeMember(tx, workspaceId, actorId, targetId, change),
    );
    // The next drain checks membership again and ends a removed operator's stream. If this signal
    // is lost, the next message's drain does the same before it sends anything.
    if (result === "ok") live.wake(workspaceId, OPERATORS);
    return result;
  };

  app.openapi(changeMemberRoute, async (c) => {
    const { operatorId } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const change = { kind: "role" as const, role };
    const result = await applyChange(
      c.get("memberWorkspaceId"),
      c.get("operatorId"),
      operatorId,
      change,
    );
    if (result === "forbidden") return c.json(FORBIDDEN, 403);
    if (result === "not_found") return c.json(NOT_FOUND, 404);
    if (result === "last_owner") return c.json(LAST_OWNER, 409);
    auditChange("member.role_changed", c.get("memberWorkspaceId"), c.get("operatorId"), {
      targetId: operatorId,
      role,
    });
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(removeMemberRoute, async (c) => {
    const { operatorId } = c.req.valid("param");
    const result = await applyChange(c.get("memberWorkspaceId"), c.get("operatorId"), operatorId, {
      kind: "remove",
    });
    if (result === "forbidden") return c.json(FORBIDDEN, 403);
    if (result === "not_found") return c.json(NOT_FOUND, 404);
    if (result === "last_owner") return c.json(LAST_OWNER, 409);
    auditChange("member.removed", c.get("memberWorkspaceId"), c.get("operatorId"), {
      targetId: operatorId,
    });
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(listInvitesRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const rows = await withWorkspace(db, id, (tx) =>
      tx
        .select({ id: invite.id, role: invite.role, expiresAt: invite.expiresAt })
        .from(invite)
        .where(
          and(
            eq(invite.workspaceId, id),
            isNull(invite.usedAt),
            isNull(invite.revokedAt),
            gt(invite.expiresAt, sql`now()`),
          ),
        )
        .orderBy(asc(invite.expiresAt)),
    );
    return c.json(
      {
        invites: rows.map((row) => ({
          id: row.id,
          role: row.role as "admin" | "agent",
          expiresAt: row.expiresAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(createInviteRoute, async (c) => {
    const { role } = c.req.valid("json");
    const id = c.get("memberWorkspaceId");
    const operatorId = c.get("operatorId");
    const token = `${id}.${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS);
    const created = await withWorkspace(db, id, async (tx) => {
      // The creator's row is locked while this reads it. A removal or a demotion then either waits
      // and revokes this link, or goes first and this request sees the new role.
      const [creator] = await tx
        .select({ role: workspaceMember.role })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.workspaceId, id),
            eq(workspaceMember.operatorId, operatorId),
            isNull(workspaceMember.removedAt),
          ),
        )
        .for("no key update");
      if (creator === undefined || !allowed.invite(creator.role, role)) return null;
      if (!(await limits.mayInvite(tx, id))) return "full" as const;
      const [row] = await tx
        .insert(invite)
        .values({
          workspaceId: id,
          tokenHash: sha256Hex(token),
          role,
          createdBy: operatorId,
          expiresAt,
        })
        .returning({ id: invite.id });
      return row ?? null;
    });
    if (created === null) return c.json(FORBIDDEN, 403);
    if (created === "full") return c.json(OPERATOR_LIMIT, 409);
    auditChange("invite.created", id, operatorId, { inviteId: created.id, role });
    return c.json({ id: created.id, role, expiresAt: expiresAt.toISOString(), token }, 201);
  });

  app.openapi(revokeInviteRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { inviteId } = c.req.valid("param");
    await withWorkspace(db, id, (tx) =>
      tx
        .update(invite)
        .set({ revokedAt: new Date() })
        .where(and(eq(invite.workspaceId, id), eq(invite.id, inviteId), isNull(invite.usedAt))),
    );
    auditChange("invite.revoked", id, c.get("operatorId"), { inviteId });
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(getSettingsRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    return c.json(await withWorkspace(db, id, (tx) => readSettings(tx, limits, id)), 200);
  });

  app.openapi(patchSettingsRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const origins = new Set<string>();
    for (const origin of c.req.valid("json").allowedOrigins) {
      const normalized = normalizeOrigin(origin);
      if (normalized === null) {
        return c.json(failure("bad_origin", `This is not a valid origin: ${origin}`), 400);
      }
      origins.add(normalized);
    }
    const settings = await withWorkspace(db, id, async (tx) => {
      await tx
        .update(workspace)
        .set({ allowedOrigins: [...origins] })
        .where(eq(workspace.id, id));
      return readSettings(tx, limits, id);
    });
    // Origins are public, as every page that embeds the widget shows its own.
    auditChange("origins.changed", id, c.get("operatorId"), {
      allowedOrigins: settings.allowedOrigins,
    });
    return c.json(settings, 200);
  });

  app.openapi(rotateSecretRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const settings = await withWorkspace(db, id, async (tx) => {
      await tx
        .update(workspace)
        .set({ signingSecret: randomBytes(32).toString("base64url") })
        .where(eq(workspace.id, id));
      return readSettings(tx, limits, id);
    });
    auditChange("signing_secret.rotated", id, c.get("operatorId"));
    return c.json(settings, 200);
  });

  app.openapi(assignRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const { operatorId } = c.req.valid("json");
    const result = await withWorkspace(db, id, async (tx) => {
      if (operatorId !== null) {
        const [member] = await tx
          .select({ id: workspaceMember.operatorId })
          .from(workspaceMember)
          .where(
            and(
              eq(workspaceMember.workspaceId, id),
              eq(workspaceMember.operatorId, operatorId),
              isNull(workspaceMember.removedAt),
            ),
          );
        if (member === undefined) return "not_member" as const;
      }
      const found = await assignConversation(tx, id, conversationId, operatorId);
      return found ? ("ok" as const) : ("none" as const);
    });
    if (result === "not_member") {
      return c.json(failure("not_a_member", "This person is not in this workspace."), 400);
    }
    if (result === "none") return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    return c.json({ ok: true as const }, 200);
  });

  app.use("/v1/invites/*", limitByIp(rateLimit, "invites", 20, 60));
  app.use("/v1/invites/*", bodyLimit({ maxSize: 8 * 1024 }));

  app.openapi(previewRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const parsed = parseToken(c.req.valid("json").token);
    if (parsed === null) return c.json(BAD_INVITE, 404);
    const [row] = await withWorkspace(db, parsed.workspaceId, (tx) =>
      tx
        .select({ workspaceName: workspace.name, role: invite.role })
        .from(invite)
        .innerJoin(workspace, eq(workspace.id, invite.workspaceId))
        .where(usable(parsed.workspaceId, parsed.tokenHash)),
    );
    if (row === undefined) return c.json(BAD_INVITE, 404);
    return c.json({ workspaceName: row.workspaceName, role: row.role as "admin" | "agent" }, 200);
  });

  app.openapi(joinRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const { token, name } = c.req.valid("json");
    const email = c.req.valid("json").email.toLowerCase();
    const parsed = parseToken(token);
    if (parsed === null) return c.json(BAD_INVITE, 404);
    const { workspaceId, tokenHash } = parsed;
    const [valid] = await withWorkspace(db, workspaceId, (tx) =>
      tx.select({ id: invite.id }).from(invite).where(usable(workspaceId, tokenHash)),
    );
    if (valid === undefined) return c.json(BAD_INVITE, 404);
    // Each one sends an email to an address that whoever holds the invite picks.
    const wait = await rateLimit.hit("invite-join-email", emailAddressHash(email), 5, 3600);
    if (wait !== null) return tooManyRequests(c, wait);
    if (mailer === undefined) {
      const [taken] = await db
        .select({ id: operator.id })
        .from(operator)
        .where(eq(operator.email, email));
      if (taken !== undefined) return c.json(EMAIL_TAKEN, 409);
    }
    const linkToken = randomBytes(32).toString("base64url");
    const pending: z.infer<typeof PendingJoin> = {
      workspaceId,
      inviteHash: tokenHash,
      name,
      email,
      proven: mailer !== undefined,
    };
    await db.insert(verification).values({
      identifier: `${JOIN_LINK}${sha256Hex(linkToken)}`,
      value: JSON.stringify(pending),
      expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000),
    });
    const url = confirmUrl(publicUrl, "join", linkToken);
    // With no mail server, the person who handed out the invite vouches for whoever holds it.
    if (mailer === undefined) return c.json({ ok: true as const, signInUrl: url }, 200);
    const mail = joinMail(url);
    mailer.send(email, mail.subject, mail.body).catch((err: unknown) => {
      logger.error(safeErrorFields(err), "could not send a join link");
    });
    return c.json({ ok: true as const, signInUrl: null }, 200);
  });

  app.openapi(openRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    // Deleted as it is read, so a link works once, even when it is opened twice at once.
    const [row] = await db
      .delete(verification)
      .where(
        and(
          eq(verification.identifier, `${JOIN_LINK}${sha256Hex(c.req.valid("json").token)}`),
          gt(verification.expiresAt, sql`now()`),
        ),
      )
      .returning({ value: verification.value });
    if (row === undefined) return c.json(LINK_INVALID, 400);
    const pending = PendingJoin.parse(JSON.parse(row.value));
    const { workspaceId, email } = pending;
    const result = await withWorkspace(db, workspaceId, async (tx) => {
      const [created] = await tx
        .insert(operator)
        .values({ name: pending.name, email, emailVerified: pending.proven })
        .onConflictDoNothing()
        .returning({ id: operator.id });
      let operatorId = created?.id;
      if (operatorId === undefined) {
        if (!pending.proven) return "email_taken" as const;
        const [found] = await tx
          .select({ id: operator.id })
          .from(operator)
          .where(eq(operator.email, email));
        operatorId = found?.id;
        if (operatorId === undefined) throw new Error("The operator row is missing");
      }
      await consumeInvite(tx, limits, workspaceId, pending.inviteHash, operatorId);
      return { operatorId };
    }).catch((error: unknown) => {
      if (error instanceof InviteUnusableError) return "invite_invalid" as const;
      // Already in the workspace: the link still signs in.
      if (error instanceof AlreadyMemberError) return "member" as const;
      if (error instanceof OperatorLimitError) return "operator_limit" as const;
      throw error;
    });
    if (typeof result === "object") {
      auditChange("invite.used", workspaceId, result.operatorId);
      live.wake(workspaceId, OPERATORS);
    } else if (result === "invite_invalid") {
      return c.json(BAD_INVITE, 404);
    } else if (result === "operator_limit") {
      return c.json(OPERATOR_LIMIT, 409);
    } else if (result === "email_taken") {
      return c.json(EMAIL_TAKEN, 409);
    }
    const cookies = await signInNow(auth, email, c.req.raw.headers);
    if (cookies === null) throw new Error("A sign-in token made just now did not work");
    for (const cookie of cookies) c.header("set-cookie", cookie, { append: true });
    return c.json({ workspaceId }, 200);
  });

  app.openapi(acceptRoute, async (c) => {
    const parsed = parseToken(c.req.valid("json").token);
    if (parsed === null) return c.json(BAD_INVITE, 404);
    const { workspaceId, tokenHash } = parsed;
    const operatorId = c.get("operatorId");
    const result = await withWorkspace(db, workspaceId, async (tx) => {
      const [current] = await tx
        .select({ removedAt: workspaceMember.removedAt })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.workspaceId, workspaceId),
            eq(workspaceMember.operatorId, operatorId),
            isNull(workspaceMember.removedAt),
          ),
        );
      // The invite stays usable, and this member's role does not change by accident.
      if (current !== undefined) return "member" as const;
      await consumeInvite(tx, limits, workspaceId, tokenHash, operatorId);
      return "joined" as const;
    }).catch((error: unknown) => {
      if (error instanceof InviteUnusableError) return "invalid" as const;
      if (error instanceof AlreadyMemberError) return "member" as const;
      if (error instanceof OperatorLimitError) return "full" as const;
      throw error;
    });
    if (result === "member") return c.json(ALREADY_MEMBER, 409);
    if (result === "full") return c.json(OPERATOR_LIMIT, 409);
    if (result === "invalid") return c.json(BAD_INVITE, 404);
    auditChange("invite.used", workspaceId, operatorId);
    live.wake(workspaceId, OPERATORS);
    return c.json({ workspaceId }, 200);
  });
}
