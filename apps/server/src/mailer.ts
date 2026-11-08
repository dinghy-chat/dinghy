import nodemailer from "nodemailer";

export interface Mailer {
  send(to: string, subject: string, text: string, headers?: Record<string, string>): Promise<void>;
}

/** SMTP connections open at once. The worker sends no more emails than this at a time. */
export const MAIL_CONNECTIONS = 3;

/** Sends mail through the SMTP server in the settings. Self-hosting works without one. */
export function createMailer(smtpUrl: string, from: string): Mailer {
  // One pooled connection set, so each email does not open and secure its own. The socket timeouts
  // end a stalled send inside nodemailer, before the worker's own limit, so its connection frees up.
  const transport = nodemailer.createTransport({
    url: smtpUrl,
    pool: true,
    maxConnections: MAIL_CONNECTIONS,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    async send(to, subject, text, headers) {
      await transport.sendMail({ from, to, subject, text, ...(headers && { headers }) });
    },
  };
}
