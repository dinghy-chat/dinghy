import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
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
import { localStore, type ObjectStore } from "./storage.ts";
import { DAY_MS } from "./time.ts";
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
/** Random pixels, whose thumbnail compresses as badly as any. */
let noise: Buffer;
/** The answers that the gated page holds until the test lets them go. */
const gated: ServerResponse[] = [];

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
  "/noisy": (response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(page('<title>Noisy</title><meta property="og:image" content="/noise.png">'));
  },
  "/noise.png": (response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(noise);
  },
  "/gate": (response) => {
    gated.push(response);
  },
  "/latin1": (response) => {
    response.writeHead(200, { "content-type": "text/html; charset=ISO-8859-1" });
    response.end(Buffer.from(page("<title>Caf\u00e9</title>"), "latin1"));
  },
  "/meta-charset": (response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      Buffer.from(page('<meta charset="windows-1252"><title>\x93Na\xefve\x94</title>'), "latin1"),
    );
  },
  "/http-equiv": (response) => {
    response.writeHead(200, { "content-type": "text/html" });
    const head =
      '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>Gr\u00fc\u00dfe</title>';
    response.end(Buffer.from(page(head), "latin1"));
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
  noise = await sharp(randomBytes(300 * 200 * 3), { raw: { width: 300, height: 200, channels: 3 } })
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

  test("only the first 64 KB of a page are read", async () => {
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

  test("a quoted '>' stays in its value, and a comment hides its tags", () => {
    const html =
      '<!-- <meta property="og:title" content="Hidden"> --><meta content="Prices > $10" property=og:title><title>Shop</title>';
    expect(pageFields(html).title).toBe("Prices > $10");
    expect(pageFields("<!-- <title>Hidden</title> --><title>Shown</title>").title).toBe("Shown");
    expect(pageFields("<title>Cut off").title).toBe("Cut off");
  });

  test("a page made to slow a parser down is read in one pass", () => {
    const started = performance.now();
    for (const html of [
      `<meta ${"a".repeat(500_000)}`,
      "<meta".repeat(100_000),
      "<title>".repeat(70_000),
      `<meta content="${"x".repeat(500_000)}`,
      "<!--".repeat(120_000),
      `<meta ${"a=b ".repeat(120_000)}`,
    ]) {
      pageFields(html);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a page is read in the charset its header or its meta tags name", async () => {
    for (const [path, title] of [
      ["/latin1", "Café"],
      ["/meta-charset", "\u201cNaïve\u201d"],
      ["/http-equiv", "Grüße"],
    ]) {
      expect((await fetchPreview(`http://docs.example${path}`, network))?.title).toBe(title);
    }
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

  async function reply(conversationId: string, body: string, card: Card | null, server = app) {
    const response = await asOperator(
      server,
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

  const serverWith = (store: ObjectStore, cloud?: Parameters<typeof createApp>[0]["cloud"]) =>
    createApp({
      db,
      auth,
      logger,
      valkey,
      checks: { postgres: async () => {}, valkey: async () => {} },
      uploads: createUploads({ store, secret: AUTH_SECRET, publicUrl: PUBLIC_URL }),
      linkPreviewNetwork: network,
      cloud,
    });

  const thumbnails = (messageId: string) =>
    owner.select().from(attachment).where(eq(attachment.messageId, messageId));

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    db = database.connect("app", 10).db;
    owner = database.connect("migrator").db;
    valkey = new Redis(VALKEY_URL);
    auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    app = serverWith(localStore(await mkdtemp(join(tmpdir(), "dinghy-link-"))));
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

  test("a changed image or a link no longer in the body sends no card, and a day later it still goes", async () => {
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

    // The token binds the workspace, the link and the image, so it does not expire.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY_MS });
    try {
      const later = await reply(conversationId, "See http://docs.example/reset", card);
      expect(later.link).toMatchObject({ title: "Reset your password" });
    } finally {
      vi.useRealTimers();
    }
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

  test("the longest text reply with the largest card fits the body limit", async () => {
    const { conversationId } = await visitorStarts(app, space.publicKey, "Long");
    const card = await preview(conversationId, "http://docs.example/noisy");
    expect(card?.image).not.toBeNull();
    const text = "See http://docs.example/noisy ";
    // A control character takes six bytes of JSON, the most any character takes.
    const sent = await reply(
      conversationId,
      text + "\u0001".repeat(MESSAGE_MAX - text.length),
      card,
    );
    expect(sent.link?.image).not.toBeNull();
  });

  test("a thumbnail the store cannot take leaves the card without it, and the reply goes", async () => {
    const down: ObjectStore = {
      ...localStore(await mkdtemp(join(tmpdir(), "dinghy-link-down-"))),
      put: () => Promise.reject(new Error("The store is down")),
    };
    const { conversationId } = await visitorStarts(app, space.publicKey, "Store down");
    const card = await preview(conversationId, "http://docs.example/reset");
    const sent = await reply(
      conversationId,
      "See http://docs.example/reset",
      card,
      serverWith(down),
    );
    expect(sent.link).toMatchObject({ title: "Reset your password", image: null });
    expect(await thumbnails(sent.id)).toEqual([]);
  });

  test("a workspace with no room left gets the card without its thumbnail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dinghy-link-full-"));
    const full = serverWith(localStore(directory), {
      signup: "early",
      limits: { maxStoredBytes: 1 },
    });
    const { conversationId } = await visitorStarts(app, space.publicKey, "Full");
    const card = await preview(conversationId, "http://docs.example/reset");
    const sent = await reply(conversationId, "See http://docs.example/reset", card, full);
    expect(sent.link).toMatchObject({ title: "Reset your password", image: null });
    expect(await thumbnails(sent.id)).toEqual([]);
    expect(await readdir(join(directory, space.id)).catch(() => [])).toEqual([]);
  });

  test("requests that arrive together run at most 4 fetches", async () => {
    const { conversationId } = await visitorStarts(app, space.publicKey, "Together");
    // Each request's rate limit waits until all 6 have reached it or answered, so a cap that is
    // checked before that wait and counted after it lets them all through.
    const held: (() => void)[] = [];
    const multi = valkey.multi.bind(valkey);
    const hold = vi.spyOn(valkey, "multi").mockImplementation(((...args: []) => {
      const chain = multi(...args);
      const exec = chain.exec.bind(chain);
      chain.exec = () => new Promise<void>((resolve) => held.push(resolve)).then(() => exec());
      return chain;
    }) as typeof valkey.multi);
    let answered = 0;
    const asks = Array.from({ length: 6 }, () =>
      preview(conversationId, "http://docs.example/gate").finally(() => {
        answered += 1;
      }),
    );
    try {
      await vi.waitFor(() => expect(held.length + answered).toBe(6));
    } finally {
      hold.mockRestore();
      for (const resume of held) resume();
    }
    await vi.waitFor(() => expect(gated).toHaveLength(4));
    for (const response of gated.splice(0)) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(page("<title>Gate</title>"));
    }
    const cards = await Promise.all(asks);
    expect(cards.filter((one) => one !== null)).toHaveLength(4);
    expect(gated).toEqual([]);
  });
});
