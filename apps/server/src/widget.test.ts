import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { type App, createApp } from "./app.ts";
import { conversation, visitor } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { withWorkspace } from "./db/tenant.ts";
import { normalizeOrigin, verifyHostToken } from "./identity.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = "https://app.example.com";
const OTHER_ORIGIN = "https://other.example.com";

let database: TestDatabase;
let db: Database;
let app: App;
let a: NewWorkspace;
let b: NewWorkspace;

interface TokenOptions {
  secret?: string;
  audience?: string;
  subject?: string | null;
  expires?: string | number | null;
  issued?: number | null;
  claims?: Record<string, unknown>;
}

function hostToken(options: TokenOptions = {}): Promise<string> {
  let builder = new SignJWT(options.claims ?? {})
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(options.audience ?? a.publicKey);
  if (options.issued !== null) builder = builder.setIssuedAt(options.issued);
  if (options.subject !== null) builder = builder.setSubject(options.subject ?? "user-1");
  if (options.expires !== null) builder = builder.setExpirationTime(options.expires ?? "1h");
  return builder.sign(new TextEncoder().encode(options.secret ?? a.signingSecret));
}

function me(token: string, key = a.publicKey, origin = ORIGIN) {
  return app.request(`/v1/widget/${key}/me`, {
    headers: { origin, authorization: `Bearer ${token}` },
  });
}

function newVisitor(key = a.publicKey, origin = ORIGIN) {
  return app.request(`/v1/widget/${key}/visitors`, { method: "POST", headers: { origin } });
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app").db;
  const ok = async () => {};
  app = createApp({
    db,
    logger: pino({ level: "silent" }),
    checks: { postgres: ok, valkey: ok },
  });
  a = await createWorkspace(db, "A", [ORIGIN]);
  b = await createWorkspace(db, "B", [OTHER_ORIGIN]);
});

afterAll(async () => {
  await database.drop();
});

describe("host tokens", () => {
  test("a valid token identifies a signed-in visitor", async () => {
    const response = await me(await hostToken());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signedIn: true });
  });

  test("the same user gets the same visitor on every request", async () => {
    const first = (await (await me(await hostToken({ subject: "same" }))).json()) as {
      visitorId: string;
    };
    const second = (await (await me(await hostToken({ subject: "same" }))).json()) as {
      visitorId: string;
    };
    expect(second.visitorId).toBe(first.visitorId);
  });

  test("two first requests together create one visitor", async () => {
    const token = await hostToken({ subject: "racing" });
    const responses = await Promise.all(Array.from({ length: 8 }, () => me(token)));
    const ids = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { visitorId: string }).visitorId),
    );
    expect(new Set(ids).size).toBe(1);
  });

  test("the email and claims in a token reach the visitor row", async () => {
    const token = await hostToken({
      subject: "context",
      claims: { email: "pat@example.com", claims: { plan: "pro" } },
    });
    const { visitorId } = (await (await me(token)).json()) as { visitorId: string };
    const [row] = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(visitor).where(eq(visitor.id, visitorId)),
    );
    expect(row?.email).toBe("pat@example.com");
    expect(row?.attributes).toEqual({ plan: "pro" });
  });

  test.each<[string, TokenOptions]>([
    ["an expired token", { expires: "-1m" }],
    ["a token with no expiry", { expires: null }],
    ["a token that lives past the 24-hour limit", { expires: "25h" }],
    ["a token with no subject", { subject: null }],
    ["a token for another audience", { audience: "wk_other" }],
    ["a token signed with the wrong secret", { secret: "a-different-secret-of-enough-length" }],
    ["a token with oversized claims", { claims: { claims: { big: "x".repeat(3000) } } }],
    ["a token with no issue time", { issued: null }],
  ])("%s fails", async (_name, options) => {
    expect((await me(await hostToken(options))).status).toBe(401);
  });

  test("an oversized token stays invalid as it ages", async () => {
    const issued = Math.floor(Date.now() / 1000);
    const token = await hostToken({ issued, expires: issued + 25 * 60 * 60 });
    const later = new Date((issued + 2 * 60 * 60) * 1000);
    expect(await verifyHostToken(token, a.signingSecret, a.publicKey, later)).toBeNull();
  });

  test("a future-dated token fails", async () => {
    const issued = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const token = await hostToken({ issued, expires: issued + 60 * 60 });
    expect((await me(token)).status).toBe(401);
  });

  test.each([["josé@münchen.de"], [""], [null], ["x".repeat(400)]])(
    "the email %j does not lock the user out",
    async (email) => {
      const token = await hostToken({
        subject: `email-${String(email).slice(0, 32)}`,
        claims: { email },
      });
      expect((await me(token)).status).toBe(200);
    },
  );

  test.each([
    ["a@example.com, b@example.com"],
    ["a@example.com;b@example.com"],
    ["Pat <a@example.com>"],
  ])("the email %j is dropped, so a reply goes to one address at most", async (email) => {
    const token = await hostToken({ subject: `list-${email}`, claims: { email } });
    const response = await me(token);
    expect(response.status).toBe(200);
    const { visitorId } = (await response.json()) as { visitorId: string };
    const [row] = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(visitor).where(eq(visitor.id, visitorId)),
    );
    expect(row?.email).toBeNull();
  });

  test("a repeated token causes no write", async () => {
    const issued = Math.floor(Date.now() / 1000);
    const token = await hostToken({
      subject: "unchanged",
      issued,
      claims: { claims: { plan: "pro" } },
    });
    await me(token);
    const version = async () => {
      const { rows } = await database
        .connect("migrator")
        .db.execute<{ xmin: string }>(
          sql`select xmin from visitor where external_id = 'unchanged'`,
        );
      return rows[0]?.xmin;
    };
    const before = await version();
    await me(token);
    expect(await version()).toBe(before);
  });

  test("a token with the none algorithm fails", async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none" })}.${encode({
      sub: "attacker",
      aud: a.publicKey,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    expect((await me(token)).status).toBe(401);
  });

  test("workspace B's secret cannot sign for workspace A", async () => {
    const token = await hostToken({ secret: b.signingSecret, audience: a.publicKey });
    expect((await me(token)).status).toBe(401);
  });

  test("a valid token for A does not work at B's key", async () => {
    expect((await me(await hostToken(), b.publicKey, OTHER_ORIGIN)).status).toBe(401);
  });
});

describe("browser tokens", () => {
  test("a token unused for a year stops working, and each use renews it", async () => {
    const owner = database.connect("migrator").db;
    const created = (await (await newVisitor()).json()) as { visitorId: string; token: string };
    const usedAt = async () => {
      const [row] = await owner
        .select({ at: visitor.tokenUsedAt })
        .from(visitor)
        .where(eq(visitor.id, created.visitorId));
      return row?.at.getTime() ?? 0;
    };
    const setUsed = (ago: string) =>
      owner.execute(
        sql`update visitor set token_used_at = now() - ${ago}::interval where id = ${created.visitorId}`,
      );

    // Used two days ago: it works, and the use moves its expiry forward.
    await setUsed("2 days");
    const before = await usedAt();
    expect((await me(created.token)).status).toBe(200);
    expect(await usedAt()).toBeGreaterThan(before);

    // A use within the day writes nothing.
    const renewed = await usedAt();
    expect((await me(created.token)).status).toBe(200);
    expect(await usedAt()).toBe(renewed);

    // Unused for a year and a day: refused, and a refusal renews nothing.
    await setUsed("366 days");
    const expired = await usedAt();
    expect((await me(created.token)).status).toBe(401);
    expect(await usedAt()).toBe(expired);
  });

  test("a new visitor's token identifies it as signed out", async () => {
    const created = (await (await newVisitor()).json()) as { visitorId: string; token: string };
    const response = await me(created.token);
    expect(await response.json()).toEqual({
      visitorId: created.visitorId,
      signedIn: false,
      openConversation: false,
      chatted: false,
      lastReadSeq: "0",
      unread: 0,
      readCursor: expect.stringMatching(/^\d+\.0$/),
    });
  });

  test("the database stores only a hash of the token", async () => {
    const created = (await (await newVisitor()).json()) as { visitorId: string; token: string };
    const [row] = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(visitor).where(eq(visitor.id, created.visitorId)),
    );
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(row ?? {}).map(String)).not.toContain(created.token);
  });

  test("an unknown token fails", async () => {
    expect((await me("dbt_unknown")).status).toBe(401);
  });

  test("a token from workspace A does not work at workspace B", async () => {
    const created = (await (await newVisitor()).json()) as { token: string };
    expect((await me(created.token, b.publicKey, OTHER_ORIGIN)).status).toBe(401);
  });

  test("a signed-out visitor never merges into a signed-in user", async () => {
    const created = (await (await newVisitor()).json()) as { visitorId: string };
    const signedIn = (await (await me(await hostToken({ subject: "merge" }))).json()) as {
      visitorId: string;
    };
    expect(signedIn.visitorId).not.toBe(created.visitorId);
  });

  test("a request with no token fails", async () => {
    const response = await app.request(`/v1/widget/${a.publicKey}/me`, {
      headers: { origin: ORIGIN },
    });
    expect(response.status).toBe(401);
  });
});

describe("origins", () => {
  test("an allowed origin gets the CORS header for itself", async () => {
    const response = await newVisitor();
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  test.each([
    ["another site", OTHER_ORIGIN],
    ["a longer host that starts the same", `${ORIGIN}.evil.test`],
    ["a different scheme", "http://app.example.com"],
    ["a different port", `${ORIGIN}:8443`],
    ["an opaque origin", "null"],
  ])("%s is refused and gets no CORS header", async (_name, origin) => {
    const response = await newVisitor(a.publicKey, origin);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a request with no Origin header is refused", async () => {
    const response = await app.request(`/v1/widget/${a.publicKey}/visitors`, { method: "POST" });
    expect(response.status).toBe(403);
  });

  test("an unknown key gets the same answer as a refused site", async () => {
    const unknown = await newVisitor(`wk_${"0".repeat(32)}`);
    const refused = await newVisitor(a.publicKey, OTHER_ORIGIN);
    expect(unknown.status).toBe(refused.status);
    expect(await unknown.text()).toBe(await refused.text());
  });

  test.each(["%00", "wk_%00", "wk_short"])(
    "a malformed key %s gets the same refusal, not a server error",
    async (key) => {
      const response = await app.request(`/v1/widget/${key}/visitors`, {
        method: "POST",
        headers: { origin: ORIGIN },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    },
  );

  test("a workspace with no allowed origins allows no site", async () => {
    const empty = await createWorkspace(db, "Empty", []);
    expect((await newVisitor(empty.publicKey)).status).toBe(403);
  });

  test("a preflight from an allowed origin passes, and one from another site fails", async () => {
    const preflight = (origin: string) =>
      app.request(`/v1/widget/${a.publicKey}/me`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
    const allowed = await preflight(ORIGIN);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("authorization");
    expect((await preflight(OTHER_ORIGIN)).status).toBe(403);
  });

  test("no widget response holds the signing secret", async () => {
    const responses = [await newVisitor(), await me(await hostToken())];
    for (const response of responses) {
      expect(await response.text()).not.toContain(a.signingSecret);
    }
  });

  test("normalizeOrigin accepts only a plain origin", () => {
    expect(normalizeOrigin("https://App.Example.com")).toBe(ORIGIN);
    expect(normalizeOrigin("https://app.example.com/path")).toBeNull();
    expect(normalizeOrigin("https://user@app.example.com")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
  });
});

describe("saving an email", () => {
  const save = (token: string, email: string, key = a.publicKey) =>
    app.request(`/v1/widget/${key}/me`, {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email }),
    });

  test("a signed-out visitor can save an email", async () => {
    const created = (await (await newVisitor()).json()) as { visitorId: string; token: string };
    expect((await save(created.token, "pat@example.com")).status).toBe(200);
    const [row] = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(visitor).where(eq(visitor.id, created.visitorId)),
    );
    expect(row?.email).toBe("pat@example.com");
  });

  test("a signed-in visitor cannot replace the email the host signed", async () => {
    const token = await hostToken({ subject: "owned", claims: { email: "owner@example.com" } });
    const { visitorId } = (await (await me(token)).json()) as { visitorId: string };
    expect((await save(token, "attacker@example.com")).status).toBe(403);
    const [row] = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(visitor).where(eq(visitor.id, visitorId)),
    );
    expect(row?.email).toBe("owner@example.com");
  });

  test("an invalid email or a missing token is refused", async () => {
    const created = (await (await newVisitor()).json()) as { token: string };
    expect((await save(created.token, "not-an-email")).status).toBe(400);
    expect((await save("dbt_wrong", "pat@example.com")).status).toBe(401);
  });

  test("a preflight allows PATCH", async () => {
    const response = await app.request(`/v1/widget/${a.publicKey}/me`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "PATCH" },
    });
    expect(response.headers.get("access-control-allow-methods")).toContain("PATCH");
  });
});

describe("open conversations", () => {
  test("me reports an open conversation, and not a closed one", async () => {
    const { token } = (await (await newVisitor()).json()) as { token: string };
    const read = async () =>
      ((await (await me(token)).json()) as { openConversation: boolean }).openConversation;
    expect(await read()).toBe(false);
    await app.request(`/v1/widget/${a.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "open", body: "hello" }),
    });
    expect(await read()).toBe(true);
    await withWorkspace(db, a.id, (tx) => tx.update(conversation).set({ status: "closed" }));
    expect(await read()).toBe(false);
  });
});

describe("the widget files", () => {
  test("only the listed files are served, and a path cannot leave the directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dinghy-files-"));
    await writeFile(join(directory, "loader.js"), "// loader");
    await writeFile(join(directory, "secret.txt"), "secret");
    const served = createApp({
      db,
      logger: pino({ level: "silent" }),
      checks: { postgres: async () => {}, valkey: async () => {} },
      widgetDirectory: directory,
    });
    const loader = await served.request("/widget/loader.js");
    expect(loader.status).toBe(200);
    expect(loader.headers.get("content-type")).toContain("javascript");
    expect(loader.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    for (const path of ["secret.txt", "..%2Fpackage.json", "widget.js"]) {
      expect((await served.request(`/widget/${path}`)).status).toBe(404);
    }
    await rm(directory, { recursive: true, force: true });
  });
});

describe("the widget lookup", () => {
  test("the worker role cannot call it", async () => {
    const { db: worker } = database.connect("worker");
    const { widgetWorkspace } = await import("./workspaces.ts");
    await expect(widgetWorkspace(worker, a.publicKey)).rejects.toThrow();
  });

  test("a visitor must have exactly one identity", async () => {
    const { db: owner } = database.connect("migrator");
    await expect(owner.insert(visitor).values({ workspaceId: a.id })).rejects.toThrow();
    await expect(
      owner.insert(visitor).values({ workspaceId: a.id, externalId: "x", tokenHash: "y" }),
    ).rejects.toThrow();
  });
});
