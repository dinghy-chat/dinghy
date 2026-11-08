// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Redis } from "iovalkey";
import type pg from "pg";
import type { Logger } from "pino";
import type { App } from "../../apps/server/src/app.ts";
import { type Auth, signInLink } from "../../apps/server/src/auth.ts";
import { operator, visitor, workspace, workspaceMember } from "../../apps/server/src/db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import {
  errorAnswer,
  failure,
  safeErrorFields,
  WRONG_ORIGIN,
} from "../../apps/server/src/errors.ts";
import { LINK_LASTS, letter } from "../../apps/server/src/letter.ts";
import { createLinkLimit, tooManyAttempts } from "../../apps/server/src/login-limit.ts";
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

/** Where operators of a suspended cloud workspace write to, and where the welcome sends questions. */
export const CLOUD_CONTACT = "hello@dinghy.chat";

// Plain text. Every string has a key here, so a locale can be added later.
const text = {
  sampleVisitor: "Sample visitor",
  sampleMessage:
    "Hi! This is a sample conversation. When the cloud opens, your visitors' messages will " +
    "appear here, and you answer them from this inbox.",
  signupSubject: "Finish signing up for Dinghy",
  // Fixed text only: nobody has proved this address yet.
  signupBody: (url: string) => [
    "Thanks for trying Dinghy! Open this link to confirm your email and set up your workspace:",
    url,
    LINK_LASTS,
    "Didn't sign up? You can ignore this email, and nothing happens.",
  ],
  takenSubject: "Your Dinghy sign-in link",
  // Sent instead of an answer that would tell the person signing up that this email has an account.
  takenBody: (url: string) => [
    "Someone, hopefully you, just tried to sign up for Dinghy with this email. You already have " +
      "an account, so here's a link to sign in instead. From there, you can add a workspace.",
    url,
    LINK_LASTS,
    "If it wasn't you, you can ignore this email. Nobody gets in without the link.",
  ],
  welcomeSubject: (workspace: string) => `${workspace} is ready`,
  // The operator proved this address with their link before they named themselves and the workspace.
  // Only early signup sends it, so it lists only what works before the cloud opens: no widget yet.
  welcomeBody: (workspace: string, url: string) => [
    `Welcome to Dinghy! Your workspace ${workspace} is set up. Here's what to do next:`,
    "- Invite your team from Settings, under Team.\n" +
      "- Turn on alerts there too, so you hear about new messages.",
    `Sign in any time at ${url}`,
    `Questions? Write to us at ${CLOUD_CONTACT}.`,
  ],
};

const signupRoute = createRoute({
  method: "post",
  path: "/v1/signup",
  summary: "Send the link that creates an account, or signs in to the one this email has",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ email: z.email().max(254) }) },
      },
    },
  },
  responses: {
    200: {
      description:
        "Check the email: this answer is the same whether or not the email has an account. The " +
        "link signs in, and the account adds a workspace next, at POST /v1/operator/workspaces",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    403: errorAnswer("Another site sent this"),
    429: errorAnswer("Too many attempts"),
    503: errorAnswer("email_unavailable: this server cannot send email"),
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
  const links = createLinkLimit(valkey, logger);

  /** At most once, after the commit. A mail failure never fails the signup. */
  const welcome = (to: string, name: string, workspace: string) => {
    if (mailer === undefined) {
      logger.info("this server has no SMTP, so a welcome email was not sent");
      return;
    }
    const body = letter(text.welcomeBody(workspace, publicUrl), name);
    mailer
      .send(to, text.welcomeSubject(workspace), body)
      .catch((err: unknown) => logger.warn({ err }, "a welcome email was not sent"));
  };

  /** A new email gets the signup link. One with an account gets a sign-in link and a note. */
  const sendLink = async (email: string) => {
    if (mailer === undefined) return;
    const [known] = await db
      .select({ verified: operator.emailVerified })
      .from(operator)
      .where(eq(operator.email, email));
    // An account that never opened its link, from before links, counts as new: it proves itself.
    const taken = known?.verified === true;
    // A known email lands on the workspace setup, which is why its owner came to sign up.
    const url = await signInLink(auth, email, taken ? "add-workspace" : "signup");
    const subject = taken ? text.takenSubject : text.signupSubject;
    await mailer.send(email, subject, letter(taken ? text.takenBody(url) : text.signupBody(url)));
  };

  app.use("/v1/signup", limitByIp(rateLimit, "signup", 10, 3600));
  app.use("/v1/signup", bodyLimit({ maxSize: 8 * 1024 }));

  app.openapi(signupRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    if (mailer === undefined) {
      return c.json(failure("email_unavailable", "This server cannot send email."), 503);
    }
    const email = c.req.valid("json").email.toLowerCase();
    if (!(await links.attempt(email, c.get("clientIp")))) return tooManyAttempts(c, links);
    // After the answer, so its timing never tells whether the email has an account.
    sendLink(email).catch((err: unknown) => {
      logger.error(safeErrorFields(err), "could not send a signup link");
    });
    return c.json({ ok: true as const }, 200);
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
    if (welcomed) welcome(c.get("operatorEmail"), body.name, body.workspaceName);
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
