import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { untilWaiting } from "../test/locks.ts";
import { signedInOperator, signIn, TEST_PASSWORD } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { conversation, event, invite, operator, workspaceMember } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
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
  role: "owner" | "admin" | "agent" | null,
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

async function newInvite(by: Person, role: "admin" | "agent" = "agent", workspaceId = space.id) {
  const response = await call("POST", inSpace("/invites", workspaceId), by, { role });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string; token: string }).token;
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

const join = (token: string, email: string, origin = ORIGIN) =>
  call(
    "POST",
    "/v1/invites/join",
    null,
    { token, name: "New Person", email, password: TEST_PASSWORD },
    origin,
  );

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger });
  app = createApp({
    auth,
    db,
    live,
    logger,
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

describe("with a mail server, an invite join verifies the email", () => {
  test("the new account signs in only after it opens the link sent to its email", async () => {
    const links: { to: string; url: string }[] = [];
    const verifyingAuth = createAuth({
      db,
      secret: AUTH_SECRET,
      baseURL: PUBLIC_URL,
      logger,
      sendVerificationEmail: async (to, url) => {
        links.push({ to, url });
      },
    });
    const verifying = createApp({
      auth: verifyingAuth,
      db,
      live,
      logger,
      checks: { postgres: ok, valkey: ok },
    });
    const boss = await person("owner");
    const token = await newInvite(boss);
    const email = `joiner-${randomUUID()}@example.com`;
    const joined = await verifying.request("/v1/invites/join", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token, name: "New Person", email, password: TEST_PASSWORD }),
    });
    expect(await joined.json()).toEqual({ ok: true, verify: true });
    await expect.poll(() => links.some((link) => link.to === email)).toBe(true);
    await expect(signIn(verifying, email)).rejects.toThrow("Sign-in failed with 403");

    const link = new URL(links.find((one) => one.to === email)?.url ?? "");
    const opened = await verifying.request(`${link.pathname}${link.search}`);
    expect(opened.status).toBe(302);
    expect(await signIn(verifying, email)).not.toBe("");
  });

  test("without one, the account signs in at once", async () => {
    const boss = await person("owner");
    const email = `plain-${randomUUID()}@example.com`;
    const joined = await join(await newInvite(boss), email);
    expect(await joined.json()).toEqual({ ok: true, verify: false });
    expect(await signIn(app, email)).not.toBe("");
  });
});

describe("the audit log", () => {
  test("each security change writes one line, with IDs and no email or secret", async () => {
    const boss = await person("owner");
    const target = await person("agent");
    const leaving = await person("agent");
    lines.length = 0;
    await call("PATCH", inSpace(`/members/${target.id}`), boss, { role: "admin" });
    await call("DELETE", inSpace(`/members/${leaving.id}`), boss);
    await call("PATCH", inSpace("/settings"), boss, { allowedOrigins: [SITE] });
    const rotated = await call("POST", inSpace("/settings/rotate-secret"), boss, {});
    const { signingSecret } = (await rotated.json()) as { signingSecret: string };
    const token = await newInvite(boss);
    const joiner = `joiner-${randomUUID()}@example.com`;
    expect((await join(token, joiner)).status).toBe(200);

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
    const agent = await person("agent");
    lines.length = 0;
    expect((await call("POST", inSpace("/settings/rotate-secret"), agent, {})).status).toBe(403);
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
      { owner: 200, admin: 200, agent: 403 },
    ],
    [
      "change origins",
      (as) => call("PATCH", inSpace("/settings"), as, { allowedOrigins: [SITE] }),
      { owner: 200, admin: 200, agent: 403 },
    ],
    [
      "rotate the secret",
      (as) => call("POST", inSpace("/settings/rotate-secret"), as, {}),
      { owner: 200, admin: 200, agent: 403 },
    ],
    [
      "list invites",
      (as) => call("GET", inSpace("/invites"), as),
      { owner: 200, admin: 200, agent: 403 },
    ],
    [
      "invite an agent",
      (as) => call("POST", inSpace("/invites"), as, { role: "agent" }),
      { owner: 201, admin: 201, agent: 403 },
    ],
    [
      "invite an admin",
      (as) => call("POST", inSpace("/invites"), as, { role: "admin" }),
      { owner: 201, admin: 403, agent: 403 },
    ],
    [
      "list members",
      (as) => call("GET", inSpace("/members"), as),
      { owner: 200, admin: 200, agent: 200 },
    ],
    [
      "revoke an invite",
      (as) => call("DELETE", inSpace(`/invites/${AGENT_ID}`), as),
      { owner: 200, admin: 200, agent: 403 },
    ],
  ];

  test.each(checks)("%s", async (_name, run, expected) => {
    for (const role of ["owner", "admin", "agent"] as const) {
      expect([role, (await run(await person(role))).status]).toEqual([role, expected[role]]);
    }
  });

  test("an owner cannot be invited, by anyone", async () => {
    const boss = await person("owner");
    expect((await call("POST", inSpace("/invites"), boss, { role: "owner" })).status).toBe(400);
  });

  test("only an owner changes a role", async () => {
    const target = await person("agent");
    for (const role of ["admin", "agent"] as const) {
      const as = await person(role);
      const response = await call("PATCH", inSpace(`/members/${target.id}`), as, { role: "admin" });
      expect(response.status).toBe(403);
      // Nobody promotes themselves either.
      const self = await call("PATCH", inSpace(`/members/${as.id}`), as, { role: "owner" });
      expect(self.status).toBe(403);
    }
    expect((await memberRow(target.id))?.role).toBe("agent");
    const boss = await person("owner");
    expect(
      (await call("PATCH", inSpace(`/members/${target.id}`), boss, { role: "admin" })).status,
    ).toBe(200);
    expect((await memberRow(target.id))?.role).toBe("admin");
  });

  test("an admin removes only agents, an agent removes only itself", async () => {
    const admin = await person("admin");
    const agent = await person("agent");
    const otherAgent = await person("agent");
    const otherAdmin = await person("admin");
    const boss = await person("owner");
    const remove = (as: Person, target: Person) =>
      call("DELETE", inSpace(`/members/${target.id}`), as);
    expect((await remove(agent, otherAgent)).status).toBe(403);
    expect((await remove(admin, otherAdmin)).status).toBe(403);
    expect((await remove(admin, boss)).status).toBe(403);
    expect((await remove(admin, otherAgent)).status).toBe(200);
    expect((await remove(agent, agent)).status).toBe(200);
    expect((await memberRow(otherAgent.id))?.removedAt).toBeInstanceOf(Date);
  });

  test("a role change takes effect on the next request", async () => {
    const boss = await person("owner");
    const admin = await person("admin");
    expect((await call("GET", inSpace("/settings"), admin)).status).toBe(200);
    await call("PATCH", inSpace(`/members/${admin.id}`), boss, { role: "agent" });
    expect((await call("GET", inSpace("/settings"), admin)).status).toBe(403);
  });

  test("a member of another workspace sees nothing here", async () => {
    const other = await createWorkspace(db, "Other", [SITE]);
    const outsider = await person("owner", other.id);
    for (const path of ["/settings", "/members", "/invites"]) {
      expect((await call("GET", inSpace(path), outsider)).status).toBe(404);
    }
    const target = await person("agent");
    expect((await call("DELETE", inSpace(`/members/${target.id}`), outsider)).status).toBe(404);
  });
});

describe("the last owner", () => {
  test("cannot be demoted or removed, and a second owner makes both possible", async () => {
    const boss = await person("owner");
    const path = inSpace(`/members/${boss.id}`);
    expect((await call("PATCH", path, boss, { role: "admin" })).status).toBe(409);
    expect((await call("DELETE", path, boss)).status).toBe(409);
    const second = await person("agent");
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
        Promise.resolve(call("PATCH", inSpace(`/members/${two.id}`), one, { role: "agent" })),
        Promise.resolve(call("PATCH", inSpace(`/members/${one.id}`), two, { role: "agent" })),
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
    const replier = await person("agent");
    const target = await person("agent");
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
      attempt = Promise.resolve(call("POST", inSpace("/invites"), admin, { role: "agent" }));
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
    const token = await newInvite(boss, "admin");
    const stored = await owner.select().from(invite).where(eq(invite.workspaceId, space.id));
    expect(JSON.stringify(stored)).not.toContain(token);

    const offer = await call("POST", "/v1/invites/preview", null, { token });
    expect(await offer.json()).toEqual({ workspaceName: "Acme", role: "admin" });

    const email = `new-${randomUUID()}@example.com`;
    expect((await join(token, email.toUpperCase())).status).toBe(200);
    const cookie = await signIn(app, email);
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
      },
    ]);

    expect((await join(token, `again-${randomUUID()}@example.com`)).status).toBe(404);
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(404);
    const late = await person(null);
    expect((await call("POST", "/v1/operator/invites/accept", late, { token })).status).toBe(404);
  });

  test("an expired link and a revoked link do nothing", async () => {
    const boss = await person("owner");
    const expired = await newInvite(boss);
    await owner.update(invite).set({ expiresAt: new Date(Date.now() - 1000) });
    const someone = await person(null);
    expect(
      (await call("POST", "/v1/operator/invites/accept", someone, { token: expired })).status,
    ).toBe(404);
    expect((await join(expired, `x-${randomUUID()}@example.com`)).status).toBe(404);

    const response = await call("POST", inSpace("/invites"), boss, { role: "agent" });
    const revoked = (await response.json()) as { id: string; token: string };
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
      expect((await join(token, `x-${randomUUID()}@example.com`)).status).toBe(404);
    }
    const boss = await person("owner");
    const real = await newInvite(boss);
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
    const token = await newInvite(boss);
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
        [space.id, "agent"],
      ].sort(),
    );
    expect((await call("GET", inSpace("/members"), existing)).status).toBe(200);
  });

  test("joining with a taken email makes nothing and leaves the link usable", async () => {
    const boss = await person("owner");
    const token = await newInvite(boss);
    const response = await join(token, boss.email);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("email_taken");
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(200);
  });

  test("two people racing for one link: one joins, and the other leaves no account", async () => {
    const boss = await person("owner");
    const token = await newInvite(boss);
    const emails = [`a-${randomUUID()}@example.com`, `b-${randomUUID()}@example.com`];
    const results = await Promise.all(emails.map((email) => join(token, email)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 404]);
    const lost = emails[results.findIndex((result) => result.status === 404)] ?? "";
    expect(await owner.select().from(operator).where(eq(operator.email, lost))).toEqual([]);
  });

  test("an existing member keeps their role and does not use up the link", async () => {
    const boss = await person("owner");
    const token = await newInvite(boss);
    const accepted = await call("POST", "/v1/operator/invites/accept", boss, { token });
    expect(accepted.status).toBe(409);
    expect((await memberRow(boss.id))?.role).toBe("owner");
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(200);
  });

  test("two invites accepted at once leave one role, and the other invite usable", async () => {
    const boss = await person("owner");
    const someone = await person(null);
    const tokens = [await newInvite(boss, "admin"), await newInvite(boss, "agent")];
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
    await call("PATCH", inSpace(`/members/${demoted.id}`), boss, { role: "agent" });
    expect((await call("POST", "/v1/invites/preview", null, { token: own })).status).toBe(404);

    // Another person's link is not affected.
    const others = await newInvite(boss);
    const third = await person("agent");
    await call("DELETE", inSpace(`/members/${third.id}`), boss);
    expect((await call("POST", "/v1/invites/preview", null, { token: others })).status).toBe(200);
  });

  test("a team change reaches the operators' feed, with no names in it", async () => {
    const boss = await person("owner");
    const target = await person("agent");
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
    const token = await newInvite(boss, "agent");
    expect((await call("POST", "/v1/operator/invites/accept", admin, { token })).status).toBe(200);
    const row = await memberRow(admin.id);
    expect(row?.removedAt).toBeNull();
    expect(row?.role).toBe("agent");
  });

  test("another site cannot read or use a link", async () => {
    const boss = await person("owner");
    const token = await newInvite(boss);
    const evil = "https://evil.example";
    expect((await call("POST", "/v1/invites/preview", null, { token }, evil)).status).toBe(403);
    expect((await join(token, `x-${randomUUID()}@example.com`, evil)).status).toBe(403);
    expect((await call("POST", "/v1/operator/invites/accept", boss, { token }, evil)).status).toBe(
      403,
    );
  });

  test("a short password is refused", async () => {
    const boss = await person("owner");
    const token = await newInvite(boss);
    const response = await call("POST", "/v1/invites/join", null, {
      token,
      name: "New",
      email: `x-${randomUUID()}@example.com`,
      password: "short",
    });
    expect(response.status).toBe(400);
    expect((await call("POST", "/v1/invites/preview", null, { token })).status).toBe(200);
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
    const agent = await person("agent");
    const other = await person("agent");
    const id = await aConversation();
    wakes.length = 0;
    expect((await call("PUT", path(id), agent, { operatorId: other.id })).status).toBe(200);
    expect(wakes).toContain("operators");
    const list = await call("GET", inSpace("/conversations"), agent);
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
    expect((await call("PUT", path(id), agent, { operatorId: null })).status).toBe(200);
    const [row] = await owner.select().from(conversation).where(eq(conversation.id, id));
    expect(row?.assigneeOperatorId).toBeNull();
  });

  test("a removed member or an outsider cannot be assigned", async () => {
    const boss = await person("owner");
    const removed = await person("agent");
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
    const removed = await person("agent");
    const boss = await person("owner");
    await call("DELETE", inSpace(`/members/${removed.id}`), boss);
    expect((await beat(removed)).status).toBe(404);
  });

  test("with no Valkey, an operator's app and the widget keep working", async () => {
    const agent = await person("agent");
    const response = await beat(agent);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ viewers: {} });
    const leave = await call("POST", inSpace("/presence/leave"), agent, { conversationId: null });
    expect(leave.status).toBe(200);
    const widget = await app.request(`/v1/widget/${space.publicKey}/presence`, {
      headers: { origin: SITE },
    });
    expect(await widget.json()).toEqual({ online: null, emailReplies: false });
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
    const removed = await person("agent");
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
    const removed = await person("agent");
    await call("DELETE", inSpace(`/members/${removed.id}`), boss);
    for (const path of ["", "/conversations", "/stream", "/members", "/alerts"]) {
      expect((await call("GET", inSpace(path), removed)).status).toBe(404);
    }
  });
});
