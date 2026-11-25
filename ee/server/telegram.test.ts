// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../apps/server/src/config.ts";
import { cloudFromConfig } from "./index.ts";
import {
  createTelegram,
  type Notice,
  noticeHtml,
  type TelegramSettings,
  telegramFromConfig,
} from "./telegram.ts";

const TOKEN = "123456:secret-bot-token";
const settings = (send: typeof fetch, topics: TelegramSettings["topics"] = {}) => ({
  token: TOKEN,
  chatId: "-1006098886410",
  topics,
  fetch: send,
});
const notice: Notice = { title: "Workspace created", fields: [["Owner", "jane@acme.com"]] };

/** A fake fetch that records each call and answers with `answer`. */
function fakeFetch(answer: () => Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const send = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return answer();
  };
  return { calls, send: send as typeof fetch };
}

/** A logger whose lines the test reads. */
function capturedLogger() {
  const lines: string[] = [];
  return { lines, logger: pino({ level: "warn" }, { write: (line: string) => lines.push(line) }) };
}

const ok = () => Promise.resolve(Response.json({ ok: true }));

describe("Telegram notices", () => {
  test("a notice is a bold title and one line per field, with every value escaped", () => {
    expect(
      noticeHtml({
        title: "Workspace <created> & more",
        fields: [
          ["Workspace", { name: "Acme <b>&</b>", id: "w-1" }],
          ["Owner", "jane@acme.com"],
        ],
      }),
    ).toBe(
      "<b>Workspace &lt;created&gt; &amp; more</b>\n\n" +
        "<b>Workspace:</b> Acme &lt;b&gt;&amp;&lt;/b&gt; (<code>w-1</code>)\n" +
        "<b>Owner:</b> jane@acme.com",
    );
  });

  test("a set topic posts to its thread, and General, unset or 1, gets no thread", async () => {
    const { calls, send } = fakeFetch(ok);
    const silent = pino({ level: "silent" });
    const notify = createTelegram(settings(send, { signups: 7, billing: 1 }), silent);
    await notify?.("signups", notice);
    await notify?.("billing", notice);
    await createTelegram(settings(send), silent)?.("billing", notice);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.body).toEqual({
      chat_id: "-1006098886410",
      message_thread_id: 7,
      text: "<b>Workspace created</b>\n\n<b>Owner:</b> jane@acme.com",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    expect(calls[1]?.body).not.toHaveProperty("message_thread_id");
    expect(calls[2]?.body).not.toHaveProperty("message_thread_id");
  });

  test("a refused or failed send resolves, and logs a warning without the token", async () => {
    for (const answer of [
      () => Promise.resolve(Response.json({ description: "Bad Request" }, { status: 500 })),
      () => Promise.reject(new TypeError(`fetch failed for /bot${TOKEN}/sendMessage`)),
    ]) {
      const { lines, logger } = capturedLogger();
      const notify = createTelegram(settings(fakeFetch(answer).send), logger);
      await expect(notify?.("billing", notice)).resolves.toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("a Telegram notice was not sent");
      expect(lines[0]).not.toContain("secret-bot-token");
    }
  });

  test("with the bot or the chat unset, there is no sender, and Telegram alone is no cloud", () => {
    const env = {
      DATABASE_URL: "postgres://x@db/x",
      VALKEY_URL: "redis://valkey",
      AUTH_SECRET: "a".repeat(40),
    };
    expect(telegramFromConfig(loadConfig(env))).toBeUndefined();
    expect(telegramFromConfig(loadConfig({ ...env, TELEGRAM_BOT_TOKEN: TOKEN }))).toBeUndefined();
    expect(createTelegram(undefined, pino({ level: "silent" }))).toBeUndefined();
    const telegram = {
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: "-100",
      TELEGRAM_TOPIC_BILLING: "3",
    };
    expect(telegramFromConfig(loadConfig({ ...env, ...telegram }))).toEqual({
      token: TOKEN,
      chatId: "-100",
      topics: { signups: undefined, billing: 3 },
    });
    expect(cloudFromConfig(loadConfig({ ...env, ...telegram }))).toBeUndefined();
  });
});
