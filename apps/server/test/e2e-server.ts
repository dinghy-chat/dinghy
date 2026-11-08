import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { SignJWT } from "jose";
import pg from "pg";
import { pino } from "pino";
import webPush from "web-push";
import type { CloudSettings } from "../../../ee/server/index.ts";
import { buildWidget } from "../../../packages/widget/build.ts";
import { buildOperator } from "../../operator/build.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { ensureRoles } from "../src/db/roles.ts";
import {
  conversation,
  operator,
  session,
  visitor,
  workspaceMember,
  workspace as workspaceTable,
} from "../src/db/schema.ts";
import { withWorkspace } from "../src/db/tenant.ts";
import { createImages } from "../src/images.ts";
import { createLive, createSignals, OPERATORS } from "../src/live.ts";
import { appendMessage } from "../src/messages.ts";
import { createPush } from "../src/push.ts";
import { localStore } from "../src/storage.ts";
import { setSuspended, signalSuspension } from "../src/suspension.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { createTestDatabase } from "./database.ts";
import { AUTH_SECRET, DATABASE_URL, VALKEY_URL } from "./env.ts";
import { sendOperatorMessage } from "./messages.ts";

const OPERATOR = "00000000-0000-4000-8000-0000000000f3";

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

/** The real server and a host site on another origin, for browser tests. */
export async function startE2EServer(
  hostPages: Record<string, { html: string; csp?: string }>,
  { emailAvailable = false, cloud }: { emailAvailable?: boolean; cloud?: CloudSettings } = {},
) {
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await ensureRoles(admin);
  await admin.end();

  const database = await createTestDatabase();
  await database.migrate();
  const { db } = database.connect("app", 20);
  const { db: owner } = database.connect("migrator");
  const { db: workerDb } = database.connect("worker", 1);

  const directory = await mkdtemp(join(tmpdir(), "dinghy-widget-"));
  await buildWidget(directory);
  const operatorBundle = join(directory, "operator");
  await buildOperator(operatorBundle);

  const publisher = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  const logger = pino({ level: "silent" });
  const live = createLive(publisher, VALKEY_URL, logger);
  const ok = async () => {};
  // The app needs its own URL for sign-in, so the port comes first.
  let app: ReturnType<typeof createApp> | undefined;
  const api = serve({
    fetch: (request) => {
      if (app === undefined) throw new Error("The app is not ready");
      return app.fetch(request);
    },
    port: 0,
    hostname: "127.0.0.1",
  }) as http.Server;
  await new Promise((resolve) => api.once("listening", resolve));
  const apiAddress = api.address();
  const apiPort = typeof apiAddress === "object" && apiAddress !== null ? apiAddress.port : 0;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: apiOrigin, logger });
  const valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  const pushed: string[] = [];
  const push = createPush(
    { ...webPush.generateVAPIDKeys(), subject: "mailto:hello@dinghy.chat" },
    (async (url: string) => {
      pushed.push(url);
      return new Response(null, { status: 201 });
    }) as typeof fetch,
  );
  // Moves forward, so every image URL handed out so far has expired.
  let imageClockMs = 0;
  app = createApp({
    cloud,
    // Every browser here shares one address, and sends more than any person does.
    limitScale: 1000,
    alerts: { push, emailAvailable, secret: AUTH_SECRET },
    auth,
    db,
    live,
    logger,
    valkey,
    checks: { postgres: ok, valkey: ok },
    widgetDirectory: directory,
    images: createImages({
      store: localStore(join(directory, "images")),
      secret: AUTH_SECRET,
      publicUrl: apiOrigin,
      now: () => Date.now() + imageClockMs,
    }),
    operatorDirectory: operatorBundle,
  });

  let workspace = { id: "", publicKey: "", signingSecret: "" };
  const host = http.createServer((req, res) => {
    const page = hostPages[new URL(req.url ?? "/", "http://x").pathname];
    if (page === undefined) {
      res.writeHead(404).end();
      return;
    }
    const fill = (text: string) =>
      text.replaceAll("{{API}}", apiOrigin).replaceAll("{{PUBLIC_KEY}}", workspace.publicKey);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(page.csp === undefined ? {} : { "content-security-policy": fill(page.csp) }),
    });
    res.end(fill(page.html));
  });
  const hostPort = await listen(host);
  const hostOrigin = `http://127.0.0.1:${hostPort}`;
  workspace = await createWorkspace(db, "E2E", [hostOrigin]);
  await owner.insert(operator).values({ id: OPERATOR, name: "Seed", email: "seed@example.com" });
  await owner
    .insert(workspaceMember)
    .values({ workspaceId: workspace.id, operatorId: OPERATOR, role: "owner" });

  return {
    pushed,
    /** Expires every image URL handed out so far, as a tab left open for an hour finds. */
    expireImageUrls() {
      imageClockMs += 60 * 60_000;
    },
    /** For the cloud's helpers in ee/, which run the worker's passes on the same databases. */
    owner,
    workerDb,
    signals: createSignals(publisher, logger),
    async isDeleted(workspaceId: string) {
      const [row] = await owner
        .select({ deletedAt: workspaceTable.deletedAt })
        .from(workspaceTable)
        .where(eq(workspaceTable.id, workspaceId));
      return row === undefined || row.deletedAt !== null;
    },
    apiOrigin,
    hostOrigin,
    workspace,
    /** An operator who is a member of this workspace, or of none with `member: false`. */
    async createOperator(email: string, password: string, { member = true } = {}) {
      const context = await auth.$context;
      const [created] = await owner
        .insert(operator)
        .values({ name: email, email, emailVerified: true })
        .returning({ id: operator.id });
      const id = created?.id ?? "";
      await context.internalAdapter.linkAccount({
        userId: id,
        providerId: "credential",
        accountId: id,
        password: await context.password.hash(password),
      });
      if (!member) return;
      await owner
        .insert(workspaceMember)
        .values({ workspaceId: workspace.id, operatorId: id, role: "owner" });
    },
    /** Commits several messages in one go and signals once, as a lost signal's next wake does. */
    async visitorBurst(bodies: string[]) {
      const rows = await withWorkspace(db, workspace.id, (tx) => tx.select().from(conversation));
      const latest = rows.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1);
      if (latest === undefined) throw new Error("No conversation to send to");
      const { visitorId } = latest;
      for (const body of bodies) {
        await withWorkspace(db, workspace.id, (tx) =>
          appendMessage(
            tx,
            workspace.id,
            { kind: "visitor", visitorId },
            { clientId: crypto.randomUUID(), body },
          ),
        );
      }
      live.wake(workspace.id, OPERATORS);
    },
    /** Adds conversations with one message each, for paging tests. */
    async seedConversations(count: number, prefix: string) {
      for (let i = 0; i < count; i++) {
        await withWorkspace(db, workspace.id, async (tx) => {
          const [row] = await tx
            .insert(visitor)
            .values({ workspaceId: workspace.id, externalId: `${prefix}-${i}` })
            .returning({ id: visitor.id });
          await appendMessage(
            tx,
            workspace.id,
            { kind: "visitor", visitorId: row?.id ?? "" },
            { clientId: `${prefix}-${i}`, body: `${prefix} message ${i}` },
          );
        });
      }
    },
    workspaceId: () => workspace.id,
    async blockVisitors(count: number) {
      await owner.insert(visitor).values(
        Array.from({ length: count }, () => ({
          workspaceId: workspace.id,
          tokenHash: randomUUID(),
          blockedAt: new Date(),
        })),
      );
    },
    async unblockVisitors() {
      await owner
        .update(visitor)
        .set({ blockedAt: null })
        .where(eq(visitor.workspaceId, workspace.id));
    },
    wakeOperators: () => live.wake(workspace.id, OPERATORS),
    /** A second workspace, owned by a new operator, for tests of one login across workspaces. */
    async createSecondWorkspace(name: string, email: string, password: string) {
      const created = await createWorkspace(db, name, []);
      const context = await auth.$context;
      const [row] = await owner
        .insert(operator)
        .values({ name: email, email, emailVerified: true })
        .returning({ id: operator.id });
      const id = row?.id ?? "";
      await context.internalAdapter.linkAccount({
        userId: id,
        providerId: "credential",
        accountId: id,
        password: await context.password.hash(password),
      });
      await owner
        .insert(workspaceMember)
        .values({ workspaceId: created.id, operatorId: id, role: "owner" });
      return { id: created.id };
    },
    async revokeSessions() {
      await owner.delete(session);
    },
    /** Suspends the workspace, or lifts it, as `chat suspend` does. */
    async suspend(suspend = true) {
      const client = new pg.Client({ connectionString: database.adminUrl() });
      await client.connect();
      try {
        await setSuspended(client, workspace.id, suspend, suspend ? "E2E" : null);
      } finally {
        await client.end();
      }
      signalSuspension(createSignals(publisher, logger), workspace.id, suspend);
    },
    /** A token the host backend would sign. */
    hostToken(subject: string, expiresInSeconds = 3600) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setAudience(workspace.publicKey)
        .setSubject(subject)
        .setIssuedAt(now)
        .setExpirationTime(now + expiresInSeconds)
        .sign(new TextEncoder().encode(workspace.signingSecret));
    },
    async visitorCount() {
      const rows = await withWorkspace(db, workspace.id, (tx) => tx.select().from(visitor));
      return rows.length;
    },
    async visitorEmails() {
      const rows = await withWorkspace(db, workspace.id, (tx) => tx.select().from(visitor));
      return rows.map((row) => row.email);
    },
    /** Sends an operator reply to the latest conversation and wakes the visitor's stream. */
    async reply(body: string) {
      const rows = await withWorkspace(db, workspace.id, (tx) => tx.select().from(conversation));
      const latest = rows.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1);
      if (latest === undefined) throw new Error("No conversation to reply to");
      const sent = await sendOperatorMessage(db, workspace.id, OPERATOR, latest.id, body);
      live.wake(workspace.id, latest.visitorId);
      return sent.seq;
    },
    async closeConversations() {
      await withWorkspace(db, workspace.id, (tx) =>
        tx
          .update(conversation)
          .set({ status: "closed" })
          .where(eq(conversation.workspaceId, workspace.id)),
      );
    },
    async stop() {
      live.stop();
      publisher.disconnect();
      valkey.disconnect();
      api.closeAllConnections();
      host.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => api.close(resolve)),
        new Promise((resolve) => host.close(resolve)),
      ]);
      await rm(directory, { recursive: true, force: true });
      await database.drop();
    },
  };
}
