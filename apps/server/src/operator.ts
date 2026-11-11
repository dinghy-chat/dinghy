import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { isSoleOwner } from "./account-delete.ts";
import {
  type Actor,
  apiKeyToken,
  authenticateApiKey,
  KEY_INVALID,
  KEY_REQUESTS_PER_MINUTE,
} from "./api-keys.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { type Auth, confirmUrl, deliverLinks, redeemSignInToken } from "./auth.ts";
import { operator, operatorPicture, widgetSettings, workspace } from "./db/schema.ts";
import { accessFlags, type Database, operatorWorkspaces, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  LINK_INVALID,
  OPERATOR_ERRORS,
  OPERATOR_POST_ERRORS,
  safeErrorFields,
  UNAUTHORIZED,
  WRONG_ORIGIN,
} from "./errors.ts";
import { emailAddressHash } from "./identity.ts";
import {
  PUBLIC_IMAGE_MAX_BYTES,
  PUBLIC_IMAGE_TOO_LARGE,
  processPicture,
  refuseImage,
} from "./images.ts";
import { noAccountMail, signInMail } from "./letter.ts";
import { createLinkLimit, tooManyAttempts } from "./login-limit.ts";
import type { Mailer } from "./mailer.ts";
import { WORKSPACE_PREFIX } from "./member.ts";
import type { ImageUrls } from "./public-images.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";

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
              // The operator's picture, the same in every workspace. Null with none.
              pictureUrl: z.string().nullable(),
              workspaces: z.array(
                z.object({
                  workspaceId: z.string(),
                  role: z.string(),
                  name: z.string(),
                  // The workspace's logo, for the workspace menu. Null with no logo.
                  logoUrl: z.string().nullable(),
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
                  // True when the operator is its only owner, so they cannot leave it or delete
                  // their account until they delete it or make someone else an owner.
                  soleOwner: z.boolean(),
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

const pictureAnswer = {
  description: "The picture's new address, or null with none",
  content: {
    "application/json": { schema: z.object({ pictureUrl: z.string().nullable() }) },
  },
};

const setPictureRoute = createRoute({
  method: "put",
  path: "/v1/operator/me/picture",
  security: SESSION,
  summary:
    "Set your picture from a PNG, JPEG or WebP of at most 2 MB, as the raw request body. The server cuts it to a 128-pixel square and stores it as WebP. Visitors see it next to your replies.",
  responses: {
    200: pictureAnswer,
    ...OPERATOR_POST_ERRORS,
    400: errorAnswer("not_an_image: not a PNG, JPEG or WebP. too_many_pixels: over 16 megapixels"),
    413: errorAnswer("too_large: the picture is over 2 MB"),
  },
});

const removePictureRoute = createRoute({
  method: "delete",
  path: "/v1/operator/me/picture",
  security: SESSION,
  summary: "Remove your picture, so your initials show again",
  responses: { 200: pictureAnswer, ...OPERATOR_POST_ERRORS },
});

/** The routes whose body is an image, read as bytes rather than as text. */
const PUBLIC_IMAGE_PATH = /\/(logo|picture)$/;

interface OperatorOptions {
  auth: Auth;
  db: Database;
  imageUrls: ImageUrls;
  logger: Logger;
  /** Sends sign-in links. Without one, an operator asks the server's admin for a link. */
  mailer: Mailer | undefined;
  rateLimit: RateLimit;
  valkey: Redis | null;
  /** True when the cloud plan's billing is on. */
  billing: boolean;
  /** Who a suspended workspace's operators write to, on the cloud. */
  contact: string | null;
  /** True when anyone can sign up here, as on the cloud. */
  signup: boolean;
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
  {
    auth,
    billing,
    contact,
    db,
    imageUrls,
    logger,
    mailer,
    rateLimit,
    signup,
    valkey,
  }: OperatorOptions,
) {
  const publicOrigin = new URL(String(auth.options.baseURL)).origin;
  const links = createLinkLimit(valkey, logger);

  /** Sends a link to an operator. On the cloud, any other email gets a note that points to signup. */
  const sendLink = async (email: string, ip: string) => {
    if (mailer === undefined) return;
    const [known] = await db
      .select({ id: operator.id })
      .from(operator)
      .where(and(eq(operator.email, email), isNull(operator.deletedAt)));
    if (known === undefined) {
      // Only where anyone may sign up, which already mails any address. A self-hosted server mails
      // only its operators, so nobody can make it write to strangers.
      if (!signup) return;
      const mail = noAccountMail(`${publicOrigin}/signup`);
      await mailer.send(email, mail.subject, mail.body);
      audit(logger, "sign_in.no_account", { account: emailAddressHash(email).slice(0, 16), ip });
      return;
    }
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
      actor: Actor;
      operatorId: string;
      operatorName: string;
      operatorEmail: string;
      sessionId: string;
    };
  }>(async (c, next) => {
    // A key in a bearer header, which a browser never sends on its own, so it needs no Origin. It
    // reaches only its own workspace's routes, and the member check limits it to a member's.
    const token = apiKeyToken(c.req.header("authorization"));
    if (token !== null) {
      const actor = await authenticateApiKey(db, token);
      if (actor === null) return c.json(KEY_INVALID, 401);
      const wait = await rateLimit.hit("api-key", actor.apiKeyId, KEY_REQUESTS_PER_MINUTE, 60);
      if (wait !== null) return tooManyRequests(c, wait);
      if (!c.req.path.startsWith(`${WORKSPACE_PREFIX}/`)) return c.json(FORBIDDEN, 403);
      c.set("actor", actor);
      return next();
    }
    // A cookie goes with any same-site request, so a write must come from the server's own origin.
    if (c.req.method !== "GET" && c.req.header("origin") !== publicOrigin) {
      return c.json(WRONG_ORIGIN, 403);
    }
    // The whole body first, so the session and membership checks see the state when the request
    // ends. Otherwise a member could send a body slowly and finish it after their removal. Hono
    // keeps the text for the route. An image streams instead, and its route checks again.
    if (c.req.method !== "GET" && !c.req.path.endsWith("/images")) {
      // A logo or a picture is binary, which reading it as text would garble for its route.
      const body = PUBLIC_IMAGE_PATH.test(c.req.path) ? c.req.arrayBuffer() : c.req.text();
      await body.catch(() => undefined);
    }
    const { response: found, headers } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    // A renewed session sends a new cookie, or an active operator would be signed out in a week.
    for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
    // The delete ends the account's sessions, and this holds even if one were left.
    if (found === null || found.user.deletedAt != null) return c.json(UNAUTHORIZED, 401);
    c.set("actor", { kind: "operator", operatorId: found.user.id, name: found.user.name });
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
  // Dinghy answers it instead of BetterAuth, so the write can refuse an account deleted after the
  // session was read: one statement, which waits for the delete's row lock and checks again.
  app.post("/v1/auth/update-user", async (c) => {
    const parsed = AccountName.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(failure("invalid_name", "Send a name of 1 to 100 characters."), 400);
    }
    const found = await auth.api.getSession({ headers: c.req.raw.headers });
    if (found === null) return c.json(UNAUTHORIZED, 401);
    const [changed] = await db
      .update(operator)
      .set({ name: parsed.data.name })
      .where(and(eq(operator.id, found.user.id), isNull(operator.deletedAt)))
      .returning({ id: operator.id });
    if (changed === undefined) return c.json(UNAUTHORIZED, 401);
    return c.json({ status: true }, 200);
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
  const imageBody = bodyLimit({
    maxSize: PUBLIC_IMAGE_MAX_BYTES,
    onError: (c) => c.json(PUBLIC_IMAGE_TOO_LARGE, 413),
  });
  app.use(
    "/v1/operator/*",
    (c, next) => {
      if (c.req.path.endsWith("/images")) return next();
      return (PUBLIC_IMAGE_PATH.test(c.req.path) ? imageBody : smallBody)(c, next);
    },
    requireOperator,
  );
  app.use("/v1/operator/push-test", async (c, next) => {
    const wait = await rateLimit.hit("push-test", c.get("operatorId"), 5, 60);
    return wait === null ? next() : tooManyRequests(c, wait);
  });
  app.openapi(meRoute, async (c) => {
    const id = c.get("operatorId");
    const [picture] = await db
      .select({ pictureUpdatedAt: operator.pictureUpdatedAt })
      .from(operator)
      .where(eq(operator.id, id));
    return c.json(
      {
        id,
        name: c.get("operatorName"),
        email: c.get("operatorEmail"),
        pictureUrl: imageUrls.picture(id, picture?.pictureUpdatedAt ?? null),
        workspaces: await Promise.all(
          (await operatorWorkspaces(db, id)).map(async ({ access, ...membership }) => {
            const { workspaceId, role } = membership;
            const { row, soleOwner } = await withWorkspace(db, workspaceId, async (tx) => ({
              row: (
                await tx
                  .select({
                    name: workspace.name,
                    publicKey: workspace.publicKey,
                    logoUpdatedAt: widgetSettings.logoUpdatedAt,
                  })
                  .from(workspace)
                  .innerJoin(widgetSettings, eq(widgetSettings.workspaceId, workspace.id))
                  .where(eq(workspace.id, workspaceId))
              )[0],
              soleOwner: await isSoleOwner(tx, workspaceId, role),
            }));
            return {
              ...membership,
              ...accessFlags(access),
              name: row?.name ?? "",
              logoUrl: row === undefined ? null : imageUrls.logo(row.publicKey, row.logoUpdatedAt),
              soleOwner,
            };
          }),
        ),
        billing,
        contact,
      },
      200,
    );
  });

  /**
   * Saves or removes the picture, unless the account was deleted after the session was read. The
   * update locks the operator's row first, as an account's delete does, so the two take turns and
   * a picture never outlives its account.
   */
  const savePicture = async (operatorId: string, data: Buffer | null) => {
    const pictureUpdatedAt = data === null ? null : new Date();
    const changed = await db.transaction(async (tx) => {
      const [found] = await tx
        .update(operator)
        .set({ pictureUpdatedAt })
        .where(and(eq(operator.id, operatorId), isNull(operator.deletedAt)))
        .returning({ id: operator.id });
      if (found === undefined) return false;
      if (data === null) {
        await tx.delete(operatorPicture).where(eq(operatorPicture.operatorId, operatorId));
      } else {
        await tx
          .insert(operatorPicture)
          .values({ operatorId, data })
          .onConflictDoUpdate({ target: operatorPicture.operatorId, set: { data } });
      }
      return true;
    });
    return changed ? { pictureUrl: imageUrls.picture(operatorId, pictureUpdatedAt) } : null;
  };

  app.openapi(setPictureRoute, async (c) => {
    const picture = await processPicture(new Uint8Array(await c.req.arrayBuffer()));
    if (typeof picture === "string") return refuseImage(c, picture);
    const saved = await savePicture(c.get("operatorId"), picture);
    return saved === null ? c.json(UNAUTHORIZED, 401) : c.json(saved, 200);
  });

  app.openapi(removePictureRoute, async (c) => {
    const saved = await savePicture(c.get("operatorId"), null);
    return saved === null ? c.json(UNAUTHORIZED, 401) : c.json(saved, 200);
  });
}
