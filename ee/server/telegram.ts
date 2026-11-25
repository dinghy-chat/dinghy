// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import type { Config } from "../../apps/server/src/config.ts";

/** The bot and the group with topics that the cloud's admin notices go to. */
export interface TelegramSettings {
  token: string;
  chatId: string;
  /** Each topic's thread ID. Unset posts to the group's General topic. */
  topics: { signups?: number | undefined; billing?: number | undefined };
  /** Tests record the messages here instead of sending them. */
  fetch?: typeof fetch;
}

type TelegramTopic = keyof TelegramSettings["topics"];

/** A field's text, or a name with its ID in code, such as a workspace's. */
type FieldValue = string | { name: string; id: string };

/** A title in bold, then one line per field. */
export interface Notice {
  title: string;
  fields: [label: string, value: FieldValue][];
}

/** Posts a notice. It never rejects: a failure is logged and dropped. */
export type Notify = (topic: TelegramTopic, notice: Notice) => Promise<void>;

/** The settings, or none when the bot or the chat is unset. */
export function telegramFromConfig(config: Config): TelegramSettings | undefined {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = config;
  if (token === undefined || chatId === undefined) return undefined;
  return {
    token,
    chatId,
    topics: { signups: config.TELEGRAM_TOPIC_SIGNUPS, billing: config.TELEGRAM_TOPIC_BILLING },
  };
}

const TELEGRAM_TIMEOUT_MS = 5_000;

/** The General topic's thread ID, which Telegram accepts only as no thread. */
const GENERAL_TOPIC = 1;

/** Why Telegram refused a message, in its own words. */
const telegramError = z.object({ description: z.string() });

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const valueHtml = (value: FieldValue) =>
  typeof value === "string"
    ? escapeHtml(value)
    : `${escapeHtml(value.name)} (<code>${escapeHtml(value.id)}</code>)`;

/** The notice in Telegram's HTML. */
export function noticeHtml({ title, fields }: Notice): string {
  const lines = fields.map(([label, value]) => `<b>${escapeHtml(label)}:</b> ${valueHtml(value)}`);
  return [`<b>${escapeHtml(title)}</b>`, "", ...lines].join("\n");
}

/** How long from one time to another, such as "2h". */
export function elapsed(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** The sender, or none when the settings are unset. */
export function createTelegram(
  settings: TelegramSettings | undefined,
  logger: Logger,
): Notify | undefined {
  if (settings === undefined) return undefined;
  const send = settings.fetch ?? fetch;
  const url = `https://api.telegram.org/bot${settings.token}/sendMessage`;
  return async (topic, notice) => {
    const thread = settings.topics[topic];
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: settings.chatId,
          // Telegram refuses thread 1, the General topic, so General gets no thread at all.
          ...(thread !== undefined && thread !== GENERAL_TOPIC && { message_thread_id: thread }),
          text: noticeHtml(notice),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      if (response.ok) return;
      const answer = telegramError.safeParse(await response.json().catch(() => null));
      logger.warn(
        { status: response.status, description: answer.data?.description, topic },
        "a Telegram notice was not sent",
      );
    } catch (err) {
      // The URL holds the token, so only the error's name and message go to the log, without it.
      const { name, message } =
        err instanceof Error ? err : { name: "Error", message: String(err) };
      const error = { name, message: message.replaceAll(settings.token, "<token>") };
      logger.warn({ error, topic }, "a Telegram notice was not sent");
    }
  };
}
