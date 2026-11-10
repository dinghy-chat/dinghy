import { setTimeout as delay } from "node:timers/promises";
import { type ServerType, serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "iovalkey";
import pg from "pg";
import { pino } from "pino";
import { cloudFromConfig } from "../../../ee/server/index.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { loadConfig, pushKeysFromConfig } from "./config.ts";
import * as schema from "./db/schema.ts";
import { createImages } from "./images.ts";
import { createLive, createSignals } from "./live.ts";
import { createMailer } from "./mailer.ts";
import { createPush } from "./push.ts";
import { storeFromConfig } from "./storage.ts";
import { startWorker } from "./worker.ts";

const ROLES = ["web", "worker", "all"] as const;
type Role = (typeof ROLES)[number];

// A stop must finish before Docker's 10-second kill.
const STOP_TIMEOUT_MS = 8000;
const CHECK_TIMEOUT_MS = 2000;

function isRole(value: string | undefined): value is Role {
  return ROLES.some((role) => role === value);
}

function withTimeout(work: Promise<unknown>): Promise<void> {
  return Promise.race([
    work.then(() => undefined),
    delay(CHECK_TIMEOUT_MS, undefined, { ref: false }).then(() => {
      throw new Error("check timed out");
    }),
  ]);
}

const role = process.argv[2];
if (!isRole(role)) {
  console.error(`Usage: main.ts <${ROLES.join("|")}>`);
  process.exit(2);
}

const config = loadConfig(process.env);
const logger = pino({ level: config.LOG_LEVEL });
const stops: (() => Promise<unknown>)[] = [];
const pushKeys = pushKeysFromConfig(config);
// Unset on a self-hosted install, which then never turns on the code in ee/.
const cloud = cloudFromConfig(config);
const push = pushKeys === undefined ? undefined : createPush(pushKeys);
const webhooks = { allowPrivate: config.WEBHOOK_ALLOW_PRIVATE };
const imagesFor = () =>
  createImages({
    store: storeFromConfig(config),
    secret: config.AUTH_SECRET,
    publicUrl: config.PUBLIC_URL,
    origin: config.IMAGES_ORIGIN,
  });
const smtp =
  config.SMTP_URL !== undefined && config.MAIL_FROM !== undefined
    ? { url: config.SMTP_URL, from: config.MAIL_FROM }
    : undefined;

if (role === "web" || role === "all") {
  const mailer = smtp === undefined ? undefined : createMailer(smtp.url, smtp.from);
  // A request waits at most 5 s for a connection, then gets 503 busy, so one workspace whose sends
  // queue on its row lock cannot stall every other tenant's requests without end.
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  // Stop a Valkey outage from queueing commands, because a send must still succeed without it.
  const valkey = new Redis(config.VALKEY_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // A Valkey that accepts a connection and stops answering must not hold up a request.
    commandTimeout: 2000,
  });
  pool.on("error", (err) => logger.error({ err }, "postgres pool error"));
  valkey.on("error", (err) => logger.error({ err }, "valkey error"));

  const live = createLive(valkey, config.VALKEY_URL, logger);
  const db = drizzle(pool, { schema });
  const app = createApp({
    trustedProxyHops: config.TRUSTED_PROXY_HOPS,
    limitScale: config.RATE_LIMIT_SCALE,
    ipSecret: config.AUTH_SECRET,
    alerts: { push, emailAvailable: mailer !== undefined, secret: config.AUTH_SECRET },
    cloud,
    mailer,
    auth: createAuth({ db, secret: config.AUTH_SECRET, baseURL: config.PUBLIC_URL }),
    db,
    images: imagesFor(),
    webhooks,
    live,
    valkey,
    logger,
    metricsToken: config.METRICS_TOKEN,
    widgetDirectory: config.WIDGET_DIR,
    operatorDirectory: config.OPERATOR_DIR,
    publicUrl: config.PUBLIC_URL,
    checks: {
      postgres: () => withTimeout(pool.query("select 1")),
      valkey: () => withTimeout(valkey.ping()),
    },
  });
  const server: ServerType = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port, role }, "listening");
  });
  stops.push(
    // Streams first, because the server waits for open connections before it closes.
    async () => live.stop(),
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        // A client that stopped reading would hold its connection open past Docker's kill.
        const drop = setTimeout(() => {
          if ("closeAllConnections" in server) server.closeAllConnections();
        }, 2000);
        drop.unref();
      }),
    () => pool.end(),
    async () => valkey.disconnect(),
  );
}

if (role === "worker" || role === "all") {
  if (config.WORKER_DATABASE_URL === undefined) {
    logger.error("WORKER_DATABASE_URL is required for the worker");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: config.WORKER_DATABASE_URL, max: 5 });
  pool.on("error", (err) => logger.error({ err }, "postgres pool error"));
  const workerDb = drizzle(pool, { schema });
  // Only publishes, to wake open inboxes after a billing change. A lost signal loses no data.
  const publisher = new Redis(config.VALKEY_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
  });
  publisher.on("error", (err) => logger.error({ err }, "valkey error"));
  const worker = startWorker({
    db: workerDb,
    cloud,
    signals: createSignals(publisher, logger),
    logger,
    push,
    // Its own connections, so the web side's emails never queue in front of an alert, whose time
    // starts when it gets a connection.
    mailer: smtp === undefined ? undefined : createMailer(smtp.url, smtp.from),
    publicUrl: config.PUBLIC_URL,
    secret: config.AUTH_SECRET,
    store: storeFromConfig(config),
    images: imagesFor(),
    webhooks,
  });
  stops.push(
    () => worker.stop(),
    () => pool.end(),
    async () => publisher.disconnect(),
  );
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "stopping");
  const forced = setTimeout(() => {
    logger.error("stop timed out");
    process.exit(1);
  }, STOP_TIMEOUT_MS);
  for (const stopOne of stops) {
    await stopOne().catch((err: unknown) => logger.error({ err }, "stop failed"));
  }
  clearTimeout(forced);
  logger.info("stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
