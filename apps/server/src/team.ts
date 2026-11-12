import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import type { Actor } from "./api-keys.ts";
import { SESSION, SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { type Auth, confirmUrl, LINK_MINUTES, signInNow } from "./auth.ts";
import {
  attachment,
  conversation,
  invite,
  operator,
  verification,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, lockLiveOperator, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  INVALID,
  KEY_LIMITED,
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
  WRONG_ORIGIN_TEXT,
} from "./errors.ts";
import { emailAddressHash, normalizeOrigins, sha256Hex } from "./identity.ts";
import { inviteMail, joinMail } from "./letter.ts";
import { type Limits, OPERATOR_LIMIT, OperatorLimitError } from "./limits.ts";
import { type Live, OPERATORS } from "./live.ts";
import { type Mailer, recipientRejected } from "./mailer.ts";
import { OPEN_WHILE_CLOSED } from "./member.ts";
import { assignConversation, recordTeamChange, recordWorkspaceChange } from "./messages.ts";
import type { ImageUrls } from "./public-images.ts";
import { limitByIp, type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { MINUTE_MS } from "./time.ts";
import { isOnlyWorkspace } from "./workspace-delete.ts";

export type Role = "owner" | "admin" | "member";

const PREFIX = "/v1/operator/workspaces/{workspaceId}";
const INVITE_LIFETIME_MS = 7 * 24 * 3_600_000;
const HOUR_SECONDS = 3600;
/** Invite emails a workspace may send in an hour. */
const INVITE_MAILS_PER_WORKSPACE = 20;
/** Invite emails one address may get in an hour, from all workspaces together. */
const INVITE_MAILS_PER_ADDRESS = 5;
/** Allowed sites a workspace may have. */
export const MAX_ORIGINS = 20;

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
const INVITEE_IS_MEMBER = failure("already_member", "This person is already in the workspace.");
const NAME_NEEDED = failure("invalid_request", "Send a name: this account has none yet.");
const EMAIL_REJECTED = failure(
  "email_rejected",
  "The mail server says this address does not exist. Check it and try again.",
);
const MAIL_FAILED = failure("mail_failed", "The invite email could not be sent. Try again soon.");
const OTHER_EMAIL = failure("invite_other_email", "This invite is for another email address.");

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/** The rules in one place, so a route cannot apply a looser version of them. */
export const allowed = {
  settings: (role: Role) => role === "owner" || role === "admin",
  invite: (role: Role, invited: Role) =>
    invited !== "owner" && (role === "owner" || (role === "admin" && invited === "member")),
  changeRole: (role: Role) => role === "owner",
  remove: (role: Role, target: Role, isSelf: boolean) =>
    isSelf || role === "owner" || (role === "admin" && target === "member"),
};

/** Owners and admins, and a Setup key, which the member check let through to a Setup route. */
export const maySetUp = (actor: Actor, role: Role) =>
  actor.kind === "key" || allowed.settings(role);

export const badOrigin = (origin: string) =>
  failure("bad_origin", `This is not a valid origin: ${origin}`);

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

const roleEnum = z.enum(["owner", "admin", "member"]);
const invitedRole = z.enum(["admin", "member"]);
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
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: roleEnum,
    // The member's picture, which they set on their profile. Null with none.
    pictureUrl: z.string().nullable(),
  })
  .openapi("Member");
const PendingInvite = z
  .object({ id: z.string(), email: z.string(), role: invitedRole, expiresAt: z.string() })
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
    // What a delete removes, and whether it is refused: on a self-hosted server, the only
    // workspace that is not deleted stays.
    deletion: z.object({
      conversations: z.number(),
      images: z.number(),
      members: z.number(),
      onlyWorkspace: z.boolean(),
    }),
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
  summary:
    "Invite an email address. With a mail server, the invite goes by email. An earlier invite to the same address stops working.",
  request: {
    params: workspaceParams,
    body: json(z.object({ email: z.email().max(254), role: invitedRole })),
  },
  responses: {
    201: reply(
      "The invite. `token` is null when the invite went by email. On a server with no mail server, it is shown only here, for you to send to the person",
      PendingInvite.extend({ token: z.string().nullable() }),
    ),
    ...ROLE_WRITE_ERRORS,
    409: errorAnswer(
      "already_member: this person is already in the workspace. operator_limit: the workspace has as many operators as its plan allows",
    ),
    422: errorAnswer(
      "email_rejected: the mail server refused the address, so nothing was sent and the invite is revoked",
    ),
    ...RATE_LIMITED,
    502: errorAnswer(
      "mail_failed: the invite email could not be sent, and the invite is revoked. Try again",
    ),
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

const renameRoute = createRoute({
  method: "patch",
  path: PREFIX,
  security: SESSION,
  summary: "Rename the workspace. Open operator apps show the new name.",
  request: {
    params: workspaceParams,
    // The same rule as the workspace name at signup.
    body: json(z.object({ name: z.string().trim().min(1).max(100) })),
  },
  responses: {
    200: reply("The new name", z.object({ name: z.string() })),
    ...ROLE_WRITE_ERRORS,
    400: errorAnswer("invalid_request: the name is blank or over 100 characters"),
  },
});

const assignRoute = createRoute({
  method: "put",
  path: `${PREFIX}/conversations/{conversationId}/assignee`,
  security: SESSION_OR_KEY,
  summary: "Assign a conversation to a member, or clear it with null",
  request: {
    params: workspaceParams.extend({ conversationId: z.uuid() }),
    body: json(z.object({ operatorId: z.uuid().nullable() })),
  },
  responses: {
    200: ok,
    ...KEY_LIMITED,
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
    200: reply(
      "The invite, the email it is for, and whether that email has an account",
      z.object({
        workspaceName: z.string(),
        role: invitedRole,
        email: z.string(),
        hasAccount: z.boolean(),
        inviterName: z.string().openapi({
          description: "The name of the person who made the invite. Empty when they have none",
        }),
        needsName: z.boolean().openapi({
          description: "Join must send a name: the email has no account, or one with no name yet",
        }),
      }),
    ),
    ...inviteErrors,
  },
});

const joinRoute = createRoute({
  method: "post",
  path: "/v1/invites/join",
  summary:
    "Join with an invite, as the email it is for. With no account, this creates one and signs in. With an account, a link to join goes to the email",
  request: {
    body: json(
      tokenBody.extend({
        // Names a new account. An existing account keeps its own name.
        name: z.string().trim().min(1).max(100).optional(),
      }),
    ),
  },
  responses: {
    200: reply(
      "With a workspace ID, the new account joined and is signed in, with the session cookie set. Null means the email has an account: a link to join went to it, and works for 15 minutes",
      z.object({ workspaceId: z.string().nullable() }),
    ),
    ...inviteErrors,
    400: errorAnswer(
      "invalid_request: the request is not valid, or it has no name and the account has none yet",
    ),
    409: errorAnswer(
      "email_taken: the invite was not emailed and the email has an account. Sign in, then accept the invite. operator_limit: the workspace has as many operators as its plan allows",
    ),
  },
});

const openRoute = createRoute({
  method: "post",
  path: "/v1/invites/open",
  summary:
    "Use a join link's token, from the button on the page the link opens: join with the account, and sign in",
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
    409: errorAnswer("operator_limit: the workspace has the most operators its plan allows"),
  },
});

/** What a join link carries, in BetterAuth's verification table until it is opened or expires. */
const PendingJoin = z.object({
  workspaceId: z.uuid(),
  inviteHash: z.string(),
  // Names the account only if it has no name yet, such as after an unfinished signup.
  name: z.string().optional(),
  email: z.string(),
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
    403: errorAnswer(
      `${WRONG_ORIGIN_TEXT}. invite_other_email: the invite is for another email address`,
    ),
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
 * usable. It throws OperatorLimitError if the workspace would have too many operators, and
 * AccountDeletedError if the account was deleted, even by a delete still in flight.
 */
async function consumeInvite(
  tx: Transaction,
  limits: Limits,
  workspaceId: string,
  tokenHash: string,
  operatorId: string,
): Promise<void> {
  await lockLiveOperator(tx, operatorId);
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

/** The answer for an error that rolled back a join. Any other error goes on up. */
function joinFailure(error: unknown) {
  if (error instanceof InviteUnusableError) return "invite_invalid" as const;
  if (error instanceof AlreadyMemberError) return "member" as const;
  if (error instanceof OperatorLimitError) return "operator_limit" as const;
  throw error;
}

/** What the settings read besides the workspace's rows. */
interface SettingsSources {
  limits: Limits;
  keepsLastWorkspace: boolean;
}

/** What deleting the workspace removes, so the owner's confirm can say it with numbers. */
async function deletionContents(tx: Transaction, workspaceId: string) {
  const counted = (table: typeof conversation | typeof attachment) =>
    tx.$count(table, eq(table.workspaceId, workspaceId));
  const [conversations, images, members] = await Promise.all([
    counted(conversation),
    counted(attachment),
    tx.$count(
      workspaceMember,
      and(eq(workspaceMember.workspaceId, workspaceId), isNull(workspaceMember.removedAt)),
    ),
  ]);
  return { conversations, images, members };
}

async function readSettings(
  tx: Transaction,
  { limits, keepsLastWorkspace }: SettingsSources,
  workspaceId: string,
) {
  const [row] = await tx
    .select({
      publicKey: workspace.publicKey,
      allowedOrigins: workspace.allowedOrigins,
      signingSecret: workspace.signingSecret,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (row === undefined) throw new Error("The workspace row is missing");
  return {
    ...row,
    usage: await limits.usage(tx, workspaceId),
    deletion: {
      ...(await deletionContents(tx, workspaceId)),
      onlyWorkspace: keepsLastWorkspace && (await isOnlyWorkspace(tx, workspaceId)),
    },
  };
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

/**
 * The operator leaves the workspace, as a member who leaves from the Team tab: "last_owner" when they
 * are its only owner. Run it in the workspace's context.
 */
export const leaveWorkspace = (tx: Transaction, workspaceId: string, operatorId: string) =>
  changeMember(tx, workspaceId, operatorId, operatorId, { kind: "remove" });

/**
 * Assigns a conversation to an active member, or clears it with null, and wakes the inboxes. The
 * route and the MCP tool share it.
 */
export async function assignTo(
  db: Database,
  live: Live,
  workspaceId: string,
  conversationId: string,
  operatorId: string | null,
): Promise<"ok" | "not_member" | "none"> {
  const result = await withWorkspace(db, workspaceId, async (tx) => {
    if (operatorId !== null) {
      const [member] = await tx
        .select({ id: workspaceMember.operatorId })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.workspaceId, workspaceId),
            eq(workspaceMember.operatorId, operatorId),
            isNull(workspaceMember.removedAt),
          ),
        );
      if (member === undefined) return "not_member" as const;
    }
    const found = await assignConversation(tx, workspaceId, conversationId, operatorId);
    return found ? ("ok" as const) : ("none" as const);
  });
  if (result === "ok") live.wake(workspaceId, OPERATORS);
  return result;
}

export const NOT_A_MEMBER = failure("not_a_member", "This person is not in this workspace.");

interface TeamOptions {
  auth: Auth;
  db: Database;
  limits: Limits;
  live: Live;
  logger: Logger;
  imageUrls: ImageUrls;
  /** Sends join links. Without one, a new operator signs in from the join's answer. */
  mailer: Mailer | undefined;
  rateLimit: RateLimit;
  /** True on a self-hosted server, which keeps its last workspace. */
  keepsLastWorkspace: boolean;
}

export function registerTeamRoutes(
  app: App,
  { auth, db, limits, live, logger, imageUrls, mailer, rateLimit, keepsLastWorkspace }: TeamOptions,
): void {
  const sources = { limits, keepsLastWorkspace };
  const publicUrl = String(auth.options.baseURL);
  const publicOrigin = new URL(publicUrl).origin;
  const auditChange = (event: string, workspaceId: string, operatorId: string, fields = {}) =>
    audit(logger, event, { workspaceId, operatorId, ...fields });
  app.openapi(listMembersRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const rows = await withWorkspace(db, id, (tx) =>
      tx
        .select({
          id: operator.id,
          name: operator.name,
          email: operator.email,
          role: workspaceMember.role,
          pictureUpdatedAt: operator.pictureUpdatedAt,
        })
        .from(workspaceMember)
        .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
        .where(and(eq(workspaceMember.workspaceId, id), isNull(workspaceMember.removedAt)))
        .orderBy(asc(operator.name)),
    );
    const members = rows.map(({ pictureUpdatedAt, ...member }) => ({
      ...member,
      pictureUrl: imageUrls.picture(member.id, pictureUpdatedAt),
    }));
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
        .select({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
        })
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
          ...row,
          role: row.role as "admin" | "member",
          expiresAt: row.expiresAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(createInviteRoute, async (c) => {
    const { role } = c.req.valid("json");
    const email = c.req.valid("json").email.toLowerCase();
    const id = c.get("memberWorkspaceId");
    const operatorId = c.get("operatorId");
    // Checked again below, with the row locked. This one keeps a refused request off the limits.
    if (!allowed.invite(c.get("memberRole"), role)) return c.json(FORBIDDEN, 403);
    if (mailer !== undefined) {
      // Each invite emails an address that the admin picks.
      const wait =
        (await rateLimit.hit("invite-mail", id, INVITE_MAILS_PER_WORKSPACE, HOUR_SECONDS)) ??
        (await rateLimit.hit(
          "invite-mail-to",
          emailAddressHash(email),
          INVITE_MAILS_PER_ADDRESS,
          HOUR_SECONDS,
        ));
      if (wait !== null) return tooManyRequests(c, wait);
    }
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
      if (creator === undefined || !allowed.invite(creator.role, role)) return "forbidden" as const;
      const [member] = await tx
        .select({ id: operator.id })
        .from(workspaceMember)
        .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
        .where(
          and(
            eq(workspaceMember.workspaceId, id),
            eq(operator.email, email),
            isNull(workspaceMember.removedAt),
          ),
        );
      if (member !== undefined) return "member" as const;
      // Inviting someone again replaces their invite, so only the newest link works. Two inviters
      // lock different creator rows, so this lock on the address makes the second one wait and
      // revoke the first one's invite.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`invite:${id}:${email}`}, 0))`,
      );
      await tx
        .update(invite)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invite.workspaceId, id),
            eq(invite.email, email),
            isNull(invite.usedAt),
            isNull(invite.revokedAt),
          ),
        );
      if (!(await limits.mayInvite(tx, id))) return "full" as const;
      const [row] = await tx
        .insert(invite)
        .values({
          workspaceId: id,
          tokenHash: sha256Hex(token),
          role,
          email,
          mailed: mailer !== undefined,
          createdBy: operatorId,
          expiresAt,
        })
        .returning({ id: invite.id });
      const [named] = await tx
        .select({ name: workspace.name })
        .from(workspace)
        .where(eq(workspace.id, id));
      if (row === undefined || named === undefined) throw new Error("The invite row is missing");
      return { id: row.id, workspaceName: named.name };
    });
    if (created === "forbidden") return c.json(FORBIDDEN, 403);
    if (created === "member") return c.json(INVITEE_IS_MEMBER, 409);
    if (created === "full") return c.json(OPERATOR_LIMIT, 409);
    const answer = { id: created.id, email, role, expiresAt: expiresAt.toISOString() };
    // With no mail server, the admin hands the link out, so the answer is the only place it shows.
    if (mailer === undefined) {
      auditChange("invite.created", id, operatorId, { inviteId: created.id, role });
      return c.json({ ...answer, token }, 201);
    }
    const url = new URL("/invite", publicUrl);
    url.searchParams.set("token", token);
    const mail = inviteMail(url.href, created.workspaceName, role);
    // The answer waits for the mail server, so the admin learns when the email did not go out.
    try {
      await mailer.send(email, mail.subject, mail.body);
    } catch (err) {
      logger.error(safeErrorFields(err), "could not send an invite");
      // Nobody got the link, so the invite would only hold a seat.
      await withWorkspace(db, id, (tx) =>
        tx
          .update(invite)
          .set({ revokedAt: new Date() })
          .where(and(eq(invite.workspaceId, id), eq(invite.id, created.id))),
      );
      return recipientRejected(err) ? c.json(EMAIL_REJECTED, 422) : c.json(MAIL_FAILED, 502);
    }
    auditChange("invite.created", id, operatorId, { inviteId: created.id, role });
    return c.json({ ...answer, token: null }, 201);
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
    return c.json(await withWorkspace(db, id, (tx) => readSettings(tx, sources, id)), 200);
  });

  app.openapi(patchSettingsRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const normalized = normalizeOrigins(c.req.valid("json").allowedOrigins);
    if ("bad" in normalized) return c.json(badOrigin(normalized.bad), 400);
    const settings = await withWorkspace(db, id, async (tx) => {
      await tx
        .update(workspace)
        .set({ allowedOrigins: normalized.origins })
        .where(eq(workspace.id, id));
      return readSettings(tx, sources, id);
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
      return readSettings(tx, sources, id);
    });
    auditChange("signing_secret.rotated", id, c.get("operatorId"));
    return c.json(settings, 200);
  });

  app.openapi(renameRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { name } = c.req.valid("json");
    await withWorkspace(db, id, async (tx) => {
      await tx.update(workspace).set({ name }).where(eq(workspace.id, id));
      await recordWorkspaceChange(tx, id);
    });
    // Open apps read `me` again on the event. A lost signal only delays it until the next one.
    live.wake(id, OPERATORS);
    auditChange("workspace.renamed", id, c.get("operatorId"));
    return c.json({ name }, 200);
  });

  app.openapi(assignRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const { operatorId } = c.req.valid("json");
    const result = await assignTo(db, live, c.get("memberWorkspaceId"), conversationId, operatorId);
    if (result === "not_member") return c.json(NOT_A_MEMBER, 400);
    if (result === "none") return c.json(NOT_FOUND, 404);
    return c.json({ ok: true as const }, 200);
  });

  app.use("/v1/invites/*", limitByIp(rateLimit, "invites", 20, 60));
  app.use("/v1/invites/*", bodyLimit({ maxSize: 8 * 1024 }));

  /** The invite a token names, if it can still be used. */
  const readInvite = async (workspaceId: string, tokenHash: string) => {
    const [row] = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({
          workspaceName: workspace.name,
          inviterName: sql<string>`coalesce((select ${operator.name} from ${operator} where ${operator.id} = ${invite.createdBy}), '')`,
          role: invite.role,
          email: invite.email,
          mailed: invite.mailed,
          hasAccount: sql<boolean>`exists (select 1 from ${operator} where ${operator.email} = ${invite.email})`,
          needsName: sql<boolean>`not exists (select 1 from ${operator} where ${operator.email} = ${invite.email} and ${operator.name} <> '')`,
        })
        .from(invite)
        .innerJoin(workspace, eq(workspace.id, invite.workspaceId))
        .where(usable(workspaceId, tokenHash)),
    );
    return row;
  };

  /** Signs `email` in, with the session cookie on the answer. */
  const startSession = async (c: Context, email: string, route: "email" | "shown") => {
    const cookies = await signInNow(auth, db, email, c.req.raw.headers, route);
    if (cookies === null) throw new Error("A sign-in token made just now did not work");
    for (const cookie of cookies) c.header("set-cookie", cookie, { append: true });
  };

  const joined = (workspaceId: string, operatorId: string) => {
    auditChange("invite.used", workspaceId, operatorId);
    live.wake(workspaceId, OPERATORS);
  };

  app.openapi(previewRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const parsed = parseToken(c.req.valid("json").token);
    if (parsed === null) return c.json(BAD_INVITE, 404);
    const row = await readInvite(parsed.workspaceId, parsed.tokenHash);
    if (row === undefined) return c.json(BAD_INVITE, 404);
    // Only the invitee holds the token, or on a server with no mail server, whoever the admin gave
    // it to. So the email, and whether it has an account, tell a stranger nothing.
    return c.json(
      {
        workspaceName: row.workspaceName,
        inviterName: row.inviterName,
        role: row.role as "admin" | "member",
        email: row.email,
        hasAccount: row.hasAccount,
        needsName: row.needsName,
      },
      200,
    );
  });

  app.openapi(joinRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const { token, name } = c.req.valid("json");
    const parsed = parseToken(token);
    if (parsed === null) return c.json(BAD_INVITE, 404);
    const { workspaceId, tokenHash } = parsed;
    const offer = await readInvite(workspaceId, tokenHash);
    if (offer === undefined) return c.json(BAD_INVITE, 404);
    const { email, mailed } = offer;
    // A new account, or one an unfinished signup left unnamed, takes the name sent here.
    if (offer.needsName && name === undefined) return c.json(NAME_NEEDED, 400);
    if (!offer.hasAccount && name !== undefined) {
      const result = await withWorkspace(db, workspaceId, async (tx) => {
        const [created] = await tx
          .insert(operator)
          .values({ name, email, emailProven: mailed })
          .onConflictDoNothing()
          .returning({ id: operator.id });
        // The account appeared in the meantime, so it joins as an existing one, below.
        if (created === undefined) return "exists" as const;
        await consumeInvite(tx, limits, workspaceId, tokenHash, created.id);
        return { operatorId: created.id };
      }).catch(joinFailure);
      if (result === "invite_invalid") return c.json(BAD_INVITE, 404);
      if (result === "operator_limit") return c.json(OPERATOR_LIMIT, 409);
      if (typeof result === "object") {
        joined(workspaceId, result.operatorId);
        // A mailed token proves the mailbox. Otherwise the admin who handed it out vouches for it.
        await startSession(c, email, mailed ? "email" : "shown");
        return c.json({ workspaceId }, 200);
      }
    }
    // The email has an account, and only its mailbox may sign in to it.
    if (!mailed || mailer === undefined) return c.json(EMAIL_TAKEN, 409);
    const wait = await rateLimit.hit("invite-join-email", emailAddressHash(email), 5, HOUR_SECONDS);
    if (wait !== null) return tooManyRequests(c, wait);
    const linkToken = randomBytes(32).toString("base64url");
    const pending: z.infer<typeof PendingJoin> = {
      workspaceId,
      inviteHash: tokenHash,
      name,
      email,
    };
    await db.insert(verification).values({
      identifier: `${JOIN_LINK}${sha256Hex(linkToken)}`,
      value: JSON.stringify(pending),
      expiresAt: new Date(Date.now() + LINK_MINUTES * MINUTE_MS),
    });
    const mail = joinMail(
      confirmUrl(publicUrl, "join", linkToken),
      offer.workspaceName,
      offer.inviterName,
    );
    mailer.send(email, mail.subject, mail.body).catch((err: unknown) => {
      logger.error(safeErrorFields(err), "could not send a join link");
    });
    return c.json({ workspaceId: null }, 200);
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
      // An account left unnamed, such as by an unfinished signup, takes the typed name.
      const [found] = await tx
        .update(operator)
        .set({
          name: sql`case when ${operator.name} = '' then ${pending.name ?? ""} else ${operator.name} end`,
        })
        .where(and(eq(operator.email, email), isNull(operator.deletedAt)))
        .returning({ id: operator.id });
      if (found === undefined) return "gone" as const;
      await consumeInvite(tx, limits, workspaceId, pending.inviteHash, found.id);
      return { operatorId: found.id };
    }).catch(joinFailure);
    if (result === "gone") return c.json(LINK_INVALID, 400);
    if (result === "invite_invalid") return c.json(BAD_INVITE, 404);
    if (result === "operator_limit") return c.json(OPERATOR_LIMIT, 409);
    // Already in the workspace: the link still signs in.
    if (typeof result === "object") joined(workspaceId, result.operatorId);
    await startSession(c, email, "email");
    return c.json({ workspaceId }, 200);
  });

  app.openapi(acceptRoute, async (c) => {
    const parsed = parseToken(c.req.valid("json").token);
    if (parsed === null) return c.json(BAD_INVITE, 404);
    const { workspaceId, tokenHash } = parsed;
    const operatorId = c.get("operatorId");
    const result = await withWorkspace(db, workspaceId, async (tx) => {
      const [offered] = await tx
        .select({ email: invite.email })
        .from(invite)
        .where(usable(workspaceId, tokenHash));
      if (offered === undefined) return "invite_invalid" as const;
      if (offered.email !== c.get("operatorEmail").toLowerCase()) return "other_email" as const;
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
    }).catch(joinFailure);
    if (result === "other_email") return c.json(OTHER_EMAIL, 403);
    if (result === "member") return c.json(ALREADY_MEMBER, 409);
    if (result === "operator_limit") return c.json(OPERATOR_LIMIT, 409);
    if (result === "invite_invalid") return c.json(BAD_INVITE, 404);
    joined(workspaceId, operatorId);
    return c.json({ workspaceId }, 200);
  });
}
