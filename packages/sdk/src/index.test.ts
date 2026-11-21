import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, expectTypeOf, test } from "vitest";
import { type components, Dinghy, DinghyError, type WebhookEvent } from "./index.ts";

const WORKSPACE_ID = randomUUID();
const API_KEY = `dk_${WORKSPACE_ID}.secret`;
const URL_BASE = "https://chat.example.com";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers each call with the next answer, and records what it was sent. */
function fakeFetch(answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error("No answer left");
    return Promise.resolve(next());
  };
  return { fetch, sent };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
const dropped = () => {
  throw new TypeError("fetch failed");
};

const client = (fetch: ReturnType<typeof fakeFetch>["fetch"], extra = {}) =>
  new Dinghy({ url: URL_BASE, apiKey: API_KEY, fetch, ...extra });

const OUTBOUND = { outboundMessage: { id: "om_1" } };

describe("requests", () => {
  test("fill the workspace from the key, and send the key as a bearer token", async () => {
    const { fetch, sent } = fakeFetch([json(200, { labels: [] })]);
    expect(await client(fetch).labels.list()).toEqual({ labels: [] });
    expect(sent[0]?.url).toBe(`${URL_BASE}/v1/operator/workspaces/${WORKSPACE_ID}/labels`);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("put path parameters and the query in the URL", async () => {
    const { fetch, sent } = fakeFetch([json(200, { messages: [] })]);
    await client(fetch).conversations.messages("c/1", { limit: 5 });
    expect(sent[0]?.url).toBe(
      `${URL_BASE}/v1/operator/workspaces/${WORKSPACE_ID}/conversations/c%2F1/messages?limit=5`,
    );
  });

  test("refuse a key that names no workspace", () => {
    expect(() => new Dinghy({ url: URL_BASE, apiKey: "sk_live" })).toThrow(TypeError);
  });

  test("throw the server's error code and message", async () => {
    const refusal = {
      error: { code: "send_mode_required", message: "This key drafts replies." },
    };
    const { fetch } = fakeFetch([json(403, refusal)]);
    const sending = client(fetch).outboundMessages.send({ visitor: { userId: "42" }, body: "Hi" });
    await expect(sending).rejects.toBeInstanceOf(DinghyError);
    await expect(sending).rejects.toMatchObject({
      status: 403,
      code: "send_mode_required",
      message: "This key drafts replies.",
    });
  });

  test("throw a generic error for a body that is not the API's", async () => {
    const { fetch } = fakeFetch([() => new Response("Bad gateway", { status: 502 })]);
    await expect(client(fetch).labels.list()).rejects.toMatchObject({
      status: 502,
      code: "unexpected_response",
    });
  });
});

describe("retries", () => {
  test("keep the client ID they made across 429 and a dropped connection", async () => {
    const { fetch, sent } = fakeFetch([
      json(
        429,
        { error: { code: "too_many_requests", message: "Slow down" } },
        { "retry-after": "0" },
      ),
      dropped,
      json(201, OUTBOUND),
    ]);
    const answer = await client(fetch).outboundMessages.send({
      visitor: { userId: "42" },
      body: "Welcome",
      dedupeKey: "welcome",
    });
    expect(answer).toEqual(OUTBOUND);
    const ids = sent.map((one) => (one.body as { clientId: string }).clientId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("keep the caller's client ID", async () => {
    const { fetch, sent } = fakeFetch([json(201, OUTBOUND)]);
    await client(fetch).outboundMessages.send({
      clientId: "mine",
      visitor: { id: "v" },
      body: "Hi",
    });
    expect(sent[0]?.body).toMatchObject({ clientId: "mine" });
  });

  test("stop after 3 tries and throw the last error", async () => {
    const busy = json(503, { error: { code: "busy", message: "Busy" } }, { "retry-after": "0" });
    const { fetch, sent } = fakeFetch([busy, busy, busy]);
    await expect(client(fetch).labels.list()).rejects.toMatchObject({ status: 503, code: "busy" });
    expect(sent).toHaveLength(3);
  });

  test("do not repeat a POST with no client ID after a dropped connection", async () => {
    const { fetch, sent } = fakeFetch([dropped, json(201, {})]);
    const creating = client(fetch).webhooks.create({
      url: "https://example.com/hook",
      events: ["message.created"],
    });
    await expect(creating).rejects.toThrow("fetch failed");
    expect(sent).toHaveLength(1);
  });
});

describe("outbound messages", () => {
  test("cancel by ID or by the visitor and the dedupe key", async () => {
    const { fetch, sent } = fakeFetch([json(200, OUTBOUND), json(200, OUTBOUND)]);
    const dinghy = client(fetch);
    await dinghy.outboundMessages.cancel({ id: "om_1" });
    await dinghy.outboundMessages.cancel({ visitor: { userId: "42" }, dedupeKey: "dns:7" });
    const base = `${URL_BASE}/v1/operator/workspaces/${WORKSPACE_ID}/outbound-messages`;
    expect(sent.map((one) => one.url)).toEqual([`${base}/om_1/cancel`, `${base}/cancel`]);
    expect(sent[1]?.body).toEqual({ visitor: { userId: "42" }, dedupeKey: "dns:7" });
  });
});

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

describe("campaigns", () => {
  const at = (path: string) => `${URL_BASE}/v1/operator/workspaces/${WORKSPACE_ID}${path}`;

  test("name a campaign by its key or by its ID, and a send gets a client ID", async () => {
    const id = randomUUID();
    const { fetch, sent } = fakeFetch([json(200, {}), json(200, {}), json(201, OUTBOUND)]);
    const dinghy = client(fetch);
    await dinghy.campaigns.pause("onboarding-done");
    await dinghy.campaigns.results({ id }, { from: "2026-11-01" });
    await dinghy.campaigns.send("onboarding-done", {
      visitor: { userId: "42" },
      data: { plan: "Pro" },
    });
    expect(sent.map((one) => [one.method, one.url])).toEqual([
      ["POST", at("/campaigns/by-key/onboarding-done/pause")],
      ["GET", at(`/campaigns/${id}/results?from=2026-11-01`)],
      ["POST", at("/campaigns/by-key/onboarding-done/send")],
    ]);
    expect(sent[2]?.body).toMatchObject({
      visitor: { userId: "42" },
      clientId: expect.any(String),
    });
  });

  test("upsert by the definition's key, and track an event", async () => {
    const { fetch, sent } = fakeFetch([json(200, {}), json(200, { counted: true })]);
    const dinghy = client(fetch);
    const definition = {
      key: "dns-help",
      name: "DNS help",
      trigger: { type: "api" as const },
      message: { body: "Hi" },
      presentation: {
        startConversation: "on_reply" as const,
        show: "badge" as const,
        ifConversationOpen: "skip" as const,
      },
    };
    await dinghy.campaigns.upsert(definition);
    await dinghy.track({ visitor: { userId: "42" }, name: "export.finished", id: "e-1" });
    expect(sent.map((one) => [one.method, one.url])).toEqual([
      ["PUT", at("/campaigns/by-key/dns-help")],
      ["POST", at("/track")],
    ]);
    expect(sent[0]?.body).toEqual(definition);
  });
});

describe("identity.sign", () => {
  const options = { signingSecret: "s3cret", publicKey: "wk_test" };

  test("makes an HS256 token for the public key, valid for one hour", async () => {
    const token = await client(fakeFetch([]).fetch, options).identity.sign({
      userId: "42",
      name: "Ada",
      attributes: { plan: "pro" },
    });
    const [header = "", payload = "", signature = ""] = token.split(".");
    const expected = createHmac("sha256", "s3cret")
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expected);
    expect(decode(header)).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims).toMatchObject({
      sub: "42",
      aud: "wk_test",
      name: "Ada",
      attributes: { plan: "pro" },
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
  });

  test("refuses a token that lives longer than 24 hours", async () => {
    const dinghy = client(fakeFetch([]).fetch, options);
    await expect(dinghy.identity.sign({ userId: "42", expiresInSeconds: 86_401 })).rejects.toThrow(
      RangeError,
    );
  });

  test("needs the signing secret", async () => {
    await expect(client(fakeFetch([]).fetch).identity.sign({ userId: "42" })).rejects.toThrow(
      "signingSecret",
    );
  });
});

describe("webhooks.verify", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({
    id: "evt_1",
    type: "outbound_message.read",
    createdAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    data: { outboundMessage: { id: "om_1" } },
  });
  // As the server signs: the hex HMAC-SHA256 of "time.body".
  const signed = (time: number, text = body) =>
    `t=${time},v1=${createHmac("sha256", secret).update(`${time}.${text}`).digest("hex")}`;
  const now = () => Math.floor(Date.now() / 1000);
  const dinghy = client(fakeFetch([]).fetch, { webhookSecret: secret });

  test("returns the body of a signed request", async () => {
    const request = new Request("https://example.com/hook", {
      method: "POST",
      headers: { "Dinghy-Signature": signed(now()), "Dinghy-Event-Id": "evt_1" },
      body,
    });
    const event = await dinghy.webhooks.verify(request);
    expect(event.type).toBe("outbound_message.read");
    if (event.type === "outbound_message.read") expect(event.data.outboundMessage.id).toBe("om_1");
  });

  test("types each event's data by its type", () => {
    type DataOf<T extends WebhookEvent["type"]> = Extract<WebhookEvent, { type: T }>["data"];
    type Schemas = components["schemas"];
    expectTypeOf<DataOf<"draft.change_requested">>().toEqualTypeOf<{
      changeRequest: Schemas["DraftChangeRequest"];
      draft: Schemas["Draft"];
    }>();
    expectTypeOf<DataOf<"campaign.updated">>().toEqualTypeOf<{ campaign: Schemas["Campaign"] }>();
    expectTypeOf<DataOf<"conversation.closed">>().toEqualTypeOf<{
      conversation: Schemas["Conversation"];
    }>();
  });

  test("takes a raw body and Node's headers", async () => {
    const headers = { "dinghy-signature": signed(now()) };
    expect(await dinghy.webhooks.verify({ body: Buffer.from(body), headers })).toMatchObject({
      id: "evt_1",
    });
  });

  test("refuses a changed body, an old timestamp and a missing header", async () => {
    const changed = {
      body: body.replace("om_1", "om_2"),
      headers: { "dinghy-signature": signed(now()) },
    };
    const old = { body, headers: { "dinghy-signature": signed(now() - 301) } };
    for (const received of [changed, old, { body, headers: {} }]) {
      await expect(dinghy.webhooks.verify(received)).rejects.toMatchObject({
        code: "bad_signature",
      });
    }
  });
});

const sse = (text: string) => () =>
  new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });

const eventData = (type: string, data: unknown) =>
  JSON.stringify({ type, workspaceId: WORKSPACE_ID, data });

describe("events.stream", () => {
  test("yields events, skips pings and notices, and resumes after the last one", async () => {
    const first = [
      ": ping",
      "",
      `event: message.created\nid: 1.5.0\ndata: ${eventData("message.created", { message: { id: "m1" } })}`,
      "",
      `event: notice\ndata: {"kind":"typing"}`,
      "",
      `event: close\ndata: {"reason":"lifetime"}`,
      "",
      "",
    ].join("\n");
    const second = `event: conversation.closed\r\nid: 1.6\r\ndata: ${eventData("conversation.closed", {})}\r\n\r\n`;
    const { fetch, sent } = fakeFetch([sse(first), sse(second)]);
    const stream = client(fetch).events.stream({
      types: ["message.created", "conversation.closed"],
    });
    const seen = [];
    for await (const event of stream) {
      seen.push({ id: event.id, type: event.type });
      if (seen.length === 2) break;
    }
    expect(seen).toEqual([
      { id: "1.5.0", type: "message.created" },
      { id: "1.6", type: "conversation.closed" },
    ]);
    expect(sent[0]?.url).toBe(`${URL_BASE}/v1/events?types=message.created%2Cconversation.closed`);
    expect(sent[0]?.headers["last-event-id"]).toBeUndefined();
    expect(sent[1]?.headers["last-event-id"]).toBe("1.5.0");
  });

  test("throws when the key is no longer valid", async () => {
    const { fetch } = fakeFetch([sse(`event: close\ndata: {"reason":"unauthorized"}\n\n`)]);
    const stream = client(fetch).events.stream();
    await expect(stream.next()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});
