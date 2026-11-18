import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { signedSessionCookie } from "./auth.ts";
import { operator, session, workspace } from "./db/schema.ts";
import { type Database, lockAccount, operatorWorkspaces, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  jsonAnswer,
  jsonBody,
  OPERATOR_WRITE_ERRORS,
  RATE_LIMITED,
  TWO_FACTOR_REQUIRED,
  UNAUTHORIZED,
  WRONG_ORIGIN_TEXT,
} from "./errors.ts";
import { sha256Hex } from "./identity.ts";
import type { RateLimit } from "./rate-limit.ts";
import { tooManyRequests } from "./rate-limit.ts";
import { MINUTE_MS } from "./time.ts";
import { twoFactorStateOf } from "./two-factor.ts";

const NATIVE_REDIRECT_URI = "dinghy://auth/callback";
const NATIVE_CODE_MINUTES = 5;
const NATIVE_EXCHANGES_PER_MINUTE = 20;
const CODE_PREFIX = "native-sign-in:";
const Base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const AuthorizeRequest = z.strictObject({
  codeChallenge: Base64Url32,
  codeChallengeMethod: z.literal("S256"),
  redirectUri: z.literal(NATIVE_REDIRECT_URI),
  state: Base64Url32,
});

const ExchangeRequest = z.strictObject({
  code: Base64Url32,
  codeVerifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/),
});

const StoredCode = z.strictObject({
  challenge: Base64Url32,
  operatorId: z.uuid(),
  sessionId: z.uuid(),
});

const authorizeRoute = createRoute({
  method: "post",
  path: "/v1/auth/native/authorize",
  security: SESSION,
  summary: "Confirm a signed-in browser may sign in the Dinghy native operator app",
  request: { body: jsonBody(AuthorizeRequest) },
  responses: {
    200: jsonAnswer(
      "The fixed Dinghy app callback with a five-minute one-time code and the request state",
      z.object({ redirectTo: z.string() }),
    ),
    ...OPERATOR_WRITE_ERRORS,
  },
});

const exchangeRoute = createRoute({
  method: "post",
  path: "/v1/auth/native/exchange",
  summary: "Exchange a native app sign-in code and proof verifier for an operator session",
  request: { body: jsonBody(ExchangeRequest) },
  responses: {
    200: jsonAnswer(
      "A normal operator session Cookie pair for this server, with its initial workspace",
      z.object({
        origin: z.string(),
        session: z.string(),
        operator: z.object({ id: z.uuid(), name: z.string() }),
        workspace: z.object({ id: z.uuid(), name: z.string() }),
      }),
    ),
    400: errorAnswer(
      "invalid_request: the code or verifier has the wrong shape. link_invalid: the code expired, was used, or does not match the verifier",
    ),
    402: errorAnswer(
      "payment_required: every workspace waits for its first payment, so none can open",
    ),
    403: errorAnswer(WRONG_ORIGIN_TEXT),
    409: errorAnswer("not_a_member: the operator is not in a workspace on this server"),
    ...RATE_LIMITED,
    413: errorAnswer("too_large: the body is over 8 KB"),
  },
});

interface NativeAuthOptions {
  auth: Auth;
  db: Database;
  logger: Logger;
  rateLimit: RateLimit;
}

const invalidCode = () =>
  failure(
    "link_invalid",
    "This app sign-in request expired or was already used. Start again from the app.",
  );

const jsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const matchesChallenge = (verifier: string, expected: string) => {
  const actual = Buffer.from(challengeOf(verifier));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

/**
 * Adds the browser confirmation and proof-key exchange routes for the native operator app. The
 * normal auth middleware still checks the server Origin and JSON content type for both writes.
 */
export function registerNativeAuthRoutes(
  app: App,
  { auth, db, logger, rateLimit }: NativeAuthOptions,
): void {
  const publicOrigin = new URL(String(auth.options.baseURL)).origin;

  app.openapi(authorizeRoute, async (c) => {
    const request = c.req.valid("json");
    const found = await auth.api.getSession({ headers: c.req.raw.headers });
    if (found === null || found.user.deletedAt != null) return c.json(UNAUTHORIZED, 401);
    if (twoFactorStateOf(found.user.twoFactorOn, found.session.twoFactorAt) === "required") {
      return c.json(TWO_FACTOR_REQUIRED, 401);
    }

    const code = randomBytes(32).toString("base64url");
    const { internalAdapter } = await auth.$context;
    await internalAdapter.createVerificationValue({
      identifier: `${CODE_PREFIX}${sha256Hex(code)}`,
      value: JSON.stringify({
        challenge: request.codeChallenge,
        operatorId: found.user.id,
        sessionId: found.session.id,
      }),
      expiresAt: new Date(Date.now() + NATIVE_CODE_MINUTES * MINUTE_MS),
    });
    const redirect = new URL(NATIVE_REDIRECT_URI);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", request.state);
    audit(logger, "native_sign_in.authorized", {
      operatorId: found.user.id,
      ip: c.get("clientIp"),
    });
    return c.json({ redirectTo: redirect.href }, 200);
  });

  app.openapi(exchangeRoute, async (c) => {
    const wait = await rateLimit.hit(
      "native-sign-in-exchange",
      c.get("clientIp"),
      NATIVE_EXCHANGES_PER_MINUTE,
      60,
    );
    if (wait !== null) return tooManyRequests(c, wait);

    const request = c.req.valid("json");
    const { internalAdapter } = await auth.$context;
    const record = await internalAdapter.consumeVerificationValue(
      `${CODE_PREFIX}${sha256Hex(request.code)}`,
    );
    const stored = StoredCode.safeParse(record === null ? null : jsonValue(record.value));
    if (!stored.success || !matchesChallenge(request.codeVerifier, stored.data.challenge)) {
      audit(logger, "native_sign_in.refused", { ip: c.get("clientIp") }, "warn");
      return c.json(invalidCode(), 400);
    }

    const memberships = await operatorWorkspaces(db, stored.data.operatorId);
    if (memberships.length === 0) {
      return c.json(
        failure("not_a_member", "This account is not in a workspace on this server."),
        409,
      );
    }
    // Match the web app: a workspace that waits for its first payment does not open while another
    // workspace can. Read-only, suspended and early-cloud workspaces still open for their notices.
    const membership = memberships.find(({ access }) => access !== "waiting_payment");
    if (membership === undefined) {
      return c.json(
        failure(
          "payment_required",
          "No workspace is available in the mobile app until its first payment is complete.",
        ),
        402,
      );
    }
    const workspaceName = await withWorkspace(db, membership.workspaceId, async (tx) => {
      const [found] = await tx
        .select({ name: workspace.name })
        .from(workspace)
        .where(eq(workspace.id, membership.workspaceId));
      return found?.name;
    });
    if (workspaceName === undefined) return c.json(invalidCode(), 400);

    const context = await auth.$context;
    const token = randomBytes(32).toString("base64url");
    const source = await db.transaction(async (tx) => {
      // Account changes and two-step resets take this lock first. Sign-out takes the session lock
      // below. A revocation that wins either race prevents this transaction from making a session.
      const account = await lockAccount(tx, stored.data.operatorId);
      if (account === undefined) return null;
      const [sourceSession] = await tx
        .select({ twoFactorAt: session.twoFactorAt })
        .from(session)
        .where(
          and(
            eq(session.id, stored.data.sessionId),
            eq(session.userId, stored.data.operatorId),
            gt(session.expiresAt, new Date()),
          ),
        )
        .for("update");
      const [sourceOperator] = await tx
        .select({ twoFactorOn: operator.twoFactorOn })
        .from(operator)
        .where(and(eq(operator.id, stored.data.operatorId), isNull(operator.deletedAt)));
      if (
        sourceSession === undefined ||
        sourceOperator === undefined ||
        twoFactorStateOf(sourceOperator.twoFactorOn, sourceSession.twoFactorAt) === "required"
      ) {
        return null;
      }
      await tx.insert(session).values({
        userId: stored.data.operatorId,
        token,
        expiresAt: new Date(Date.now() + context.sessionConfig.expiresIn * 1000),
        ipAddress: c.get("clientIp"),
        userAgent: c.req.header("user-agent") ?? "",
        twoFactorAt: sourceSession.twoFactorAt,
      });
      return { operatorId: stored.data.operatorId, operatorName: account.name };
    });
    if (source === null) return c.json(invalidCode(), 400);

    const cookie = await signedSessionCookie(auth, token);
    audit(logger, "native_sign_in.used", {
      operatorId: source.operatorId,
      workspaceId: membership.workspaceId,
      ip: c.get("clientIp"),
    });
    return c.json(
      {
        origin: publicOrigin,
        session: cookie,
        operator: { id: source.operatorId, name: source.operatorName },
        workspace: { id: membership.workspaceId, name: workspaceName },
      },
      200,
    );
  });
}
