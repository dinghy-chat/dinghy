import { randomBytes } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";
import { type CloudSettings, createCloud } from "../../../ee/server/index.ts";
import serverPackage from "../package.json" with { type: "json" };
import { registerAccountDelete } from "./account-delete.ts";
import { registerAlertRoutes, registerEmailStop } from "./alert-routes.ts";
import { registerAnalyticsRoute } from "./analytics.ts";
import { type Actor, registerApiKeyRoutes } from "./api-keys.ts";
import { registerSecuritySchemes } from "./api-security.ts";
import type { Auth } from "./auth.ts";
import { registerBulkRoute } from "./bulk.ts";
import { registerBusinessHoursRoutes } from "./business-hours.ts";
import { registerChatPage } from "./chat-link.ts";
import { clientIp } from "./client-ip.ts";
import { registerContactRoutes } from "./contacts.ts";
import {
  AccountDeletedError,
  type Database,
  type Transaction,
  type WorkspaceAccess,
} from "./db/tenant.ts";
import { safeErrorFields, UNAUTHORIZED } from "./errors.ts";
import { type CountryOf, NO_COUNTRIES } from "./geo.ts";
import { registerGetStartedRoutes } from "./get-started.ts";
import { registerHandlingRoutes } from "./handling.ts";
import { createEmailIntake, type InboundEmail, registerInboundEmail } from "./inbound-email.ts";
import { createInbox, registerInboxRoutes } from "./inbox.ts";
import { registerKeyEvents } from "./key-events.ts";
import { registerLabelRoutes } from "./labels.ts";
import { NO_LIMITS } from "./limits.ts";
import { type Live, noLive } from "./live.ts";
import { createLiveVisitors, registerLiveVisitorRoutes } from "./live-visitors.ts";
import type { Mailer } from "./mailer.ts";
import { registerMcp } from "./mcp.ts";
import { registerMemberCheck } from "./member.ts";
import { registerModerationRoutes } from "./moderation.ts";
import { oauthIssuer, registerOAuth, resourceMetadataUrl } from "./oauth.ts";
import { type FetchClientDocument, fetchClientDocument } from "./oauth-client.ts";
import { registerOperatorRoutes } from "./operator.ts";
import { registerOperatorApp } from "./operator-app.ts";
import {
  createPresence,
  createVisitorPresence,
  registerOperatorPresence,
  registerWidgetPresence,
} from "./presence.ts";
import { imageUrls, registerPublicImages } from "./public-images.ts";
import type { Push } from "./push.ts";
import { createRateLimit, createSlots } from "./rate-limit.ts";
import { registerSavedReplyRoutes } from "./saved-replies.ts";
import { createSetup, registerSetupRoutes } from "./setup.ts";
import { DEFAULT_STREAM, type StreamOptions } from "./stream.ts";
import { type Role, registerTeamRoutes } from "./team.ts";
import { createTestVisitors, registerTestVisitorRoutes } from "./test-visitors.ts";
import { MINUTE_MS } from "./time.ts";
import { registerExportRoute } from "./transfer.ts";
import { registerTwoFactorRoutes, type TwoFactorState } from "./two-factor.ts";
import { registerRemovalRoutes } from "./two-factor-removal.ts";
import { registerUploadFiles, type Uploads } from "./uploads.ts";
import {
  createWebhooks,
  PUBLIC_ONLY,
  registerWebhookRoutes,
  type WebhookPolicy,
} from "./webhooks.ts";
import { registerWidgetRoutes, type WidgetToken } from "./widget.ts";
import { registerWidgetFiles } from "./widget-files.ts";
import {
  createAppearance,
  registerWidgetAppearance,
  registerWidgetSettingsRoutes,
} from "./widget-settings.ts";
import { lastWorkerPass } from "./worker.ts";
import { registerWorkspaceDelete } from "./workspace-delete.ts";
import type { WidgetWorkspace } from "./workspaces.ts";

const { version } = serverPackage;

interface Checks {
  postgres(): Promise<void>;
  valkey(): Promise<void>;
}

export interface AppOptions {
  auth?: Auth | undefined;
  /** Dinghy Cloud's settings, read by `ee/`. A self-hosted install leaves them unset. */
  cloud?: CloudSettings | undefined;
  /** Sends sign-in links and the cloud's emails. Without it, the server's admin hands out links. */
  mailer?: Mailer | undefined;
  alerts?: { push?: Push | undefined; emailAvailable: boolean; secret: string };
  checks: Checks;
  db: Database;
  live?: Live;
  logger: Logger;
  metricsToken?: string | undefined;
  uploads?: Uploads | undefined;
  /** Visitors' replies by email. Without it, the route is off. */
  inboundEmail?: InboundEmail | undefined;
  stream?: StreamOptions;
  valkey?: Redis | null;
  /** How many proxies in front of the server may add to X-Forwarded-For. */
  trustedProxyHops?: number;
  /** Keys the hash of a blocked address. Without one, a block lasts only until a restart. */
  ipSecret?: string;
  /** Multiplies every rate limit. Browser tests send far more than one person can. */
  limitScale?: number;
  /** How long an operator stays online with no heartbeat. Tests set a short one. */
  presenceTtlMs?: number;
  /** The directory with the operator app. Without it, the app's pages get a 404. */
  operatorDirectory?: string | undefined;
  /** The directory with the widget's bundles. Without it, /widget/* gets a 404. */
  widgetDirectory?: string | undefined;
  /** The server's public URL. Without it, the reply email's chat page is off. */
  publicUrl?: string | undefined;
  /** Whether webhooks may go over http and to private addresses. Off by default. */
  webhooks?: WebhookPolicy;
  /** The country of an address, for the live view. Without it, every country is unknown. */
  countryOf?: CountryOf;
  /** Fetches an OAuth client's metadata document. Tests replace it, because it needs the internet. */
  fetchClientDocument?: FetchClientDocument;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    workspace: WidgetWorkspace;
    /** The widget request's bearer token, which the widget's access check reads once. */
    widgetToken: WidgetToken;
    /** Who makes an operator API request: a signed-in operator, or a workspace API key. */
    actor: Actor;
    /** The rest are set only for a signed-in operator, never for an API key. */
    operatorId: string;
    operatorName: string;
    operatorEmail: string;
    /** The operator set Away, so their beats do not count them online. */
    operatorAway: boolean;
    /** The signed-in operator's session, which a stream checks again on each wake. */
    sessionId: string;
    /** Whether this session passed two-step sign-in, or needs it. */
    twoFactor: TwoFactorState;
    memberWorkspaceId: string;
    memberRole: Role;
    /** The workspace's access, for a route open while closed that refuses some writes itself. */
    memberAccess: WorkspaceAccess;
    clientIp: string;
  };
}

export type App = OpenAPIHono<AppEnv>;

const metaRoute = createRoute({
  method: "get",
  path: "/v1/meta",
  summary: "Get the server's name and version",
  responses: {
    200: {
      description: "The server's name and version",
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string(),
              version: z.string(),
              billing: z.boolean(),
              // How cloud signup works on this server, or null where nobody can sign up.
              signup: z.enum(["payment", "early"]).nullable(),
              // Whether sign-in links go by email. Without, the server's admin hands them out.
              email: z.boolean(),
            })
            .openapi("Meta"),
        },
      },
    },
  },
});

async function settled(check: () => Promise<void>): Promise<"ok" | "failed"> {
  try {
    await check();
    return "ok";
  } catch {
    return "failed";
  }
}

/** A worker records a pass every 30 seconds at most, and one pass rarely takes a minute. */
const WORKER_STALE_MS = 5 * MINUTE_MS;

/** Whether the worker's passes still finish: `none` until a worker first runs. */
async function workerState(db: Database): Promise<"ok" | "stale" | "none" | "unknown"> {
  try {
    const at = await lastWorkerPass(db);
    if (at === null) return "none";
    return Date.now() - at.getTime() <= WORKER_STALE_MS ? "ok" : "stale";
  } catch {
    return "unknown";
  }
}

/** pg's pool says this when no connection frees up within `connectionTimeoutMillis`. */
const POOL_TIMEOUT = "timeout exceeded when trying to connect";

/**
 * A lock timeout (Postgres's 55P03) or a full pool. Drizzle wraps either one in `cause`.
 * Both are a moment's load, and a retry is safe.
 */
function isBusy(error: unknown): boolean {
  let current = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && current.code === "55P03") return true;
    if (current instanceof Error && current.message === POOL_TIMEOUT) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export function createApp({
  alerts,
  auth,
  checks,
  cloud: cloudSettings,
  mailer,
  db,
  uploads,
  inboundEmail,
  live = noLive,
  logger,
  metricsToken,
  valkey = null,
  presenceTtlMs,
  trustedProxyHops = 0,
  ipSecret = randomBytes(32).toString("hex"),
  limitScale = 1,
  operatorDirectory,
  stream = DEFAULT_STREAM,
  widgetDirectory,
  publicUrl,
  webhooks = PUBLIC_ONLY,
  countryOf = NO_COUNTRIES,
  fetchClientDocument: fetchDocument = fetchClientDocument,
}: AppOptions): App {
  const app: App = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (result.success) return;
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "The request is not valid.",
            requestId: c.get("requestId"),
          },
        },
        400,
      );
    },
  });

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requests = new Counter({
    name: "dinghy_http_requests_total",
    help: "HTTP requests by method, route and status.",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "dinghy_http_request_duration_seconds",
    help: "HTTP request duration by method and route.",
    labelNames: ["method", "route"],
    registers: [registry],
  });

  new Gauge({
    name: "dinghy_worker_last_pass_timestamp_seconds",
    help: "When a worker last finished a pass, over every worker instance.",
    registers: [registry],
    async collect() {
      const at = await lastWorkerPass(db).catch(() => null);
      if (at !== null) this.set(at.getTime() / 1000);
    },
  });

  app.use(requestId());
  // HSTS keeps a browser on HTTPS after its first visit, so a hostile network cannot hold it on
  // HTTP. Operator answers hold the signing secret and invite tokens, so no cache may keep them.
  const https = auth !== undefined && String(auth.options.baseURL).startsWith("https:");
  app.use(async (c, next) => {
    await next();
    if (https) c.header("strict-transport-security", "max-age=31536000");
    if (c.req.path.startsWith("/v1/operator/") || c.req.path.startsWith("/v1/auth/")) {
      c.header("cache-control", "no-store");
    }
  });
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    const seconds = (performance.now() - started) / 1000;
    // The route pattern, not the path, so an ID or a scanner cannot create new label values.
    const route = c.req.routePath;
    requests.inc({ method: c.req.method, route, status: c.res.status });
    duration.observe({ method: c.req.method, route }, seconds);
    // Docker's health check alone would write a line every 5 seconds. A failing probe still logs.
    if ((route === "/healthz" || route === "/readyz") && c.res.status < 400) return;
    // Logs never hold a query string or a body, because they can hold tokens and chat text.
    logger.info(
      {
        requestId: c.get("requestId"),
        method: c.req.method,
        route,
        status: c.res.status,
        ms: Math.round(seconds * 1000),
      },
      "request",
    );
  });

  // First, so a separate image origin serves uploads and nothing else.
  if (uploads !== undefined) registerUploadFiles(app, db, uploads, logger);
  // Before the widget routes, whose access check would refuse an <img>'s request.
  registerPublicImages(app, db, uploads?.origin);
  // Logos and pictures come from the image origin, like every user image, or from this server's own.
  const urls = imageUrls(
    uploads?.origin ?? publicUrl ?? (auth === undefined ? "" : String(auth.options.baseURL)),
  );

  // Liveness: the process answers. A restart cannot fix a database outage, so it checks nothing.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Readiness: this instance can serve traffic. Only Postgres decides it. Without Valkey, chat
  // still works: limits fail open and streams read from Postgres. The body still says which one
  // failed, and whether the worker's passes still finish, which no instance of the web role can fix.
  app.get("/readyz", async (c) => {
    const [postgres, valkey, worker] = await Promise.all([
      settled(checks.postgres),
      settled(checks.valkey),
      workerState(db),
    ]);
    const ready = postgres === "ok";
    return c.json({ status: ready ? "ok" : "failed", postgres, valkey, worker }, ready ? 200 : 503);
  });

  if (metricsToken !== undefined) {
    app.get("/metrics", bearerAuth({ token: metricsToken }), async (c) =>
      c.text(await registry.metrics(), 200, { "content-type": registry.contentType }),
    );
  }

  const rateLimit = createRateLimit(valkey, logger, limitScale);
  // Only Dinghy Cloud sets these settings, and core works the same without them.
  const cloud =
    auth === undefined
      ? undefined
      : createCloud(cloudSettings, {
          auth,
          db,
          live,
          logger,
          mailer,
          rateLimit,
          store: uploads?.store,
          valkey,
        });
  app.openapi(metaRoute, (c) =>
    c.json({
      name: "dinghy",
      version,
      billing: cloud?.billing ?? false,
      signup: cloud?.signup ?? null,
      email: auth !== undefined && mailer !== undefined,
    }),
  );
  // The plan's limits on Dinghy Cloud. A self-hosted install has none.
  const limits = cloud?.limits ?? NO_LIMITS;
  app.use("*", async (c, next) => {
    c.set("clientIp", clientIp(c, trustedProxyHops));
    await next();
  });
  const visitorPresence = createVisitorPresence(valkey, logger, presenceTtlMs);
  const liveVisitors = createLiveVisitors(valkey, logger);
  const ownOrigin = publicUrl === undefined ? undefined : new URL(publicUrl).origin;
  const setup = createSetup({ db, logger, valkey, liveVisitors });
  // Before the widget routes, because any site may read it.
  registerWidgetAppearance(app, db, urls, rateLimit);
  registerWidgetRoutes(app, {
    db,
    uploads,
    imageUrls: urls,
    ipSecret,
    limits,
    live,
    logger,
    rateLimit,
    slots: createSlots(valkey, logger, limitScale),
    stream,
    visitorPresence,
    liveVisitors,
    countryOf,
    ownOrigin,
    sites: setup,
  });
  const presence = createPresence(valkey, logger, presenceTtlMs);
  registerWidgetPresence(app, db, presence, alerts?.emailAvailable ?? false);
  if (ownOrigin !== undefined) {
    registerChatPage(app, { db, rateLimit, uploadsOrigin: uploads?.origin });
  }
  if (inboundEmail !== undefined) {
    const { domain } = inboundEmail;
    const intake = createEmailIntake({ db, domain, uploads, limits, live, rateLimit });
    registerInboundEmail(app, intake, inboundEmail.secret);
  }
  if (auth !== undefined) {
    registerOperatorRoutes(app, {
      auth,
      billing: cloud?.billing ?? false,
      contact: cloud?.contact ?? null,
      db,
      imageUrls: urls,
      logger,
      mailer,
      rateLimit,
      signup: cloud !== undefined,
      valkey,
    });
    registerTwoFactorRoutes(app, {
      db,
      live,
      logger,
      // AUTH_SECRET itself. A fallback to a random secret would change the keys at each restart.
      authSecret: auth.options.secret,
      valkey,
      mailer,
    });
    // Right after the session check, so every workspace route runs behind it, whatever its order.
    registerMemberCheck(app, db);
    registerAccountDelete(app, {
      beforeDelete: cloud?.beforeDelete,
      db,
      keepsLastWorkspace: cloud === undefined,
      live,
      logger,
      mailer,
      publicUrl: String(auth.options.baseURL),
      rateLimit,
    });
    // After the account delete, whose limits on /v1/account/ the cancel link's route uses.
    registerRemovalRoutes(app, {
      db,
      live,
      logger,
      mailer,
      publicUrl: String(auth.options.baseURL),
      authSecret: auth.options.secret,
    });
    // The founder's picture as the picture route serves it, for a new workspace's welcome chat.
    const welcomeFace = cloud?.welcomeFace;
    const founderPicture =
      welcomeFace &&
      (async (tx: Transaction) => {
        const face = await welcomeFace(tx);
        return face === null ? null : urls.picture(face.operatorId, face.pictureUpdatedAt);
      });
    registerInboxRoutes(app, {
      copyReply: cloud?.copyReply,
      founderPicture,
      db,
      uploads,
      imageUrls: urls,
      limits,
      live,
      logger,
      stream,
      visitorPresence,
    });
    registerApiKeyRoutes(app, db, logger);
    // On https or a loopback address only, because OAuth 2.1 allows no other http issuer.
    const issuer = oauthIssuer(String(auth.options.baseURL));
    if (issuer !== null) {
      registerOAuth(app, {
        db,
        logger,
        rateLimit,
        valkey,
        secret: auth.options.secret ?? ipSecret,
        issuer,
        fetchDocument,
      });
    }
    const webhookManager = createWebhooks({ db, logger, policy: webhooks });
    registerWebhookRoutes(app, { webhooks: webhookManager });
    registerHandlingRoutes(app, { db, uploads, live });
    const serverUrl = new URL(String(auth.options.baseURL)).origin;
    registerSetupRoutes(app, setup, serverUrl);
    const testVisitors = createTestVisitors({ db, live, rateLimit });
    registerTestVisitorRoutes(app, testVisitors);
    const inbox = createInbox({
      copyReply: cloud?.copyReply,
      founderPicture,
      db,
      uploads,
      live,
      visitorPresence,
    });
    registerMcp(app, {
      db,
      webhooks: webhookManager,
      live,
      rateLimit,
      inbox,
      publicOrigin: serverUrl,
      version,
      setup: {
        setup,
        appearance: createAppearance(db, urls),
        webhooks: webhookManager,
        testVisitors,
        serverUrl,
      },
      chat: { db, uploads, inbox, limits, live, liveVisitors, presence, visitorPresence },
      resourceMetadata: issuer === null ? null : resourceMetadataUrl(issuer),
    });
    registerKeyEvents(app, {
      db,
      uploads,
      limits,
      live,
      logger,
      rateLimit,
      stream,
      publicOrigin: serverUrl,
    });
    registerAnalyticsRoute(app, db);
    registerOperatorPresence(app, db, presence);
    registerModerationRoutes(app, db, live);
    registerContactRoutes(app, { db, live, visitorPresence });
    registerLiveVisitorRoutes(app, db, liveVisitors);
    registerGetStartedRoutes(app, db);
    registerSavedReplyRoutes(app, db, live);
    registerLabelRoutes(app, db, live);
    registerBulkRoute(app, db, live);
    if (uploads !== undefined) registerExportRoute(app, db, uploads.store, rateLimit);
    registerTeamRoutes(app, {
      auth,
      db,
      limits,
      live,
      logger,
      imageUrls: urls,
      mailer,
      rateLimit,
      keepsLastWorkspace: cloud === undefined,
    });
    registerWidgetSettingsRoutes(app, db, urls, live);
    registerBusinessHoursRoutes(app, db, live);
    if (alerts !== undefined) {
      registerAlertRoutes(app, {
        db,
        logger,
        push: alerts.push,
        emailAvailable: alerts.emailAvailable,
      });
      registerEmailStop(app, db, alerts.secret, rateLimit);
    }
    registerWorkspaceDelete(app, {
      db,
      beforeDelete: cloud?.beforeDelete,
      now: cloud?.now,
      keepsLastWorkspace: cloud === undefined,
      live,
      logger,
      rateLimit,
    });
    cloud?.registerRoutes(app);
  }
  if (operatorDirectory !== undefined)
    registerOperatorApp(app, operatorDirectory, {
      billing: cloud?.billing ?? false,
      signup: cloud !== undefined,
      uploadsOrigin: uploads?.origin,
    });
  if (widgetDirectory !== undefined) registerWidgetFiles(app, widgetDirectory);

  registerSecuritySchemes(app.openAPIRegistry);
  app.doc31("/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Dinghy API",
      version,
      description:
        "The widget API (`/v1/widget/{key}`, with the visitor's bearer token) and the operator API (`/v1/operator`, with the session cookie, or a workspace API key on the routes whose security lists `apiKey`). MCP lives at `/v1/mcp`, with an API key. Every error answer is `{ error: { code, message } }`, and clients branch on `code`. Sign-in lives at `/v1/auth`, a BetterAuth pass-through that is not part of the versioned API.",
    },
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: "This route does not exist.",
          requestId: c.get("requestId"),
        },
      },
      404,
    ),
  );

  app.onError((error, c) => {
    // A middleware that refuses a request, such as bearerAuth, sets its own status.
    if (error instanceof HTTPException) {
      // Answer through the context, because a new Response would drop the CORS headers.
      const response = error.getResponse();
      // A malformed body has no response of its own. bearerAuth's keeps its WWW-Authenticate.
      const refusal =
        error.status === 413
          ? { code: "too_large", message: "The request is too large." }
          : error.status === 400 && error.res === undefined
            ? { code: "invalid_request", message: "The request is not valid." }
            : undefined;
      if (refusal === undefined) return c.newResponse(response.body, response);
      return c.json({ error: { ...refusal, requestId: c.get("requestId") } }, error.status);
    }
    if (error instanceof AccountDeletedError) return c.json(UNAUTHORIZED, 401);
    // One stuck workspace row or a full pool: the client-generated ID makes the retry safe.
    if (isBusy(error)) {
      c.header("retry-after", "1");
      return c.json(
        {
          error: {
            code: "busy",
            message: "This workspace is busy. Try again.",
            requestId: c.get("requestId"),
          },
        },
        503,
      );
    }
    logger.error({ ...safeErrorFields(error), requestId: c.get("requestId") }, "unhandled error");
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Something went wrong.",
          requestId: c.get("requestId"),
        },
      },
      500,
    );
  });

  return app;
}

/** The OpenAPI document. It needs no running service, so a script and a test can build it. */
export async function openApiDocument(): Promise<unknown> {
  const unused = async () => {};
  const { pino } = await import("pino");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { default: pg } = await import("pg");
  const { createAuth } = await import("./auth.ts");
  const schema = await import("./db/schema.ts");
  // The pool connects on first use, and building the document runs no query.
  const db = drizzle(new pg.Pool(), { schema });
  const { createUploads } = await import("./uploads.ts");
  const app = createApp({
    alerts: { emailAvailable: false, secret: "unused-while-building-the-document" },
    uploads: createUploads({
      store: { put: unused, get: async () => null, delete: unused },
      secret: "unused-while-building-the-document",
      publicUrl: "http://localhost",
    }),
    auth: createAuth({
      db,
      secret: "unused-while-building-the-document",
      baseURL: "http://localhost",
    }),
    checks: { postgres: unused, valkey: unused },
    db,
    inboundEmail: { domain: "reply.example.com", secret: "unused-while-building-the-document" },
    logger: pino({ level: "silent" }),
  });
  const response = await app.request("/v1/openapi.json");
  return response.json();
}
