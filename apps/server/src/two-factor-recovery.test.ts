import { tmpdir } from "node:os";
import { and, eq, isNull } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { authenticatorCode, turnOnTwoFactor } from "../test/authenticator.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { addOperator, captureMail, openLink, pressLinkButton, signIn } from "../test/operators.ts";
import { asOperator } from "../test/requests.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import {
  operator,
  operatorTwoFactor,
  pushSubscription,
  session,
  twoFactorRecovery,
  workspaceMember,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import type { Push, PushPayload } from "./push.ts";
import { localStore } from "./storage.ts";
import type { Role } from "./team.ts";
import { HOUR_MS, MINUTE_MS } from "./time.ts";
import { recoveryWorkerStep } from "./two-factor-recovery.ts";
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
  workerStep = recoveryWorkerStep({
    db: database.connect("worker").db,
    logger,
    mailer: mail,
    publicUrl: PUBLIC_URL,
    secret: AUTH_SECRET,
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
const askRecovery = (cookie: string) => call(cookie, "POST", "/v1/operator/two-factor/recovery");
const check = (cookie: string, code: string) =>
  call(cookie, "POST", "/v1/operator/two-factor/check", { code });
const me = async (cookie: string) =>
  (await (await call(cookie, "GET", "/v1/operator/me")).json()) as {
    twoFactor: string;
    recoveryCompletesAt: string | null;
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
async function lostPhone(
  workspaceId: string,
  { role = "owner" as Role, keepsPassedSession = true } = {},
) {
  const person = await member(workspaceId, role);
  const factor = await turnOnTwoFactor(app, person.cookie);
  if (!keepsPassedSession) await owner.delete(session).where(eq(session.userId, person.id));
  return { ...person, ...factor, waiting: await signIn(app, auth, person.email) };
}

/** A team: an owner who lost their phone, a second owner and a member, in a new workspace. */
async function team() {
  const space = await newWorkspace();
  const lost = await lostPhone(space.id);
  const coOwner = await member(space.id, "owner");
  const plain = await member(space.id, "member");
  return { space, lost, coOwner, plain };
}

const requestOf = async (operatorId: string) =>
  owner.select().from(twoFactorRecovery).where(eq(twoFactorRecovery.operatorId, operatorId));

/** Moves the waiting request's end, as time passing would. */
const endsIn = (operatorId: string, ms: number) =>
  owner
    .update(twoFactorRecovery)
    .set({ completesAt: new Date(Date.now() + ms) })
    .where(
      and(eq(twoFactorRecovery.operatorId, operatorId), isNull(twoFactorRecovery.cancelledAt)),
    );

const cancelLinkOf = async (email: string) => {
  const sent = await mailTo(email, "Someone asked to remove");
  return sent.text.match(/https?:\/\/\S+/)?.[0] ?? "";
};

describe("asking for a recovery", () => {
  test("starts from a fresh session at the code screen, and a second ask changes nothing", async () => {
    const { lost } = await team();
    const started = await askRecovery(lost.waiting);
    expect(started.status).toBe(200);
    const { completesAt } = (await started.json()) as { completesAt: string };
    expect(new Date(completesAt).getTime() - Date.now()).toBeGreaterThan(71 * HOUR_MS);
    const again = await askRecovery(lost.waiting);
    expect(await again.json()).toEqual({ completesAt });
    expect(await requestOf(lost.id)).toHaveLength(1);
    expect(audits("two_factor.recovery_requested", lost.id)).toHaveLength(1);
    // The code screen shows it.
    expect((await me(lost.waiting)).recoveryCompletesAt).toBe(completesAt);
  });

  test("is not needed by a session that passed, or with two-step sign-in off", async () => {
    const space = await newWorkspace();
    const lost = await lostPhone(space.id);
    expect(await codeOf(await askRecovery(lost.cookie))).toBe("recovery_not_needed");
    const off = await member(space.id);
    expect(await codeOf(await askRecovery(off.cookie))).toBe("recovery_not_needed");
  });

  test("needs a session that an email link made in the last 15 minutes", async () => {
    const { lost } = await team();
    await owner
      .update(session)
      .set({ createdAt: new Date(Date.now() - 16 * MINUTE_MS) })
      .where(and(eq(session.userId, lost.id), isNull(session.twoFactorAt)));
    expect(await codeOf(await askRecovery(lost.waiting))).toBe("sign_in_again");
    expect(await requestOf(lost.id)).toEqual([]);
  });

  test("goes to manual review when nobody else can be warned", async () => {
    const space = await newWorkspace();
    const solo = await lostPhone(space.id, { keepsPassedSession: false });
    // A plain member is not warned.
    await member(space.id, "member");
    expect(await codeOf(await askRecovery(solo.waiting))).toBe("manual_review");
    expect(await requestOf(solo.id)).toEqual([]);
    // A device of theirs that gets the push is enough.
    await owner.insert(pushSubscription).values({
      operatorId: solo.id,
      endpoint: `https://fcm.googleapis.com/fcm/send/${solo.id}`,
      p256dh: "key",
      auth: "auth",
    });
    expect((await askRecovery(solo.waiting)).status).toBe(200);
  });

  test("an admin of another of the account's workspaces counts as someone to warn", async () => {
    const space = await newWorkspace();
    const solo = await lostPhone(space.id, { keepsPassedSession: false });
    const other = await newWorkspace();
    await join(other.id, solo.id, "member");
    const admin = await member(other.id, "admin");
    expect((await askRecovery(solo.waiting)).status).toBe(200);
    await mailTo(admin.email, "asked to remove two-step sign-in");
  });
});

describe("the warnings", () => {
  test("email the account with a cancel link, push its devices, email the owners and admins, and mark the member", async () => {
    const space = await newWorkspace();
    const lost = await lostPhone(space.id);
    const coOwner = await member(space.id, "owner");
    const admin = await member(space.id, "admin");
    const plain = await member(space.id, "member");
    const endpoint = `https://fcm.googleapis.com/fcm/send/${lost.id}`;
    await owner
      .insert(pushSubscription)
      .values({ operatorId: lost.id, endpoint, p256dh: "key", auth: "auth" });
    expect((await askRecovery(lost.waiting)).status).toBe(200);
    expect(await cancelLinkOf(lost.email)).toContain("/link?for=cancel-recovery&token=");
    for (const manager of [coOwner, admin]) {
      const sent = await mailTo(manager.email, "asked to remove two-step sign-in");
      expect(sent.text).toContain(lost.email);
      expect(sent.text).toContain("by voice or in person");
      // Only the account's own email cancels by link.
      expect(sent.text).not.toContain("/link?");
    }
    expect(subjectsTo(plain.email)).toEqual([]);
    await vi.waitFor(() => expect(pushes.some((one) => one.endpoint === endpoint)).toBe(true));
    // The banner on the session that passed, and the mark in Settings > Team.
    expect((await me(lost.cookie)).recoveryCompletesAt).not.toBeNull();
    const listed = await call(coOwner.cookie, "GET", `/v1/operator/workspaces/${space.id}/members`);
    const { members } = (await listed.json()) as { members: { id: string; twoFactor: string }[] };
    expect(members.find((one) => one.id === lost.id)?.twoFactor).toBe("recovery");
  });

  test("the worker reminds once, a day before the end, with the same cancel link", async () => {
    const { lost } = await team();
    await askRecovery(lost.waiting);
    const link = await cancelLinkOf(lost.email);
    await workerStep();
    expect(subjectsTo(lost.email).filter((one) => one.includes("24 hours"))).toEqual([]);
    await endsIn(lost.id, 23 * HOUR_MS);
    await workerStep();
    await workerStep();
    const reminders = mail.sent.filter(
      (one) => one.to === lost.email && one.subject.includes("24 hours"),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.text).toContain(link);
  });
});

describe("cancelling", () => {
  test("by the link: opening it does nothing, and only the button's POST cancels", async () => {
    const { lost } = await team();
    await askRecovery(lost.waiting);
    const link = await cancelLinkOf(lost.email);
    // A mail scanner opens the link, and a GET of the cancel route is not one.
    await openLink(app, link);
    const token = new URL(link).searchParams.get("token");
    await app.request(`/v1/two-factor-recovery/cancel?token=${token}`);
    expect((await requestOf(lost.id))[0]?.cancelledAt).toBeNull();
    expect((await pressLinkButton(app, link)).status).toBe(200);
    expect((await requestOf(lost.id))[0]?.cancelledAt).not.toBeNull();
    // The token ended with its request.
    const again = await pressLinkButton(app, link);
    expect(await codeOf(again)).toBe("link_invalid");
    expect(audits("two_factor.recovery_cancelled", lost.id)).toEqual([
      expect.objectContaining({ by: "link" }),
    ]);
  });

  test("ends the sessions that never passed, blocks new requests for 7 days and warns the account", async () => {
    const { lost } = await team();
    await askRecovery(lost.waiting);
    expect(
      (await call(lost.cookie, "POST", "/v1/operator/two-factor/recovery/cancel")).status,
    ).toBe(200);
    expect(await isSignedOut(lost.waiting)).toBe(true);
    // The session that passed, which cancelled, stays.
    expect((await me(lost.cookie)).recoveryCompletesAt).toBeNull();
    const sent = await mailTo(lost.email, "was cancelled");
    expect(sent.text).toContain("someone can most likely read your email");
    const next = await signIn(app, auth, lost.email);
    expect(await codeOf(await askRecovery(next))).toBe("recovery_blocked");
    // 8 days later, it can start again.
    await owner
      .update(twoFactorRecovery)
      .set({ cancelledAt: new Date(Date.now() - 8 * 24 * HOUR_MS) })
      .where(eq(twoFactorRecovery.operatorId, lost.id));
    expect((await askRecovery(next)).status).toBe(200);
  });

  test("the banner's cancel needs a session that passed, and a request that waits", async () => {
    const { lost } = await team();
    const cancel = (cookie: string) =>
      call(cookie, "POST", "/v1/operator/two-factor/recovery/cancel");
    expect(await codeOf(await cancel(lost.cookie))).toBe("no_recovery");
    await askRecovery(lost.waiting);
    expect(await codeOf(await cancel(lost.waiting))).toBe("two_factor_required");
    expect((await cancel(lost.cookie)).status).toBe(200);
    expect(audits("two_factor.recovery_cancelled", lost.id)).toEqual([
      expect.objectContaining({ by: "session" }),
    ]);
  });

  test("a correct code from the app cancels it, as does a recovery code", async () => {
    const { lost } = await team();
    await askRecovery(lost.waiting);
    const found = await signIn(app, auth, lost.email);
    expect((await check(found, await authenticatorCode(lost.secret))).status).toBe(200);
    expect((await requestOf(lost.id))[0]?.cancelledAt).not.toBeNull();
    expect(await isSignedOut(lost.waiting)).toBe(true);
    expect(await isSignedOut(found)).toBe(false);
    expect(audits("two_factor.recovery_cancelled", lost.id)).toEqual([
      expect.objectContaining({ by: "code" }),
    ]);

    const other = await team();
    await askRecovery(other.lost.waiting);
    const typed = await signIn(app, auth, other.lost.email);
    expect((await check(typed, other.lost.recoveryCodes[0] ?? "")).status).toBe(200);
    expect((await requestOf(other.lost.id))[0]?.cancelledAt).not.toBeNull();
  });
});

describe("the end of the wait", () => {
  test("removes the secret and the codes, ends every session and tells the account and the team", async () => {
    const { space, lost, coOwner } = await team();
    await askRecovery(lost.waiting);
    await endsIn(lost.id, -MINUTE_MS);
    expect(await workerStep()).toBe(true);
    expect(
      await owner.select().from(operatorTwoFactor).where(eq(operatorTwoFactor.operatorId, lost.id)),
    ).toEqual([]);
    expect(await owner.select().from(session).where(eq(session.userId, lost.id))).toEqual([]);
    const [account] = await owner.select().from(operator).where(eq(operator.id, lost.id));
    expect(account?.twoFactorOn).toBe(false);
    expect((await requestOf(lost.id))[0]?.completedAt).not.toBeNull();
    expect(audits("two_factor.recovery_completed", lost.id)).toHaveLength(1);
    await mailTo(lost.email, "Two-step sign-in is off");
    await mailTo(coOwner.email, "was removed");
    // Done once.
    expect(await workerStep()).toBe(false);
    const listed = await call(coOwner.cookie, "GET", `/v1/operator/workspaces/${space.id}/members`);
    const { members } = (await listed.json()) as { members: { id: string; twoFactor: string }[] };
    expect(members.find((one) => one.id === lost.id)?.twoFactor).toBe("off");
  });

  test("a cancelled request never completes", async () => {
    const { lost } = await team();
    await askRecovery(lost.waiting);
    await call(lost.cookie, "POST", "/v1/operator/two-factor/recovery/cancel");
    await owner
      .update(twoFactorRecovery)
      .set({ completesAt: new Date(Date.now() - MINUTE_MS) })
      .where(eq(twoFactorRecovery.operatorId, lost.id));
    await workerStep();
    expect((await me(lost.cookie)).twoFactor).toBe("on");
  });

  test("the next sign-in asks to turn it on again, until a skip or turning it on", async () => {
    const { lost } = await team();
    await askRecovery(lost.waiting);
    await endsIn(lost.id, -MINUTE_MS);
    await workerStep();
    const next = await signIn(app, auth, lost.email);
    expect(await me(next)).toMatchObject({ twoFactor: "off", asksTwoFactorAgain: true });
    expect((await call(next, "POST", "/v1/operator/two-factor/skip-prompt")).status).toBe(200);
    expect((await me(next)).asksTwoFactorAgain).toBe(false);

    const other = await team();
    await askRecovery(other.lost.waiting);
    await endsIn(other.lost.id, -MINUTE_MS);
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
    const otherOwner = await lostPhone(space.id, { role: "owner" });
    const admin = await lostPhone(space.id, { role: "admin" });
    const otherAdmin = await lostPhone(space.id, { role: "admin" });
    const plain = await lostPhone(space.id, { role: "member" });
    const plainToo = await lostPhone(space.id, { role: "member" });
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
    const elsewhere = await lostPhone(space.id, { role: "member" });
    const higher = await lostPhone(space.id, { role: "owner" });
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
    const plain = await lostPhone(space.id, { role: "member" });
    await askRecovery(plain.waiting);
    expect((await reset(boss.cookie, space.id, plain.id)).status).toBe(200);
    expect(await isSignedOut(plain.cookie)).toBe(true);
    expect(
      await owner
        .select()
        .from(operatorTwoFactor)
        .where(eq(operatorTwoFactor.operatorId, plain.id)),
    ).toEqual([]);
    // The waiting recovery ended with it.
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

  test("does not reach a member of another workspace", async () => {
    const space = await newWorkspace();
    const boss = await member(space.id, "owner");
    const other = await newWorkspace();
    const stranger = await lostPhone(other.id, { role: "member" });
    expect((await reset(boss.cookie, space.id, stranger.id)).status).toBe(404);
    expect((await reset(boss.cookie, other.id, stranger.id)).status).toBe(404);
    expect((await me(stranger.cookie)).twoFactor).toBe("on");
  });
});
