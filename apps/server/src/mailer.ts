import nodemailer from "nodemailer";
import type { Logger } from "pino";
import { safeErrorFields } from "./errors.ts";

export interface Mailer {
  /** `html` is an optional second version of the same email, for mail apps that show HTML. */
  send(
    to: string,
    subject: string,
    text: string,
    headers?: Record<string, string>,
    html?: string,
  ): Promise<void>;
}

/** One plain-text email, as the builders in letter.ts make them. */
export interface Mail {
  subject: string;
  body: string;
}

/**
 * Sends one email after the answer, and logs a failure: what committed stays, whatever the mail
 * server does. Without a mailer, it sends nothing.
 */
export function sendQuietly(
  mailer: Mailer | undefined,
  logger: Logger,
  to: string,
  mail: Mail,
): void {
  mailer?.send(to, mail.subject, mail.body).catch((err: unknown) => {
    logger.error(safeErrorFields(err), "could not send an email");
  });
}

/** The mail server refused the address itself, such as a mailbox that does not exist. */
export function recipientRejected(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "EENVELOPE" &&
    "responseCode" in err &&
    typeof err.responseCode === "number" &&
    err.responseCode >= 500
  );
}

/** SMTP connections open at once. The worker sends no more emails than this at a time. */
export const MAIL_CONNECTIONS = 3;

/**
 * Sends mail through the SMTP server in the settings. Self-hosting works without one. A command
 * that sends one email and exits passes `pool: false`, so no open connection keeps it running.
 */
export function createMailer(smtpUrl: string, from: string, { pool = true } = {}): Mailer {
  // One pooled connection set, so each email does not open and secure its own. The socket timeouts
  // end a stalled send inside nodemailer, before the worker's own limit, so its connection frees up.
  const transport = nodemailer.createTransport({
    url: smtpUrl,
    pool,
    maxConnections: MAIL_CONNECTIONS,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    async send(to, subject, text, headers, html) {
      await transport.sendMail({
        from,
        to,
        subject,
        text,
        ...(html !== undefined && { html }),
        ...(headers && { headers }),
      });
    },
  };
}
