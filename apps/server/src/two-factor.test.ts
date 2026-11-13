import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { base32 } from "@better-auth/utils/base32";
import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { authenticatorCode } from "../test/authenticator.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { addOperator, signIn } from "../test/operators.ts";
import { asOperator, ORIGIN, withKey } from "../test/requests.ts";
import { readStream } from "../test/sse.ts";
import { SITE, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { operator, operatorTwoFactor, session } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import { type Live, OPERATORS } from "./live.ts";
import { localStore } from "./storage.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
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
const audits = (event: string, operatorId: string) =>
  lines.filter((line) => line.event === event && line.operatorId === operatorId);

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
let valkey: Redis;
let space: NewWorkspace;
/** Wakes every operator stream that the app opened. */
let wakeStreams = () => {};
/** The wake signals the app sent, by workspace and subscriber. */
const wakes: [string, string][] = [];

const live: Live = {
  wake(workspaceId, subscriber) {
    wakes.push([workspaceId, subscriber]);
  },
  revoke() {},
  tell() {},
  tellVisitor() {},
  async subscribe(_workspaceId, _subscriber, opened) {
    const before = wakeStreams;
    wakeStreams = () => {
      before();
      opened.wake();
    };
    return () => {};
  },
  stop() {},
};

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL);
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    auth,
    db,
    live,
    logger,
    valkey,
    images: createImages({
      store: localStore(tmpdir()),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    }),
    checks: { postgres: async () => {}, valkey: async () => {} },
    stream: { heartbeatMs: 25_000, lifetimeMs: 60_000 },
  });
  space = await createWorkspace(db, "Acme", [SITE]);
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

const inSpace = (path = "") => `/v1/operator/workspaces/${space.id}${path}`;
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  asOperator(app, cookie, method, path, body);
const codeOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

/** An owner of the workspace with a signed-in session. */
async function newOwner() {
  const added = await addOperator({ auth, owner, workspaceId: space.id });
  return { ...added, cookie: await signIn(app, auth, added.email) };
}

/** An owner who turned on two-step sign-in, with the step that turned it on used up. */
async function ownerWithTwoFactor() {
  const person = await newOwner();
  const setup = await call(person.cookie, "POST", "/v1/operator/two-factor/setup");
  expect(setup.status).toBe(200);
  const { secret } = (await setup.json()) as { secret: string };
  const enabled = await call(person.cookie, "POST", "/v1/operator/two-factor/enable", {
    code: await authenticatorCode(secret, -1),
  });
  expect(enabled.status).toBe(200);
  const { recoveryCodes } = (await enabled.json()) as { recoveryCodes: string[] };
  return { ...person, secret, recoveryCodes };
}

const twoFactorOf = async (cookie: string) => {
  const me = await call(cookie, "GET", "/v1/operator/me");
  return ((await me.json()) as { twoFactor: string }).twoFactor;
};
/** The account's flag, which the session check reads with the session. */
const flagOf = async (operatorId: string) => {
  const [row] = await owner
    .select({ twoFactorOn: operator.twoFactorOn })
    .from(operator)
    .where(eq(operator.id, operatorId));
  return row?.twoFactorOn;
};
const check = (cookie: string, code: string) =>
  call(cookie, "POST", "/v1/operator/two-factor/check", { code });

describe("turning it on", () => {
  test("a setup confirmed with a code turns it on and shows 10 recovery codes once", async () => {
    const person = await newOwner();
    const setup = await call(person.cookie, "POST", "/v1/operator/two-factor/setup");
    const { secret, uri } = (await setup.json()) as { secret: string; uri: string };
    expect(uri).toContain(`secret=${secret}`);
    expect(uri.startsWith("otpauth://totp/Dinghy:")).toBe(true);
    // Not on before a code confirms it.
    expect(await twoFactorOf(person.cookie)).toBe("off");
    const wrong = await call(person.cookie, "POST", "/v1/operator/two-factor/enable", {
      code: "000000",
    });
    expect(wrong.status).toBe(400);
    expect(await codeOf(wrong)).toBe("wrong_code");
    // A code of another length is wrong, not a server error.
    for (const code of ["12345", "1234567", "abcdef"]) {
      const shaped = await call(person.cookie, "POST", "/v1/operator/two-factor/enable", { code });
      expect(await codeOf(shaped)).toBe("wrong_code");
    }
    const blank = await call(person.cookie, "POST", "/v1/operator/two-factor/enable", {
      code: "   ",
    });
    expect(await codeOf(blank)).toBe("invalid_request");
    const typed = await authenticatorCode(secret);
    const enabled = await call(person.cookie, "POST", "/v1/operator/two-factor/enable", {
      code: `${typed.slice(0, 3)} ${typed.slice(3)}`,
    });
    expect(enabled.status).toBe(200);
    const { recoveryCodes } = (await enabled.json()) as { recoveryCodes: string[] };
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(await flagOf(person.id)).toBe(true);
    // The session that turned it on passed it, and keeps working.
    expect(await twoFactorOf(person.cookie)).toBe("on");
    expect((await call(person.cookie, "GET", inSpace())).status).toBe(200);
    expect(audits("two_factor.enabled", person.id)).toHaveLength(1);
    const again = await call(person.cookie, "POST", "/v1/operator/two-factor/setup");
    expect(await codeOf(again)).toBe("two_factor_on");
  });

  test("the secret is stored encrypted, and the recovery codes hashed", async () => {
    const person = await ownerWithTwoFactor();
    const [row] = await owner
      .select()
      .from(operatorTwoFactor)
      .where(eq(operatorTwoFactor.operatorId, person.id));
    expect(Buffer.from(row?.secret ?? []).includes(Buffer.from(base32.decode(person.secret)))).toBe(
      false,
    );
    expect(row?.recoveryCodes).toHaveLength(10);
    for (const code of person.recoveryCodes) expect(row?.recoveryCodes).not.toContain(code);
  });

  test("Settings > Team shows who has it on", async () => {
    const person = await ownerWithTwoFactor();
    const other = await newOwner();
    const listed = await call(person.cookie, "GET", inSpace("/members"));
    const { members } = (await listed.json()) as { members: { id: string; twoFactor: string }[] };
    expect(members.find((one) => one.id === person.id)?.twoFactor).toBe("on");
    expect(members.find((one) => one.id === other.id)?.twoFactor).toBe("off");
  });
});

describe("a new session", () => {
  test("may use only the check, me and sign-out until it passes, and me names no workspace", async () => {
    const person = await ownerWithTwoFactor();
    const cookie = await signIn(app, auth, person.email);
    const workspacesOf = async () =>
      ((await (await call(cookie, "GET", "/v1/operator/me")).json()) as { workspaces: unknown[] })
        .workspaces;
    expect(await twoFactorOf(cookie)).toBe("required");
    expect(await workspacesOf()).toEqual([]);
    for (const [method, path] of [
      ["GET", inSpace()],
      ["GET", "/v1/operator/waiting"],
      ["POST", "/v1/operator/two-factor/disable"],
    ] as const) {
      const refused = await call(
        cookie,
        method,
        path,
        method === "GET" ? undefined : { code: "000000" },
      );
      expect(refused.status).toBe(401);
      expect(await codeOf(refused)).toBe("two_factor_required");
    }
    const renamed = await call(cookie, "POST", "/v1/auth/update-user", { name: "Mallory" });
    expect(await codeOf(renamed)).toBe("two_factor_required");
    const passed = await check(cookie, await authenticatorCode(person.secret));
    expect(passed.status).toBe(200);
    expect((await call(cookie, "GET", inSpace())).status).toBe(200);
    expect(await workspacesOf()).toHaveLength(1);
    const other = await signIn(app, auth, person.email);
    expect((await call(other, "POST", "/v1/auth/sign-out", {})).status).toBe(200);
  });

  test("a wrong code and a code used before are refused", async () => {
    const person = await ownerWithTwoFactor();
    const first = await signIn(app, auth, person.email);
    const second = await signIn(app, auth, person.email);
    const wrong = await check(first, "123456");
    expect(await codeOf(wrong)).toBe("wrong_code");
    const code = await authenticatorCode(person.secret, 1);
    expect((await check(first, code)).status).toBe(200);
    const replayed = await check(second, code);
    expect(replayed.status).toBe(400);
    expect(await codeOf(replayed)).toBe("wrong_code");
    // An earlier step is a code seen before too.
    expect((await check(second, await authenticatorCode(person.secret))).status).toBe(400);
    expect(audits("two_factor.failed", person.id)).toHaveLength(3);
  });

  test("a recovery code works once", async () => {
    const person = await ownerWithTwoFactor();
    const [recovery] = person.recoveryCodes;
    const first = await signIn(app, auth, person.email);
    expect((await check(first, ` ${recovery?.toUpperCase()} `)).status).toBe(200);
    expect(audits("two_factor.recovery_used", person.id)).toHaveLength(1);
    const second = await signIn(app, auth, person.email);
    expect(await codeOf(await check(second, recovery ?? ""))).toBe("wrong_code");
    expect((await check(second, person.recoveryCodes[1] ?? "")).status).toBe(200);
  });

  test("5 wrong codes end the session, and the count outlives it", async () => {
    const person = await ownerWithTwoFactor();
    const cookie = await signIn(app, auth, person.email);
    for (let tries = 1; tries < 5; tries += 1) {
      expect((await check(cookie, "000000")).status).toBe(400);
    }
    const locked = await check(cookie, "000000");
    expect(locked.status).toBe(429);
    expect(await codeOf(locked)).toBe("too_many_attempts");
    expect(await codeOf(await call(cookie, "GET", "/v1/operator/me"))).toBe("unauthorized");
    const next = await signIn(app, auth, person.email);
    expect((await check(next, person.recoveryCodes[0] ?? "")).status).toBe(429);
    expect(await codeOf(await call(next, "GET", "/v1/operator/me"))).toBe("unauthorized");
    // Past the limit, a code is not checked, so it is not a failure either.
    expect(audits("two_factor.failed", person.id)).toHaveLength(5);
  });

  test("when Valkey does not answer, no code is checked and the check answers 503", async () => {
    const down = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    const outage = createApp({
      auth,
      db,
      live,
      logger,
      valkey: down,
      checks: { postgres: async () => {}, valkey: async () => {} },
    });
    const person = await ownerWithTwoFactor();
    const cookie = await signIn(app, auth, person.email);
    const refused = await asOperator(outage, cookie, "POST", "/v1/operator/two-factor/check", {
      code: await authenticatorCode(person.secret, 1),
    });
    expect(refused.status).toBe(503);
    expect(await codeOf(refused)).toBe("check_unavailable");
    expect(await twoFactorOf(cookie)).toBe("required");
    const off = await asOperator(outage, person.cookie, "POST", "/v1/operator/two-factor/disable", {
      code: person.recoveryCodes[0],
    });
    expect(await codeOf(off)).toBe("check_unavailable");
    expect(await twoFactorOf(person.cookie)).toBe("on");
    // Nothing was spent, so the same codes still pass once Valkey answers.
    expect((await check(cookie, person.recoveryCodes[0] ?? "")).status).toBe(200);
    expect(audits("two_factor.failed", person.id)).toHaveLength(0);
    down.disconnect();
  });
});

describe("turning it off", () => {
  test("needs a current code, and ends the sessions that never passed", async () => {
    const person = await ownerWithTwoFactor();
    const waiting = await signIn(app, auth, person.email);
    const wrong = await call(person.cookie, "POST", "/v1/operator/two-factor/disable", {
      code: "000000",
    });
    expect(await codeOf(wrong)).toBe("wrong_code");
    const off = await call(person.cookie, "POST", "/v1/operator/two-factor/disable", {
      code: await authenticatorCode(person.secret, 1),
    });
    expect(off.status).toBe(200);
    expect(await twoFactorOf(person.cookie)).toBe("off");
    expect(await flagOf(person.id)).toBe(false);
    expect(await codeOf(await call(waiting, "GET", "/v1/operator/me"))).toBe("unauthorized");
    expect(audits("two_factor.disabled", person.id)).toHaveLength(1);
  });
});

describe("turning it on again", () => {
  test("asks every other session for the new secret, also one that passed before", async () => {
    const person = await ownerWithTwoFactor();
    const other = await signIn(app, auth, person.email);
    expect((await check(other, await authenticatorCode(person.secret, 1))).status).toBe(200);
    const off = await call(person.cookie, "POST", "/v1/operator/two-factor/disable", {
      code: person.recoveryCodes[0],
    });
    expect(off.status).toBe(200);
    const setup = await call(person.cookie, "POST", "/v1/operator/two-factor/setup");
    const { secret } = (await setup.json()) as { secret: string };
    await call(person.cookie, "POST", "/v1/operator/two-factor/enable", {
      code: await authenticatorCode(secret),
    });
    expect(await twoFactorOf(person.cookie)).toBe("on");
    expect(await twoFactorOf(other)).toBe("required");
  });
});

describe("every way in", () => {
  test("a stream opens only after the check, and a drain stops once it is turned on", async () => {
    const person = await newOwner();
    const streaming = await signIn(app, auth, person.email);
    wakeStreams = () => {};
    const response = await app.request(inSpace("/stream"), { headers: { cookie: streaming } });
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
    // The operator turns it on in another tab, and the open stream never passed the check.
    const setup = await call(person.cookie, "POST", "/v1/operator/two-factor/setup");
    const { secret } = (await setup.json()) as { secret: string };
    await call(person.cookie, "POST", "/v1/operator/two-factor/enable", {
      code: await authenticatorCode(secret),
    });
    await visitorStarts(app, space.publicKey, "After turning it on");
    wakeStreams();
    await until("event: close");
    expect(text).toContain('"reason":"unauthorized"');
    expect(text).not.toContain("event: change");
    const reopened = await app.request(inSpace("/stream"), { headers: { cookie: streaming } });
    expect(await codeOf(reopened)).toBe("two_factor_required");
    const passed = await app.request(inSpace("/stream"), { headers: { cookie: person.cookie } });
    expect(await readStream(passed)).toContain("event: ready");
  });

  test("turning it on wakes the operator's streams, so the drains end the others at once", async () => {
    const person = await newOwner();
    const setup = await call(person.cookie, "POST", "/v1/operator/two-factor/setup");
    const { secret } = (await setup.json()) as { secret: string };
    wakes.length = 0;
    await call(person.cookie, "POST", "/v1/operator/two-factor/enable", {
      code: await authenticatorCode(secret),
    });
    expect(wakes).toEqual([[space.id, OPERATORS]]);
  });

  test("an upload that ends after it is turned on is refused", async () => {
    const person = await newOwner();
    const uploading = await signIn(app, auth, person.email);
    const { conversationId } = await visitorStarts(app, space.publicKey, "Send me a picture");
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    let finish = () => {};
    let reading = () => {};
    const waiting = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(image.subarray(0, 16));
      },
      pull(controller) {
        reading();
        return new Promise<void>((resolve) => {
          finish = () => {
            controller.enqueue(image.subarray(16));
            controller.close();
            resolve();
          };
        });
      },
    });
    const pending = app.request(inSpace(`/conversations/${conversationId}/images?clientId=late`), {
      method: "POST",
      headers: { cookie: uploading, origin: ORIGIN, "content-type": "image/png" },
      body,
      duplex: "half",
    } as RequestInit);
    await waiting;
    const setup = await call(person.cookie, "POST", "/v1/operator/two-factor/setup");
    const { secret } = (await setup.json()) as { secret: string };
    await call(person.cookie, "POST", "/v1/operator/two-factor/enable", {
      code: await authenticatorCode(secret),
    });
    finish();
    expect((await pending).status).toBe(404);
  });

  test("OAuth consent refuses a session before the check", async () => {
    const person = await ownerWithTwoFactor();
    const cookie = await signIn(app, auth, person.email);
    const info = await call(cookie, "GET", "/v1/operator/oauth/authorize-info?client_id=x");
    expect(await codeOf(info)).toBe("two_factor_required");
    const approve = await call(cookie, "POST", inSpace("/oauth/grants"), { request: "" });
    expect(await codeOf(approve)).toBe("two_factor_required");
  });

  test("an API key is not a sign-in, so it works with no second step", async () => {
    const person = await ownerWithTwoFactor();
    const made = await call(person.cookie, "POST", inSpace("/api-keys"), { name: "Bot" });
    const { token } = (await made.json()) as { token: string };
    expect((await withKey(app, token, "GET", inSpace("/conversations"))).status).toBe(200);
  });
});

/** Runs `chat two-factor-reset` for `email`, as the server's admin does. */
function resetFromCli(email: string) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, "two-factor-reset", email], {
      env: {
        ...process.env,
        DATABASE_URL: database.url("app"),
        VALKEY_URL,
        AUTH_SECRET,
        PUBLIC_URL,
      },
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("exit", (code) => resolve({ code, out }));
  });
}

describe("the account", () => {
  test("chat two-factor-reset turns it off and ends every session", async () => {
    const person = await ownerWithTwoFactor();
    const result = await resetFromCli(person.email);
    expect(result.code).toBe(0);
    expect(result.out).toContain('"event":"two_factor.reset"');
    expect(result.out).toContain(person.id);
    const rows = await owner.select().from(session).where(eq(session.userId, person.id));
    expect(rows).toEqual([]);
    expect(await flagOf(person.id)).toBe(false);
    expect(await twoFactorOf(await signIn(app, auth, person.email))).toBe("off");
  });

  test("chat two-factor-reset changes nothing for an operator who has it off", async () => {
    const person = await newOwner();
    expect((await resetFromCli(person.email)).code).toBe(1);
    expect((await call(person.cookie, "GET", inSpace())).status).toBe(200);
  });

  test("deleting the account removes its secret and recovery codes", async () => {
    const person = await ownerWithTwoFactor();
    // Another owner stays, so the workspace passes to them.
    await newOwner();
    const deleted = await call(person.cookie, "POST", "/v1/operator/account/delete", {
      email: person.email,
    });
    expect(deleted.status).toBe(200);
    const rows = await owner
      .select()
      .from(operatorTwoFactor)
      .where(eq(operatorTwoFactor.operatorId, person.id));
    expect(rows).toEqual([]);
  });
});
