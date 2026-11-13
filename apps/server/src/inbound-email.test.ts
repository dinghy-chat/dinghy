import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, DATABASE_URL, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { type App, createApp } from "./app.ts";
import { inboundEmailFromConfig, loadConfig } from "./config.ts";
import { conversation, event, message, replyAddress, visitor, workspace } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import { createReplyAddress, pruneReplyAddresses, replyText, textParts } from "./inbound-email.ts";
import { appendMessage, setConversationStatus } from "./messages.ts";
import { localStore } from "./storage.ts";
import { DAY_MS } from "./time.ts";
import { signature } from "./webhooks.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const DOMAIN = "reply.example.com";
const SECRET = "an-inbound-secret-of-at-least-32-characters";
const VISITOR_EMAIL = "ada@example.com";
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let workerDb: Database;
let owner: Database;
let valkey: Redis;
let app: App;
let a: NewWorkspace;
let b: NewWorkspace;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app").db;
  workerDb = database.connect("worker").db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
  const images = createImages({
    store: localStore(await mkdtemp(join(tmpdir(), "dinghy-inbound-"))),
    secret: AUTH_SECRET,
    publicUrl: PUBLIC_URL,
  });
  app = createApp({
    db,
    images,
    inboundEmail: { domain: DOMAIN, secret: SECRET },
    logger,
    valkey,
    checks: { postgres: ok, valkey: ok },
  });
  a = await createWorkspace(db, "Acme", ["https://a.example.com"]);
  b = await createWorkspace(db, "Beta", ["https://b.example.com"]);
});

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

/** A visitor with an email and a conversation, from their message. */
async function newChat(space = a) {
  const [row] = await owner
    .insert(visitor)
    .values({ workspaceId: space.id, tokenHash: randomUUID(), email: VISITOR_EMAIL })
    .returning({ id: visitor.id });
  const visitorId = row?.id ?? "";
  const conversationId = await startConversation(space, visitorId);
  return { visitorId, conversationId };
}

/** A new conversation of the visitor, so they can have several. */
async function startConversation(space: NewWorkspace, visitorId: string) {
  const [row] = await owner
    .insert(conversation)
    .values({ workspaceId: space.id, visitorId })
    .returning({ id: conversation.id });
  return row?.id ?? "";
}

const addressFor = (space: NewWorkspace, chat: { visitorId: string; conversationId: string }) =>
  withWorkspace(workerDb, space.id, (tx) =>
    createReplyAddress(tx, space.id, chat.visitorId, chat.conversationId, DOMAIN),
  );

interface Attachment {
  filename: string;
  type: string;
  content: Buffer;
  /** An image inside the HTML, referenced by this Content-ID. */
  contentId?: string;
}

interface Mail {
  to: string;
  text?: string;
  html?: string;
  from?: string;
  subject?: string;
  messageId?: string | null | undefined;
  headers?: Record<string, string>;
  attachments?: Attachment[];
}

/** An email as a mail server passes it on, with a text part, or an HTML part, and attachments. */
function mime({
  to,
  text,
  html,
  from = VISITOR_EMAIL,
  subject = "Re: Acme replied to your message",
  messageId = `<${randomUUID()}@mail.example.com>`,
  headers = {},
  attachments = [],
}: Mail): string {
  const head = [
    `From: Ada <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(messageId === null ? [] : [`Message-ID: ${messageId}`]),
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    "MIME-Version: 1.0",
  ];
  const body =
    html === undefined
      ? ["Content-Type: text/plain; charset=utf-8", "", text ?? ""]
      : ["Content-Type: text/html; charset=utf-8", "", html];
  if (attachments.length === 0) return [...head, ...body].join("\r\n");
  const parts = attachments.map((one) =>
    [
      `Content-Type: ${one.type}; name="${one.filename}"`,
      ...(one.contentId === undefined
        ? [`Content-Disposition: attachment; filename="${one.filename}"`]
        : [`Content-Disposition: inline`, `Content-ID: <${one.contentId}>`]),
      "Content-Transfer-Encoding: base64",
      "",
      one.content.toString("base64").replace(/.{76}/g, "$&\r\n"),
    ].join("\r\n"),
  );
  // Inline images make the email multipart/related, as mail apps send them.
  const related = attachments.some((one) => one.contentId !== undefined);
  return [
    ...head,
    `Content-Type: multipart/${related ? "related" : "mixed"}; boundary="b"`,
    "",
    ...[body.join("\r\n"), ...parts].flatMap((part) => ["--b", part]),
    "--b--",
  ].join("\r\n");
}

const sign = (raw: string, time = Math.floor(Date.now() / 1000), secret = SECRET) =>
  signature(secret, time, raw);

/** Posts as the forwarder does, with the Content-Length that a fixed-size body has. */
const post = (
  raw: string,
  signed = sign(raw),
  server = app,
  length: string | null = String(Buffer.byteLength(raw)),
) =>
  server.request("/v1/inbound-email", {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      "dinghy-inbound-signature": signed,
      ...(length !== null && { "content-length": length }),
    },
    body: raw,
  });

/** The conversation's messages and status lines, in order. */
const messagesOf = (conversationId: string) =>
  owner
    .select({
      kind: message.kind,
      body: message.body,
      clientId: message.clientId,
      metadata: message.metadata,
      fromVisitor: sql<boolean>`${message.authorVisitorId} is not null`,
    })
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.seq));

const png = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: "#e5352b" } })
    .png()
    .toBuffer();

const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");

describe("the settings", () => {
  const base = { DATABASE_URL, VALKEY_URL, AUTH_SECRET, PUBLIC_URL };

  test("without both, the route is off, and one alone stops the server", async () => {
    const off = createApp({ db, logger, checks: { postgres: ok, valkey: ok } });
    const raw = mime({ to: "reply+x@reply.example.com", text: "Hi" });
    expect((await post(raw, sign(raw), off)).status).toBe(404);
    expect(() => loadConfig({ ...base, INBOUND_EMAIL_DOMAIN: DOMAIN })).not.toThrow();
    expect(inboundEmailFromConfig(loadConfig(base))).toBeUndefined();
    expect(() =>
      inboundEmailFromConfig(loadConfig({ ...base, INBOUND_EMAIL_DOMAIN: DOMAIN })),
    ).toThrow(/INBOUND_EMAIL_SECRET/);
    expect(
      inboundEmailFromConfig(
        loadConfig({
          ...base,
          INBOUND_EMAIL_DOMAIN: "Reply.Example.com",
          INBOUND_EMAIL_SECRET: SECRET,
        }),
      ),
    ).toEqual({ domain: DOMAIN, secret: SECRET });
  });
});

describe("the signature", () => {
  test("a missing, wrong or stale signature adds nothing", async () => {
    const chat = await newChat();
    const raw = mime({ to: await addressFor(a, chat), text: "Signed?" });
    const now = Math.floor(Date.now() / 1000);
    for (const signed of [
      "",
      sign(raw, now, "another-secret-of-at-least-32-characters"),
      sign(`${raw} `, now),
      sign(raw, now - 6 * 60),
      sign(raw, now + 6 * 60),
    ]) {
      const answer = await post(raw, signed);
      expect(answer.status).toBe(401);
      expect(await answer.json()).toMatchObject({ error: { code: "bad_signature" } });
    }
    expect(await messagesOf(chat.conversationId)).toEqual([]);
    expect((await post(raw, sign(raw, now - 4 * 60))).status).toBe(200);
  });

  test("a length over 25 MB is refused before the body is read", async () => {
    // The body is small: only the declared length can refuse it.
    const answer = await post("a", "t=0,v1=0", app, String(25 * 1024 * 1024 + 1));
    expect(answer.status).toBe(413);
    expect(await answer.json()).toMatchObject({ error: { code: "too_large" } });
  });

  test("a body without a Content-Length is refused before it is read", async () => {
    const chat = await newChat();
    const raw = mime({ to: await addressFor(a, chat), text: "Streamed" });
    const answer = await post(raw, sign(raw), app, null);
    expect(answer.status).toBe(411);
    expect(await answer.json()).toMatchObject({ error: { code: "length_required" } });
    expect(await messagesOf(chat.conversationId)).toEqual([]);
  });
});

describe("a reply", () => {
  test("goes to its address's conversation and reopens it, not the visitor's open one", async () => {
    const chat = await newChat();
    const to = await addressFor(a, chat);
    await withWorkspace(db, a.id, (tx) =>
      setConversationStatus(tx, a.id, chat.conversationId, "closed", {
        kind: "visitor",
        visitorId: chat.visitorId,
      }),
    );
    const newer = await startConversation(a, chat.visitorId);
    const answer = await post(mime({ to, text: "Still broken, sorry." }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true });
    expect(await messagesOf(newer)).toEqual([]);
    const [reply] = await owner
      .select({ status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, chat.conversationId));
    expect(reply?.status).toBe("open");
    const lines = await messagesOf(chat.conversationId);
    expect(lines.map((line) => line.kind)).toEqual(["closed", "reopened", "text"]);
    expect(lines[2]).toMatchObject({
      body: "Still broken, sorry.",
      fromVisitor: true,
      metadata: { via: "email" },
    });
    // A normal visitor message: it alerts the team.
    const [created] = await owner
      .select({ needsAlert: event.needsAlert })
      .from(event)
      .where(
        sql`${event.payload}->>'conversationId' = ${chat.conversationId} and ${event.kind} = 'message.created'`,
      );
    expect(created?.needsAlert).toBe(true);
  });

  test("is cut at the quote of Dinghy's email, and kept whole without one", async () => {
    const chat = await newChat();
    const to = await addressFor(a, chat);
    const quoted = [
      "Thanks, that works.",
      "",
      "Ada",
      "",
      "On Mon, 13 Nov 2026 at 10:00, Acme <support@acme.example> wrote:",
      "> Write your reply above this line",
      ">",
      "> Hi,",
    ].join("\r\n");
    expect((await post(mime({ to, text: quoted }))).status).toBe(200);
    const plain = "No quote here.\n\n> A quote of something else\n\n--\nAda";
    expect((await post(mime({ to, text: plain }))).status).toBe(200);
    expect((await messagesOf(chat.conversationId)).map((line) => line.body)).toEqual([
      "Thanks, that works.\n\nAda",
      plain,
    ]);
  });

  test("from an HTML-only mail app is read as text", async () => {
    const chat = await newChat();
    const html =
      "<html><head><style>p { color: red }</style></head><body><div>Got it &amp;\n  thanks&#33;</div><div>Ada</div>" +
      "<blockquote><p>Write your reply above this line</p><p>Hi,</p></blockquote></body></html>";
    expect((await post(mime({ to: await addressFor(a, chat), html }))).status).toBe(200);
    expect((await messagesOf(chat.conversationId))[0]?.body).toBe("Got it & thanks!\nAda");
  });

  test("from an HTML-only mail app decodes entities, before the marker is found", async () => {
    const chat = await newChat();
    const html =
      "<div>Merci, &ccedil;a marche&nbsp;&#x21;</div><div>&Agrave; bient&ocirc;t &#8211; Ada</div><br>" +
      "<div>Le lun. 13 nov., Acme a &eacute;crit&#160;:</div>" +
      "<blockquote><p>&Eacute;crivez votre r&eacute;ponse au-dessus de cette ligne</p><p>Bonjour,</p></blockquote>";
    expect((await post(mime({ to: await addressFor(a, chat), html }))).status).toBe(200);
    expect((await messagesOf(chat.conversationId)).map((line) => line.body)).toEqual([
      "Merci, ça marche !\nÀ bientôt – Ada",
    ]);
  });

  test("longer than a message goes in as several, and a retry adds none", async () => {
    const chat = await newChat();
    const first = "a".repeat(MESSAGE_MAX - 100);
    const second = "b".repeat(MESSAGE_MAX - 30);
    const raw = mime({
      to: await addressFor(a, chat),
      text: `${first}\n\n${second}`,
      attachments: [
        { filename: "run.exe", type: "application/octet-stream", content: Buffer.from("MZ") },
      ],
    });
    expect((await post(raw)).status).toBe(200);
    expect((await post(raw)).status).toBe(200);
    const lines = await messagesOf(chat.conversationId);
    // The note does not fit beside the second part, so it comes whole after it.
    expect(lines.map((line) => line.body)).toEqual([
      first,
      second,
      "1 attachment was left out. The chat takes up to 5 per email, of the types and sizes it allows.",
    ]);
    expect(lines.map((line) => line.clientId.replace(/^email:[0-9a-f]{64}/, ""))).toEqual([
      ":text1",
      ":text2",
      ":text3",
    ]);
  });

  test("with more than 10 messages of text is refused, and adds nothing", async () => {
    const chat = await newChat();
    const text = Array.from({ length: 11 }, () => "x".repeat(MESSAGE_MAX)).join("\n\n");
    const answer = await post(mime({ to: await addressFor(a, chat), text }));
    expect(answer.status).toBe(413);
    expect(await messagesOf(chat.conversationId)).toEqual([]);
  });

  test("sent again by the forwarder adds nothing, with or without a Message-ID", async () => {
    const chat = await newChat();
    const to = await addressFor(a, chat);
    const image = { filename: "shot.png", type: "image/png", content: await png() };
    for (const messageId of [undefined, null]) {
      const raw = mime({ to, text: "Once", attachments: [image], messageId });
      expect((await post(raw)).status).toBe(200);
      expect((await post(raw)).status).toBe(200);
    }
    const lines = await messagesOf(chat.conversationId);
    expect(lines.map((line) => line.kind)).toEqual(["image", "text", "image", "text"]);
    expect(lines[0]?.clientId).toMatch(/^email:[0-9a-f]{64}:1$/);
    expect(lines[1]?.clientId).toMatch(/^email:[0-9a-f]{64}:text1$/);
  });

  test("from another address is taken, and the team sees it", async () => {
    const chat = await newChat();
    const to = await addressFor(a, chat);
    await post(mime({ to, text: "Same person", from: "ADA@example.com" }));
    await post(mime({ to, text: "Forwarded", from: "ada.work@example.org" }));
    const lines = await messagesOf(chat.conversationId);
    expect(lines.map((line) => line.metadata)).toEqual([
      { via: "email" },
      { via: "email", fromOtherAddress: true },
    ]);
  });

  test("from a robot is dropped", async () => {
    const chat = await newChat();
    const to = await addressFor(a, chat);
    for (const mail of [
      { headers: { "Auto-Submitted": "auto-replied" } },
      { headers: { Precedence: "bulk" } },
      { headers: { Precedence: "list" } },
      { subject: "Out of Office: Re: Acme replied to your message" },
      { subject: "Automatic reply: Acme replied to your message" },
      { subject: "Réponse automatique : Acme a répondu à votre message" },
    ]) {
      expect((await post(mime({ to, text: "I am away", ...mail }))).status).toBe(200);
    }
    expect(await messagesOf(chat.conversationId)).toEqual([]);
    await post(mime({ to, text: "A person", headers: { "Auto-Submitted": "no" } }));
    expect(await messagesOf(chat.conversationId)).toHaveLength(1);
  });

  test("from a blocked visitor is refused", async () => {
    const chat = await newChat();
    const to = await addressFor(a, chat);
    await owner
      .update(visitor)
      .set({ blockedAt: new Date() })
      .where(eq(visitor.id, chat.visitorId));
    const answer = await post(mime({ to, text: "Let me in" }));
    expect(answer.status).toBe(403);
    expect(await messagesOf(chat.conversationId)).toEqual([]);
  });

  test("to a suspended workspace is refused as suspended", async () => {
    const space = await createWorkspace(db, "Paused", ["https://p.example.com"]);
    const chat = await newChat(space);
    const to = await addressFor(space, chat);
    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, space.id));
    const answer = await post(mime({ to, text: "Anyone there?" }));
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ error: { code: "suspended" } });
    expect(await messagesOf(chat.conversationId)).toEqual([]);
  });
});

describe("attachments", () => {
  test("an image and a file become messages before the text", async () => {
    const chat = await newChat();
    const raw = mime({
      to: await addressFor(a, chat),
      text: "Here you go",
      attachments: [
        { filename: "shot.png", type: "image/png", content: await png() },
        { filename: "invoice.pdf", type: "application/pdf", content: pdf },
      ],
    });
    expect((await post(raw)).status).toBe(200);
    const lines = await messagesOf(chat.conversationId);
    expect(lines.map((line) => [line.kind, line.body])).toEqual([
      ["image", null],
      ["file", null],
      ["text", "Here you go"],
    ]);
    expect(lines[1]?.metadata).toMatchObject({ via: "email", file: { name: "invoice.pdf" } });
  });

  test("one too large, of a refused type or past the fifth is left out, and the text says so", async () => {
    const chat = await newChat();
    await owner.update(visitor).set({ locale: "fr" }).where(eq(visitor.id, chat.visitorId));
    const file = (filename: string) => ({ filename, type: "application/pdf", content: pdf });
    const raw = mime({
      to: await addressFor(a, chat),
      text: "Voici",
      attachments: [
        file("1.pdf"),
        { filename: "big.txt", type: "text/plain", content: Buffer.alloc(11 * 1024 * 1024, "a") },
        { filename: "run.exe", type: "application/octet-stream", content: Buffer.from("MZ") },
        file("2.pdf"),
        file("3.pdf"),
        file("4.pdf"),
        file("5.pdf"),
      ],
    });
    expect((await post(raw)).status).toBe(200);
    const lines = await messagesOf(chat.conversationId);
    expect(lines.map((line) => line.kind)).toEqual(["file", "file", "file", "text"]);
    expect(lines.at(-1)?.body).toBe(
      "Voici\n\n4 pièces jointes n'ont pas été ajoutées. Le chat accepte jusqu'à 5 pièces jointes par e-mail, aux formats et aux tailles qu'il autorise.",
    );
  });

  test("a small inline image, such as a signature logo, is skipped, and a large one or a file kept", async () => {
    const chat = await newChat();
    // Random pixels do not compress, so this PNG is well over 16 KB.
    const noise = Buffer.from(Array.from({ length: 96 * 96 * 3 }, () => randomInt(256)));
    const screenshot = await sharp(noise, { raw: { width: 96, height: 96, channels: 3 } })
      .png()
      .toBuffer();
    expect(screenshot.byteLength).toBeGreaterThan(16 * 1024);
    const raw = mime({
      to: await addressFor(a, chat),
      text: "See the screenshot",
      attachments: [
        { filename: "logo.png", type: "image/png", content: await png(), contentId: "logo" },
        { filename: "shot.png", type: "image/png", content: screenshot, contentId: "shot" },
        // A small file in the same part is no logo, so it stays.
        {
          filename: "terms.pdf",
          type: "application/pdf",
          content: Buffer.from("%PDF-1.4"),
          contentId: "terms",
        },
      ],
    });
    expect((await post(raw)).status).toBe(200);
    const lines = await messagesOf(chat.conversationId);
    expect(lines.map((line) => line.kind)).toEqual(["image", "file", "text"]);
  });

  test("with no text, the note stands alone", async () => {
    const chat = await newChat();
    const raw = mime({
      to: await addressFor(a, chat),
      attachments: [
        { filename: "run.exe", type: "application/octet-stream", content: Buffer.from("MZ") },
      ],
    });
    expect((await post(raw)).status).toBe(200);
    expect((await messagesOf(chat.conversationId)).map((line) => line.body)).toEqual([
      "1 attachment was left out. The chat takes up to 5 per email, of the types and sizes it allows.",
    ]);
  });
});

describe("the address", () => {
  test("takes 20 emails an hour", async () => {
    const chat = await newChat();
    const to = await addressFor(a, chat);
    for (let count = 0; count < 20; count += 1) {
      expect((await post(mime({ to, text: `Message ${count}` }))).status).toBe(200);
    }
    const answer = await post(mime({ to, text: "One more" }));
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).not.toBeNull();
    expect(await messagesOf(chat.conversationId)).toHaveLength(20);
    // Another address of the same visitor has its own count.
    expect((await post(mime({ to: await addressFor(a, chat), text: "New email" }))).status).toBe(
      200,
    );
  });

  test("expires 90 days after its last use, and the worker prunes it", async () => {
    const chat = await newChat();
    const used = await addressFor(a, chat);
    const unused = await addressFor(a, chat);
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
    const ofVisitor = eq(replyAddress.visitorId, chat.visitorId);
    await owner
      .update(replyAddress)
      .set({ lastUsedAt: ago(89) })
      .where(ofVisitor);
    expect((await post(mime({ to: used, text: "Still here" }))).status).toBe(200);
    await owner
      .update(replyAddress)
      .set({ lastUsedAt: ago(91) })
      .where(and(ofVisitor, sql`${replyAddress.lastUsedAt} < now() - interval '1 day'`));
    const answer = await post(mime({ to: unused, text: "Too late" }));
    expect(answer.status).toBe(404);
    expect((await post(mime({ to: used, text: "Used yesterday" }))).status).toBe(200);
    expect(await pruneReplyAddresses(workerDb, 1000)).toBeGreaterThanOrEqual(1);
    expect(await owner.select().from(replyAddress).where(ofVisitor)).toHaveLength(1);
  });

  test("names its workspace, and another workspace's ID finds nothing", async () => {
    const chat = await newChat(a);
    const to = await addressFor(a, chat);
    const other = to.replace(a.id.replaceAll("-", ""), b.id.replaceAll("-", ""));
    expect((await post(mime({ to: other, text: "Crossed" }))).status).toBe(404);
    expect(
      (await post(mime({ to: to.replace(DOMAIN, "elsewhere.example.com"), text: "Elsewhere" })))
        .status,
    ).toBe(404);
    // The case of the address does not matter, as some mail systems change it.
    expect((await post(mime({ to: to.toUpperCase(), text: "Loud" }))).status).toBe(200);
    expect(await messagesOf(chat.conversationId)).toHaveLength(1);
  });

  test("goes with its conversation", async () => {
    const chat = await newChat();
    await addressFor(a, chat);
    await owner.delete(conversation).where(eq(conversation.id, chat.conversationId));
    const left = await owner
      .select({ id: replyAddress.id })
      .from(replyAddress)
      .where(eq(replyAddress.conversationId, chat.conversationId));
    expect(left).toEqual([]);
  });
});

describe("the text", () => {
  test.each([
    ["en", "On Mon, Acme wrote:", "> Write your reply above this line"],
    ["fr", "Le lun. 13 nov., Acme a écrit :", "> Écrivez votre réponse au-dessus de cette ligne"],
    ["es", "El lun, 13 nov, Acme escribió:", "> Escribe tu respuesta encima de esta línea"],
  ])("is cut at the marker line in %s, with the line that names the quote", (_, said, marker) => {
    expect(replyText(`Merci\n\n${said}\n${marker}\n> Hi,\n> More`)).toBe("Merci");
  });

  test("keeps a reply that mentions the marker in a sentence", () => {
    const text = 'What does "Write your reply above this line" mean?\nI wrote below it.\n\nAda';
    expect(replyText(text)).toBe(text);
  });

  test("is cut at Outlook's headers above an unquoted copy", () => {
    const text = [
      "It works now, thanks.",
      "",
      "________________________________",
      "From: Acme <support@acme.example>",
      "Sent: Monday, November 13, 2026 10:00 AM",
      "To: Ada <ada@example.com>",
      "Subject: Acme replied to your message",
      "",
      "Write your reply above this line",
      "",
      "Hi,",
    ].join("\r\n");
    expect(replyText(text)).toBe("It works now, thanks.");
  });

  test("is cut at a Gmail attribution that wraps onto two lines", () => {
    const text = [
      "Thanks!",
      "",
      "On Mon, 13 Nov 2026 at 10:00, Acme Support Team <",
      "support@acme.example> wrote:",
      "",
      "> Write your reply above this line",
      ">",
      "> Hi,",
    ].join("\n");
    expect(replyText(text)).toBe("Thanks!");
  });

  test("keeps the visitor's lines right above a quote's name, with no blank line between", () => {
    // HTML mail has no blank line between paragraphs once it becomes text.
    const said = "Yes, please.\nOn Monday, Acme wrote:\n> Write your reply above this line";
    expect(replyText(said)).toBe("Yes, please.");
    const outlook =
      "It works.\nFrom: Acme\nSent: Monday\nSubject: Re\nWrite your reply above this line";
    expect(replyText(outlook)).toBe("It works.");
  });

  test("keeps the visitor's text right above the quote when nothing names it", () => {
    expect(replyText("Thanks\nAda\n\n> Write your reply above this line\n> Hi,")).toBe(
      "Thanks\nAda",
    );
  });

  test.each(["Order: 1042", "My order:", "Date: tomorrow works"])(
    "keeps %j above the quote, which names no quote",
    (said) => {
      expect(replyText(`${said}\n\n> Write your reply above this line\n> Hi,`)).toBe(said);
    },
  );

  test("is cut at French Outlook headers", () => {
    const text =
      "Merci\n\nDe : Acme\nEnvoyé : lundi\nÀ : Ada\nObjet : Re\n\n> Write your reply above this line";
    expect(replyText(text)).toBe("Merci");
  });

  test("keeps everything without a marker, signatures too", () => {
    const text = "Thanks:\n\n> Some quote\n\n-- \nAda Lovelace\nAnalytical Engines Ltd";
    expect(replyText(text)).toBe(text);
  });

  test("is split into messages within the limit, at a paragraph or line break near the end", () => {
    const paragraph = "a".repeat(MESSAGE_MAX - 10);
    expect(textParts(`${paragraph}\n\n${"b".repeat(20)}`)).toEqual([paragraph, "b".repeat(20)]);
    const line = "c".repeat(MESSAGE_MAX - 5);
    expect(textParts(`${line}\n${"d".repeat(20)}`)).toEqual([line, "d".repeat(20)]);
    // With no break near, the cut falls at the limit and never inside an emoji.
    const emoji = `${"e".repeat(MESSAGE_MAX - 1)}😀f`;
    expect(textParts(emoji)).toEqual(["e".repeat(MESSAGE_MAX - 1), "😀f"]);
    expect(textParts("g".repeat(MESSAGE_MAX * 10))).toHaveLength(10);
    expect(textParts("g".repeat(MESSAGE_MAX * 10 + 1))).toBeNull();
  });
});

test.each([
  [{ via: "email", fromOtherAddress: true } as const, { via: "email", fromOtherAddress: true }],
  [{ via: "email", fromOtherAddress: false } as const, { via: "email", fromOtherAddress: false }],
  [undefined, { via: null }],
])(
  "a stored message says how it came, with fromOtherAddress only by email",
  async (source, via) => {
    const chat = await newChat();
    const result = await withWorkspace(db, a.id, (tx) =>
      appendMessage(
        tx,
        a.id,
        { kind: "visitor", visitorId: chat.visitorId, conversationId: chat.conversationId },
        { clientId: randomUUID(), body: "Hi", source },
      ),
    );
    expect(result.message).toMatchObject(via);
    expect("fromOtherAddress" in result.message).toBe(source !== undefined);
  },
);
