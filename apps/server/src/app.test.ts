import { readdirSync, readFileSync } from "node:fs";
import { createRoute, z } from "@hono/zod-openapi";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createTestDatabase } from "../test/database.ts";
import { DATABASE_URL } from "../test/env.ts";
import { type AppOptions, createApp, openApiDocument } from "./app.ts";
import * as schema from "./db/schema.ts";
import { workerHeartbeat } from "./db/schema.ts";
import { ERROR_CODES } from "./errors.ts";
import { startWorker } from "./worker.ts";

const logger = pino({ level: "silent" });
const ok = async () => {};
const down = async () => {
  throw new Error("down");
};
const app = (options: Partial<AppOptions> = {}) =>
  createApp({
    logger,
    db: drizzle(new pg.Pool()),
    checks: { postgres: ok, valkey: ok },
    ...options,
  });

describe("health", () => {
  test("the liveness route needs no service", async () => {
    const response = await app({ checks: { postgres: down, valkey: down } }).request("/healthz");
    expect(response.status).toBe(200);
  });

  test("the readiness route passes when both services answer", async () => {
    const response = await app().request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", postgres: "ok", valkey: "ok" });
  });

  test("the readiness route fails when Postgres is really unreachable", async () => {
    // Nothing listens on port 1.
    const pool = new pg.Pool({ connectionString: "postgres://x@127.0.0.1:1/x" });
    const postgres = async () => {
      await pool.query("select 1");
    };
    const response = await app({ checks: { postgres, valkey: ok } }).request("/readyz");
    await pool.end();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "failed",
      postgres: "failed",
      valkey: "ok",
    });
  });

  test("the readiness route passes when only Valkey is down, and says so", async () => {
    // Chat works without Valkey, so a proxy must keep sending traffic to this instance.
    const response = await app({ checks: { postgres: ok, valkey: down } }).request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", postgres: "ok", valkey: "failed" });
  });

  test("the readiness route and the metrics show whether the worker's passes still finish", async () => {
    const database = await createTestDatabase();
    try {
      await database.migrate();
      const { db } = database.connect("app");
      const { db: workerDb } = database.connect("worker");
      const instance = app({ db, metricsToken: "metrics-token" });
      const worker = async () =>
        ((await (await instance.request("/readyz")).json()) as { worker: string }).worker;
      expect(await worker()).toBe("none");

      const running = startWorker({
        db: workerDb,
        logger,
        publicUrl: "http://localhost",
        secret: "a-test-secret",
        pollMs: 20,
      });
      try {
        await expect.poll(worker, { timeout: 5000 }).toBe("ok");
      } finally {
        await running.stop();
      }
      const metrics = await instance.request("/metrics", {
        headers: { authorization: "Bearer metrics-token" },
      });
      expect(await metrics.text()).toMatch(/^dinghy_worker_last_pass_timestamp_seconds \d/m);

      const { db: owner } = database.connect("migrator");
      await owner.update(workerHeartbeat).set({ passedAt: new Date(Date.now() - 10 * 60_000) });
      expect(await worker()).toBe("stale");
      // A stalled worker is not this instance's fault, so it stays ready.
      expect((await instance.request("/readyz")).status).toBe(200);
    } finally {
      await database.drop();
    }
  });
});

describe("/v1", () => {
  test("the meta route returns the name and version", async () => {
    const response = await app().request("/v1/meta");
    expect(await response.json()).toEqual({
      name: "dinghy",
      // The server package's version, which version.test.ts keeps equal to the release.
      version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
        .version,
      billing: false,
      signup: null,
      // This app has no mail server, so the server's admin hands out sign-in links.
      email: false,
    });
  });

  test("an invalid request gets a 400 in the standard error shape", async () => {
    const instance = app();
    instance.openapi(
      createRoute({
        method: "get",
        path: "/v1/test/{id}",
        request: { params: z.object({ id: z.uuid() }) },
        responses: { 200: { description: "ok" } },
      }),
      (c) => c.body(null, 200),
    );
    const response = await instance.request("/v1/test/not-a-uuid");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.requestId).toEqual(expect.any(String));
  });

  test("an unknown route gets a 404 in the standard error shape", async () => {
    const response = await app().request("/v1/nothing");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("an unhandled error gets a 500 and leaks no detail", async () => {
    const instance = app();
    instance.get("/v1/boom", () => {
      throw new Error("the database password is hunter2");
    });
    const response = await instance.request("/v1/boom");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("hunter2");
  });

  test("a request that finds no free connection in time gets a 503 busy, not a wait", async () => {
    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 100,
    });
    const db = drizzle(pool, { schema });
    const instance = app({ db });
    instance.get("/v1/read", async (c) => c.json((await db.execute("select 1 as one")).rows));
    const taken = await pool.connect();
    try {
      const response = await instance.request("/v1/read");
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("busy");
    } finally {
      taken.release();
    }
    expect((await instance.request("/v1/read")).status).toBe(200);
    await pool.end();
  });

  test("the committed OpenAPI spec is up to date", async () => {
    const committed = readFileSync(new URL("../openapi.json", import.meta.url), "utf8");
    expect(JSON.parse(committed)).toEqual(await openApiDocument());
  });

  test("the OpenAPI spec lists the answers that the middleware gives", async () => {
    const document = (await openApiDocument()) as {
      paths: Record<string, Record<string, { responses: object; security?: object[] }>>;
      components: {
        securitySchemes?: Record<string, unknown>;
        schemas: Record<string, { properties: { error: { properties: { code: object } } } }>;
      };
    };
    expect(Object.keys(document.components.securitySchemes ?? {}).sort()).toEqual([
      "apiKey",
      "sessionCookie",
      "visitorToken",
    ]);
    expect(document.components.schemas.Error?.properties.error.properties.code).toMatchObject({
      enum: [...ERROR_CODES],
    });
    const missing: string[] = [];
    const expectAnswers = (operation: string, statuses: number[], listed: object) => {
      for (const status of statuses) {
        if (!(String(status) in listed)) missing.push(`${operation} ${status}`);
      }
    };
    const workspace = "/v1/operator/workspaces/{workspaceId}";
    const allowedWhileReadOnly = ["", "/presence", "/presence/leave"];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, { responses, security }] of Object.entries(operations)) {
        const operation = `${method.toUpperCase()} ${path}`;
        const read = method === "get";
        if (path.startsWith("/v1/widget/{key}/")) expectAnswers(operation, [403, 429], responses);
        if (path.startsWith("/v1/operator/")) {
          expectAnswers(operation, read ? [401] : [401, 403], responses);
          if (security === undefined) missing.push(`${operation} security`);
        }
        // A key has a rate limit of its own.
        if (security?.some((scheme) => "apiKey" in scheme)) {
          expectAnswers(operation, [401, 429], responses);
        }
        if (path.startsWith(workspace)) {
          expectAnswers(operation, [402, 404], responses);
          const rest = path.slice(workspace.length);
          if (!read && !allowedWhileReadOnly.includes(rest)) {
            expectAnswers(operation, [400, 403, 503], responses);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("every error code the server sends is in the OpenAPI enum", () => {
    const sources = ["apps/server/src", "ee/server"].flatMap((folder) =>
      readdirSync(new URL(`../../../${folder}`, import.meta.url), { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map((file) =>
          readFileSync(new URL(`../../../${folder}/${file}`, import.meta.url), "utf8"),
        ),
    );
    const codes = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/(?:code: |failure\(\s*)"([a-z_]+)"/g)) {
        if (match[1] !== undefined) codes.add(match[1]);
      }
    }
    const unknown = [...codes].filter((code) => !(ERROR_CODES as readonly string[]).includes(code));
    expect(unknown).toEqual([]);
  });
});

describe("metrics", () => {
  const TOKEN = "a-long-metrics-token";

  test("the route does not exist without a token in the config", async () => {
    expect((await app().request("/metrics")).status).toBe(404);
  });

  test("the route refuses a request with no token or a wrong one", async () => {
    const instance = app({ metricsToken: TOKEN });
    expect((await instance.request("/metrics")).status).toBe(401);
    const wrong = await instance.request("/metrics", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
  });

  test("a malformed authorization header keeps its WWW-Authenticate header", async () => {
    const response = await app({ metricsToken: TOKEN }).request("/metrics", {
      headers: { authorization: "Basic x" },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("the route counts requests by route pattern, not by path", async () => {
    const instance = app({ metricsToken: TOKEN });
    await instance.request("/v1/meta");
    await instance.request("/v1/scanner-probe-123");
    const response = await instance.request("/metrics", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('route="/v1/meta"');
    expect(text).not.toContain("scanner-probe-123");
  });
});

describe("logs", () => {
  test("a request log holds no query string", async () => {
    const lines: string[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    await app({ logger: capture }).request("/v1/meta?token=secret-value");
    expect(lines.join("")).toContain('"route":"/v1/meta"');
    expect(lines.join("")).not.toContain("secret-value");
  });

  test("a passing health probe writes no line, and a failing one does", async () => {
    const lines: string[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    await app({ logger: capture }).request("/healthz");
    await app({ logger: capture }).request("/readyz");
    expect(lines.filter((line) => line.includes('"msg":"request"'))).toEqual([]);
    await app({ logger: capture, checks: { postgres: down, valkey: ok } }).request("/readyz");
    expect(lines.join("")).toContain('"route":"/readyz","status":503');
  });
});
