import { createHash, randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";
import { openSettings } from "./settings.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

// A loopback address nothing listens on: the test answers it in the browser, as a CLI's listener does.
const REDIRECT = "http://127.0.0.1:9/callback";
const STATELESS = "2026-07-28";
const AGENT = "Claude Code";

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("owner@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

/** Registers with DCR, approves Setup with Drafts only in the browser, and redeems the code. */
async function connect(page: Page): Promise<string> {
  const registered = await fetch(`${server.apiOrigin}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: AGENT, redirect_uris: [REDIRECT] }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "agent-state",
    scope: "setup",
    resource: `${server.apiOrigin}/v1/mcp`,
  });
  await page.route(`${REDIRECT}**`, (route) =>
    route.fulfill({ contentType: "text/plain", body: "connected" }),
  );
  await page.goto(`${server.apiOrigin}/oauth/authorize?${query}`);
  await page.getByRole("radio", { name: "Setup" }).check();
  await page.getByRole("radio", { name: "Drafts only" }).check();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:9\/callback\?/);
  const answer = new URL(page.url()).searchParams;
  expect(answer.get("state")).toBe("agent-state");

  const token = await fetch(`${server.apiOrigin}/v1/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: answer.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${server.apiOrigin}/v1/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  const granted = (await token.json()) as { access_token: string; scope: string };
  expect(granted.scope).toBe("conversations setup");
  return granted.access_token;
}

interface ToolAnswer {
  isError: boolean;
  structuredContent: Record<string, unknown>;
}

/** An MCP client that speaks the stateless 2026-07-28 protocol with an OAuth access token. */
function mcpClient(accessToken: string) {
  let ids = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    ids += 1;
    const name = typeof params.name === "string" ? { "mcp-name": params.name } : {};
    const response = await fetch(`${server.apiOrigin}/v1/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": STATELESS,
        "mcp-method": method,
        ...name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ids,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": STATELESS,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "e2e-agent", version: "1.0.0" },
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: Record<string, unknown> };
    expect(body.result.resultType).toBe("complete");
    return body.result;
  };
  return {
    request,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await request("tools/call", { name, arguments: args })) as unknown as ToolAnswer,
  };
}

test("an agent connects with OAuth, tests with a visitor, drafts a reply an operator sends, and hands off @smoke", async ({
  browser,
}) => {
  const page = await signedIn(browser, server, "owner@example.com");
  const mcp = mcpClient(await connect(page));

  const discovered = await mcp.request("server/discover");
  expect(discovered.supportedVersions).toContain(STATELESS);
  const { tools } = (await mcp.request("tools/list")) as { tools: { name: string }[] };
  expect(tools.map((one) => one.name)).toEqual(
    expect.arrayContaining(["verify_install", "wait_for_messages", "reply", "handoff"]),
  );

  const install = await mcp.call("verify_install");
  expect(install.isError).toBe(false);
  expect(install.structuredContent.widgetSeenAt).toBeNull();
  expect(install.structuredContent.nextStep).toEqual(expect.any(String));

  const start = await mcp.call("wait_for_messages");
  const cursor = start.structuredContent.cursor;
  expect(cursor).toEqual(expect.any(String));
  const sent = await mcp.call("simulate_visitor_message", {
    body: "Can I change my plan?",
    name: "Tess Test",
  });
  expect(sent.isError).toBe(false);
  const conversationId = sent.structuredContent.conversationId as string;
  const waited = await mcp.call("wait_for_messages", { cursor, timeoutSeconds: 10 });
  expect(waited.structuredContent.messages).toEqual([
    expect.objectContaining({
      conversationId,
      message: expect.objectContaining({ body: "Can I change my plan?" }),
      humanHandling: false,
    }),
  ]);

  const drafted = await mcp.call("reply", {
    conversationId,
    clientId: "agent-reply-1",
    body: "Yes, in **Settings > Billing**.",
  });
  expect(drafted.structuredContent.status).toBe("drafted");

  // An operator reads the suggestion and sends it.
  await page.goto(server.apiOrigin);
  await page.locator(".row", { hasText: "Tess Test" }).click();
  const card = page.locator(".draft-card");
  await expect(card).toContainText(`Suggested by ${AGENT}`);
  await expect(page.locator(".thread-head .handler")).toContainText(`Bot: ${AGENT}`);
  await card.getByRole("button", { name: "Send" }).click();
  await expect(
    page.locator(".bubble-row", { hasText: "Yes, in Settings > Billing." }),
  ).toBeVisible();
  const read = await mcp.call("get_conversation", { conversationId });
  const messages = read.structuredContent.messages as {
    body: string;
    authorOperatorId: string | null;
    authorApiKeyId: string | null;
  }[];
  expect(messages.at(-1)).toMatchObject({
    body: "Yes, in **Settings > Billing**.",
    authorOperatorId: expect.any(String),
    authorApiKeyId: null,
  });

  // The owner lets the agent send directly, so a person's handling is what stops its replies.
  await openSettings(page, "API & webhooks");
  const replies = page
    .locator(".key-item", { hasText: AGENT })
    .getByRole("button", { name: /Replies from/ });
  await replies.click();
  await page.getByRole("option", { name: "Send directly" }).click();
  await expect(replies).toContainText("Send directly");

  const handedOff = await mcp.call("handoff", {
    conversationId,
    clientId: "agent-handoff-1",
    reason: "Plan changes need a person",
  });
  expect(handedOff.structuredContent.status).toBe("handed_off");
  const refused = await mcp.call("reply", {
    conversationId,
    clientId: "agent-reply-2",
    body: "Anything else?",
  });
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent).toMatchObject({ error: { code: "human_handling" } });

  await page.goto(server.apiOrigin);
  await page.locator(".row", { hasText: "Tess Test" }).click();
  await expect(page.locator(".thread-head .handler")).toContainText("owner@example.com");
  await expect(
    page.locator(".team-note", { hasText: "Handed off: Plan changes need a person" }),
  ).toContainText(AGENT);

  const cleaned = await mcp.call("delete_test_visitors");
  expect(cleaned.structuredContent.deleted).toBe(1);
  await page.context().close();
});
