// What a reply email and a transcript share: the limit on emails to a visitor, the stop link, the
// authors' names, the quote above a reply, and the layout with the sentences at the end.

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { escapeHtml } from "../../../packages/widget/src/markdown.ts";
import { quoteStandIn } from "../../../packages/widget/src/quote.ts";
import { firstName } from "../../../packages/widget/src/shared.ts";
import type { ClaimedDelivery } from "./alerts.ts";
import { alertDelivery, emailStop } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { emailAddressHash } from "./identity.ts";
import { EMAIL_COLORS, letterHtml, oneLine } from "./letter.ts";
import type { MessageAuthor, Quote } from "./messages.ts";
import { DAY_MS } from "./time.ts";
import type { VisitorWords } from "./visitor-words.ts";

// The emails a visitor gets in a day, reply emails and transcripts together, because anyone can
// type someone else's address into the widget.
export const VISITOR_EMAILS_PER_DAY = 5;
const VISITOR_EMAILS: ClaimedDelivery["channel"][] = ["email", "transcript"];

/** The emails sent to this visitor in the last day, newest first. */
export async function sentToday(tx: Transaction, workspaceId: string, visitorId: string) {
  const rows = await tx
    .select({ channel: alertDelivery.channel, finishedAt: alertDelivery.finishedAt })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.visitorId, visitorId),
        inArray(alertDelivery.channel, VISITOR_EMAILS),
        eq(alertDelivery.outcome, "sent"),
        gt(alertDelivery.finishedAt, new Date(Date.now() - DAY_MS)),
      ),
    )
    .orderBy(desc(alertDelivery.finishedAt));
  return rows.map((one) => ({ channel: one.channel, finishedAt: one.finishedAt ?? new Date(0) }));
}

/** The address followed a stop link in this workspace's emails. */
export async function emailStopped(
  tx: Transaction,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ hash: emailStop.addressHash })
    .from(emailStop)
    .where(
      and(
        eq(emailStop.workspaceId, workspaceId),
        eq(emailStop.addressHash, emailAddressHash(email)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Signs the stop link, so nobody can stop the emails of an address they did not receive at. */
const stopSignature = (secret: string, workspaceId: string, addressHash: string) =>
  createHmac("sha256", secret)
    .update(`email-stop/${workspaceId}/${addressHash}`)
    .digest("base64url");

export function emailStopUrl(
  publicUrl: string,
  secret: string,
  workspaceId: string,
  email: string,
): string {
  const hash = emailAddressHash(email);
  const signature = stopSignature(secret, workspaceId, hash);
  return new URL(`/v1/email-stop/${workspaceId}/${hash}?signature=${signature}`, publicUrl).href;
}

export function verifyEmailStop(
  secret: string,
  workspaceId: string,
  addressHash: string,
  signature: string,
): boolean {
  const expected = Buffer.from(stopSignature(secret, workspaceId, addressHash));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Who wrote a message, for an email to the visitor: the visitor, a member's first name, the
 * workspace for an API key, or the team when the author is gone.
 */
export function visitorAuthorName(
  line: {
    authorVisitorId: string | null;
    authorOperatorId: string | null;
    authorApiKeyId: string | null;
  },
  authors: Map<string, MessageAuthor>,
  placeName: string,
  words: VisitorWords,
): string {
  if (line.authorVisitorId !== null) return words.you;
  // A bot's key has a name for the team, such as "Support bot". A visitor reads the workspace.
  if (line.authorApiKeyId !== null) return placeName;
  const author = authors.get(line.authorOperatorId ?? "");
  if (author === undefined) return words.team(placeName);
  return author.isDeleted ? author.name : firstName(author.name);
}

/**
 * The text of an email to a visitor: a greeting with no name, the paragraphs, why they got it with
 * the stop link, and the workspace's sign-off.
 */
export function visitorLetterText(
  placeName: string,
  paragraphs: string[],
  stopUrl: string,
  words: VisitorWords,
): string {
  return [
    words.hi,
    ...paragraphs,
    words.linkWarning,
    `${words.gotThisBecause(placeName)} ${words.stopHere(stopUrl)}`,
    words.signOff(oneLine(placeName) || "Dinghy"),
  ].join("\n\n");
}

/** The layout of an email to a visitor: the workspace's header, a button to the chat, the stop link. */
export function visitorLetterHtml(
  placeName: string,
  html: string,
  links: { chatUrl: string; stopUrl: string; logoUrl: string | null; chatLabel: string },
  words: VisitorWords,
): string {
  const stop = `<a href="${escapeHtml(links.stopUrl)}" style="color:${EMAIL_COLORS.muted};text-decoration:underline">${escapeHtml(words.stopThem)}</a>`;
  return letterHtml({
    team: placeName,
    logoUrl: links.logoUrl,
    html,
    action: { label: links.chatLabel, url: links.chatUrl },
    footer: [
      escapeHtml(words.linkWarning),
      `${escapeHtml(words.gotThisBecause(placeName))} ${stop}`,
    ],
  });
}

/** A quoted message's lines above a reply: who wrote it, and its text. */
function quoteParts(quote: Quote, words: VisitorWords): [string, string] {
  const standIn = quoteStandIn(quote);
  return [quote.authorName ?? words.you, standIn === null ? quote.text : words[standIn]];
}

/** A reply in an email's plain text: its quote as `> ` lines, then the text. */
export function quotedText(quote: Quote | null, body: string, words: VisitorWords): string {
  if (quote === null) return body;
  const [who, text] = quoteParts(quote, words);
  return `> ${words.lead(who)}\n${text.replace(/^/gm, "> ")}\n\n${body}`;
}

/** A reply in an email's HTML: its quote as a short block with the author's name. */
export function quotedHtml(quote: Quote | null, html: string, words: VisitorWords): string {
  if (quote === null) return html;
  const [who, text] = quoteParts(quote, words);
  return (
    `<div style="margin:0 0 8px;padding:8px 12px;background:${EMAIL_COLORS.quote};border-radius:8px;color:${EMAIL_COLORS.muted};font-size:13px">` +
    `<strong>${escapeHtml(who)}</strong><br>${escapeHtml(text).replace(/\n/g, "<br>")}</div>${html}`
  );
}
