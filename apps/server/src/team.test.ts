import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { untilWaiting } from "../test/locks.ts";
import {
  captureMail,
  cookieOf,
  openLink,
  openSignInLink,
  pressLinkButton,
  signedInOperator,
  signIn,
} from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import {
  account,
  conversation,
  event,
  invite,
  operator,
  verification,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { sha256Hex } from "./identity.ts";
import type { Live } from "./live.ts";
import { appendMessage } from "./messages.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const SITE = "https://app.example.com";
// Captures the audit lines that security changes write.
const lines: Record<string, unknown>[] = [];
const logger = pino(
  { level: "info" },
  {
    write: (line: string) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.msg === "audit") lines.push(parsed);
    },
  },
);
const audits = (event: string) => lines.filter((line) => line.event === event);
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: ReturnType<typeof createAuth>;
let app: App;
/** The same server with a mail server, so join links go by email. */
let mailApp: App;
const mail = captureMail();
let space: NewWorkspace;
const wakes: string[] = [];
const live: Live = {
  wake(_workspaceId, subscriber) {
    wakes.push(subscriber);
  },
  revoke() {},
  async subscribe() {
    return () => {};
  },
  stop() {},
};

interface Person {
  id: string;
  email: string;
  cookie: string;
}

const person = (
  role: "owner" | "admin" | "member" | null,
  workspaceId = space.id,
): Promise<Person> =>
  signedInOperator({
    app,
    auth,
    owner,
    email: `${role ?? "outsider"}-${randomUUID()}@example.com`,
    ...(role === null ? {} : { workspaceId, role }),
  });

const call = (method: string, path: string, as: Person | null, body?: unknown, origin = ORIGIN) =>
  app.request(path, {
    method,
    headers: {
      ...(as === null ? {} : { cookie: as.cookie }),
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const inSpace = (path: string, id = space.id) => `/v1/operator/workspaces/${id}${path}`;

const newEmail = () => `invitee-${randomUUID()}@example.com`;

/** Invites `email` as `by`, and returns the answer's body. */
async function createInvite(
  by: Person,
  role: "admin" | "member" = "member",
  email = newEmail(),
  server = app,
) {
  const response = await server.request(inSpace("/invites"), {
    method: "POST",
    headers: { cookie: by.cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; email: string; token: string | null };
}

/** Invites `email` on the server with no mail server, and returns the token it shows. */
async function newInvite(by: Person, role: "admin" | "member" = "member", email = newEmail()) {
  const { token } = await createInvite(by, role, email);
  if (token === null) throw new Error("A server with no mail server showed no token");
  return token;
}

/** Invites `email` on the server with a mail server, and returns the token from the email. */
async function mailInvite(by: Person, email: string, role: "admin" | "member" = "member") {
  const before = mail.countTo(email);
  expect((await createInvite(by, role, email, mailApp)).token).toBeNull();
  const link = new URL(await mail.linkTo(email, before));
  return link.searchParams.get("token") ?? "";
}

/** A second usable invite for the same email, which the API would replace. Returns its token. */
async function plantInvite(by: Person, email: string, role: "admin" | "member") {
  const token = `${space.id}.${randomUUID()}`;
  await owner.insert(invite).values({
    workspaceId: space.id,
    tokenHash: sha256Hex(token),
    role,
    email,
    mailed: false,
    createdBy: by.id,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return token;
}

const memberRow = async (operatorId: string, workspaceId = space.id) => {
  const [row] = await owner
    .select()
    .from(workspaceMember)
    .where(
      and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.operatorId, operatorId)),
    );
  return row;
};

/** Joins with an invite, as a person with no session does. */
const join = (
  token: string,
  // Null sends no name, as for an existing account.
  { server = app, origin = ORIGIN, name = "New Person" as string | null } = {},
) =>
  server.request("/v1/invites/join", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token, ...(name === null ? {} : { name }) }),
  });

/** Joins as a new account, and returns the session cookie. */
async function joinNew(token: string, server = app) {
  const response = await join(token, { server });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ workspaceId: space.id });
  return cookieOf(response);
}

/** Opens a join link and selects the page's button, as a person does. */
async function openJoin(url: string, server = app) {
  await openLink(server, url);
  const response = await pressLinkButton(server, url);
  const body = (await response.json()) as { workspaceId?: string; error?: { code: string } };
  return {
    cookie: cookieOf(response),
    workspaceId: body.workspaceId ?? null,
    error: body.error?.code ?? null,
  };
}

const operatorRow = async (email: string) =>
  (await owner.select().from(operator).where(eq(operator.email, email)))[0];

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    auth,
    db,
    live,
    logger,
    checks: { postgres: ok, valkey: ok },
  });
  mailApp = createApp({
    auth,
    db,
    live,
    logger,
    mailer: mail,
    checks: { postgres: ok, valkey: ok },
  });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  wakes.length = 0;
  space = await createWorkspace(db, "Acme", [SITE]);
});

describe("inviting by email", () => {
  test.each([
    [
      "a refused address",
      Object.assign(new Error("550"), { code: "EENVELOPE", responseCode: 550 }),
      422,
      "email_rejected",
    ],
    ["a mail server that is down", new Error("connect ECONNREFUSED"), 502, "mail_failed"],
  ])(
    "an invite email that fails for %s says so, and revokes the invite",
    async (_, error, status, code) => {
      const boss = await person("owner");
      const email = newEmail();
      const send = mail.send;
      mail.send = async () => {
        throw error;
      };
      try {
        const response = await mailApp.request(inSpace("/invites"), {
          method: "POST",
          headers: { cookie: boss.cookie, origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email, role: "member" }),
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ error: { code } });
      } finally {
        mail.send = send;
      }
      const rows = await owner.select().from(invite).where(eq(invite.email, email));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
    },
  );

  test("with a mail server, the invite goes by email, and the answer shows no token", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const created = await createInvite(boss, "admin", email.toUpperCase(), mailApp);
    expect(created).toMatchObject({ email, role: "admin", token: null });
    const link = await mail.linkTo(email);
    expect(link.startsWith(`${ORIGIN}/invite?token=${space.id}.`)).toBe(true);
    const sent = mail.sent.find((one) => one.to === email);
    expect(sent?.subject).toBe("Join Acme on Dinghy");
    expect(sent?.text.startsWith("Hi,\n\n")).toBe(true);
    expect(sent?.text).toContain("Acme on Dinghy as an admin");
    expect(sent?.text).toContain("7 days");
    expect(sent?.text.endsWith("\n\nCheers,\nThe Dinghy team")).toBe(true);
    const listed = await call("GET", inSpace("/invites"), boss);
    expect(await listed.json()).toMatchObject({ invites: [{ id: created.id, email }] });
  });

  test("with no mail server, the answer shows the token and nothing is sent", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const created = await createInvite(boss, "member", email);
    expect(created.token?.startsWith(`${space.id}.`)).toBe(true);
    expect(mail.countTo(email)).toBe(0);
  });

  test("inviting the same email again replaces the old invite", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const first = await newInvite(boss, "member", email);
    const second = await newInvite(boss, "admin", email);
    expect((await call("POST", "/v1/invites/preview", null, { token: first })).status).toBe(404);
    const offer = await call("POST", "/v1/invites/preview", null, { token: second });
    expect(await offer.json()).toMatchObject({ role: "admin" });
    const listed = (await (await call("GET", inSpace("/invites"), boss)).json()) as {
      invites: unknown[];
    };
    expect(listed.invites).toHaveLength(1);
  });

  test("a member's email cannot be invited", async () => {
    const boss = await person("owner");
    const member = await person("member");
    const response = await call("POST", inSpace("/invites"), boss, {
      email: member.email.toUpperCase(),
      role: "admin",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "already_member" } });
    expect(await owner.select().from(invite).where(eq(invite.workspaceId, space.id))).toEqual([]);
  });

  test("a mailed invite and a new email join with one request, and prove the email", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const token = await mailInvite(boss, email, "admin");
    const offer = await call("POST", "/v1/invites/preview", null, { token });
    expect(await offer.json()).toEqual({
      workspaceName: "Acme",
      inviterName: boss.email,
      role: "admin",
      email,
      hasAccount: false,
      needsName: true,
    });
    const cookie = await joinNew(token, mailApp);
    const me = await mailApp.request("/v1/operator/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({
      name: "New Person",
      email,
      workspaces: [{ workspaceId: space.id, role: "admin" }],
    });
    expect((await operatorRow(email))?.emailProven).toBe(true);
    // The invite was the only email.
    expect(mail.countTo(email)).toBe(1);
    expect((await join(token, { server: mailApp })).status).toBe(404);
  });

  test("a new account needs a name", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const token = await mailInvite(boss, email);
    expect((await join(token, { server: mailApp, name: null })).status).toBe(400);
    expect(await operatorRow(email)).toBeUndefined();
  });

  test("a mailed invite and an existing account: a link goes to the email, and it joins and signs in", async () => {
    const other = await createWorkspace(db, "Other", [SITE]);
    const existing = await person("owner", other.id);
    const boss = await person("owner");
    const token = await mailInvite(boss, existing.email);
    const offer = await call("POST", "/v1/invites/preview", null, { token });
    expect(await offer.json()).toMatchObject({ email: existing.email, hasAccount: true });
    const response = await join(token, { server: mailApp, name: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: null });
    expect(response.headers.getSetCookie()).toEqual([]);
    const link = await mail.linkTo(existing.email, 1);
    expect(link.startsWith(`${ORIGIN}/link?for=join&token=`)).toBe(true);
    expect(mail.sent.at(-1)?.subject).toBe("Your link to join your team on Dinghy");
    // Opening the link, as a mail scanner does, uses nothing.
    await openLink(mailApp, link);
    expect(await memberRow(existing.id)).toBeUndefined();
    const { cookie, workspaceId } = await openJoin(link, mailApp);
    expect(workspaceId).toBe(space.id);
    expect((await memberRow(existing.id))?.role).toBe("member");
    // Its own name stays.
    const me = await mailApp.request("/v1/operator/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ id: existing.id, name: existing.email });
    const again = await pressLinkButton(mailApp, link);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: "link_invalid" } });
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  test("an expired join link changes nothing", async () => {
    const existing = await person(null);
    const boss = await person("owner");
    const token = await mailInvite(boss, existing.email);
    await join(token, { server: mailApp });
    const link = await mail.linkTo(existing.email, 1);
    await owner
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(sql`${verification.identifier} like 'invite-join:%'`);
    expect((await openJoin(link, mailApp)).error).toBe("link_invalid");
    expect(await memberRow(existing.id)).toBeUndefined();
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(200);
  });

  test("an existing account with no name takes the typed one", async () => {
    const [unnamed] = await owner
      .insert(operator)
      .values({ name: "", email: newEmail(), emailVerified: true })
      .returning({ id: operator.id, email: operator.email });
    if (unnamed === undefined) throw new Error("No operator");
    const boss = await person("owner");
    const token = await mailInvite(boss, unnamed.email);
    const offer = await call("POST", "/v1/invites/preview", null, { token });
    expect(await offer.json()).toMatchObject({ hasAccount: true, needsName: true });
    expect((await join(token, { server: mailApp, name: null })).status).toBe(400);
    await join(token, { server: mailApp });
    const { cookie } = await openJoin(await mail.linkTo(unnamed.email, 1), mailApp);
    const me = await mailApp.request("/v1/operator/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ id: unnamed.id, name: "New Person" });
  });

  test("an invite used or revoked before the join link opens makes nothing", async () => {
    const boss = await person("owner");
    const used = await person(null);
    const usedToken = await mailInvite(boss, used.email);
    await join(usedToken, { server: mailApp });
    expect(
      (await call("POST", "/v1/operator/invites/accept", used, { token: usedToken })).status,
    ).toBe(200);
    const revoked = await person(null);
    await join(await mailInvite(boss, revoked.email), { server: mailApp });
    const [pending] = (await (await call("GET", inSpace("/invites"), boss)).json()).invites as {
      id: string;
    }[];
    await call("DELETE", inSpace(`/invites/${pending?.id}`), boss);
    for (const { email } of [used, revoked]) {
      const opened = await openJoin(await mail.linkTo(email, 1), mailApp);
      expect(opened).toEqual({ cookie: "", workspaceId: null, error: "invite_invalid" });
    }
    expect(await memberRow(revoked.id)).toBeUndefined();
  });

  test("with no mail server, a new email joins at once and proves nothing", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const cookie = await joinNew(await newInvite(boss, "member", email));
    const me = await app.request("/v1/operator/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ email, workspaces: [{ workspaceId: space.id }] });
    expect((await operatorRow(email))?.emailProven).toBe(false);
    // A link from `chat sign-in-link` signs in, and proves nothing either.
    const shown = await signIn(app, auth, email);
    expect((await operatorRow(email))?.emailProven).toBe(false);
    // Once the server sends email, the mailbox's owner proves it and the earlier sessions end.
    const asked = await mailApp.request("/v1/auth/sign-in/magic-link", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(asked.status).toBe(200);
    const proven = await openSignInLink(mailApp, await mail.linkTo(email));
    expect((await operatorRow(email))?.emailProven).toBe(true);
    for (const old of [cookie, shown]) {
      expect((await app.request("/v1/operator/me", { headers: { cookie: old } })).status).toBe(401);
    }
    expect((await app.request("/v1/operator/me", { headers: { cookie: proven } })).status).toBe(
      200,
    );
  });

  test("with no mail server, an existing account cannot join without signing in", async () => {
    const existing = await person(null);
    const boss = await person("owner");
    const token = await newInvite(boss, "member", existing.email);
    const response = await join(token, { name: null });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "email_taken" } });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(200);
  });

  test("a signed-in account with another email cannot accept the invite", async () => {
    const boss = await person("owner");
    const someone = await person(null);
    const token = await newInvite(boss);
    const response = await call("POST", "/v1/operator/invites/accept", someone, { token });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "invite_other_email" } });
    expect(await memberRow(someone.id)).toBeUndefined();
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(200);
  });

  test("a password in the body is ignored, and nothing stores one", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const token = await newInvite(boss, "member", email);
    const response = await call("POST", "/v1/invites/join", null, {
      token,
      name: "New",
      password: "a-long-password-value",
    });
    expect(response.status).toBe(200);
    const created = await operatorRow(email);
    expect(created).toBeDefined();
    expect(
      await owner
        .select()
        .from(account)
        .where(eq(account.userId, created?.id ?? "")),
    ).toEqual([]);
  });
});

describe("the audit log", () => {
  test("each security change writes one line, with IDs and no email or secret", async () => {
    const boss = await person("owner");
    const target = await person("member");
    const leaving = await person("member");
    lines.length = 0;
    await call("PATCH", inSpace(`/members/${target.id}`), boss, { role: "admin" });
    await call("DELETE", inSpace(`/members/${leaving.id}`), boss);
    await call("PATCH", inSpace("/settings"), boss, { allowedOrigins: [SITE] });
    const rotated = await call("POST", inSpace("/settings/rotate-secret"), boss, {});
    const { signingSecret } = (await rotated.json()) as { signingSecret: string };
    const joiner = newEmail();
    const token = await newInvite(boss, "member", joiner);
    expect(await joinNew(token)).not.toBe("");

    const by = { workspaceId: space.id, operatorId: boss.id };
    expect(audits("member.role_changed")).toEqual([
      expect.objectContaining({ ...by, targetId: target.id, role: "admin" }),
    ]);
    expect(audits("member.removed")).toEqual([
      expect.objectContaining({ ...by, targetId: leaving.id }),
    ]);
    expect(audits("origins.changed")).toEqual([
      expect.objectContaining({ ...by, allowedOrigins: [SITE] }),
    ]);
    expect(audits("signing_secret.rotated")).toEqual([expect.objectContaining(by)]);
    expect(audits("invite.created")).toEqual([expect.objectContaining(by)]);
    expect(audits("invite.used")).toEqual([expect.objectContaining({ workspaceId: space.id })]);
    const text = JSON.stringify(lines);
    for (const secret of [signingSecret, token, joiner, target.email, boss.email]) {
      expect(text).not.toContain(secret);
    }
  });

  test("a refused change writes no line", async () => {
    const member = await person("member");
    lines.length = 0;
    expect((await call("POST", inSpace("/settings/rotate-secret"), member, {})).status).toBe(403);
    expect(lines).toEqual([]);
  });
});

describe("each role can do only what it should", () => {
  const AGENT_ID = "00000000-0000-4000-8000-000000000001";
  type Check = [string, (as: Person) => Promise<Response> | Response, Record<string, number>];
  const checks: Check[] = [
    [
      "read settings",
      (as) => call("GET", inSpace("/settings"), as),
      { owner: 200, admin: 200, member: 403 },
    ],
    [
      "change origins",
      (as) => call("PATCH", inSpace("/settings"), as, { allowedOrigins: [SITE] }),
      { owner: 200, admin: 200, member: 403 },
    ],
    [
      "rotate the secret",
      (as) => call("POST", inSpace("/settings/rotate-secret"), as, {}),
      { owner: 200, admin: 200, member: 403 },
    ],
    [
      "list invites",
      (as) => call("GET", inSpace("/invites"), as),
      { owner: 200, admin: 200, member: 403 },
    ],
    [
      "invite a member",
      (as) => call("POST", inSpace("/invites"), as, { email: newEmail(), role: "member" }),
      { owner: 201, admin: 201, member: 403 },
    ],
    [
      "invite an admin",
      (as) => call("POST", inSpace("/invites"), as, { email: newEmail(), role: "admin" }),
      { owner: 201, admin: 403, member: 403 },
    ],
    [
      "list members",
      (as) => call("GET", inSpace("/members"), as),
      { owner: 200, admin: 200, member: 200 },
    ],
    [
      "revoke an invite",
      (as) => call("DELETE", inSpace(`/invites/${AGENT_ID}`), as),
      { owner: 200, admin: 200, member: 403 },
    ],
  ];

  test.each(checks)("%s", async (_name, run, expected) => {
    for (const role of ["owner", "admin", "member"] as const) {
      expect([role, (await run(await person(role))).status]).toEqual([role, expected[role]]);
    }
  });

  test("an owner cannot be invited, by anyone", async () => {
    const boss = await person("owner");
    const response = await call("POST", inSpace("/invites"), boss, {
      email: newEmail(),
      role: "owner",
    });
    expect(response.status).toBe(400);
  });

  test("only an owner changes a role", async () => {
    const target = await person("member");
    for (const role of ["admin", "member"] as const) {
      const as = await person(role);
      const response = await call("PATCH", inSpace(`/members/${target.id}`), as, { role: "admin" });
      expect(response.status).toBe(403);
      // Nobody promotes themselves either.
      const self = await call("PATCH", inSpace(`/members/${as.id}`), as, { role: "owner" });
      expect(self.status).toBe(403);
    }
    expect((await memberRow(target.id))?.role).toBe("member");
    const boss = await person("owner");
    expect(
      (await call("PATCH", inSpace(`/members/${target.id}`), boss, { role: "admin" })).status,
    ).toBe(200);
    expect((await memberRow(target.id))?.role).toBe("admin");
  });

  test("an admin removes only members, a member removes only itself", async () => {
    const admin = await person("admin");
    const member = await person("member");
    const otherMember = await person("member");
    const otherAdmin = await person("admin");
    const boss = await person("owner");
    const remove = (as: Person, target: Person) =>
      call("DELETE", inSpace(`/members/${target.id}`), as);
    expect((await remove(member, otherMember)).status).toBe(403);
    expect((await remove(admin, otherAdmin)).status).toBe(403);
    expect((await remove(admin, boss)).status).toBe(403);
    expect((await remove(admin, otherMember)).status).toBe(200);
    expect((await remove(member, member)).status).toBe(200);
    expect((await memberRow(otherMember.id))?.removedAt).toBeInstanceOf(Date);
  });

  test("a role change takes effect on the next request", async () => {
    const boss = await person("owner");
    const admin = await person("admin");
    expect((await call("GET", inSpace("/settings"), admin)).status).toBe(200);
    await call("PATCH", inSpace(`/members/${admin.id}`), boss, { role: "member" });
    expect((await call("GET", inSpace("/settings"), admin)).status).toBe(403);
  });

  test("a body sent slowly cannot finish after its sender's removal", async () => {
    const boss = await person("owner");
    const admin = await person("admin");
    // The server reads "{", then waits for the rest, which comes after the removal. With a
    // Content-Length, the body limit lets the body stream instead of reading it first.
    let finish = () => {};
    let reading = () => {};
    const waiting = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      pull(controller) {
        reading();
        return new Promise<void>((resolve) => {
          finish = () => {
            controller.enqueue(new TextEncoder().encode("}"));
            controller.close();
            resolve();
          };
        });
      },
    });
    const pending = app.request(inSpace("/settings"), {
      method: "PATCH",
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "content-length": "2",
      },
      body,
      duplex: "half",
    } as RequestInit);
    await waiting;
    expect((await call("DELETE", inSpace(`/members/${admin.id}`), boss)).status).toBe(200);
    finish();
    const response = await pending;
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("signingSecret");
  });

  test("a member of another workspace sees nothing here", async () => {
    const other = await createWorkspace(db, "Other", [SITE]);
    const outsider = await person("owner", other.id);
    for (const path of ["/settings", "/members", "/invites"]) {
      expect((await call("GET", inSpace(path), outsider)).status).toBe(404);
    }
    const target = await person("member");
    expect((await call("DELETE", inSpace(`/members/${target.id}`), outsider)).status).toBe(404);
  });
});

describe("the last owner", () => {
  test("cannot be demoted or removed, and a second owner makes both possible", async () => {
    const boss = await person("owner");
    const path = inSpace(`/members/${boss.id}`);
    const refused = {
      code: "last_owner",
      message: "A workspace needs an owner. Make someone else owner first.",
    };
    for (const answer of [
      await call("PATCH", path, boss, { role: "admin" }),
      await call("DELETE", path, boss),
    ]) {
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: refused });
    }
    const second = await person("member");
    await call("PATCH", inSpace(`/members/${second.id}`), boss, { role: "owner" });
    expect((await call("PATCH", path, boss, { role: "admin" })).status).toBe(200);
  });

  test("two owners who demote each other at once leave one owner", async () => {
    const one = await person("owner");
    const two = await person("owner");
    // A held lock makes both requests read the roles before either can write, every time.
    let both: Promise<Response[]> | undefined;
    await owner.transaction(async (tx) => {
      await tx
        .select()
        .from(workspaceMember)
        .where(eq(workspaceMember.workspaceId, space.id))
        .for("update");
      both = Promise.all([
        Promise.resolve(call("PATCH", inSpace(`/members/${two.id}`), one, { role: "member" })),
        Promise.resolve(call("PATCH", inSpace(`/members/${one.id}`), two, { role: "member" })),
      ]);
      await untilWaiting(owner, 2);
    });
    const [first, second] = (await both) ?? [];
    if (first === undefined || second === undefined) throw new Error("No responses");
    expect([first.status, second.status].filter((status) => status === 200)).toHaveLength(1);
    const owners = await owner
      .select()
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, space.id), eq(workspaceMember.role, "owner")));
    expect(owners).toHaveLength(1);
  });
});

describe("team changes and other writes at once", () => {
  test("a team change waiting for the workspace does not deadlock with a reply", async () => {
    const boss = await person("owner");
    const replier = await person("member");
    const target = await person("member");
    const visitorId = randomUUID();
    await owner.execute(
      sql`insert into visitor (workspace_id, id, token_hash) values (${space.id}, ${visitorId}, ${randomUUID()})`,
    );
    const { message } = await withWorkspace(db, space.id, (tx) =>
      appendMessage(
        tx,
        space.id,
        { kind: "visitor", visitorId },
        {
          clientId: randomUUID(),
          body: "Hello",
        },
      ),
    );
    let changed: Promise<Response> | undefined;
    // The reply holds the workspace row while the team change starts, as in the real overlap.
    await withWorkspace(db, space.id, async (tx) => {
      const before = await tx.execute(
        sql`select event_seq from workspace where id = ${space.id} for update`,
      );
      expect(before.rows).toHaveLength(1);
      changed = Promise.resolve(
        call("PATCH", inSpace(`/members/${target.id}`), boss, { role: "admin" }),
      );
      await untilWaiting(owner);
      // This foreign key check needs the author's row, which the team change has locked.
      await tx
        .update(conversation)
        .set({ assigneeOperatorId: replier.id })
        .where(eq(conversation.id, message.conversationId));
    });
    expect((await changed)?.status).toBe(200);
  });

  test("an invite created during its creator's removal does not survive it", async () => {
    const admin = await person("admin");
    let attempt: Promise<Response> | undefined;
    await owner.transaction(async (tx) => {
      await tx
        .update(workspaceMember)
        .set({ removedAt: new Date() })
        .where(eq(workspaceMember.operatorId, admin.id));
      // The request passes its first check, because the removal has not committed.
      attempt = Promise.resolve(
        call("POST", inSpace("/invites"), admin, { email: newEmail(), role: "member" }),
      );
      await untilWaiting(owner);
    });
    expect((await attempt)?.status).toBe(403);
    const rows = await owner.select().from(invite).where(eq(invite.createdBy, admin.id));
    expect(rows).toEqual([]);
  });

  test("an owner demoted to admin loses the admin links they made", async () => {
    const boss = await person("owner");
    const second = await person("owner");
    const link = await newInvite(second, "admin");
    await call("PATCH", inSpace(`/members/${second.id}`), boss, { role: "admin" });
    expect((await call("POST", "/v1/invites/preview", null, { token: link })).status).toBe(404);
  });

  test("a change that keeps or raises a role leaves that person's links alone", async () => {
    const boss = await person("owner");
    const admin = await person("admin");
    const link = await newInvite(admin);
    await call("PATCH", inSpace(`/members/${admin.id}`), boss, { role: "admin" });
    await call("PATCH", inSpace(`/members/${admin.id}`), boss, { role: "owner" });
    expect((await call("POST", "/v1/invites/preview", null, { token: link })).status).toBe(200);
  });
});

describe("invites", () => {
  test("a link makes an account, joins with its role, and works once", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const token = await newInvite(boss, "admin", email.toUpperCase());
    const stored = await owner.select().from(invite).where(eq(invite.workspaceId, space.id));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored).toMatchObject([{ email, mailed: false }]);

    const offer = await call("POST", "/v1/invites/preview", null, { token });
    expect(await offer.json()).toEqual({
      workspaceName: "Acme",
      inviterName: boss.email,
      role: "admin",
      email,
      hasAccount: false,
      needsName: true,
    });

    const cookie = await joinNew(token);
    expect(cookie).toContain("session");
    const me = await app.request("/v1/operator/me", { headers: { cookie } });
    expect(((await me.json()) as { workspaces: unknown[] }).workspaces).toEqual([
      {
        workspaceId: space.id,
        role: "admin",
        name: "Acme",
        active: true,
        readOnly: false,
        waiting: false,
        suspended: false,
        soleOwner: false,
      },
    ]);

    expect((await join(token)).status).toBe(404);
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(404);
  });

  test("an expired link and a revoked link do nothing", async () => {
    const boss = await person("owner");
    const someone = await person(null);
    const expired = await newInvite(boss, "member", someone.email);
    await owner.update(invite).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(
      (await call("POST", "/v1/operator/invites/accept", someone, { token: expired })).status,
    ).toBe(404);
    expect((await join(expired)).status).toBe(404);

    const revoked = await createInvite(boss, "member", someone.email);
    await call("DELETE", inSpace(`/invites/${revoked.id}`), boss);
    expect(
      (await call("POST", "/v1/operator/invites/accept", someone, { token: revoked.token })).status,
    ).toBe(404);
    expect(await memberRow(someone.id)).toBeUndefined();
  });

  test("a made-up or tampered token does nothing", async () => {
    const someone = await person(null);
    for (const token of ["nonsense", `${space.id}.forged`, `${randomUUID()}.forged`]) {
      expect((await call("POST", "/v1/operator/invites/accept", someone, { token })).status).toBe(
        404,
      );
      expect((await join(token)).status).toBe(404);
    }
    const boss = await person("owner");
    const real = await newInvite(boss, "member", someone.email);
    const other = await createWorkspace(db, "Other", [SITE]);
    const moved = real.replace(space.id, other.id);
    expect(
      (await call("POST", "/v1/operator/invites/accept", someone, { token: moved })).status,
    ).toBe(404);
  });

  test("someone with an account in another workspace keeps one login", async () => {
    const other = await createWorkspace(db, "Other", [SITE]);
    const existing = await person("owner", other.id);
    const boss = await person("owner");
    const token = await newInvite(boss, "member", existing.email);
    const accepted = await call("POST", "/v1/operator/invites/accept", existing, { token });
    expect(await accepted.json()).toEqual({ workspaceId: space.id });
    const operators = await owner.select().from(operator).where(eq(operator.email, existing.email));
    expect(operators).toHaveLength(1);
    const me = await call("GET", "/v1/operator/me", existing);
    const { workspaces } = (await me.json()) as {
      workspaces: { workspaceId: string; role: string }[];
    };
    expect(workspaces.map((one) => [one.workspaceId, one.role]).sort()).toEqual(
      [
        [other.id, "owner"],
        [space.id, "member"],
      ].sort(),
    );
    expect((await call("GET", inSpace("/members"), existing)).status).toBe(200);
  });

  test("two joins racing for one link: one makes the account, and the other makes nothing", async () => {
    const boss = await person("owner");
    const email = newEmail();
    const token = await newInvite(boss, "member", email);
    const results = await Promise.all([join(token), join(token)]);
    const statuses = results.map((result) => result.status).sort();
    // The second waits for the first account, then finds the invite used or the email taken.
    expect([
      [200, 404],
      [200, 409],
    ]).toContainEqual(statuses);
    expect(results.filter((result) => cookieOf(result) !== "")).toHaveLength(1);
    expect(await owner.select().from(operator).where(eq(operator.email, email))).toHaveLength(1);
  });

  test("an existing member keeps their role and does not use up the link", async () => {
    const boss = await person("owner");
    const someone = await person(null);
    const token = await newInvite(boss, "admin", someone.email);
    // They joined another way after the invite was made.
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: space.id, operatorId: someone.id, role: "member" });
    const accepted = await call("POST", "/v1/operator/invites/accept", someone, { token });
    expect(accepted.status).toBe(409);
    expect((await memberRow(someone.id))?.role).toBe("member");
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(200);
  });

  test("two inviters inviting one email at once leave one usable invite", async () => {
    const boss = await person("owner");
    const admin = await person("admin");
    const email = newEmail();
    // Holding the address lock makes both requests wait at the same point, then go one by one.
    let both: Promise<Response[]> | undefined;
    await owner.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`invite:${space.id}:${email}`}, 0))`,
      );
      both = Promise.all(
        [boss, admin].map((who) =>
          Promise.resolve(call("POST", inSpace("/invites"), who, { email, role: "member" })),
        ),
      );
      await untilWaiting(owner, 2);
    });
    const results = (await both) ?? [];
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    const rows = await owner
      .select()
      .from(invite)
      .where(and(eq(invite.workspaceId, space.id), eq(invite.email, email)));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  test("two invites accepted at once leave one role, and the other invite usable", async () => {
    const boss = await person("owner");
    const someone = await person(null);
    const tokens = [
      await newInvite(boss, "admin", someone.email),
      await plantInvite(boss, someone.email, "member"),
    ];
    // A held lock makes both requests pass the membership check before either can write.
    let both: Promise<Response[]> | undefined;
    await owner.transaction(async (tx) => {
      await tx.select().from(invite).where(eq(invite.workspaceId, space.id)).for("update");
      both = Promise.all(
        tokens.map((token) =>
          Promise.resolve(call("POST", "/v1/operator/invites/accept", someone, { token })),
        ),
      );
      await untilWaiting(owner, 2);
    });
    const results = (await both) ?? [];
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const used = await owner.select().from(invite).where(eq(invite.workspaceId, space.id));
    const winner = used.filter((row) => row.usedAt !== null);
    expect(winner).toHaveLength(1);
    expect((await memberRow(someone.id))?.role).toBe(winner[0]?.role);
  });

  test("a removed or demoted person's unused links stop working", async () => {
    const boss = await person("owner");
    const removed = await person("admin");
    const kept = await newInvite(removed);
    await call("DELETE", inSpace(`/members/${removed.id}`), boss);
    const back = await call("POST", "/v1/operator/invites/accept", removed, { token: kept });
    expect(back.status).toBe(404);
    expect(await call("POST", "/v1/invites/preview", null, { token: kept })).toHaveProperty(
      "status",
      404,
    );

    const demoted = await person("owner");
    const own = await newInvite(demoted, "admin");
    await call("PATCH", inSpace(`/members/${demoted.id}`), boss, { role: "member" });
    expect((await call("POST", "/v1/invites/preview", null, { token: own })).status).toBe(404);

    // Another person's link is not affected.
    const others = await newInvite(boss);
    const third = await person("member");
    await call("DELETE", inSpace(`/members/${third.id}`), boss);
    expect((await call("POST", "/v1/invites/preview", null, { token: others })).status).toBe(200);
  });

  test("a team change reaches the operators' feed, with no names in it", async () => {
    const boss = await person("owner");
    const target = await person("member");
    await call("PATCH", inSpace(`/members/${target.id}`), boss, { role: "admin" });
    const rows = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "team.changed")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({});
    expect(rows[0]?.needsAlert).toBe(false);
  });

  test("a removed member can return by a new invite, with its role", async () => {
    const boss = await person("owner");
    const admin = await person("admin");
    await call("DELETE", inSpace(`/members/${admin.id}`), boss);
    expect((await call("GET", inSpace("/members"), admin)).status).toBe(404);
    const token = await newInvite(boss, "member", admin.email);
    expect((await call("POST", "/v1/operator/invites/accept", admin, { token })).status).toBe(200);
    const row = await memberRow(admin.id);
    expect(row?.removedAt).toBeNull();
    expect(row?.role).toBe("member");
  });

  test("another site cannot read or use a link", async () => {
    const boss = await person("owner");
    const token = await newInvite(boss);
    const evil = "https://evil.example";
    expect((await call("POST", "/v1/invites/preview", null, { token }, evil)).status).toBe(403);
    expect((await join(token, { origin: evil })).status).toBe(403);
    expect((await call("POST", "/v1/operator/invites/accept", boss, { token }, evil)).status).toBe(
      403,
    );
  });
});

describe("settings", () => {
  const widgetToken = (secret: string, subject = "user-1") => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(space.publicKey)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode(secret));
  };
  const widgetMe = (token: string, origin = SITE) =>
    app.request(`/v1/widget/${space.publicKey}/me`, {
      headers: { origin, authorization: `Bearer ${token}` },
    });

  test("a rotated signing secret stops the old tokens and starts the new ones", async () => {
    const boss = await person("owner");
    const old = await widgetToken(space.signingSecret);
    expect((await widgetMe(old)).status).toBe(200);
    const response = await call("POST", inSpace("/settings/rotate-secret"), boss, {});
    const { signingSecret } = (await response.json()) as { signingSecret: string };
    expect(signingSecret).not.toBe(space.signingSecret);
    expect(signingSecret.length).toBeGreaterThanOrEqual(32);
    expect((await widgetMe(old)).status).toBe(401);
    expect((await widgetMe(await widgetToken(signingSecret))).status).toBe(200);
  });

  test("a rotated secret closes a stream that used an old token", async () => {
    const boss = await person("owner");
    let wake = () => {};
    const server = createApp({
      db,
      logger,
      checks: { postgres: ok, valkey: ok },
      live: {
        ...live,
        async subscribe(_workspaceId, _subscriber, session) {
          wake = () => session.wake();
          return () => {};
        },
      },
    });
    const token = await widgetToken(space.signingSecret, "stream-user");
    const response = await server.request(`/v1/widget/${space.publicKey}/stream`, {
      headers: { origin: SITE, authorization: `Bearer ${token}` },
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (reader !== undefined && !text.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until("event: ready");
    await call("POST", inSpace("/settings/rotate-secret"), boss, {});
    wake();
    await until("event: close");
    expect(text).toContain("event: close");
  });

  test("a changed origin list takes effect at once, and a bad origin changes nothing", async () => {
    const boss = await person("owner");
    const token = await widgetToken(space.signingSecret);
    const next = "https://new.example.com";
    const saved = await call("PATCH", inSpace("/settings"), boss, {
      allowedOrigins: [`${next}/`, next],
    });
    expect(((await saved.json()) as { allowedOrigins: string[] }).allowedOrigins).toEqual([next]);
    expect((await widgetMe(token, SITE)).status).toBe(403);
    expect((await widgetMe(token, next)).status).toBe(200);
    const bad = await call("PATCH", inSpace("/settings"), boss, { allowedOrigins: ["not a site"] });
    expect(bad.status).toBe(400);
    const settings = await call("GET", inSpace("/settings"), boss);
    expect(((await settings.json()) as { allowedOrigins: string[] }).allowedOrigins).toEqual([
      next,
    ]);
  });

  test("the settings hold only this workspace's values", async () => {
    const boss = await person("owner");
    const body = await (await call("GET", inSpace("/settings"), boss)).json();
    expect(body).toEqual({
      publicKey: space.publicKey,
      allowedOrigins: [SITE],
      signingSecret: space.signingSecret,
      // A self-hosted install has no limits.
      usage: null,
      // workspace-delete.test.ts checks these numbers.
      deletion: expect.any(Object),
    });
  });
});

describe("assignment", () => {
  async function aConversation(workspaceId = space.id) {
    const visitorId = randomUUID();
    await owner.execute(
      sql`insert into visitor (workspace_id, id, token_hash) values (${workspaceId}, ${visitorId}, ${randomUUID()})`,
    );
    const { message } = await withWorkspace(db, workspaceId, (tx) =>
      appendMessage(
        tx,
        workspaceId,
        { kind: "visitor", visitorId },
        {
          clientId: randomUUID(),
          body: "Hello",
        },
      ),
    );
    return message.conversationId;
  }
  const path = (conversationId: string) => inSpace(`/conversations/${conversationId}/assignee`);

  test("any member assigns to any member, and clears it", async () => {
    const member = await person("member");
    const other = await person("member");
    const id = await aConversation();
    wakes.length = 0;
    expect((await call("PUT", path(id), member, { operatorId: other.id })).status).toBe(200);
    expect(wakes).toContain("operators");
    const list = await call("GET", inSpace("/conversations"), member);
    const { conversations } = (await list.json()) as {
      conversations: { assigneeOperatorId: string | null }[];
    };
    expect(conversations[0]?.assigneeOperatorId).toBe(other.id);
    const events = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "conversation.assigned")));
    expect(events).toHaveLength(1);
    expect(events[0]?.needsAlert).toBe(false);
    expect((await call("PUT", path(id), member, { operatorId: null })).status).toBe(200);
    const [row] = await owner.select().from(conversation).where(eq(conversation.id, id));
    expect(row?.assigneeOperatorId).toBeNull();
  });

  test("a removed member or an outsider cannot be assigned", async () => {
    const boss = await person("owner");
    const removed = await person("member");
    await call("DELETE", inSpace(`/members/${removed.id}`), boss);
    const other = await createWorkspace(db, "Other", [SITE]);
    const outsider = await person("owner", other.id);
    const id = await aConversation();
    expect((await call("PUT", path(id), boss, { operatorId: removed.id })).status).toBe(400);
    expect((await call("PUT", path(id), boss, { operatorId: outsider.id })).status).toBe(400);
  });

  test("a conversation in another workspace cannot be assigned", async () => {
    const boss = await person("owner");
    const other = await createWorkspace(db, "Other", [SITE]);
    const elsewhere = await aConversation(other.id);
    expect((await call("PUT", path(elsewhere), boss, { operatorId: boss.id })).status).toBe(404);
  });
});

describe("presence routes", () => {
  const conversationId = "00000000-0000-4000-8000-000000000001";
  const beat = (as: Person | null, workspaceId = space.id) =>
    call("PUT", inSpace("/presence", workspaceId), as, { viewing: conversationId, left: null });

  test("only a member can say or read presence", async () => {
    const other = await createWorkspace(db, "Other", [SITE]);
    const outsider = await person("owner", other.id);
    expect((await beat(outsider)).status).toBe(404);
    expect((await beat(null)).status).toBe(401);
    const removed = await person("member");
    const boss = await person("owner");
    await call("DELETE", inSpace(`/members/${removed.id}`), boss);
    expect((await beat(removed)).status).toBe(404);
  });

  test("with no Valkey, an operator's app and the widget keep working", async () => {
    const member = await person("member");
    const response = await beat(member);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ viewers: {} });
    const leave = await call("POST", inSpace("/presence/leave"), member, { conversationId: null });
    expect(leave.status).toBe(200);
    const widget = await app.request(`/v1/widget/${space.publicKey}/presence`, {
      headers: { origin: SITE },
    });
    expect(await widget.json()).toEqual({
      online: null,
      emailReplies: false,
    });
  });

  test("the widget's answer needs an allowed site and needs no token", async () => {
    const path = `/v1/widget/${space.publicKey}/presence`;
    expect((await app.request(path, { headers: { origin: SITE } })).status).toBe(200);
    const other = await app.request(path, { headers: { origin: "https://evil.example" } });
    expect(other.status).toBe(403);
  });
});

describe("a removed operator", () => {
  test("gets no data on an open stream, even if the removal's signal was lost", async () => {
    const boss = await person("owner");
    const removed = await person("member");
    let wake = () => {};
    // A removal here wakes nothing, as when the Valkey subscriber was disconnected.
    const server = createApp({
      auth,
      db,
      logger,
      checks: { postgres: ok, valkey: ok },
      live: {
        ...live,
        wake() {},
        async subscribe(_workspaceId, _subscriber, session) {
          wake = () => session.wake();
          return () => {};
        },
      },
    });
    const response = await server.request(inSpace("/stream"), {
      headers: { cookie: removed.cookie },
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (reader !== undefined && !text.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until("event: ready");
    const before = text;

    const gone = await server.request(inSpace(`/members/${removed.id}`), {
      method: "DELETE",
      headers: { cookie: boss.cookie, origin: ORIGIN },
    });
    expect(gone.status).toBe(200);

    const visitorId = randomUUID();
    await owner.execute(
      sql`insert into visitor (workspace_id, id, token_hash) values (${space.id}, ${visitorId}, ${randomUUID()})`,
    );
    await withWorkspace(db, space.id, (tx) =>
      appendMessage(
        tx,
        space.id,
        { kind: "visitor", visitorId },
        {
          clientId: randomUUID(),
          body: "Secret",
        },
      ),
    );
    // The next message's wake reaches this stream, and its drain checks membership first.
    wake();
    await until("event: close");
    const after = text.slice(before.length);
    expect(after).toContain('"reason":"unauthorized"');
    expect(after).not.toContain("event: change");
  });

  test("loses every route in that workspace at once", async () => {
    const boss = await person("owner");
    const removed = await person("member");
    await call("DELETE", inSpace(`/members/${removed.id}`), boss);
    for (const path of ["", "/conversations", "/stream", "/members", "/alerts"]) {
      expect((await call("GET", inSpace(path), removed)).status).toBe(404);
    }
  });
});
