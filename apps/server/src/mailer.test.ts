import PostalMime from "postal-mime";
import { expect, test } from "vitest";
import { fakeSmtp } from "../test/smtp.ts";
import { createMailer } from "./mailer.ts";

test("the Reply-To keeps a name with quotes and non-ASCII as it was", async () => {
  const smtp = await fakeSmtp();
  try {
    const replyTo = {
      name: 'Café "Le Coin" <Paris>, Ltd.',
      address: "reply+a.b@reply.example.com",
    };
    await createMailer(smtp.url, "hello@example.com", { pool: false }).send(
      "ada@example.com",
      "Hi",
      "Hello",
      { replyTo },
    );
    const email = await PostalMime.parse(smtp.received[0] ?? "");
    expect(email.replyTo).toEqual([replyTo]);
  } finally {
    smtp.close();
  }
});
