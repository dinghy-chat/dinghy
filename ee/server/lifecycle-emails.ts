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

/** Where replies to the check-in and review emails go. */
const SUPPORT_ADDRESS = "support@dinghy.chat";
const INSTALL_DOCS_URL = "https://dinghy.chat/docs/add-to-your-site";

type Kind = (typeof lifecycleEmailKind.enumValues)[number];

/** What an email may name. The dates come from the occurrence, so a retry says the same. */
export interface MailContext {
  name: string;
  /** Opens the workspace, where Settings has Billing, Export and the install code. */
  settingsUrl: string;
  signInUrl: string;
  reviewUrl: string | undefined;
  /** The owner's own stop link, in onboarding emails only. */
  stopUrl: string | undefined;
  days: { paymentLeft: number; readOnly: number; firstWarning: number; endingSoon: number };
  payUntil: Date;
  deleteOn: Date;
  endsOn: Date | null;
}

const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? "";

// Plain text. Every string has a key here, so a locale can be added later.
const text = {
  readySubject: (name: string) => `Your workspace ${name} is ready`,
  readyBody: (c: MailContext) => [
    `Thanks for subscribing to Dinghy. Your workspace ${c.name} is ready.`,
    "To put the chat on your site, open Settings. Add your site under Allowed sites, then copy " +
      `the code under Install the chat into your pages: ${c.settingsUrl}`,
    `The full steps are here: ${INSTALL_DOCS_URL}`,
  ],
  installSubject: "Add the chat to your site",
  installBody: (c: MailContext) => [
    `Your Dinghy workspace ${c.name} is ready, but the chat hasn't run on a site yet.`,
    "It takes two steps in Settings. Add your site under Allowed sites, then paste the code " +
      `under Install the chat into your pages: ${c.settingsUrl}`,
    `The full steps are here: ${INSTALL_DOCS_URL}`,
  ],
  teamSubject: "Invite your team and turn on alerts",
  teamBody: (c: MailContext) => [
    `Two things help you answer faster in ${c.name}:`,
    "- Invite your team from Settings, under Team.\n" +
      "- Turn on alerts there too, so you hear about new messages when the inbox is closed.",
    `Open Settings here: ${c.settingsUrl}`,
  ],
  checkInSubject: "How is Dinghy going?",
  checkInBody: (c: MailContext) => [
    `You've had ${c.name} for a week now. How is it going?`,
    "Just reply to this email. We read every reply, and we'd like to hear what works and what " +
      "doesn't.",
  ],
  reviewSubject: "Would you review Dinghy?",
  reviewBody: (c: MailContext, url: string) => [
    `You've used ${c.name} for a month now. If Dinghy helps you, a short review helps other ` +
      `small teams find it: ${url}`,
    "Something missing or annoying? Reply to this email and tell us.",
  ],
  feedbackSubject: "What do you think of Dinghy?",
  feedbackBody: (c: MailContext) => [
    `You've used ${c.name} for a month now. What works for you, and what doesn't?`,
    "Reply to this email and tell us. We read every reply.",
  ],
  stopLine: (url: string) =>
    `Don't want emails like this one? Stop them here: ${url}\nYou still get emails about billing.`,
  cancellationSubject: (name: string, endsOn: Date | null) =>
    `Your plan for ${name} ends on ${date(endsOn)}`,
  cancellationBody: (c: MailContext) => [
    `We got your cancellation for the Dinghy workspace ${c.name}. Everything keeps working ` +
      `until ${date(c.endsOn)}.`,
    `After that, the workspace turns read-only for ${c.days.readOnly} days. The chat widget goes ` +
      "off, and your team can still read conversations and download an export. Then we delete it.",
    `Changed your mind? Renew in Settings, under Billing: ${c.settingsUrl}`,
  ],
  endingSoonSubject: (name: string, days: number) => `${name} turns read-only in ${days} days`,
  endingSoonBody: (c: MailContext) => [
    `Your Dinghy plan for ${c.name} ends on ${date(c.endsOn)}. After that, the chat widget goes ` +
      "off and nobody can reply.",
    `To keep it, renew in Settings, under Billing: ${c.settingsUrl}`,
    `If you're done with it, you can still download an export for ${c.days.readOnly} days after ` +
      "the end.",
  ],
  paymentFailedSubject: (name: string) => `The payment for ${name} didn't go through`,
  paymentFailedBody: (c: MailContext) => [
    `The payment for your Dinghy workspace ${c.name} didn't go through. Stripe will try again ` +
      "on its own.",
    `Everything keeps working until ${date(c.payUntil)}. If no payment clears by then, the ` +
      "workspace turns read-only: the chat widget goes off and nobody can reply.",
    `You can update the card in Settings, under Billing: ${c.settingsUrl}`,
  ],
  paymentReminderSubject: (name: string, days: number) =>
    `${days} days left to fix the payment for ${name}`,
  paymentReminderBody: (c: MailContext) => [
    `The payment for your Dinghy workspace ${c.name} still hasn't gone through.`,
    `Everything keeps working until ${date(c.payUntil)}. After that, the workspace turns ` +
      "read-only: the chat widget goes off and nobody can reply.",
    `Update the card in Settings, under Billing: ${c.settingsUrl}`,
  ],
  paymentLastDaySubject: (name: string) => `Last day to fix the payment for ${name}`,
  paymentLastDayBody: (c: MailContext) => [
    `The payment for your Dinghy workspace ${c.name} still hasn't gone through. On ` +
      `${date(c.payUntil)}, the workspace turns read-only: the chat widget goes off and nobody ` +
      "can reply.",
    `Update the card today in Settings, under Billing: ${c.settingsUrl}`,
  ],
  paymentRecoveredSubject: (name: string) => `The payment for ${name} went through`,
  paymentRecoveredBody: (c: MailContext) => [
    `Thanks. The payment for your Dinghy workspace ${c.name} went through, and everything is ` +
      "back to normal.",
    `Your invoices are in Settings, under Billing: ${c.settingsUrl}`,
  ],
  readOnlySubject: (name: string) => `${name} is now read-only`,
  readOnlyBody: (c: MailContext) => [
    `Your Dinghy workspace ${c.name} no longer has a paid subscription, so it's read-only now. ` +
      "The chat widget is off, and nobody can reply.",
    "Your team can still sign in and read conversations. To keep a copy, download an export in " +
      `Settings, under Export: ${c.settingsUrl}`,
    "Subscribe again in Settings, under Billing, and you get everything back with all its data.",
    `If nobody subscribes by ${date(c.deleteOn)}, we delete the workspace and all its data.`,
  ],
  welcomeBackSubject: (name: string) => `${name} is active again`,
  welcomeBackBody: (c: MailContext) => [
    `Thanks for subscribing again. Your Dinghy workspace ${c.name} is active again, with all its ` +
      "conversations and settings, and the chat widget is back on your site.",
    `You can manage billing in Settings, under Billing: ${c.settingsUrl}`,
  ],
  deletionLaterSubject: (name: string, days: number) => `${name} will be deleted in ${days} days`,
  deletionSubject: (name: string, deleteOn: Date) => `${name} will be deleted on ${date(deleteOn)}`,
  deletionBody: (c: MailContext) => [
    `Your Dinghy workspace ${c.name} has been read-only since its subscription ended. On ` +
      `${date(c.deleteOn)}, we delete the workspace and all its data, images included, for good.`,
    `To keep it, subscribe again in Settings, under Billing: ${c.settingsUrl}`,
    "If you'd rather keep a copy, download an export in Settings, under Export, before then.",
  ],
  deletedSubject: (name: string) => `We deleted ${name}`,
  deletedBody: (c: MailContext) => [
    `We deleted your Dinghy workspace ${c.name} today, with all its conversations and images. It ` +
      `was read-only for ${c.days.readOnly} days after its subscription ended.`,
    "Backup copies disappear within the next 30 days.",
    `Your Dinghy account stays. To start again, sign in and add a workspace: ${c.signInUrl}`,
  ],
  stopTitle: "Stop these emails",
  stopQuestion: "Stop Dinghy's tips and check-ins for this workspace? Billing emails still come.",
  stopButton: "Stop the emails",
  stopDone: "You will not receive these emails again.",
  stopInvalid: "This link does not work.",
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
  review: (c) =>
    c.reviewUrl === undefined
      ? { subject: text.feedbackSubject, body: text.feedbackBody(c) }
      : { subject: text.reviewSubject, body: text.reviewBody(c, c.reviewUrl) },
  cancellation: (c) => ({
    subject: text.cancellationSubject(c.name, c.endsOn),
    body: text.cancellationBody(c),
  }),
  ending_soon: (c) => ({
    subject: text.endingSoonSubject(c.name, c.days.endingSoon),
    body: text.endingSoonBody(c),
  }),
  payment_failed: (c) => ({
    subject: text.paymentFailedSubject(c.name),
    body: text.paymentFailedBody(c),
  }),
  payment_reminder: (c) => ({
    subject: text.paymentReminderSubject(c.name, c.days.paymentLeft),
    body: text.paymentReminderBody(c),
  }),
  payment_last_day: (c) => ({
    subject: text.paymentLastDaySubject(c.name),
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
    subject: text.deletionLaterSubject(c.name, c.days.firstWarning),
    body: text.deletionBody(c),
  }),
  deletion_7: (c) => ({
    subject: text.deletionSubject(c.name, c.deleteOn),
    body: text.deletionBody(c),
  }),
  deleted: (c) => ({ subject: text.deletedSubject(c.name), body: text.deletedBody(c) }),
};

/** The emails that ask for an answer, which goes to support. */
const REPLY_TO_SUPPORT = new Set<Kind>(["check_in", "review"]);

/** One email's subject, paragraphs and headers. An onboarding email ends with its stop link. */
export function lifecycleMail(kind: Kind, context: MailContext) {
  const { subject, body } = MAILS[kind](context);
  const { stopUrl } = context;
  return {
    subject,
    body: stopUrl === undefined ? body : [...body, text.stopLine(stopUrl)],
    headers: {
      ...(REPLY_TO_SUPPORT.has(kind) && { "reply-to": SUPPORT_ADDRESS }),
      // One click in the mail app stops them, as with alert emails.
      ...(stopUrl !== undefined && {
        "list-unsubscribe": `<${stopUrl}>`,
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      }),
    },
  };
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
