import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { eq, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { SignJWT } from "jose";
import pg from "pg";
import { pino } from "pino";
import { generateVAPIDKeys } from "web-push";
import type { CloudSettings } from "../../../ee/server/index.ts";
import { buildWidget } from "../../../packages/widget/build.ts";
import type { WidgetSettings } from "../../../packages/widget/src/shared.ts";
import { buildOperator } from "../../operator/build.ts";
import { createApp } from "../src/app.ts";
import { createAuth, signInLink } from "../src/auth.ts";
import { chatLinkUrl, createChatLink } from "../src/chat-link.ts";
import { ensureRoles } from "../src/db/roles.ts";
import {
  conversation,
  operator,
  session,
  visitor,
  widgetSettings,
  workspaceMember,
  workspace as workspaceTable,
} from "../src/db/schema.ts";
import { type Database, withWorkspace } from "../src/db/tenant.ts";
import { createImages } from "../src/images.ts";
import { createLive, createSignals, OPERATORS } from "../src/live.ts";
import { createLiveVisitors, type LiveVisitors } from "../src/live-visitors.ts";
import { appendMessage } from "../src/messages.ts";
import type { FetchClientDocument } from "../src/oauth-client.ts";
import { createPush } from "../src/push.ts";
import { localStore } from "../src/storage.ts";
import { setSuspended, signalSuspension } from "../src/suspension.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { createTestDatabase } from "./database.ts";
import { AUTH_SECRET, DATABASE_URL, VALKEY_URL } from "./env.ts";
import { clearLimits } from "./limits.ts";
import { sendOperatorMessage } from "./messages.ts";
import { captureMail } from "./operators.ts";

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
  {
    emailAvailable = false,
    mail = true,
    cloud,
    fetchClientDocument,
  }: {
    emailAvailable?: boolean;
    /** False for a server with no mail server, whose admin hands out sign-in links. */
    mail?: boolean;
    /** The cloud's settings, or a function that makes them once the database exists. */
    cloud?:
      | CloudSettings
      | ((databases: { db: Database; owner: Database }) => Promise<CloudSettings>);
    /** Answers OAuth client metadata URLs, so a test needs no network. */
    fetchClientDocument?: FetchClientDocument;
  } = {},
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
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: apiOrigin });
  // Keeps what it sends, so a test opens a link the way a person would.
  const mailer = captureMail();
  const valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await new Promise((resolve) => valkey.once("ready", resolve));
  await clearLimits(valkey);
  const pushed: string[] = [];
  const push = createPush({ ...generateVAPIDKeys(), subject: "mailto:hello@dinghy.chat" }, (async (
    url: string,
  ) => {
    pushed.push(url);
    return new Response(null, { status: 201 });
  }) as typeof fetch);
  // Moves forward, so every image URL handed out so far has expired.
  let imageClockMs = 0;
  app = createApp({
    cloud: typeof cloud === "function" ? await cloud({ db, owner }) : cloud,
    // Every browser here shares one address, and sends more than any person does.
    limitScale: 1000,
    alerts: { push, emailAvailable, secret: AUTH_SECRET },
    auth,
    mailer: mail ? mailer : undefined,
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
    publicUrl: apiOrigin,
    ...(fetchClientDocument === undefined ? {} : { fetchClientDocument }),
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
    /** The emails the server sent, newest last. */
    mail: mailer.sent,
    /** The link in email number `index` to `email`, once it arrives. */
    linkTo: (email: string, index = 0) => mailer.linkTo(email, index),
    /** A sign-in link, as `chat sign-in-link` prints it. */
    signInLink: (email: string) => signInLink(auth, email),
    /** An operator in this workspace, an owner unless `role` says otherwise, or in none. */
    async createOperator(
      email: string,
      { member = true, role = "owner" }: { member?: boolean; role?: "owner" | "member" } = {},
    ) {
      const [created] = await owner
        .insert(operator)
        .values({ name: email, email, emailVerified: true })
        .returning({ id: operator.id });
      const id = created?.id ?? "";
      if (!member) return;
      await owner
        .insert(workspaceMember)
        .values({ workspaceId: workspace.id, operatorId: id, role });
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
    /** Adds conversations with one message each, from visitors in `country` when it is given. */
    async seedConversations(count: number, prefix: string, country: string | null = null) {
      for (let i = 0; i < count; i++) {
        await withWorkspace(db, workspace.id, async (tx) => {
          const [row] = await tx
            .insert(visitor)
            .values({ workspaceId: workspace.id, externalId: `${prefix}-${i}`, country })
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
    /** Opens tabs of the site as their beats would, each with a new contact when it has a name. */
    async openTabs(
      tabs: (Omit<Parameters<LiveVisitors["beat"]>[1], "tab" | "visitorId" | "conversationId"> & {
        name?: string;
      })[],
    ) {
      const liveVisitors = createLiveVisitors(valkey, logger);
      for (const { name, ...details } of tabs) {
        const [contact] =
          name === undefined
            ? []
            : await owner
                .insert(visitor)
                .values({ workspaceId: workspace.id, name, tokenHash: randomUUID() })
                .returning({ id: visitor.id });
        await liveVisitors.beat(workspace.id, {
          ...details,
          tab: randomUUID(),
          visitorId: contact?.id ?? null,
          conversationId: null,
        });
      }
    },
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
    /**
     * A second workspace, owned by the operator with this email, who is new unless
     * `createOperator` made them. For tests of one login across workspaces.
     */
    async createSecondWorkspace(name: string, email: string) {
      const created = await createWorkspace(db, name, []);
      await owner
        .insert(operator)
        .values({ name: email, email, emailVerified: true })
        .onConflictDoNothing();
      const [row] = await owner
        .select({ id: operator.id })
        .from(operator)
        .where(eq(operator.email, email));
      const id = row?.id ?? "";
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
    /** Moves the latest conversation `hours` back, with its replies `replyAfterSeconds` later. */
    async backdateLatest(hours: number, replyAfterSeconds: number) {
      await owner.execute(sql`
        WITH latest AS (
          SELECT id, now() - make_interval(hours => ${hours}::int) AS at FROM conversation
          WHERE workspace_id = ${workspace.id} ORDER BY created_at DESC LIMIT 1
        ), moved AS (
          UPDATE conversation AS c SET created_at = latest.at FROM latest WHERE c.id = latest.id
        )
        UPDATE message AS m
        SET created_at = latest.at + CASE WHEN m.author_visitor_id IS NULL
                                          THEN make_interval(secs => ${replyAfterSeconds}::int)
                                          ELSE interval '0' END
        FROM latest WHERE m.conversation_id = latest.id`);
    },
    /** A reply email's link to the latest conversation, as the worker makes one. */
    async chatLink() {
      const rows = await withWorkspace(db, workspace.id, (tx) => tx.select().from(conversation));
      const latest = rows.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1);
      if (latest === undefined) throw new Error("No conversation to link to");
      const token = await withWorkspace(owner, workspace.id, (tx) =>
        createChatLink(tx, workspace.id, latest.visitorId, latest.id),
      );
      return chatLinkUrl(apiOrigin, token);
    },
    /** Changes the widget's saved settings, as an owner does in the Widget tab. */
    async setWidgetSettings(change: Partial<WidgetSettings>) {
      await owner
        .update(widgetSettings)
        .set(change)
        .where(eq(widgetSettings.workspaceId, workspace.id));
    },
    async closeConversations() {
      await withWorkspace(db, workspace.id, (tx) =>
        tx
          .update(conversation)
          .set({ status: "closed", snoozedAt: null, snoozedUntil: null })
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
