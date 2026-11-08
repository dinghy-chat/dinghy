import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { workspace } from "./db/schema.ts";
import { accessFlags, type Database, operatorWorkspaces, withWorkspace } from "./db/tenant.ts";
import { failure, OPERATOR_ERRORS, WRONG_ORIGIN } from "./errors.ts";
import { emailAddressHash } from "./identity.ts";
import { createLoginLimit, createResetLimit, tooManyAttempts } from "./login-limit.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";

const UNAUTHORIZED = failure("unauthorized", "Sign in to continue.");

const AccountName = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(100)
    .refine((name) => name.trim() === name),
});

const meRoute = createRoute({
  method: "get",
  path: "/v1/operator/me",
  security: SESSION,
  summary: "Get the signed-in operator and its workspaces",
  responses: {
    200: {
      description: "The operator",
      content: {
        "application/json": {
          schema: z
            .object({
              id: z.string(),
              name: z.string(),
              email: z.string(),
              workspaces: z.array(
                z.object({
                  workspaceId: z.string(),
                  role: z.string(),
                  name: z.string(),
                  // False while a cloud signup waits for payment.
                  active: z.boolean(),
                  // True after a cloud subscription ended: operators can read and export only.
                  readOnly: z.boolean(),
                  // True for an early cloud signup that waits for the cloud to open. Everything
                  // works except the widget.
                  waiting: z.boolean(),
                  // True while the server's admin has suspended it: nobody can send, the widget
                  // is off, and operators can read.
                  suspended: z.boolean(),
                }),
              ),
              billing: z.boolean(),
              // Who a suspended workspace's operators write to: Dinghy Cloud's address, or null on
              // a self-hosted server, whose admin they already know.
              contact: z.string().nullable(),
            })
            .openapi("Operator"),
        },
      },
    },
    ...OPERATOR_ERRORS,
  },
});

interface OperatorOptions {
  auth: Auth;
  db: Database;
  logger: Logger;
  rateLimit: RateLimit;
  valkey: Redis | null;
  /** True when the cloud plan's billing is on. */
  billing: boolean;
  /** Who a suspended workspace's operators write to, on the cloud. */
  contact: string | null;
}

export function registerOperatorRoutes(
  app: App,
  { auth, billing, contact, db, logger, rateLimit, valkey }: OperatorOptions,
) {
  const publicOrigin = new URL(String(auth.options.baseURL)).origin;
  const login = createLoginLimit(valkey, logger);
  const reset = createResetLimit(valkey, logger);

  /** The email in a JSON body. The JSON check on these routes means BetterAuth reads the same one. */
  const emailIn = async (c: Context) => {
    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    return typeof body?.email === "string" ? body.email : "";
  };

  // A session is read from the database on each request, so a revoked one stops at the next.
  const requireOperator = createMiddleware<{
    Variables: {
      operatorId: string;
      operatorName: string;
      operatorEmail: string;
      sessionId: string;
    };
  }>(async (c, next) => {
    // A cookie goes with any same-site request, so a write must come from the server's own origin.
    if (c.req.method !== "GET" && c.req.header("origin") !== publicOrigin) {
      return c.json(WRONG_ORIGIN, 403);
    }
    const { response: found, headers } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    // A renewed session sends a new cookie, or an active operator would be signed out in a week.
    for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
    if (found === null) return c.json(UNAUTHORIZED, 401);
    c.set("operatorId", found.user.id);
    c.set("operatorName", found.user.name);
    c.set("operatorEmail", found.user.email);
    c.set("sessionId", found.session.id);
    await next();
  });

  app.use("/v1/auth/*", bodyLimit({ maxSize: 8 * 1024 }));

  // BetterAuth checks the origin only when a request has a cookie, and a sign-in has none. Another
  // site must not be able to sign a browser in to an attacker's account.
  app.post("/v1/auth/*", async (c, next) => {
    if (c.req.header("origin") !== publicOrigin) {
      return c.json(failure("origin_not_allowed", "This site may not sign in here."), 403);
    }
    // BetterAuth also reads form bodies. A body that is valid both ways could show the limit below
    // one email and show BetterAuth another, which would allow unlimited guesses.
    if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return c.json(failure("unsupported_media_type", "Send JSON."), 415);
    }
    await next();
  });

  // Each sends an email through the owner's mail server, so they share one limit.
  for (const path of ["/v1/auth/request-password-reset", "/v1/auth/send-verification-email"]) {
    app.post(path, async (c, next) => {
      if (!(await reset.attempt(await emailIn(c), c.get("clientIp"))))
        return tooManyAttempts(c, reset);
      await next();
    });
  }

  app.post("/v1/auth/sign-in/email", async (c, next) => {
    const email = await emailIn(c);
    const ip = c.get("clientIp");
    // The account as a short hash, so a log can link attempts without holding anyone's email.
    const account = emailAddressHash(email).slice(0, 16);
    if (!(await login.attempt(email, ip))) {
      audit(logger, "sign_in.limited", { account, ip }, "warn");
      return tooManyAttempts(c, login);
    }
    await next();
    if (c.res.status === 200) await login.clear(email, ip);
    else audit(logger, "sign_in.failed", { account, ip, status: c.res.status }, "warn");
  });

  // An operator changes only their own name here. The email is the login, and the image is unused.
  app.post("/v1/auth/update-user", async (c, next) => {
    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    if (!AccountName.safeParse(body).success) {
      return c.json(failure("invalid_name", "Send a name of 1 to 100 characters."), 400);
    }
    await next();
  });

  // A password change always ends the operator's other sessions, such as one on a lost laptop. The
  // limit is per operator, so a stolen session cannot guess the current password for long.
  app.post("/v1/auth/change-password", async (c, next) => {
    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    if (body?.revokeOtherSessions !== true) {
      return c.json(
        failure(
          "revoke_required",
          "A password change ends the other sessions. Send revokeOtherSessions: true.",
        ),
        400,
      );
    }
    const found = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableRefresh: true },
    });
    if (found !== null) {
      const wait = await rateLimit.hit("change-password", found.user.id, 10, 15 * 60);
      if (wait !== null) return tooManyRequests(c, wait);
    }
    await next();
  });

  app.on(["GET", "POST"], "/v1/auth/*", (c) => auth.handler(c.req.raw));

  const smallBody = bodyLimit({ maxSize: 64 * 1024 });
  app.use(
    "/v1/operator/*",
    (c, next) => (c.req.path.endsWith("/images") ? next() : smallBody(c, next)),
    requireOperator,
  );
  app.use("/v1/operator/push-test", async (c, next) => {
    const wait = await rateLimit.hit("push-test", c.get("operatorId"), 5, 60);
    return wait === null ? next() : tooManyRequests(c, wait);
  });
  app.openapi(meRoute, async (c) => {
    const id = c.get("operatorId");
    return c.json(
      {
        id,
        name: c.get("operatorName"),
        email: c.get("operatorEmail"),
        workspaces: await Promise.all(
          (await operatorWorkspaces(db, id)).map(async ({ access, ...membership }) => {
            const [row] = await withWorkspace(db, membership.workspaceId, (tx) =>
              tx
                .select({ name: workspace.name })
                .from(workspace)
                .where(eq(workspace.id, membership.workspaceId)),
            );
            return { ...membership, ...accessFlags(access), name: row?.name ?? "" };
          }),
        ),
        billing,
        contact,
      },
      200,
    );
  });
}
