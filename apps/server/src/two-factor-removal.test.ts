import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { authenticatorCode, turnOnTwoFactor } from "../test/authenticator.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { untilWaiting } from "../test/locks.ts";
import { addOperator, captureMail, openLink, pressLinkButton, signIn } from "../test/operators.ts";
import { asOperator } from "../test/requests.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import {
  event,
  operator,
  operatorTwoFactor,
  pushSubscription,
  session,
  twoFactorRemoval,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, lockAccount } from "./db/tenant.ts";
import type { Mailer } from "./mailer.ts";
import type { Push, PushPayload } from "./push.ts";
import { localStore } from "./storage.ts";
import type { Role } from "./team.ts";
import { HOUR_MS, MINUTE_MS } from "./time.ts";
import { removalWorkerStep, removeTwoFactor } from "./two-factor-removal.ts";
import { createUploads } from "./uploads.ts";
import { createWorkspace } from "./workspaces.ts";

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
const mail = captureMail();
const subjectsTo = (email: string) =>
  mail.sent.filter((one) => one.to === email).map((one) => one.subject);
/** Waits for an email to `email` whose subject has `words`, as emails go after the answer. */
const mailTo = (email: string, words: string) =>
  vi.waitFor(() => {
    const found = mail.sent.find((one) => one.to === email && one.subject.includes(words));
    if (found === undefined) throw new Error(`No email "${words}" to ${email}`);
    return found;
  });

/** The addresses whose next sends fail, as a mail server that is down for them would. */
const failing = new Set<string>();
const workerMail: Mailer = {
  async send(to, subject, text) {
    if (failing.has(to)) throw new Error(`The mail server refused ${to}`);
    await mail.send(to, subject, text);
  },
};
/** The workspaces whose operator streams the worker woke. */
const woken: string[] = [];
const RETRY_MS = 60_000;

const pushes: { endpoint: string; payload: PushPayload }[] = [];
const push: Push = {
  publicKey: "test",
  async send(target, payload) {
    pushes.push({ endpoint: target.endpoint, payload });
    return "sent";
  },
};

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
let valkey: Redis;
let workerStep: () => Promise<boolean>;

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
    logger,
    valkey,
    mailer: mail,
    alerts: { push, emailAvailable: true, secret: AUTH_SECRET },
    uploads: createUploads({
      store: localStore(tmpdir()),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    }),
    checks: { postgres: async () => {}, valkey: async () => {} },
  });
  // The worker's own role, so the test also proves its grants.
  workerStep = removalWorkerStep({
    db: database.connect("worker").db,
    logger,
    mailer: workerMail,
    push,
    signals: {
      wake: (workspaceId) => woken.push(workspaceId),
      revoke() {},
      tell() {},
      tellVisitor() {},
    },
    publicUrl: PUBLIC_URL,
    secret: AUTH_SECRET,
    retryMs: RETRY_MS,
  });
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

const call = (cookie: string, method: string, path: string, body?: unknown) =>
  asOperator(app, cookie, method, path, body);
const codeOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const askRemoval = (cookie: string) => call(cookie, "POST", "/v1/operator/two-factor/removal");
const cancelInApp = (cookie: string) =>
  call(cookie, "POST", "/v1/operator/two-factor/removal/cancel");
const check = (cookie: string, code: string) =>
  call(cookie, "POST", "/v1/operator/two-factor/check", { code });
const me = async (cookie: string) =>
  (await (await call(cookie, "GET", "/v1/operator/me")).json()) as {
    twoFactor: string;
    removalCompletesAt: string | null;
    asksTwoFactorAgain: boolean;
  };
const isSignedOut = async (cookie: string) =>
  (await call(cookie, "GET", "/v1/operator/me")).status === 401;

async function newWorkspace() {
  return createWorkspace(db, "Acme", []);
}

async function member(workspaceId: string, role: Role = "owner") {
  const added = await addOperator({ auth, owner, workspaceId, role });
  return { ...added, cookie: await signIn(app, auth, added.email) };
}

/** Adds an existing operator to another workspace. */
const join = (workspaceId: string, operatorId: string, role: Role) =>
  owner.insert(workspaceMember).values({ workspaceId, operatorId, role });

/**
 * An operator with two-step sign-in on, and a new session that waits at the code screen. With
 * `keepsPassedSession` false, the session that turned it on ends, so no device of theirs passed.
 */
async function lostApp(
  workspaceId: string,
  { role = "owner" as Role, keepsPassedSession = true } = {},
) {
  const person = await member(workspaceId, role);
  const factor = await turnOnTwoFactor(app, person.cookie);
  if (!keepsPassedSession) await owner.delete(session).where(eq(session.userId, person.id));
  return { ...person, ...factor, waiting: await signIn(app, auth, person.email) };
}

/** A team: an owner who lost their authenticator app, a second owner and a member, in a new workspace. */
async function team() {
  const space = await newWorkspace();
  const lost = await lostApp(space.id);
  const coOwner = await member(space.id, "owner");
  const plain = await member(space.id, "member");
  return { space, lost, coOwner, plain };
}

const requestOf = async (operatorId: string) =>
  owner.select().from(twoFactorRemoval).where(eq(twoFactorRemoval.operatorId, operatorId));

/** Moves the waiting request's end and its next warning earlier, as time passing would. */
const passTime = (operatorId: string, ms: number) =>
  owner
    .update(twoFactorRemoval)
    .set({
      completesAt: sql`${twoFactorRemoval.completesAt} - ${ms}::float8 * interval '1 millisecond'`,
      nextWarningAt: sql`${twoFactorRemoval.nextWarningAt} - ${ms}::float8 * interval '1 millisecond'`,
    })
    .where(and(eq(twoFactorRemoval.operatorId, operatorId), isNull(twoFactorRemoval.cancelledAt)));

/** The team.changed events of a workspace, which make its open apps read the team and `me`. */
const teamChanges = async (workspaceId: string) =>
  (
    await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, workspaceId), eq(event.kind, "team.changed")))
  ).length;

/** Runs the worker's step, which sends the warnings, and returns the cancel link it emailed. */
const cancelLinkOf = async (email: string) => {
  await workerStep();
  const sent = await mailTo(email, "Someone asked to remove");
  return sent.text.match(/https?:\/\/\S+/)?.[0] ?? "";
};

describe("asking for a removal", () => {
  test("starts from a fresh session at the code screen, and a second ask changes nothing", async () => {
    const { lost } = await team();
    const started = await askRemoval(lost.waiting);
    expect(started.status).toBe(200);
    const { completesAt } = (await started.json()) as { completesAt: string };
    expect(new Date(completesAt).getTime() - Date.now()).toBeGreaterThan(71 * HOUR_MS);
    const again = await askRemoval(lost.waiting);
    expect(await again.json()).toEqual({ completesAt });
    expect(await requestOf(lost.id)).toHaveLength(1);
    expect(audits("two_factor.removal_requested", lost.id)).toHaveLength(1);
    // The code screen shows it.
    expect((await me(lost.waiting)).removalCompletesAt).toBe(completesAt);
  });

  test("is not needed by a session that passed, or with two-step sign-in off", async () => {
    const space = await newWorkspace();
    const lost = await lostApp(space.id);
    expect(await codeOf(await askRemoval(lost.cookie))).toBe("removal_not_needed");
    const off = await member(space.id);
    expect(await codeOf(await askRemoval(off.cookie))).toBe("removal_not_needed");
  });

  test("needs a session that an email link made in the last 15 minutes", async () => {
    const { lost } = await team();
    await owner
      .update(session)
      .set({ createdAt: new Date(Date.now() - 16 * MINUTE_MS) })
      .where(and(eq(session.userId, lost.id), isNull(session.twoFactorAt)));
    expect(await codeOf(await askRemoval(lost.waiting))).toBe("sign_in_again");
    expect(await requestOf(lost.id)).toEqual([]);
  });

  test("goes to manual review when no other person or signed-in session can stop it", async () => {
    const space = await newWorkspace();
    const solo = await lostApp(space.id, { keepsPassedSession: false });
    // A plain member is not warned.
    await member(space.id, "member");
    // A push subscription proves nothing about a device that still gets it.
    await owner.insert(pushSubscription).values({
      operatorId: solo.id,
      endpoint: `https://fcm.googleapis.com/fcm/send/${solo.id}`,
      p256dh: "key",
      auth: "auth",
    });
    expect(await codeOf(await askRemoval(solo.waiting))).toBe("manual_review");
    // Nor does a session that passed the check and expired.
    const passed = await signIn(app, auth, solo.email);
    expect((await check(passed, await authenticatorCode(solo.secret))).status).toBe(200);
    await owner
      .update(session)
      .set({ expiresAt: new Date(Date.now() - MINUTE_MS) })
      .where(and(eq(session.userId, solo.id), sql`${session.twoFactorAt} is not null`));
    expect(await codeOf(await askRemoval(solo.waiting))).toBe("manual_review");
    expect(await requestOf(solo.id)).toEqual([]);
    // A session that passed and is still valid can stop it.
    const device = await signIn(app, auth, solo.email);
    expect((await check(device, await authenticatorCode(solo.secret, 1))).status).toBe(200);
    expect((await askRemoval(solo.waiting)).status).toBe(200);
  });

  test("an admin of another of the account's workspaces counts as someone to warn", async () => {
    const space = await newWorkspace();
    const solo = await lostApp(space.id, { keepsPassedSession: false });
    const other = await newWorkspace();
    await join(other.id, solo.id, "member");
    const admin = await member(other.id, "admin");
    expect((await askRemoval(solo.waiting)).status).toBe(200);
    await workerStep();
    await mailTo(admin.email, "asked to remove two-step sign-in");
  });

  test("reads the session and the account again under the lock, so a reset that came first wins", async () => {
    const { lost } = await team();
    // A teammate's reset holds the account's lock while the ask passes the session check.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reset = owner.transaction(async (tx) => {
      await lockAccount(tx, lost.id);
      await removeTwoFactor(tx, lost.id);
      await released;
    });
    const asked = askRemoval(lost.waiting);
    await untilWaiting(owner);
    release();
    await reset;
    expect((await asked).status).toBe(401);
    expect(await requestOf(lost.id)).toEqual([]);
  });

  test("tells the account's open apps and the Team pages in each of its workspaces", async () => {
    const { space, lost } = await team();
    const other = await newWorkspace();
    await join(other.id, lost.id, "member");
    const before = [await teamChanges(space.id), await teamChanges(other.id)];
    await askRemoval(lost.waiting);
    await vi.waitFor(async () =>
      expect([await teamChanges(space.id), await teamChanges(other.id)]).toEqual(
        before.map((count) => count + 1),
      ),
    );
  });
});

describe("the warnings", () => {
  test("email the account with a cancel link, push its devices, email the owners and admins, and mark the member", async () => {
    const space = await newWorkspace();
    const lost = await lostApp(space.id);
    const coOwner = await member(space.id, "owner");
    const admin = await member(space.id, "admin");
    const plain = await member(space.id, "member");
    const endpoint = `https://fcm.googleapis.com/fcm/send/${lost.id}`;
    await owner
      .insert(pushSubscription)
      .values({ operatorId: lost.id, endpoint, p256dh: "key", auth: "auth" });
    expect((await askRemoval(lost.waiting)).status).toBe(200);
    // The answer marks the member and shows the banner before the worker runs.
    expect((await me(lost.cookie)).removalCompletesAt).not.toBeNull();
    const listed = await call(coOwner.cookie, "GET", `/v1/operator/workspaces/${space.id}/members`);
    const { members } = (await listed.json()) as { members: { id: string; twoFactor: string }[] };
    expect(members.find((one) => one.id === lost.id)?.twoFactor).toBe("removal_requested");
    const removalMails = () => subjectsTo(lost.email).filter((one) => one.includes("remove"));
    expect(removalMails()).toEqual([]);

    expect(await cancelLinkOf(lost.email)).toContain("/link?for=cancel-removal&token=");
    for (const manager of [coOwner, admin]) {
      const sent = await mailTo(manager.email, "asked to remove two-step sign-in");
      expect(sent.text).toContain(lost.email);
      expect(sent.text).toContain("by voice or in person");
      // Only the account's own email cancels by link.
      expect(sent.text).not.toContain("/link?");
    }
    expect(subjectsTo(plain.email)).toEqual([]);
    expect(pushes.some((one) => one.endpoint === endpoint)).toBe(true);
    const [request] = await requestOf(lost.id);
    expect(request?.warnedAt).not.toBeNull();
    // The wait counts from the warning.
    expect(request?.completesAt.getTime()).toBeGreaterThanOrEqual(
      (request?.warnedAt?.getTime() ?? 0) + 72 * HOUR_MS,
    );
    // Sent once.
    await workerStep();
    expect(removalMails()).toHaveLength(1);
  });

  test("a failed send is tried again later, and the request waits for it", async () => {
    const { lost, coOwner } = await team();
    await askRemoval(lost.waiting);
    await passTime(lost.id, 73 * HOUR_MS);
    failing.add(lost.email);
    await workerStep();
    const [failed] = await requestOf(lost.id);
    expect(failed).toMatchObject({ warnedAt: null, completedAt: null, warningAttempts: 1 });
    // Later, with a wait that doubles with each failure.
    expect(failed?.nextWarningAt?.getTime()).toBeGreaterThan(Date.now() + RETRY_MS / 2);
    // Its wait has ended, but nothing completes before the warning.
    await workerStep();
    expect((await me(lost.cookie)).twoFactor).toBe("on");

    failing.delete(lost.email);
    await owner
      .update(twoFactorRemoval)
      .set({ nextWarningAt: new Date() })
      .where(eq(twoFactorRemoval.operatorId, lost.id));
    await workerStep();
    await mailTo(lost.email, "Someone asked to remove");
    await mailTo(coOwner.email, "asked to remove two-step sign-in");
    const [warned] = await requestOf(lost.id);
    expect(warned).toMatchObject({ warningAttempts: 0, completedAt: null });
    expect(warned?.warnedAt).not.toBeNull();
    expect(warned?.completesAt.getTime()).toBeGreaterThan(Date.now() + 71 * HOUR_MS);
  });

  test("an owner or admin who gets it is enough, and a request with none is tried again", async () => {
    const space = await newWorkspace();
    const lost = await lostApp(space.id, { keepsPassedSession: false });
    const coOwner = await member(space.id, "owner");
    const admin = await member(space.id, "admin");
    await askRemoval(lost.waiting);
    failing.add(coOwner.email);
    failing.add(admin.email);
    await workerStep();
    expect((await requestOf(lost.id))[0]?.warnedAt).toBeNull();
    failing.delete(admin.email);
    await owner
      .update(twoFactorRemoval)
      .set({ nextWarningAt: new Date() })
      .where(eq(twoFactorRemoval.operatorId, lost.id));
    await workerStep();
    expect((await requestOf(lost.id))[0]?.warnedAt).not.toBeNull();
    failing.delete(coOwner.email);
  });

  test("the worker reminds once, a day before the end, with the same cancel link", async () => {
    const { lost } = await team();
    await askRemoval(lost.waiting);
    const link = await cancelLinkOf(lost.email);
    await workerStep();
    expect(subjectsTo(lost.email).filter((one) => one.includes("24 hours"))).toEqual([]);
    await passTime(lost.id, 49 * HOUR_MS);
    await workerStep();
    await workerStep();
    const reminders = mail.sent.filter(
      (one) => one.to === lost.email && one.subject.includes("24 hours"),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.text).toContain(link);
  });

  test("a failed reminder is tried again", async () => {
    const { lost } = await team();
    await askRemoval(lost.waiting);
    await cancelLinkOf(lost.email);
    await passTime(lost.id, 49 * HOUR_MS);
    failing.add(lost.email);
    await workerStep();
    expect((await requestOf(lost.id))[0]?.remindedAt).toBeNull();
    failing.delete(lost.email);
    await owner
      .update(twoFactorRemoval)
      .set({ nextWarningAt: new Date() })
      .where(eq(twoFactorRemoval.operatorId, lost.id));
    await workerStep();
    await mailTo(lost.email, "24 hours");
    expect((await requestOf(lost.id))[0]).toMatchObject({ nextWarningAt: null });
  });
});

describe("cancelling", () => {
  test("by the link: opening it does nothing, and only the button's POST cancels", async () => {
    const { lost } = await team();
    await askRemoval(lost.waiting);
    const link = await cancelLinkOf(lost.email);
    // A mail scanner opens the link, and a GET of the cancel route is not one.
    await openLink(app, link);
    const token = new URL(link).searchParams.get("token");
    await app.request(`/v1/account/two-factor-removal/cancel?token=${token}`);
    expect((await requestOf(lost.id))[0]?.cancelledAt).toBeNull();
    expect((await pressLinkButton(app, link)).status).toBe(200);
    expect((await requestOf(lost.id))[0]?.cancelledAt).not.toBeNull();
    // The token ended with its request.
    const again = await pressLinkButton(app, link);
    expect(await codeOf(again)).toBe("link_invalid");
    expect(audits("two_factor.removal_cancelled", lost.id)).toEqual([
      expect.objectContaining({ by: "link" }),
    ]);
  });

  test("ends the sessions that never passed, blocks new requests for 7 days and warns the account", async () => {
    const { space, lost } = await team();
    await askRemoval(lost.waiting);
    // The request's own signal first.
    await vi.waitFor(async () => expect(await teamChanges(space.id)).toBe(1));
    expect((await cancelInApp(lost.cookie)).status).toBe(200);
    expect(await isSignedOut(lost.waiting)).toBe(true);
    // The session that passed, which cancelled, stays.
    expect((await me(lost.cookie)).removalCompletesAt).toBeNull();
    const sent = await mailTo(lost.email, "was cancelled");
    expect(sent.text).toContain("someone can most likely read your email");
    // The banners in its other apps go.
    await vi.waitFor(async () => expect(await teamChanges(space.id)).toBe(2));
    const next = await signIn(app, auth, lost.email);
    expect(await codeOf(await askRemoval(next))).toBe("removal_blocked");
    // 8 days later, it can start again.
    await owner
      .update(twoFactorRemoval)
      .set({ cancelledAt: new Date(Date.now() - 8 * 24 * HOUR_MS) })
      .where(eq(twoFactorRemoval.operatorId, lost.id));
    expect((await askRemoval(next)).status).toBe(200);
  });

  test("the banner's cancel needs a session that passed, and a request that waits", async () => {
    const { lost } = await team();
    expect(await codeOf(await cancelInApp(lost.cookie))).toBe("no_removal");
    await askRemoval(lost.waiting);
    expect(await codeOf(await cancelInApp(lost.waiting))).toBe("two_factor_required");
    expect((await cancelInApp(lost.cookie)).status).toBe(200);
    expect(audits("two_factor.removal_cancelled", lost.id)).toEqual([
      expect.objectContaining({ by: "session" }),
    ]);
  });

  test("a correct code from the app cancels it, as does a recovery code", async () => {
    const { lost } = await team();
    await askRemoval(lost.waiting);
    const found = await signIn(app, auth, lost.email);
    expect((await check(found, await authenticatorCode(lost.secret))).status).toBe(200);
    expect((await requestOf(lost.id))[0]?.cancelledAt).not.toBeNull();
    expect(await isSignedOut(lost.waiting)).toBe(true);
    expect(await isSignedOut(found)).toBe(false);
    expect(audits("two_factor.removal_cancelled", lost.id)).toEqual([
      expect.objectContaining({ by: "code" }),
    ]);

    const other = await team();
    await askRemoval(other.lost.waiting);
    const typed = await signIn(app, auth, other.lost.email);
    expect((await check(typed, other.lost.recoveryCodes[0] ?? "")).status).toBe(200);
    expect((await requestOf(other.lost.id))[0]?.cancelledAt).not.toBeNull();
  });
});

describe("the end of the wait", () => {
  test("removes the secret and the codes, ends every session and tells the account and the team", async () => {
    const { space, lost, coOwner } = await team();
    await askRemoval(lost.waiting);
    await workerStep();
    await passTime(lost.id, 73 * HOUR_MS);
    const before = await teamChanges(space.id);
    woken.length = 0;
    expect(await workerStep()).toBe(true);
    expect(
      await owner.select().from(operatorTwoFactor).where(eq(operatorTwoFactor.operatorId, lost.id)),
    ).toEqual([]);
    expect(await owner.select().from(session).where(eq(session.userId, lost.id))).toEqual([]);
    const [account] = await owner.select().from(operator).where(eq(operator.id, lost.id));
    expect(account?.twoFactorOn).toBe(false);
    expect((await requestOf(lost.id))[0]?.completedAt).not.toBeNull();
    expect(audits("two_factor.removal_completed", lost.id)).toHaveLength(1);
    await mailTo(lost.email, "Two-step sign-in is off");
    await mailTo(coOwner.email, "was removed");
    // The Team pages read the members again, and the mark is gone.
    expect(await teamChanges(space.id)).toBe(before + 1);
    expect(woken).toContain(space.id);
    // Done once.
    expect(await workerStep()).toBe(false);
    const listed = await call(coOwner.cookie, "GET", `/v1/operator/workspaces/${space.id}/members`);
    const { members } = (await listed.json()) as { members: { id: string; twoFactor: string }[] };
    expect(members.find((one) => one.id === lost.id)?.twoFactor).toBe("off");
  });

  test("a cancelled request never completes", async () => {
    const { lost } = await team();
    await askRemoval(lost.waiting);
    await workerStep();
    await cancelInApp(lost.cookie);
    await owner
      .update(twoFactorRemoval)
      .set({ completesAt: new Date(Date.now() - MINUTE_MS) })
      .where(eq(twoFactorRemoval.operatorId, lost.id));
    await workerStep();
    expect((await me(lost.cookie)).twoFactor).toBe("on");
  });

  test("the next sign-in asks to turn it on again, until a skip or turning it on", async () => {
    const { lost } = await team();
    await askRemoval(lost.waiting);
    await workerStep();
    await passTime(lost.id, 73 * HOUR_MS);
    await workerStep();
    const next = await signIn(app, auth, lost.email);
    expect(await me(next)).toMatchObject({ twoFactor: "off", asksTwoFactorAgain: true });
    expect((await call(next, "POST", "/v1/operator/two-factor/skip-prompt")).status).toBe(200);
    expect((await me(next)).asksTwoFactorAgain).toBe(false);

    const other = await team();
    await askRemoval(other.lost.waiting);
    await workerStep();
    await passTime(other.lost.id, 73 * HOUR_MS);
    await workerStep();
    const back = await signIn(app, auth, other.lost.email);
    await turnOnTwoFactor(app, back);
    expect((await me(back)).asksTwoFactorAgain).toBe(false);
  });
});

describe("a teammate's reset", () => {
  const reset = (cookie: string, workspaceId: string, operatorId: string) =>
    call(
      cookie,
      "POST",
      `/v1/operator/workspaces/${workspaceId}/members/${operatorId}/two-factor-reset`,
    );
  const resettable = async (cookie: string, workspaceId: string) => {
    const listed = await call(cookie, "GET", `/v1/operator/workspaces/${workspaceId}/members`);
    const { members } = (await listed.json()) as {
      members: { id: string; canResetTwoFactor: boolean }[];
    };
    return Object.fromEntries(members.map((one) => [one.id, one.canResetTwoFactor]));
  };

  test("owners reset admins and members, admins reset members, and nobody resets an owner", async () => {
    const space = await newWorkspace();
    const boss = await member(space.id, "owner");
    const otherOwner = await lostApp(space.id, { role: "owner" });
    const admin = await lostApp(space.id, { role: "admin" });
    const otherAdmin = await lostApp(space.id, { role: "admin" });
    const plain = await lostApp(space.id, { role: "member" });
    const plainToo = await lostApp(space.id, { role: "member" });
    await turnOnTwoFactor(app, boss.cookie);
    expect(await resettable(boss.cookie, space.id)).toMatchObject({
      [boss.id]: false,
      [otherOwner.id]: false,
      [admin.id]: true,
      [plain.id]: true,
    });
    expect(await resettable(admin.cookie, space.id)).toMatchObject({
      [otherAdmin.id]: false,
      [plain.id]: true,
    });
    expect(await resettable(plain.cookie, space.id)).toMatchObject({ [plainToo.id]: false });
    for (const [actor, target] of [
      [plain, plainToo],
      [admin, otherAdmin],
      [admin, otherOwner],
      [admin, boss],
    ] as const) {
      const refused = await reset(actor.cookie, space.id, target.id);
      expect(refused.status).toBe(403);
      expect(await codeOf(refused)).toBe("forbidden");
    }
    expect((await reset(admin.cookie, space.id, plain.id)).status).toBe(200);
    expect((await reset(boss.cookie, space.id, admin.id)).status).toBe(200);
    expect(await codeOf(await reset(boss.cookie, space.id, admin.id))).toBe("two_factor_off");
  });

  test("refuses a teammate in another workspace exactly as a role it may not reset", async () => {
    const space = await newWorkspace();
    const boss = await member(space.id, "owner");
    const elsewhere = await lostApp(space.id, { role: "member" });
    const higher = await lostApp(space.id, { role: "owner" });
    const other = await newWorkspace();
    await join(other.id, elsewhere.id, "owner");
    expect(await resettable(boss.cookie, space.id)).toMatchObject({
      [elsewhere.id]: false,
      [higher.id]: false,
    });
    const byWorkspace = await reset(boss.cookie, space.id, elsewhere.id);
    const byRole = await reset(boss.cookie, space.id, higher.id);
    expect(byWorkspace.status).toBe(byRole.status);
    expect(await byWorkspace.text()).toBe(await byRole.text());
    expect((await me(elsewhere.cookie)).twoFactor).toBe("on");
  });

  test("removes it at once, ends the teammate's sessions and emails them and the other owners", async () => {
    const space = await newWorkspace();
    const boss = await member(space.id, "owner");
    const coOwner = await member(space.id, "owner");
    const plain = await lostApp(space.id, { role: "member" });
    await askRemoval(plain.waiting);
    expect((await reset(boss.cookie, space.id, plain.id)).status).toBe(200);
    expect(await isSignedOut(plain.cookie)).toBe(true);
    expect(
      await owner
        .select()
        .from(operatorTwoFactor)
        .where(eq(operatorTwoFactor.operatorId, plain.id)),
    ).toEqual([]);
    // The waiting request ended with it.
    expect((await requestOf(plain.id))[0]?.completedAt).not.toBeNull();
    const sent = await mailTo(plain.email, "Two-step sign-in is off");
    expect(sent.text).toContain(boss.email);
    await mailTo(coOwner.email, "was reset");
    expect(subjectsTo(boss.email).some((one) => one.includes("was reset"))).toBe(false);
    expect(lines.filter((line) => line.event === "two_factor.reset_by_member")).toContainEqual(
      expect.objectContaining({ operatorId: boss.id, targetId: plain.id, workspaceId: space.id }),
    );
    const next = await signIn(app, auth, plain.email);
    expect(await me(next)).toMatchObject({ twoFactor: "off", asksTwoFactorAgain: true });
  });

  test("does not wait for a reply or an assignment that holds the teammate's row for its key", async () => {
    const space = await newWorkspace();
    const boss = await member(space.id, "owner");
    const plain = await lostApp(space.id, { role: "member" });
    // A foreign key check on the operator row, as a reply's author or an assignment takes it.
    let release = () => {};
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = owner.transaction(async (tx) => {
      await tx.execute(sql`select 1 from operator where id = ${plain.id} for key share`);
      locked();
      await released;
    });
    await isLocked;
    const answer = await Promise.race([reset(boss.cookie, space.id, plain.id), delay(3000)]);
    release();
    await holding;
    expect(answer?.status).toBe(200);
  });

  test("does not reach a member of another workspace", async () => {
    const space = await newWorkspace();
    const boss = await member(space.id, "owner");
    const other = await newWorkspace();
    const stranger = await lostApp(other.id, { role: "member" });
    expect((await reset(boss.cookie, space.id, stranger.id)).status).toBe(404);
    expect((await reset(boss.cookie, other.id, stranger.id)).status).toBe(404);
    expect((await me(stranger.cookie)).twoFactor).toBe("on");
  });
});
