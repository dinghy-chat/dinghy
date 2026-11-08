import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { type Auth, confirmUrl, deliverLinks, redeemSignInToken } from "./auth.ts";
import { operator, workspace } from "./db/schema.ts";
import { accessFlags, type Database, operatorWorkspaces, withWorkspace } from "./db/tenant.ts";
import { failure, LINK_INVALID, OPERATOR_ERRORS, safeErrorFields, WRONG_ORIGIN } from "./errors.ts";
import { emailAddressHash } from "./identity.ts";
import { signInMail } from "./letter.ts";
import { createLinkLimit, tooManyAttempts } from "./login-limit.ts";
import type { Mailer } from "./mailer.ts";
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
  /** Sends sign-in links. Without one, an operator asks the server's admin for a link. */
  mailer: Mailer | undefined;
  rateLimit: RateLimit;
  valkey: Redis | null;
  /** True when the cloud plan's billing is on. */
  billing: boolean;
  /** Who a suspended workspace's operators write to, on the cloud. */
  contact: string | null;
}

const LinkRequest = z.strictObject({ email: z.email().max(254) });
const LinkToken = z.strictObject({ token: z.string().min(1).max(200) });

/** BetterAuth's routes that the app uses. Every other one, such as a password route, is not found. */
const AUTH_ROUTES = new Set([
  "GET /v1/auth/get-session",
  "POST /v1/auth/sign-out",
  "POST /v1/auth/update-user",
  // Dinghy's own, in front of BetterAuth's, so it controls who gets a link and how one is used.
  "POST /v1/auth/sign-in/magic-link",
  "POST /v1/auth/magic-link/verify",
]);

export function registerOperatorRoutes(
  app: App,
  { auth, billing, contact, db, logger, mailer, rateLimit, valkey }: OperatorOptions,
) {
  const publicOrigin = new URL(String(auth.options.baseURL)).origin;
  const links = createLinkLimit(valkey, logger);

  /** Sends a link to an operator, and nothing to an email with no account. */
  const sendLink = async (email: string, ip: string) => {
    if (mailer === undefined) return;
    const [known] = await db
      .select({ id: operator.id })
      .from(operator)
      .where(eq(operator.email, email));
    if (known === undefined) return;
    await deliverLinks(
      ({ token }) => {
        const mail = signInMail(confirmUrl(publicOrigin, "sign-in", token));
        return mailer.send(email, mail.subject, mail.body);
      },
      () => auth.api.signInMagicLink({ body: { email }, headers: new Headers() }),
    );
    audit(logger, "sign_in.link_sent", { operatorId: known.id, ip });
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
  app.use("/v1/auth/*", async (c, next) => {
    if (!AUTH_ROUTES.has(`${c.req.method} ${c.req.path}`)) {
      return c.json(failure("not_found", "This route does not exist."), 404);
    }
    await next();
  });

  // A cookie goes with any same-site request, so a sign-in or a change must come from this origin.
  app.post("/v1/auth/*", async (c, next) => {
    if (c.req.header("origin") !== publicOrigin) {
      return c.json(failure("origin_not_allowed", "This site may not sign in here."), 403);
    }
    // BetterAuth also reads form bodies, and the checks here read JSON.
    if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return c.json(failure("unsupported_media_type", "Send JSON."), 415);
    }
    await next();
  });

  // The answer is the same for any email, and it comes before the lookup and the email, so its
  // content and its timing never tell whether an account exists.
  app.post("/v1/auth/sign-in/magic-link", async (c) => {
    if (mailer === undefined) {
      return c.json(
        failure("email_unavailable", "This server cannot send email. Ask its admin for a link."),
        400,
      );
    }
    const parsed = LinkRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(failure("invalid_request", "Send an email."), 400);
    const email = parsed.data.email.toLowerCase();
    const ip = c.get("clientIp");
    if (!(await links.attempt(email, ip))) {
      // The account as a short hash, so a log can link attempts without holding anyone's email.
      audit(
        logger,
        "sign_in.limited",
        { account: emailAddressHash(email).slice(0, 16), ip },
        "warn",
      );
      return tooManyAttempts(c, links);
    }
    sendLink(email, ip).catch((err: unknown) => {
      // The owner needs to see a broken mail server.
      logger.error(safeErrorFields(err), "could not send a sign-in link");
    });
    return c.json({ ok: true as const }, 200);
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

  // The confirm page's button uses the link. Opening the emailed page uses nothing, and a GET of
  // this route is not found, so a mail scanner that fetches links cannot use one up.
  app.post("/v1/auth/magic-link/verify", async (c) => {
    const parsed = LinkToken.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(failure("invalid_request", "Send a token."), 400);
    const ip = c.get("clientIp");
    const cookies = await redeemSignInToken(auth, db, parsed.data.token, c.req.raw.headers);
    if (cookies === null) {
      audit(logger, "sign_in.link_refused", { ip }, "warn");
      return c.json(LINK_INVALID, 400);
    }
    for (const cookie of cookies) c.header("set-cookie", cookie, { append: true });
    const cookie = cookies.map((one) => one.split(";")[0]).join("; ");
    const found = await auth.api.getSession({ headers: new Headers({ cookie }) });
    audit(logger, "sign_in.link_used", { operatorId: found?.user.id, ip });
    return c.json({ ok: true as const }, 200);
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
