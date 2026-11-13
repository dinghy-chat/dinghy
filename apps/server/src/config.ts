import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { InboundEmail } from "./inbound-email.ts";
import type { PushKeys } from "./push.ts";
import type { ShipmailInbound } from "./shipmail-inbound.ts";

const schema = z.object({
  DATABASE_URL: z.url(),
  // The worker's own login, because only that role can find work across workspaces.
  WORKER_DATABASE_URL: z.url().optional(),
  VALKEY_URL: z.url(),
  // The server's public URL, such as https://chat.example.com.
  PUBLIC_URL: z.url(),
  AUTH_SECRET: z.string().min(32),
  SMTP_URL: z.url().optional(),
  MAIL_FROM: z.string().min(3).optional(),
  // Web push stays off until all three are set. `chat push-keys` makes the keys.
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  // A real contact that push services can use, as mailto: or https:.
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:)/)
    .optional(),
  // How many proxies you run in front of this server, such as 1 for Cloudflare alone. The default of 0
  // reads the address from the connection. Too high lets a client choose its own address, and too
  // low makes all visitors share one, so limits would apply to all of them at once.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Multiplies every rate limit. Keep the default. A load test from one machine needs a large one.
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  WIDGET_DIR: z.string().optional(),
  OPERATOR_DIR: z.string().optional(),
  // Where images go: this directory, or S3-compatible storage when S3_BUCKET is set.
  STORAGE_DIR: z.string().default("/data/images"),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Optional. A separate origin for uploads, such as https://files.example.com, that reaches this same
  // server. Upload URLs then use it, and the file route answers only there.
  UPLOADS_ORIGIN: z.url().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  // DB-IP's IP to Country Lite database, which the image downloads when it is built, for the live
  // view's countries. Without it, every country is unknown.
  GEOIP_COUNTRY_FILE: z.string().optional(),
  // Off by default: webhooks go only to https addresses on the public internet. Set it to true on a
  // self-hosted install that sends webhooks to its own network, over http or to a private address.
  WEBHOOK_ALLOW_PRIVATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Visitors reply to their emails when the domain of the reply addresses is set, such as
  // reply.example.com, with at least one way for that mail to reach this server: the secret that
  // signs each post of the raw forwarder, or the three Shipmail settings below.
  INBOUND_EMAIL_DOMAIN: z.hostname().optional(),
  INBOUND_EMAIL_SECRET: z.string().min(32).optional(),
  // Shipmail's webhook for the mailbox that gets the replies: the API key that downloads and
  // deletes each email, the webhook's signing secret, and the mailbox. All three or none.
  SHIPMAIL_API_KEY: z.string().min(1).optional(),
  SHIPMAIL_WEBHOOK_SECRET: z.string().min(1).optional(),
  SHIPMAIL_MAILBOX_ID: z.string().min(1).optional(),
  // Tests point this at a local fake.
  SHIPMAIL_API_BASE: z
    .url()
    .default("https://shipmail.to/api/v1")
    .transform((url) => url.replace(/\/+$/, "")),
  // The metrics route stays off unless this is set, because it should not be public.
  METRICS_TOKEN: z.string().min(16).optional(),
  // The cloud plan's billing, read by ee/server. It stays off unless all three are set, so a
  // self-hosted install leaves them unset.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_ID: z.string().min(1).optional(),
  // Tests point this at a local fake.
  STRIPE_API_BASE: z.url().default("https://api.stripe.com"),
  // Cloud only, and a self-hosted install leaves it unset. With `early` and no Stripe keys, anyone
  // can sign up and use the dashboard, and the widget stays off until the cloud opens. With Stripe
  // keys set, signup asks for payment first, whatever this says.
  CLOUD_SIGNUP: z.enum(["early"]).optional(),
  // Cloud only. Each new cloud workspace starts with a chat with Dinghy's founder: this operator,
  // in this workspace, whose inbox gets the replies. With either unset, there is none. The server refuses to start
  // when the operator is not an active member of the workspace.
  CLOUD_WELCOME_WORKSPACE_ID: z.uuid().optional(),
  CLOUD_WELCOME_OPERATOR_EMAIL: z
    .email()
    .transform((email) => email.toLowerCase())
    .optional(),
  // Optional. Errors go to this Sentry project, which the owner of the install chooses. Unset, the
  // Sentry SDK is never loaded.
  SENTRY_DSN: z.url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).default("production"),
});

export type Config = z.infer<typeof schema>;

/** The settings that can come from a file in DINGHY_SECRETS_DIR, named in lower case. */
const FROM_FILES = [
  "DATABASE_URL",
  "WORKER_DATABASE_URL",
  "VALKEY_URL",
  "AUTH_SECRET",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "INBOUND_EMAIL_SECRET",
  "SHIPMAIL_API_KEY",
  "SHIPMAIL_WEBHOOK_SECRET",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // Compose passes an unset optional setting as an empty string, which means not set.
  const merged: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== ""),
  );
  const directory = merged.DINGHY_SECRETS_DIR;
  if (directory !== undefined) {
    for (const name of FROM_FILES) {
      if (merged[name] !== undefined) continue;
      try {
        merged[name] = readFileSync(join(directory, name.toLowerCase()), "utf8").trim();
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") throw error;
      }
    }
  }
  merged.PUBLIC_URL ??=
    merged.CHAT_DOMAIN === undefined
      ? `http://localhost:${merged.DINGHY_PORT ?? 3000}`
      : `https://${merged.CHAT_DOMAIN}`;
  // The old name, read until the next release.
  merged.UPLOADS_ORIGIN ??= merged.IMAGES_ORIGIN;
  const config = schema.parse(merged);
  // The uploads origin answers nothing but files, so on the app's own origin it would hide the app.
  if (
    config.UPLOADS_ORIGIN !== undefined &&
    new URL(config.UPLOADS_ORIGIN).host === new URL(config.PUBLIC_URL).host
  ) {
    throw new Error("Set UPLOADS_ORIGIN to another host than PUBLIC_URL, or leave it unset.");
  }
  return config;
}

export function pushKeysFromConfig(config: Config): PushKeys | undefined {
  const {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: subject,
  } = config;
  if (publicKey === undefined && privateKey === undefined && subject === undefined)
    return undefined;
  if (publicKey === undefined || privateKey === undefined || subject === undefined) {
    throw new Error("Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together.");
  }
  return { publicKey, privateKey, subject };
}

export function inboundEmailFromConfig(config: Config): InboundEmail | undefined {
  const { INBOUND_EMAIL_DOMAIN: domain, INBOUND_EMAIL_SECRET: secret } = config;
  const shipmail = shipmailFromConfig(config);
  if (domain === undefined && secret === undefined && shipmail === undefined) return undefined;
  if (domain === undefined || (secret === undefined && shipmail === undefined)) {
    throw new Error(
      "Set INBOUND_EMAIL_DOMAIN with INBOUND_EMAIL_SECRET, with the three SHIPMAIL_ settings, or with both.",
    );
  }
  return { domain: domain.toLowerCase(), secret, shipmail };
}

function shipmailFromConfig(config: Config): ShipmailInbound | undefined {
  const {
    SHIPMAIL_API_KEY: apiKey,
    SHIPMAIL_WEBHOOK_SECRET: webhookSecret,
    SHIPMAIL_MAILBOX_ID: mailboxId,
  } = config;
  if (apiKey === undefined && webhookSecret === undefined && mailboxId === undefined) {
    return undefined;
  }
  if (apiKey === undefined || webhookSecret === undefined || mailboxId === undefined) {
    throw new Error(
      "Set SHIPMAIL_API_KEY, SHIPMAIL_WEBHOOK_SECRET and SHIPMAIL_MAILBOX_ID together.",
    );
  }
  return { apiBase: config.SHIPMAIL_API_BASE, apiKey, webhookSecret, mailboxId };
}
