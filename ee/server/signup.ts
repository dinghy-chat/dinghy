// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Redis } from "iovalkey";
import type pg from "pg";
import type { Logger } from "pino";
import type { App } from "../../apps/server/src/app.ts";
import {
  type Auth,
  isSignInRefused,
  notVerified,
  sendVerification,
  verifiesEmail,
} from "../../apps/server/src/auth.ts";
import {
  account,
  operator,
  visitor,
  workspace,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { errorAnswer, failure, WRONG_ORIGIN } from "../../apps/server/src/errors.ts";
import {
  createLoginLimit,
  createResetLimit,
  tooManyAttempts,
} from "../../apps/server/src/login-limit.ts";
import type { Mailer } from "../../apps/server/src/mailer.ts";
import { appendMessage } from "../../apps/server/src/messages.ts";
import { limitByIp, type RateLimit, tooManyRequests } from "../../apps/server/src/rate-limit.ts";
import { type NewWorkspace, workspaceKeys } from "../../apps/server/src/workspaces.ts";

/**
 * How cloud signup works. With `payment`, the workspace waits for its first payment.
 * `early` opens signup before the cloud takes payments: the workspace works at once, without its
 * widget, and waits for the cloud to open.
 */
export type SignupMode = "payment" | "early";

// Plain text. Every string has a key here, so a locale can be added later.
const text = {
  sampleVisitor: "Sample visitor",
  sampleMessage:
    "Hi! This is a sample conversation. When the cloud opens, your visitors' messages will " +
    "appear here, and you answer them from this inbox.",
  welcomeSubject: "Welcome to Dinghy",
  // Fixed text only: nobody checks the address before this email goes out, so a name or a
  // workspace name typed at signup must not reach someone else's inbox.
  welcomeBody: (url: string) =>
    `Hi,\n\nYour Dinghy workspace is ready. You can sign in, invite ` +
    `your team and set it up now: ${url}\n\nDinghy Cloud opens soon. Until then, the chat ` +
    `widget does not run on your site. We will email you when you can turn it on.\n\n` +
    `The Dinghy team`,
  takenSubject: "Your Dinghy account",
  // Sent instead of an answer that would tell the person signing up that this email has an account.
  takenBody: (url: string) =>
    `Hi,\n\nSomeone, maybe you, tried to create a Dinghy account with this email. It already has ` +
    `one. Sign in at ${url}, or reset your password there if you lost it.\n\nIf it was not you, ` +
    `you need to do nothing.\n\nThe Dinghy team`,
};

const EMAIL_TAKEN = failure(
  "email_taken",
  "This email already has an account. Use its password to add a workspace.",
);

const signupRoute = createRoute({
  method: "post",
  path: "/v1/signup",
  summary: "Create an account, or sign in to the account this email already has",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            email: z.email().max(254),
            // The same rule as sign-in's.
            password: z.string().min(10).max(128),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "With `verify`, check the email: this answer is the same whether or not the email has an " +
        "account. Without it, signed in, and the account adds a workspace next, at " +
        "POST /v1/operator/workspaces",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), verify: z.boolean() }),
        },
      },
    },
    403: errorAnswer("Another site sent this"),
    409: errorAnswer(
      "On a server with no mail server: the email has an account with another password",
    ),
    429: errorAnswer("Too many attempts"),
  },
});

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/v1/operator/workspaces",
  summary: "Name the signed-in operator, and create a cloud workspace that they own",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().trim().min(1).max(100),
            workspaceName: z.string().trim().min(1).max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "A new workspace that waits for payment, or for the cloud to open",
      content: { "application/json": { schema: z.object({ workspaceId: z.string() }) } },
    },
    401: errorAnswer("No valid session"),
    403: errorAnswer("Another site sent this"),
    429: errorAnswer("Too many workspaces or attempts"),
  },
});

/** How many workspaces one operator can create in a day, so a script cannot make many. */
const WORKSPACES_PER_DAY = 5;

/**
 * A new cloud workspace and its owner, in the caller's transaction. An early one waits for the
 * cloud and gets a sample conversation, through the same message path as a visitor's.
 */
async function insertSignupWorkspace(
  tx: Transaction,
  keys: NewWorkspace,
  name: string,
  operatorId: string,
  mode: SignupMode,
): Promise<void> {
  await tx.insert(workspace).values({
    ...keys,
    name,
    active: false,
    ...(mode === "early" && { waitingSince: new Date() }),
  });
  await tx.insert(workspaceMember).values({ workspaceId: keys.id, operatorId, role: "owner" });
  if (mode !== "early") return;
  const [sample] = await tx
    .insert(visitor)
    .values({ workspaceId: keys.id, externalId: text.sampleVisitor })
    .returning({ id: visitor.id });
  if (sample === undefined) throw new Error("The sample visitor insert returned no row");
  await appendMessage(
    tx,
    keys.id,
    { kind: "visitor", visitorId: sample.id },
    { clientId: randomUUID(), body: text.sampleMessage },
  );
}

interface SignupOptions {
  auth: Auth;
  db: Database;
  logger: Logger;
  mailer: Mailer | undefined;
  mode: SignupMode;
  rateLimit: RateLimit;
  valkey: Redis | null;
}

/**
 * Cloud signup, in two steps: the account, then its first workspace. Call this only on a server
 * with billing on, or with early signup on, and after the operator routes, which check the session.
 */
export function registerSignup(
  app: App,
  { auth, db, logger, mailer, mode, rateLimit, valkey }: SignupOptions,
) {
  const publicUrl = String(auth.options.baseURL);
  const publicOrigin = new URL(publicUrl).origin;
  const login = createLoginLimit(valkey, logger);
  const notices = createResetLimit(valkey, logger);
  const verify = verifiesEmail(auth);
  const CHECK_EMAIL = { ok: true as const, verify: true };

  /** At most once, after the commit. A mail failure never fails the signup. */
  const welcome = (email: string) => {
    if (mailer === undefined) {
      logger.info("this server has no SMTP, so a welcome email was not sent");
      return;
    }
    mailer
      .send(email, text.welcomeSubject, text.welcomeBody(publicUrl))
      .catch((err: unknown) => logger.warn({ err }, "a welcome email was not sent"));
  };

  app.use("/v1/signup", limitByIp(rateLimit, "signup", 10, 3600));
  app.use("/v1/signup", bodyLimit({ maxSize: 8 * 1024 }));

  app.openapi(signupRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const body = c.req.valid("json");
    const email = body.email.toLowerCase();
    const context = await auth.$context;
    // Always hashed, so a known email takes about as long as a new one.
    const hash = await context.password.hash(body.password);
    // The name stays empty until the operator names themselves with their first workspace.
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(operator)
        .values({ name: "", email, emailVerified: false })
        .onConflictDoNothing()
        .returning({ id: operator.id });
      if (row === undefined) return false;
      await tx
        .insert(account)
        .values({ userId: row.id, accountId: row.id, providerId: "credential", password: hash });
      return row.id;
    });
    const ip = c.get("clientIp");
    // With a mail server, a new account opens its link before it can sign in. A known email with
    // another password gets the same answer, and its owner gets a note, so nobody learns here
    // whether an email has an account.
    if (verify && created !== false) {
      // The same password check a known email gets, so both answers take as long.
      await context.password.verify({ hash, password: body.password });
      await sendVerification(auth, { id: created, email });
      return c.json(CHECK_EMAIL, 200);
    }
    // A known email signs in instead, and its own password is the only way to add a workspace.
    if (!created && !(await login.attempt(email, ip))) return tooManyAttempts(c, login);
    // BetterAuth's own sign-in, so the session cookie is the usual one.
    const signedIn = await auth.api
      .signInEmail({
        body: { email, password: body.password },
        headers: c.req.raw.headers,
        returnHeaders: true,
      })
      .catch((error: unknown) => {
        if (created) throw error;
        // 403 is the right password on an account that has not opened its link, which sign-in
        // has just sent again.
        if (notVerified(error)) return "unverified" as const;
        // Only a refused password means the email is someone else's. Anything else is a failure,
        // which app.onError logs and answers with a 500.
        if (isSignInRefused(error)) return null;
        throw error;
      });
    if (verify && signedIn === "unverified") return c.json(CHECK_EMAIL, 200);
    if (verify && signedIn === null) {
      if (mailer !== undefined && (await notices.attempt(email, ip))) {
        mailer
          .send(email, text.takenSubject, text.takenBody(publicUrl))
          .catch((err: unknown) => logger.warn({ err }, "a signup notice was not sent"));
      }
      return c.json(CHECK_EMAIL, 200);
    }
    if (signedIn === null || signedIn === "unverified") return c.json(EMAIL_TAKEN, 409);
    if (!created) await login.clear(email, ip);
    for (const cookie of signedIn.headers.getSetCookie()) {
      c.header("set-cookie", cookie, { append: true });
    }
    return c.json({ ok: true as const, verify: false }, 200);
  });

  // The operator routes already check the session and the origin.
  app.use("/v1/operator/workspaces", limitByIp(rateLimit, "new-workspace", 10, 3600));

  app.openapi(createWorkspaceRoute, async (c) => {
    const body = c.req.valid("json");
    const operatorId = c.get("operatorId");
    const wait = await rateLimit.hit(
      "new-workspace-operator",
      operatorId,
      WORKSPACES_PER_DAY,
      86_400,
    );
    if (wait !== null) return tooManyRequests(c, wait);
    const keys = workspaceKeys();
    const welcomed = await withWorkspace(db, keys.id, async (tx) => {
      await tx.update(operator).set({ name: body.name }).where(eq(operator.id, operatorId));
      await insertSignupWorkspace(tx, keys, body.workspaceName, operatorId, mode);
      if (mode !== "early") return false;
      // An account gets the welcome once: deleting a workspace, or two requests at once, cannot
      // send it again, because only one update finds the column still empty.
      const marked = await tx
        .update(operator)
        .set({ welcomedAt: new Date() })
        .where(and(eq(operator.id, operatorId), isNull(operator.welcomedAt)))
        .returning({ id: operator.id });
      return marked.length > 0;
    });
    if (welcomed) welcome(c.get("operatorEmail"));
    return c.json({ workspaceId: keys.id }, 200);
  });
}

/** A spreadsheet runs a cell that starts with one of these, so it gets a quote in front. */
const FORMULA = /^[=+\-@\t\r]/;

function csvField(value: string): string {
  const safe = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * The owners of the workspaces that wait for the cloud, as CSV, oldest first. It reads across
 * workspaces, so it runs with the admin login, as `chat signups`.
 */
export async function signupsCsv(admin: pg.ClientBase): Promise<string> {
  const result = await admin.query<{
    email: string;
    name: string;
    workspace: string;
    signed_up_at: Date;
  }>(
    `SELECT o.email, o.name, w.name AS workspace, w.waiting_since AS signed_up_at
     FROM workspace AS w
     JOIN workspace_member AS m
       ON m.workspace_id = w.id AND m.role = 'owner' AND m.removed_at IS NULL
     JOIN operator AS o ON o.id = m.operator_id
     WHERE w.waiting_since IS NOT NULL AND w.deleted_at IS NULL
     ORDER BY w.waiting_since, o.email`,
  );
  const lines = [
    "email,name,workspace,signed_up_at",
    ...result.rows.map((row) =>
      [row.email, row.name, row.workspace, row.signed_up_at.toISOString()].map(csvField).join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
