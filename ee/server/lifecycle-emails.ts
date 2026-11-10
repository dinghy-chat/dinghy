// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { STOP_PAGE_SECURITY, stopPage } from "../../apps/server/src/alert-routes.ts";
import type { App } from "../../apps/server/src/app.ts";
import type { lifecycleEmailKind } from "../../apps/server/src/db/schema.ts";
import { workspaceMember } from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { limitByIp, type RateLimit } from "../../apps/server/src/rate-limit.ts";

/** The founder signs the cloud's lifecycle emails, and replies reach the founder too. */
export const LIFECYCLE_SIGN_OFF = "Cheers,\nJulien from Dinghy";

/** Where replies to every lifecycle email go. */
const SUPPORT_ADDRESS = "support@dinghy.chat";
const INSTALL_DOCS_URL = "https://dinghy.chat/docs/add-to-your-site";

type Kind = (typeof lifecycleEmailKind.enumValues)[number];

/** What an email may name. The dates come from the occurrence, so a retry says the same. */
export interface MailContext {
  name: string;
  /** Opens the workspace, where Settings has Billing, Export and the install code. */
  settingsUrl: string;
  signInUrl: string;
  /** The owner's own stop link, in onboarding emails only. */
  stopUrl: string | undefined;
  days: { readOnly: number };
  payUntil: Date;
  deleteOn: Date;
  endsOn: Date | null;
}

/** A date as people write it, such as "December 10, 2026". */
const date = (value: Date | null) =>
  value?.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }) ?? "";

// Plain text. Every string has a key here, so a locale can be added later. The voice is the founder
// writing to one person: short, warm, exact about dates, and never pushy.
const text = {
  readySubject: (name: string) => `${name} is ready`,
  readyBody: (c: MailContext) => [
    `Thanks for subscribing. ${c.name} is all set.`,
    "To put the chat on your site, open Settings, add your site under Allowed sites, then paste " +
      `the code from Install the chat into your pages: ${c.settingsUrl}`,
    `If you get stuck, the steps are here: ${INSTALL_DOCS_URL}`,
  ],
  installSubject: "Need a hand adding the chat?",
  installBody: (c: MailContext) => [
    `In case you haven't added the chat for ${c.name} yet, it only takes a minute.`,
    "Add your site in Settings under Allowed sites, then paste the code from Install the chat " +
      `into your pages: ${c.settingsUrl}`,
    `The steps are here too: ${INSTALL_DOCS_URL}`,
    "If something doesn't work, just reply and I'll help.",
  ],
  teamSubject: "Working with someone?",
  teamBody: (c: MailContext) => [
    `If someone helps you answer messages in ${c.name}, you can invite them in Settings under ` +
      `Team: ${c.settingsUrl}`,
    "You can also turn on alerts there, so you hear about new messages when the inbox is closed.",
    "Working alone? Then you can skip this one.",
  ],
  checkInSubject: "How's it going?",
  checkInBody: (c: MailContext) => [
    `It's been a week with ${c.name}, so I wanted to check in.`,
    "Is anything confusing, missing or just annoying? I'd really like to know, and good news is " +
      "welcome too.",
    "Just hit reply. I read every answer myself. And if you're busy, no need to write.",
  ],
  feedbackSubject: "What would you change?",
  feedbackBody: (c: MailContext) => [
    `It's been a month with ${c.name}. If you could change one thing about Dinghy, what would ` +
      "it be?",
    "Just reply. I read every answer myself. And if you'd rather skip it, that's fine.",
  ],
  stopLine: (url: string) => `Unsubscribe: ${url}`,
  stopLink: "Unsubscribe",
  cancellationSubject: (name: string, endsOn: Date | null) =>
    `${name} stays on until ${date(endsOn)}`,
  cancellationBody: (c: MailContext) => [
    `We got your cancellation for ${c.name}. Everything keeps working until ${date(c.endsOn)}.`,
    `After that, the chat goes off and the workspace stays read-only for ${c.days.readOnly} days, ` +
      "so your team can still read conversations and download an export. Then we delete it.",
    `Changed your mind? You can renew any time in Settings under Billing: ${c.settingsUrl}`,
    "And if you have a minute, I'd love to know why you're leaving. Just reply.",
  ],
  endingSoonSubject: (name: string, endsOn: Date | null) => `${name} ends on ${date(endsOn)}`,
  endingSoonBody: (c: MailContext) => [
    `A quick reminder that your plan for ${c.name} ends on ${date(c.endsOn)}. The chat goes ` +
      "off then, and nobody can reply.",
    `To keep it running, renew in Settings under Billing: ${c.settingsUrl}`,
    `If you're done with it, no problem. You can still download an export for ${c.days.readOnly} ` +
      "days after that.",
  ],
  paymentFailedSubject: (name: string) => `The payment for ${name} didn't go through`,
  paymentFailedBody: (c: MailContext) => [
    `The last payment for ${c.name} didn't go through. It happens, often because a card expired.`,
    `Everything keeps working until ${date(c.payUntil)}, and Stripe tries again on its own. ` +
      "If no payment clears by then, the chat goes off and the workspace turns read-only.",
    `You can update the card in Settings under Billing: ${c.settingsUrl}`,
  ],
  paymentReminderSubject: (name: string, payUntil: Date) =>
    `${name} keeps working until ${date(payUntil)}`,
  paymentReminderBody: (c: MailContext) => [
    `The payment for ${c.name} still hasn't gone through.`,
    `Everything keeps working until ${date(c.payUntil)}. After that, the chat goes off and the ` +
      "workspace turns read-only.",
    `Updating the card in Settings under Billing fixes it: ${c.settingsUrl}`,
  ],
  paymentLastDaySubject: (name: string, payUntil: Date) =>
    `${name} turns read-only on ${date(payUntil)}`,
  paymentLastDayBody: (c: MailContext) => [
    `The payment for ${c.name} still hasn't gone through, so on ${date(c.payUntil)} the chat ` +
      "goes off and the workspace turns read-only.",
    `Updating the card in Settings under Billing keeps it running: ${c.settingsUrl}`,
    "If something's wrong on our side, just reply and I'll sort it out.",
  ],
  paymentRecoveredSubject: (name: string) => `All good with ${name}`,
  paymentRecoveredBody: (c: MailContext) => [
    `Thanks, the payment for ${c.name} went through, and everything is back to normal.`,
    `Your invoices are in Settings under Billing: ${c.settingsUrl}`,
  ],
  readOnlySubject: (name: string) => `${name} is now read-only`,
  readOnlyBody: (c: MailContext) => [
    `${c.name} no longer has a paid plan, so it's read-only now. The chat is off, and nobody ` +
      "can reply.",
    "Your team can still sign in, read every conversation and download an export in Settings " +
      `under Export: ${c.settingsUrl}`,
    "Subscribe again in Settings under Billing and everything comes back, with all its data. " +
      `If not, we delete the workspace on ${date(c.deleteOn)}.`,
  ],
  welcomeBackSubject: (name: string) => `Welcome back to ${name}`,
  welcomeBackBody: (c: MailContext) => [
    `Thanks for subscribing again. ${c.name} is active, with all its conversations and settings.`,
    "Your team can reply again, and the chat works on your site again.",
    `Your billing is in Settings under Billing: ${c.settingsUrl}`,
  ],
  deletionLaterSubject: (name: string, deleteOn: Date) =>
    `${name} will be deleted on ${date(deleteOn)}`,
  deletionSubject: (name: string, deleteOn: Date) =>
    `Last reminder: ${name} will be deleted on ${date(deleteOn)}`,
  deletionBody: (c: MailContext) => [
    `${c.name} is still read-only. On ${date(c.deleteOn)}, we delete it with all its ` +
      "conversations and images.",
    `To keep it, subscribe again in Settings under Billing: ${c.settingsUrl}`,
    "Or, to keep a copy, download an export in Settings under Export before then.",
  ],
  deletedSubject: (name: string) => `${name} has been deleted`,
  deletedBody: (c: MailContext) => [
    `${c.name} was read-only for ${c.days.readOnly} days, so we've now closed it. Its ` +
      "conversations and images are being removed, and backup copies expire within 30 days.",
    `Your Dinghy account stays. If you ever want to start again, sign in and add a workspace: ` +
      `${c.signInUrl}`,
    "Thanks for giving Dinghy a try.",
  ],
  stopTitle: "Stop these emails",
  stopQuestion: "Stop Dinghy's tips and check-ins for this workspace? Billing emails still come.",
  stopButton: "Stop the emails",
  stopDone: "Done. You won't get these emails again.",
  stopInvalid: "This link doesn't work.",
};

interface Mail {
  subject: string;
  body: string[];
}

const MAILS: Record<Kind, (c: MailContext) => Mail> = {
  ready: (c) => ({ subject: text.readySubject(c.name), body: text.readyBody(c) }),
  install: (c) => ({ subject: text.installSubject, body: text.installBody(c) }),
  team: (c) => ({ subject: text.teamSubject, body: text.teamBody(c) }),
  check_in: (c) => ({ subject: text.checkInSubject, body: text.checkInBody(c) }),
  // The day-30 email. It asks what to change, and a reply reaches a person.
  review: (c) => ({ subject: text.feedbackSubject, body: text.feedbackBody(c) }),
  cancellation: (c) => ({
    subject: text.cancellationSubject(c.name, c.endsOn),
    body: text.cancellationBody(c),
  }),
  ending_soon: (c) => ({
    subject: text.endingSoonSubject(c.name, c.endsOn),
    body: text.endingSoonBody(c),
  }),
  payment_failed: (c) => ({
    subject: text.paymentFailedSubject(c.name),
    body: text.paymentFailedBody(c),
  }),
  payment_reminder: (c) => ({
    subject: text.paymentReminderSubject(c.name, c.payUntil),
    body: text.paymentReminderBody(c),
  }),
  payment_last_day: (c) => ({
    subject: text.paymentLastDaySubject(c.name, c.payUntil),
    body: text.paymentLastDayBody(c),
  }),
  payment_recovered: (c) => ({
    subject: text.paymentRecoveredSubject(c.name),
    body: text.paymentRecoveredBody(c),
  }),
  read_only: (c) => ({ subject: text.readOnlySubject(c.name), body: text.readOnlyBody(c) }),
  welcome_back: (c) => ({
    subject: text.welcomeBackSubject(c.name),
    body: text.welcomeBackBody(c),
  }),
  deletion_30: (c) => ({
    subject: text.deletionLaterSubject(c.name, c.deleteOn),
    body: text.deletionBody(c),
  }),
  deletion_7: (c) => ({
    subject: text.deletionSubject(c.name, c.deleteOn),
    body: text.deletionBody(c),
  }),
  deleted: (c) => ({ subject: text.deletedSubject(c.name), body: text.deletedBody(c) }),
};

/** One email's subject, paragraphs, footer and headers. An onboarding email's footer unsubscribes. */
export function lifecycleMail(kind: Kind, context: MailContext) {
  const { subject, body } = MAILS[kind](context);
  const { stopUrl } = context;
  return {
    subject,
    body,
    footer: stopUrl === undefined ? undefined : text.stopLine(stopUrl),
    stopUrl,
    headers: {
      // Several emails invite a reply, and an answer to any of them should reach a person.
      "reply-to": SUPPORT_ADDRESS,
      // One click in the mail app stops them, as with alert emails.
      ...(stopUrl !== undefined && {
        "list-unsubscribe": `<${stopUrl}>`,
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      }),
    },
  };
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * The HTML version of a signed lifecycle email. It looks like the plain text, with links that
 * open, and an onboarding email ends with a small Unsubscribe link instead of the bare address.
 * Every word is escaped, so a workspace name cannot add markup.
 */
export function lifecycleHtml(signed: string, stopUrl: string | undefined): string {
  const paragraphs = signed.split("\n\n").map((paragraph) => {
    const escaped = escapeHtml(paragraph).replace(
      /https?:\/\/[^\s<]+/g,
      (url) => `<a href="${url}" style="color:#1d4ed8">${url}</a>`,
    );
    return `<p style="margin:0 0 14px">${escaped.replaceAll("\n", "<br>")}</p>`;
  });
  const footer =
    stopUrl === undefined
      ? ""
      : `<p style="margin:28px 0 0;font-size:12px;color:#8a8f98"><a href="${escapeHtml(stopUrl)}" ` +
        `style="color:#8a8f98">${text.stopLink}</a></p>`;
  return (
    '<!doctype html><html><body style="margin:0;padding:16px;font-family:-apple-system,' +
    "BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;" +
    `color:#1d2433">${paragraphs.join("")}${footer}</body></html>`
  );
}

/** Signs the stop link, so nobody can stop the emails of another owner. */
const stopSignature = (secret: string, workspaceId: string, operatorId: string) =>
  createHmac("sha256", secret)
    .update(`onboarding-stop/${workspaceId}/${operatorId}`)
    .digest("base64url");

/** One owner's link that stops the onboarding emails of one workspace, and never billing ones. */
export function onboardingStopUrl(
  publicUrl: string,
  secret: string,
  workspaceId: string,
  operatorId: string,
): string {
  const signature = stopSignature(secret, workspaceId, operatorId);
  return new URL(
    `/v1/onboarding-stop/${workspaceId}/${operatorId}?signature=${signature}`,
    publicUrl,
  ).href;
}

function validStop(secret: string, workspaceId: string, operatorId: string, signature: string) {
  if (!z.uuid().safeParse(workspaceId).success || !z.uuid().safeParse(operatorId).success) {
    return false;
  }
  const expected = Buffer.from(stopSignature(secret, workspaceId, operatorId));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The stop link. GET only asks, because mail scanners open links. POST stops the emails. */
export function registerOnboardingStop(
  app: App,
  { db, secret, rateLimit }: { db: Database; secret: string; rateLimit: RateLimit },
): void {
  const path = "/v1/onboarding-stop/:workspaceId/:operatorId";
  app.use("/v1/onboarding-stop/*", limitByIp(rateLimit, "onboarding-stop", 20, 60));
  const page = (body: string) => stopPage(text.stopTitle, `<p>${body}</p>`);
  const invalid = page(text.stopInvalid);

  app.get(path, (c) => {
    const { workspaceId, operatorId } = c.req.param();
    const signature = c.req.query("signature") ?? "";
    if (!validStop(secret, workspaceId, operatorId, signature)) {
      return c.html(invalid, 404, STOP_PAGE_SECURITY);
    }
    const form = `<form method="post" action="?signature=${signature}"><button>${text.stopButton}</button></form>`;
    return c.html(
      stopPage(text.stopTitle, `<p>${text.stopQuestion}</p>${form}`),
      200,
      STOP_PAGE_SECURITY,
    );
  });

  app.post(path, async (c) => {
    const { workspaceId, operatorId } = c.req.param();
    if (!validStop(secret, workspaceId, operatorId, c.req.query("signature") ?? "")) {
      return c.html(invalid, 404, STOP_PAGE_SECURITY);
    }
    await withWorkspace(db, workspaceId, (tx) =>
      tx
        .update(workspaceMember)
        .set({ onboardingStoppedAt: new Date() })
        .where(
          and(
            eq(workspaceMember.workspaceId, workspaceId),
            eq(workspaceMember.operatorId, operatorId),
          ),
        ),
    );
    return c.html(page(text.stopDone), 200, STOP_PAGE_SECURITY);
  });
}
