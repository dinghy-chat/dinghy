import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { answer, visitor } from "./chat.ts";
import { signedIn } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';
// The test server answers this name with the host site, which permits it as a fetch target.
const GUIDE = "http://docs.example/guide";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/": { html: `<!doctype html><title>Host</title><h1>Shop</h1>${SNIPPET}` },
    "/guide": {
      html: '<!doctype html><html><head><meta property="og:title" content="Reset your password"></head><body>Steps</body></html>',
    },
  });
  await server.createOperator("alice@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test("a pasted link shows its card in the composer, and the card goes out with the reply", async ({
  browser,
}) => {
  const customer = await visitor(browser, server, "/", "How do I reset my password?");
  const other = await visitor(browser, server, "/", "Where is my order?");
  const alice = await signedIn(browser, server, "alice@example.com");
  await alice.locator(".row", { hasText: "How do I reset" }).click();

  const reply = alice.getByRole("textbox", { name: "Your reply" });
  const card = alice.locator(".compose .link-card");
  await reply.fill(`Here: ${GUIDE}`);
  await expect(card).toContainText("Reset your password");
  await expect(card).toContainText("docs.example");

  // A removed card stays removed with the draft, also after another conversation, and the reply
  // goes without it.
  const asked: string[] = [];
  alice.on("request", (request) => {
    if (request.url().endsWith("/link-preview")) asked.push(request.url());
  });
  await card.getByRole("button", { name: "Remove the link preview" }).click();
  await expect(card).toHaveCount(0);
  await alice.locator(".row", { hasText: "Where is my order" }).click();
  // The row shows the draft while another conversation is open.
  await alice.locator(".row", { hasText: GUIDE }).click();
  await expect(reply).toContainText(GUIDE);
  await answer(alice, `Here: ${GUIDE} thanks`);
  expect(asked).toEqual([]);
  await expect(
    alice.locator(".bubble-row", { hasText: "thanks" }).locator(".link-card"),
  ).toHaveCount(0);

  // The next draft starts over.
  await reply.fill(`Follow ${GUIDE}`);
  await expect(card).toContainText("Reset your password");
  await reply.press("Enter");
  await expect(card).toHaveCount(0);
  const sent = alice.locator(".bubble-row", { hasText: "Follow" });
  await expect(sent.locator(".link-card")).toContainText("Reset your password");

  const shown = customer.locator(".msg:not(.mine) .lp");
  await expect(shown).toContainText("Reset your password");
  await expect(shown).toContainText("docs.example");
  await expect(shown).toHaveAttribute("href", GUIDE);
  await expect(shown).toHaveAttribute("target", "_blank");

  for (const page of [customer, other, alice]) await page.context().close();
});
