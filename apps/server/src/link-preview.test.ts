import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, callTool, withKey } from "../test/requests.ts";
import { SITE, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { attachment, message, storageDeletion } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { fetchPreview, type PreviewNetwork, pageFields } from "./link-preview.ts";
import { localStore } from "./storage.ts";
import { MINUTE_MS } from "./time.ts";
import { createUploads } from "./uploads.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });

// Every name resolves to the test's own server, which a public fetch could never reach.
const toLocal = ((_host, options, callback) =>
  options.all === true
    ? callback(null, [{ address: "127.0.0.1", family: 4 }])
    : callback(null, "127.0.0.1", 4)) as LookupFunction;

let site: Server;
let network: PreviewNetwork;
let picture: Buffer;

const page = (head: string) => `<!doctype html><html><head>${head}</head><body>Hi</body></html>`;

const PAGES: Record<string, (response: ServerResponse) => void> = {
  "/reset": (response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      page(
        '<meta property="og:title" content="Reset your password"><meta property="og:image" content="/picture.png">',
      ),
    );
  },
  "/picture.png": (response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(picture);
  },
  "/moved": (response) => {
    response.writeHead(302, { location: "/reset" });
    response.end();
  },
  "/to-private": (response) => {
    response.writeHead(302, { location: "http://10.0.0.1/admin" });
    response.end();
  },
  "/compressed": (response) => {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
    response.end(page("<title>Zipped</title>"));
  },
  "/large": (response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<html><head>${" ".repeat(600 * 1024)}<title>Too far</title></head></html>`);
  },
  "/slow": () => {},
  "/untitled": (response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(page('<meta property="og:image" content="/picture.png">'));
  },
  "/private-image": (response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      page('<title>Docs</title><meta property="og:image" content="http://192.168.1.1/x.png">'),
    );
  },
  "/plain": (response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("<title>Not a page</title>");
  },
};

beforeAll(async () => {
  picture = await sharp({
    create: { width: 300, height: 200, channels: 3, background: "#3366cc" },
  })
    .png()
    .toBuffer();
  site = createServer((request: IncomingMessage, response: ServerResponse) => {
    const answer = PAGES[request.url ?? ""];
    if (answer === undefined) response.writeHead(404).end();
    else answer(response);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  network = { lookup: toLocal, port: typeof address === "object" && address ? address.port : 0 };
});

afterAll(() => {
  site.closeAllConnections();
  site.close();
});

describe("fetching a page", () => {
  test("the title and a square WebP thumbnail, after a redirect", async () => {
    const found = await fetchPreview("http://docs.example/moved", network);
    expect(found).toMatchObject({ url: "http://docs.example/moved", title: "Reset your password" });
    const meta = await sharp(found?.image ?? Buffer.alloc(0)).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 112, height: 112 });
  });

  test("private and IPv4-mapped addresses, other ports and credentials get no card", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://[::ffff:10.0.0.1]/",
      "http://169.254.169.254/latest",
      "http://docs.example:8080/reset",
      "http://user:secret@docs.example/reset",
      "ftp://docs.example/reset",
    ]) {
      expect(await fetchPreview(url, network)).toBeNull();
    }
  });

  test("a redirect to a private address, a compressed answer and a page that is not HTML get none", async () => {
    for (const path of ["/to-private", "/compressed", "/plain"]) {
      expect(await fetchPreview(`http://docs.example${path}`, network)).toBeNull();
    }
  });

  test("only the first 512 KB of a page are read", async () => {
    expect(await fetchPreview("http://docs.example/large", network)).toBeNull();
  });

  test("a page that does not answer within 5 seconds gets none", async () => {
    const started = Date.now();
    expect(await fetchPreview("http://docs.example/slow", network)).toBeNull();
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10_000);

  test("a page with no title gets none, and an image on a private address leaves no thumbnail", async () => {
    expect(await fetchPreview("http://docs.example/untitled", network)).toBeNull();
    expect(await fetchPreview("http://docs.example/private-image", network)).toEqual({
      url: "http://docs.example/private-image",
      title: "Docs",
      image: null,
    });
  });

  test("the title has its entities decoded, its hidden characters removed and its spaces collapsed", () => {
    const html =
      "<title>Ignored</title><meta name='twitter:title' content='Tom &amp; Jerry&#39;s\n\t &lt;show&gt; &#x202E;now&#8236;'>";
    expect(pageFields(html)).toEqual({ title: "Tom & Jerry's <show> now", image: null });
    expect(pageFields(`<title>${"a".repeat(300)}</title>`).title).toHaveLength(200);
    expect(pageFields("<title> \u0007 </title>").title).toBeNull();
  });
});

describe("a reply with a link's card", () => {
  let database: TestDatabase;
  let db: Database;
  let owner: Database;
  let valkey: Redis;
  let app: App;
  let space: NewWorkspace;
  let auth: ReturnType<typeof createAuth>;
  let ana: { id: string; cookie: string };
  let keyToken: string;

  const inSpace = (path: string) => `/v1/operator/workspaces/${space.id}${path}`;

  interface Card {
    url: string;
    title: string;
    image: { data: string; width: number; height: number } | null;
    token: string;
  }

  async function preview(
    conversationId: string,
    url: string,
    by = { workspaceId: space.id, cookie: ana.cookie },
  ): Promise<Card | null> {
    const response = await asOperator(
      app,
      by.cookie,
      "POST",
      `/v1/operator/workspaces/${by.workspaceId}/conversations/${conversationId}/link-preview`,
      { url },
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { preview: Card | null }).preview;
  }

  interface Line {
    id: string;
    body: string;
    link?: { url: string; title: string; image: { url: string } | null } | null;
  }

  async function reply(conversationId: string, body: string, card: Card | null) {
    const response = await asOperator(
      app,
      ana.cookie,
      "POST",
      inSpace(`/conversations/${conversationId}/messages`),
      {
        clientId: randomUUID(),
        body,
        linkPreview: card && { token: card.token, image: card.image?.data ?? null },
      },
    );
    expect(response.status).toBe(201);
    return (await response.json()) as Line;
  }

  const thumbnails = (messageId: string) =>
    owner.select().from(attachment).where(eq(attachment.messageId, messageId));

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    db = database.connect("app", 10).db;
    owner = database.connect("migrator").db;
    valkey = new Redis(VALKEY_URL);
    auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const directory = await mkdtemp(join(tmpdir(), "dinghy-link-"));
    app = createApp({
      db,
      auth,
      logger,
      valkey,
      checks: { postgres: async () => {}, valkey: async () => {} },
      uploads: createUploads({
        store: localStore(directory),
        secret: AUTH_SECRET,
        publicUrl: PUBLIC_URL,
      }),
      linkPreviewNetwork: network,
    });
    space = await createWorkspace(db, "Acme", [SITE]);
    ana = await signedInOperator({
      app,
      auth,
      owner,
      email: "ana@example.com",
      name: "Ana",
      workspaceId: space.id,
      role: "owner",
    });
    const made = await asOperator(app, ana.cookie, "POST", inSpace("/api-keys"), { name: "Bot" });
    keyToken = ((await made.json()) as { token: string }).token;
  }, 30_000);

  afterAll(async () => {
    valkey.disconnect();
    await database.drop();
  });

  test("the card goes out with the reply, to the operator app and the widget, and no integration", async () => {
    const { token, conversationId } = await visitorStarts(app, space.publicKey, "How do I reset?");
    const card = await preview(conversationId, "http://docs.example/reset");
    expect(card).toMatchObject({
      url: "http://docs.example/reset",
      title: "Reset your password",
      image: { width: 112, height: 112 },
    });
    expect(card?.image?.data.startsWith("data:image/webp;base64,")).toBe(true);

    const sent = await reply(conversationId, "Here: http://docs.example/reset", card);
    const shown = {
      url: "http://docs.example/reset",
      title: "Reset your password",
      image: { url: expect.stringContaining("/v1/files/"), width: 112, height: 112 },
    };
    expect(sent.link).toEqual(shown);
    expect(await thumbnails(sent.id)).toHaveLength(1);

    const read = await asOperator(
      app,
      ana.cookie,
      "GET",
      inSpace(`/conversations/${conversationId}/messages`),
    );
    const lines = ((await read.json()) as { messages: Line[] }).messages;
    expect(lines.at(-1)?.link).toEqual(shown);

    const widget = await app.request(`/v1/widget/${space.publicKey}/messages`, {
      headers: { origin: SITE, authorization: `Bearer ${token}` },
    });
    const visible = ((await widget.json()) as { messages: Line[] }).messages;
    expect(visible.at(-1)?.link).toEqual(shown);

    const byKey = await withKey(
      app,
      keyToken,
      "GET",
      inSpace(`/conversations/${conversationId}/messages`),
    );
    const keyLines = ((await byKey.json()) as { messages: Line[] }).messages;
    expect(keyLines.at(-1)?.id).toBe(sent.id);
    expect(keyLines.at(-1)).not.toHaveProperty("link");
    const tool = await callTool(app, keyToken, "get_conversation", { conversationId });
    expect(JSON.stringify(tool.structuredContent)).not.toContain("Reset your password");
  });

  test("an expired token, a changed image or a link no longer in the body sends no card", async () => {
    const { conversationId } = await visitorStarts(app, space.publicKey, "Help");
    const card = await preview(conversationId, "http://docs.example/reset");
    if (card?.image == null) throw new Error("The card has no image");

    const moved = await reply(conversationId, "Not the link anymore", card);
    expect(moved.link).toBeNull();
    const other = `data:image/webp;base64,${Buffer.from("other").toString("base64")}`;
    const changed = await reply(conversationId, "See http://docs.example/reset", {
      ...card,
      image: { ...card.image, data: other },
    });
    expect(changed.link).toBeNull();
    expect(await thumbnails(changed.id)).toEqual([]);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * MINUTE_MS });
    try {
      expect((await reply(conversationId, "See http://docs.example/reset", card)).link).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect((await reply(conversationId, "See http://docs.example/reset", card)).link).toMatchObject(
      {
        title: "Reset your password",
      },
    );
  });

  test("deleting the reply removes its card and thumbnail, and an edit that drops the link does too", async () => {
    const { conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const card = await preview(conversationId, "http://docs.example/reset");
    const path = (id: string) => inSpace(`/conversations/${conversationId}/messages/${id}`);

    const kept = await reply(conversationId, "See http://docs.example/reset", card);
    const same = await asOperator(app, ana.cookie, "PATCH", path(kept.id), {
      body: "Try http://docs.example/reset now",
    });
    expect(((await same.json()) as Line).link).toMatchObject({ title: "Reset your password" });
    const [stored] = await thumbnails(kept.id);
    const edited = await asOperator(app, ana.cookie, "PATCH", path(kept.id), {
      body: "Never mind",
    });
    expect(((await edited.json()) as Line).link).toBeNull();
    expect(await thumbnails(kept.id)).toEqual([]);
    const queued = await owner
      .select()
      .from(storageDeletion)
      .where(eq(storageDeletion.storageKey, stored?.storageKey ?? ""));
    expect(queued).toHaveLength(1);

    const removed = await reply(conversationId, "See http://docs.example/reset", card);
    expect((await asOperator(app, ana.cookie, "DELETE", path(removed.id))).status).toBe(200);
    const [row] = await owner.select().from(message).where(eq(message.id, removed.id));
    expect(row?.metadata).toEqual({});
    expect(await thumbnails(removed.id)).toEqual([]);
  });

  test("a workspace gets 30 previews a minute, and no card past them", async () => {
    const busy = await createWorkspace(db, "Busy", [SITE]);
    const bo = await signedInOperator({
      app,
      auth,
      owner,
      email: "bo@example.com",
      name: "Bo",
      workspaceId: busy.id,
      role: "owner",
    });
    const by = { workspaceId: busy.id, cookie: bo.cookie };
    const { conversationId } = await visitorStarts(app, busy.publicKey, "Many links");
    const cards = [];
    for (let i = 0; i < 31; i += 1) {
      cards.push(await preview(conversationId, "http://docs.example/private-image", by));
    }
    expect(cards.slice(0, 30).every((card) => card?.title === "Docs")).toBe(true);
    expect(cards[30]).toBeNull();
  });
});
