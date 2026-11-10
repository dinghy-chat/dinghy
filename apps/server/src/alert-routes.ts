import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { Logger } from "pino";
import { sendToOperator, testPayload, verifyEmailStop } from "./alerts.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { emailStop, pushSubscription, workspaceMember } from "./db/schema.ts";
import { type Database, lockLiveOperator, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  OPERATOR_POST_ERRORS,
  OPERATOR_WRITE_ERRORS,
  okContent,
  UNAUTHORIZED,
} from "./errors.ts";
import { isPushEndpoint, isPushKeys, type Push } from "./push.ts";
import { limitByIp, type RateLimit } from "./rate-limit.ts";

const NO_PUSH = failure("push_unavailable", "This server has no push keys.");
const BAD_ENDPOINT = failure("bad_endpoint", "This browser's push service is not supported.");

// An operator with many old devices must not make each alert slower for the worker.
const MAX_DEVICES = 10;

const STOP_TEXT = {
  title: "Stop these emails",
  question: "Stop the reply emails sent to this address from this chat?",
  button: "Stop the emails",
  done: "You will not receive these emails again.",
  invalid: "This link does not work.",
};

const Settings = z
  .object({
    email: z.boolean(),
    pushKey: z.string().nullable(),
    emailAvailable: z.boolean(),
  })
  .openapi("AlertSettings");

const workspaceParams = z.object({ workspaceId: z.uuid() });

const getSettings = createRoute({
  method: "get",
  path: "/v1/operator/workspaces/{workspaceId}/alerts",
  security: SESSION,
  summary: "Get this operator's alert settings",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The settings",
      content: { "application/json": { schema: Settings } },
    },
    ...MEMBER_ERRORS,
  },
});

const patchSettings = createRoute({
  method: "patch",
  path: "/v1/operator/workspaces/{workspaceId}/alerts",
  security: SESSION,
  summary: "Change this operator's alert settings",
  request: {
    params: workspaceParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({ email: z.boolean() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The settings",
      content: { "application/json": { schema: Settings } },
    },
    ...MEMBER_WRITE_ERRORS,
  },
});

const Device = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
});

const ok = {
  description: "Done",
  content: okContent,
};

const saveDevice = createRoute({
  method: "put",
  path: "/v1/operator/push-subscription",
  security: SESSION,
  summary: "Save this browser's push subscription",
  request: { body: { content: { "application/json": { schema: Device } } } },
  responses: {
    200: ok,
    ...OPERATOR_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid. bad_endpoint: this browser's push service is not supported",
    ),
  },
});

const deleteDevice = createRoute({
  method: "delete",
  path: "/v1/operator/push-subscription",
  security: SESSION,
  summary: "Delete this browser's push subscription",
  request: {
    body: {
      content: { "application/json": { schema: z.object({ endpoint: z.string().max(2048) }) } },
    },
  },
  responses: { 200: ok, ...OPERATOR_WRITE_ERRORS },
});

const testPush = createRoute({
  method: "post",
  path: "/v1/operator/push-test",
  security: SESSION,
  summary: "Send a real test notification to this operator's devices",
  responses: {
    200: {
      description: "How many devices the push services accepted it for",
      content: {
        "application/json": { schema: z.object({ sent: z.number(), failed: z.number() }) },
      },
    },
    ...OPERATOR_POST_ERRORS,
    409: errorAnswer("push_unavailable: this server has no push keys"),
    429: errorAnswer("too_many_requests: over 5 tests a minute. Retry after `retry-after`"),
  },
});

interface AlertRouteOptions {
  db: Database;
  logger: Logger;
  push?: Push | undefined;
  emailAvailable: boolean;
}

export function registerAlertRoutes(
  app: App,
  { db, push, emailAvailable }: AlertRouteOptions,
): void {
  const read = async (workspaceId: string, operatorId: string) => {
    const [row] = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({ email: workspaceMember.alertEmail })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.workspaceId, workspaceId),
            eq(workspaceMember.operatorId, operatorId),
          ),
        ),
    );
    if (row === undefined) return null;
    return { ...row, pushKey: push?.publicKey ?? null, emailAvailable };
  };

  app.openapi(getSettings, async (c) => {
    const settings = await read(c.get("memberWorkspaceId"), c.get("operatorId"));
    return settings === null ? c.json(NOT_FOUND, 404) : c.json(settings, 200);
  });

  app.openapi(patchSettings, async (c) => {
    const workspaceId = c.get("memberWorkspaceId");
    const operatorId = c.get("operatorId");
    const { email } = c.req.valid("json");
    await withWorkspace(db, workspaceId, (tx) =>
      tx
        .update(workspaceMember)
        .set({ alertEmail: email })
        .where(
          and(
            eq(workspaceMember.workspaceId, workspaceId),
            eq(workspaceMember.operatorId, operatorId),
          ),
        ),
    );
    const settings = await read(workspaceId, operatorId);
    return settings === null ? c.json(NOT_FOUND, 404) : c.json(settings, 200);
  });

  app.openapi(saveDevice, async (c) => {
    const { endpoint, keys } = c.req.valid("json");
    if (!isPushEndpoint(endpoint) || !isPushKeys(keys.p256dh, keys.auth)) {
      return c.json(BAD_ENDPOINT, 400);
    }
    const operatorId = c.get("operatorId");
    const saved = await db.transaction(async (tx) => {
      if (!(await lockLiveOperator(tx, operatorId))) return false;
      // A browser that another operator used last now belongs to this one.
      await tx
        .insert(pushSubscription)
        .values({ operatorId, endpoint, p256dh: keys.p256dh, auth: keys.auth })
        .onConflictDoUpdate({
          target: pushSubscription.endpoint,
          set: { operatorId, p256dh: keys.p256dh, auth: keys.auth },
        });
      const rows = await tx
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .where(eq(pushSubscription.operatorId, operatorId))
        .orderBy(asc(pushSubscription.createdAt));
      const newest = rows.slice(-MAX_DEVICES).map((row) => row.id);
      await tx
        .delete(pushSubscription)
        .where(
          and(eq(pushSubscription.operatorId, operatorId), notInArray(pushSubscription.id, newest)),
        );
      return true;
    });
    if (!saved) return c.json(UNAUTHORIZED, 401);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(deleteDevice, async (c) => {
    const { endpoint } = c.req.valid("json");
    await db
      .delete(pushSubscription)
      .where(
        and(
          eq(pushSubscription.endpoint, endpoint),
          eq(pushSubscription.operatorId, c.get("operatorId")),
        ),
      );
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(testPush, async (c) => {
    if (push === undefined) return c.json(NO_PUSH, 409);
    const result = await sendToOperator(
      db,
      push,
      c.get("operatorId"),
      testPayload(crypto.randomUUID()),
    );
    return c.json(result, 200);
  });
}

/** The headers of a stop link's page: nothing loads, and the form posts only to itself. */
export const STOP_PAGE_SECURITY = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** A stop link's page. `body` is fixed text and a form, never anything a person typed. */
export const stopPage = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:#0b2239;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:440px;padding:28px;border-radius:14px;background:#fff;color:#0b2239}button{margin-top:16px;min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#ffc917;color:#0b2239;font:600 16px system-ui,sans-serif;cursor:pointer}button:hover{background:#ffd84d}button:focus-visible{outline:2px solid #1f6bff;outline-offset:2px}</style><main>${body}</main></html>`;

/** The stop link. GET only asks, because mail scanners open links. POST stops the emails. */
export function registerEmailStop(
  app: App,
  db: Database,
  secret: string,
  rateLimit: RateLimit,
): void {
  app.use("/v1/email-stop/*", limitByIp(rateLimit, "email-stop", 20, 60));
  const page = (body: string) => stopPage(STOP_TEXT.title, body);
  const valid = (workspaceId: string, addressHash: string, signature: string) =>
    z.uuid().safeParse(workspaceId).success &&
    /^[0-9a-f]{64}$/.test(addressHash) &&
    verifyEmailStop(secret, workspaceId, addressHash, signature);

  app.get("/v1/email-stop/:workspaceId/:addressHash", (c) => {
    const { workspaceId, addressHash } = c.req.param();
    const signature = c.req.query("signature") ?? "";
    if (!valid(workspaceId, addressHash, signature)) {
      return c.html(page(`<p>${STOP_TEXT.invalid}</p>`), 404, STOP_PAGE_SECURITY);
    }
    return c.html(
      page(
        `<p>${STOP_TEXT.question}</p><form method="post" action="?signature=${signature}"><button>${STOP_TEXT.button}</button></form>`,
      ),
      200,
      STOP_PAGE_SECURITY,
    );
  });

  app.post("/v1/email-stop/:workspaceId/:addressHash", async (c) => {
    const { workspaceId, addressHash } = c.req.param();
    if (!valid(workspaceId, addressHash, c.req.query("signature") ?? "")) {
      return c.html(page(`<p>${STOP_TEXT.invalid}</p>`), 404, STOP_PAGE_SECURITY);
    }
    await withWorkspace(db, workspaceId, (tx) =>
      tx.insert(emailStop).values({ workspaceId, addressHash }).onConflictDoNothing(),
    );
    return c.html(page(`<p>${STOP_TEXT.done}</p>`), 200, STOP_PAGE_SECURITY);
  });
}
