import { escapeHtml } from "../../../packages/widget/src/markdown.ts";
import type { Mail } from "./mailer.ts";

/** How long a sign-in link works. Every email that carries one says so. */
export const LINK_MINUTES = 15;

/**
 * The colors of the HTML emails: the text, which also fills the button, quiet text, a quote's and a
 * reply's background, the footer's line, and the text on the navy.
 */
export const EMAIL_COLORS = {
  text: "#0b2239",
  muted: "#5f6e80",
  quote: "#f3efe4",
  bubble: "#f0f2f5",
  line: "#e3e7ec",
  onDark: "#ffffff",
  link: "#1d4ed8",
};

/**
 * Who turned off two-step sign-in: the operator in the app, the server's admin, a removal request
 * at the end of its wait, or a teammate who manages the workspace, by name.
 */
type TwoFactorOffBy = "operator" | "admin" | "removal" | { teammate: string };

// Every email is plain text in one voice: a greeting, a few short paragraphs and the same sign-off.
// Every string has a key here or next to its sender, so a locale can be added later.
const text = {
  hi: "Hi,",
  hiName: (name: string) => `Hi ${name},`,
  signOff: (team: string) => `Cheers,\nThe ${team} team`,
  linkLasts: `The link works once, for the next ${LINK_MINUTES} minutes.`,
  signInSubject: "Your Dinghy sign-in link",
  signInBody: (url: string): Paragraph[] => [
    ["Here's your link to ", link("sign in to Dinghy", url), "."],
    text.linkLasts,
    "Didn't ask for it? You can ignore this email. Nobody gets in without the link.",
  ],
  nativeCodeSubject: "Your Dinghy sign-in code",
  nativeCodeBody: (code: string, minutes: number) => [
    "Your Dinghy sign-in code is:",
    code,
    `It works once, for the next ${minutes} minutes.`,
    "Didn't ask for it? You can ignore this email. Nobody gets in without the code.",
  ],
  noAccountSubject: "You don't have a Dinghy account yet",
  // Fixed text only: anyone can type any email on the sign-in page.
  noAccountBody: (signupUrl: string): Paragraph[] => [
    "Someone, hopefully you, asked to sign in to Dinghy with this email, but it has no account yet.",
    ["To create one, ", link("sign up here", signupUrl), "."],
    "Didn't ask? You can ignore this email.",
  ],
  joinSubject: (workspace: string) => `Join ${workspace} on Dinghy`,
  joinBody: (url: string, workspace: string, inviter: string): Paragraph[] => [
    ...(inviter === "" ? [] : [`${inviter} invited you to ${workspace}.`]),
    [link(`Sign in and join ${workspace}`, url), "."],
    text.linkLasts,
    "Didn't ask to join? You can ignore this email, and nothing happens.",
  ],
  deleteAccountSubject: "Confirm that you want to delete your Dinghy account",
  deleteAccountBody: (url: string): Paragraph[] => [
    ["Here's your link to ", link("delete your Dinghy account", url), "."],
    text.linkLasts,
    "Deleting it takes you out of every workspace, and can't be undone. Your old replies stay, from a former team member.",
    "Didn't ask for it? Ignore this email, and nothing happens.",
  ],
  twoFactorNotYou:
    "Wasn't you? Someone may be able to read your email. Secure your email account, and tell the person who runs your Dinghy server.",
  twoFactorOnSubject: "Two-step sign-in is on for your Dinghy account",
  twoFactorOnBody: () => [
    "Two-step sign-in is now on for your Dinghy account. Each new sign-in asks for a code from your authenticator app.",
    text.twoFactorNotYou,
  ],
  twoFactorOffSubject: "Two-step sign-in is off for your Dinghy account",
  twoFactorOffBody: (by: TwoFactorOffBy) => [
    `${text.twoFactorOffBy(by)} A sign-in now needs only the email link.`,
    "You can turn it on again in Profile.",
    text.twoFactorNotYou,
  ],
  twoFactorOffBy: (by: TwoFactorOffBy) => {
    if (typeof by === "object") {
      return `${shownName(by.teammate)}, who manages your workspace, turned off two-step sign-in for your Dinghy account and signed out its sessions.`;
    }
    return {
      operator: "Two-step sign-in was turned off for your Dinghy account.",
      admin:
        "The admin of your Dinghy server turned off two-step sign-in for your account and signed out its sessions.",
      removal:
        "Two-step sign-in was removed from your Dinghy account, as someone asked, and every session signed out.",
    }[by];
  },
  removalCancelLink: (url: string): Paragraph[] => [
    [
      "Wasn't you? ",
      link("Cancel the request", url),
      ", then secure your email account, because someone can read it.",
    ],
  ],
  removalFoundApp:
    "Was it you? Then there is nothing to do. Found your authenticator app or a recovery code? Sign in and enter a code, and the request ends.",
  removalRequestedSubject: "Someone asked to remove two-step sign-in from your Dinghy account",
  removalRequestedBody: (url: string, waitHours: number): Paragraph[] => [
    `You, or someone who can read your email, asked to remove two-step sign-in from your Dinghy account, because the authenticator app and the recovery codes are lost. Unless the request is cancelled, it is removed in ${waitHours} hours, and every session signs out.`,
    text.removalFoundApp,
    ...text.removalCancelLink(url),
  ],
  removalReminderSubject: (hours: number) =>
    `Two-step sign-in will be removed from your Dinghy account in ${hours} hours`,
  removalReminderBody: (url: string, hours: number): Paragraph[] => [
    `In ${hours} hours, two-step sign-in is removed from your Dinghy account, as someone asked, and every session signs out.`,
    text.removalFoundApp,
    ...text.removalCancelLink(url),
  ],
  removalUnconfirmedSubject:
    "The request to remove two-step sign-in from your Dinghy account stopped",
  removalUnconfirmedBody: [
    "The request to remove two-step sign-in from your Dinghy account stopped before its wait began, because nobody but you could be warned: your workspaces have no other owner or admin, and none of your devices has passed two-step sign-in. Nothing changed.",
    'Sign in with your authenticator app or a recovery code if you find one. If not, open Dinghy and choose "Lost your authenticator app" again: it says who can remove it for you.',
  ],
  removalCancelledSubject:
    "The request to remove two-step sign-in from your Dinghy account was cancelled",
  removalCancelledBody: (blockDays: number) => [
    `The request to remove two-step sign-in from your Dinghy account was cancelled, and any sign-in that stopped at the code screen was signed out. No new request can start for ${blockDays} days.`,
    "If you asked for it and then found your authenticator app, there is nothing more to do.",
    "If you did not ask for it, someone can most likely read your email. Change your email password, check its forwarding rules and turn on its own two-step sign-in.",
  ],
  teamRemovalSubject: (name: string) => `${name} asked to remove two-step sign-in on Dinghy`,
  teamRemovalBody: (name: string, email: string, waitHours: number) => [
    `${name} (${email}) asked to remove two-step sign-in from their Dinghy account, because they lost their authenticator app and their recovery codes. Unless they cancel the request, it is removed in ${waitHours} hours.`,
    `Check with ${name} by voice or in person. If they did not ask for it, someone may be reading their email: ask them to cancel the request, with the link in their email or the banner in Dinghy, and to secure their email account.`,
  ],
  teamRemovalDoneSubject: (name: string) => `Two-step sign-in was removed for ${name} on Dinghy`,
  teamRemovalDoneBody: (name: string, email: string) => [
    `Two-step sign-in was removed from the Dinghy account of ${name} (${email}), as they asked at the end of the wait, and their sessions signed out.`,
    `If ${name} did not ask for it, someone may be reading their email. Remove them in Settings > Team until they secure it.`,
  ],
  teamResetSubject: (name: string) => `Two-step sign-in was reset for ${name} on Dinghy`,
  teamResetBody: (actor: string, name: string, email: string) => [
    `${actor} turned off two-step sign-in for ${name} (${email}) and signed out their sessions. ${name} now signs in with the email link only.`,
    `If you did not expect this, check with ${actor} and ${name}.`,
  ],
  recoveryUsedSubject: "A recovery code was used on your Dinghy account",
  recoveryUsedBody: () => [
    "A recovery code was just used on your Dinghy account, in place of a code from your authenticator app. Each code works once.",
    text.twoFactorNotYou,
  ],
  lockoutSubject: "Too many wrong codes on your Dinghy account",
  lockoutBody: (failures: number, minutes: number) => [
    `Someone entered ${failures} wrong two-step sign-in codes for your Dinghy account, so that session ended. No code works for up to ${minutes} minutes.`,
    "If it was you, wait and sign in again.",
    text.twoFactorNotYou,
  ],
  inviteSubject: (workspace: string) => `Join ${workspace} on Dinghy`,
  inviteBody: (url: string, workspace: string, role: "admin" | "member"): Paragraph[] => [
    `You're invited to join ${workspace} on Dinghy as ${role === "admin" ? "an admin" : "a member"}.`,
    [link("Accept the invite", url), "."],
    "The link works once, for the next 7 days.",
    "Didn't expect this? You can ignore this email.",
  ],
};

/** The longest workspace name an invite shows, so a name cannot fill the subject line. */
const WORKSPACE_NAME_MAX = 80;

/** Markdown's paragraphs come bare, and a mail app's default margins would space them too far apart. */
export const mailParagraphs = (html: string) =>
  html.replaceAll("<p>", '<p style="margin:0 0 8px">');

// One line, so a name cannot add paragraphs of its own.
export const oneLine = (words: string | undefined) => words?.replace(/\s+/g, " ").trim();

/** Words that open a link. The HTML puts the link behind them, and the plain text adds the address. */
export interface Link {
  label: string;
  url: string;
}
/** A paragraph of an email: words, and links among them. */
export type Paragraph = string | (string | Link)[];

export const link = (label: string, url: string): Link => ({ label, url });

const parts = (paragraph: Paragraph) => (typeof paragraph === "string" ? [paragraph] : paragraph);

/** A paragraph in plain text, where each link's address follows its words. */
const plainText = (paragraph: Paragraph) =>
  parts(paragraph)
    .map((part) => (typeof part === "string" ? part : `${part.label} (${part.url})`))
    .join("");

/** A paragraph in HTML, where each link sits behind its words. Every word is escaped. */
const paragraphHtml = (paragraph: Paragraph) =>
  parts(paragraph)
    .map((part) =>
      typeof part === "string"
        ? escapeHtml(part)
        : `<a href="${escapeHtml(part.url)}" style="color:${EMAIL_COLORS.link}">${escapeHtml(part.label)}</a>`,
    )
    .join("");

/** The greeting, the paragraphs and the sign-off, before they become text or HTML. */
function letterParts(
  paragraphs: Paragraph[],
  name: string | undefined,
  team: string,
  signOff: string | undefined,
): Paragraph[] {
  const shown = oneLine(name);
  const greeting = shown ? text.hiName(shown) : text.hi;
  return [greeting, ...paragraphs, signOff ?? text.signOff(oneLine(team) || "Dinghy")];
}

/**
 * An email's text. Pass a name only when the person it goes to typed it and proved this address,
 * so a stranger cannot put their own words in someone else's inbox. `team` signs it, and defaults
 * to Dinghy: a workspace signs the emails that its own visitors get. `signOff` replaces the whole
 * sign-off, for emails that a person signs.
 */
export function letter(
  paragraphs: Paragraph[],
  name?: string,
  team = "Dinghy",
  signOff?: string,
): string {
  return letterParts(paragraphs, name, team, signOff).map(plainText).join("\n\n");
}

/**
 * The same letter in HTML, which looks like the text but puts each link behind its words. It sets
 * only the font and a near-black color, and keeps the mail app's own margins. `footer` is HTML
 * that its maker escaped, in small print under the sign-off.
 */
export function plainLetterHtml(
  paragraphs: Paragraph[],
  { name, team = "Dinghy", signOff, footer = "" }: LetterOptions = {},
): string {
  const body = letterParts(paragraphs, name, team, signOff)
    .map((one) => `<p>${paragraphHtml(one).replaceAll("\n", "<br>")}</p>`)
    .join("");
  // Near-black, not the navy: in dark mode a mail app turns the navy into a pale blue.
  return (
    '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    `<div style="font-family:${EMAIL_FONTS};font-size:14px;line-height:1.6;color:#1a1a1a">` +
    `${body}${footer}</div></body></html>`
  );
}

interface LetterOptions {
  name?: string | undefined;
  team?: string;
  signOff?: string | undefined;
  footer?: string;
}

/** One email from Dinghy, as plain text and as HTML. */
export const note = (subject: string, paragraphs: Paragraph[]): Mail => ({
  subject,
  body: letter(paragraphs),
  html: plainLetterHtml(paragraphs),
});

// The fonts every system has, because mail apps load no web fonts.
const EMAIL_FONTS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const LOGO_PX = 40;
// Outlook on Windows ignores max-width, so it gets a table of this width instead.
const COLUMN_PX = 560;

// The logo, or the name's first letter on a rounded square when the workspace has none.
function logoHtml(team: string, logoUrl: string | null): string {
  const size = `width:${LOGO_PX}px;height:${LOGO_PX}px;border-radius:10px`;
  if (logoUrl !== null) {
    return `<img src="${escapeHtml(logoUrl)}" width="${LOGO_PX}" height="${LOGO_PX}" alt="" style="display:block;${size}">`;
  }
  const letter = escapeHtml(Array.from(team)[0]?.toUpperCase() ?? "");
  return `<div style="${size};background:${EMAIL_COLORS.text};color:${EMAIL_COLORS.onDark};font-size:19px;font-weight:700;line-height:${LOGO_PX}px;text-align:center">${letter}</div>`;
}

const actionHtml = ({ label, url }: { label: string; url: string }) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:999px;background:${EMAIL_COLORS.text}">` +
  `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 26px;border-radius:999px;color:${EMAIL_COLORS.onDark};font-weight:600;text-decoration:none">${escapeHtml(label)}</a>` +
  "</td></tr></table>";

/**
 * The HTML version of an email that a workspace sends: its logo and name, the content, a button,
 * and small print under a line. `above`, `html` and `footer` are HTML that their maker escaped.
 */
export function letterHtml(page: {
  /** A quiet first line, above the logo, so a reply quotes it before anything else. */
  above?: string;
  team: string;
  logoUrl: string | null;
  html: string;
  action: { label: string; url: string };
  footer: string[];
}): string {
  const team = oneLine(page.team) || "Dinghy";
  const header =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-right:12px">${logoHtml(team, page.logoUrl)}</td>` +
    `<td style="font-size:17px;font-weight:700">${escapeHtml(team)}</td></tr></table>`;
  const footer = page.footer
    .map((paragraph) => `<p style="margin:0 0 8px">${paragraph}</p>`)
    .join("");
  const rows = [
    ...(page.above === undefined
      ? []
      : [
          `<td style="padding-bottom:16px;font-size:12px;color:${EMAIL_COLORS.muted}">${page.above}</td>`,
        ]),
    `<td style="padding-bottom:24px">${header}</td>`,
    `<td>${page.html}</td>`,
    `<td style="padding:24px 0 28px">${actionHtml(page.action)}</td>`,
    `<td style="border-top:1px solid ${EMAIL_COLORS.line};padding-top:16px;font-size:12px;line-height:1.5;color:${EMAIL_COLORS.muted}">${footer}</td>`,
  ];
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    `<body style="margin:0;padding:0;background:${EMAIL_COLORS.onDark}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:32px 16px">` +
    `<!--[if mso]><table role="presentation" width="${COLUMN_PX}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${COLUMN_PX}px;font-family:${EMAIL_FONTS};font-size:15px;line-height:1.5;color:${EMAIL_COLORS.text};text-align:left">` +
    rows.map((row) => `<tr>${row}</tr>`).join("") +
    "</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>"
  );
}

/** The sign-in link that an operator asked for on the sign-in page. */
export const signInMail = (url: string) => note(text.signInSubject, text.signInBody(url));

/** The short code that signs an operator in to the native app. */
export const nativeSignInCodeMail = (code: string, minutes: number) =>
  note(text.nativeCodeSubject, text.nativeCodeBody(code, minutes));

/** Sent instead of a sign-in link to an email with no account, so nobody waits for nothing. */
export const noAccountMail = (signupUrl: string) =>
  note(text.noAccountSubject, text.noAccountBody(signupUrl));

/**
 * The link that joins an existing account to a workspace, from an invite that was emailed to it. It
 * names the workspace and who invited, as the invite did.
 */
export function joinMail(url: string, workspaceName: string, inviterName: string) {
  const workspace = (oneLine(workspaceName) ?? "").slice(0, WORKSPACE_NAME_MAX);
  const inviter = (oneLine(inviterName) ?? "").slice(0, WORKSPACE_NAME_MAX);
  return note(text.joinSubject(workspace), text.joinBody(url, workspace, inviter));
}

/** The link that deletes the account, which its operator asked for in the app. */
export const deleteAccountMail = (url: string) =>
  note(text.deleteAccountSubject, text.deleteAccountBody(url));

/** An invite to a workspace. Its admin picked this address and the workspace's name. */
export function inviteMail(url: string, workspaceName: string, role: "admin" | "member") {
  const workspace = (oneLine(workspaceName) ?? "").slice(0, WORKSPACE_NAME_MAX);
  return note(text.inviteSubject(workspace), text.inviteBody(url, workspace, role));
}

/** Two-step sign-in was turned on for this account. */
export const twoFactorOnMail = () => note(text.twoFactorOnSubject, text.twoFactorOnBody());

/** Two-step sign-in was turned off for this account. */
export const twoFactorOffMail = (by: TwoFactorOffBy) =>
  note(text.twoFactorOffSubject, text.twoFactorOffBody(by));

/** A recovery code passed the second step or turned it off. */
export const recoveryUsedMail = () => note(text.recoveryUsedSubject, text.recoveryUsedBody());

/** Too many wrong codes ended a session, and the account refuses codes for a while. */
export const lockoutMail = (failures: number, minutes: number) =>
  note(text.lockoutSubject, text.lockoutBody(failures, minutes));

/** A person's name in another person's email: one line, and short enough for a subject. */
const shownName = (name: string) => (oneLine(name) ?? "").slice(0, WORKSPACE_NAME_MAX);

/** Someone asked to remove two-step sign-in. `url` opens the page that cancels the request. */
export const removalRequestedMail = (url: string, waitHours: number) =>
  note(text.removalRequestedSubject, text.removalRequestedBody(url, waitHours));

/** A removal request ends in `hours`. `url` opens the page that cancels it. */
export const removalReminderMail = (url: string, hours: number) =>
  note(text.removalReminderSubject(hours), text.removalReminderBody(url, hours));

/** A removal request stopped before its wait, because only the account's own mailbox could be warned. */
export const removalUnconfirmedMail = () =>
  note(text.removalUnconfirmedSubject, text.removalUnconfirmedBody);

/** A removal request was cancelled, which most often means someone else asked for it. */
export const removalCancelledMail = (blockDays: number) =>
  note(text.removalCancelledSubject, text.removalCancelledBody(blockDays));

/** To the owners and admins of an account's workspaces, which a removal request warns. No link. */
export function teamRemovalMail(account: { name: string; email: string }, waitHours: number) {
  const name = shownName(account.name);
  return note(text.teamRemovalSubject(name), text.teamRemovalBody(name, account.email, waitHours));
}

/** To the same owners and admins, once the request removed two-step sign-in. */
export function teamRemovalDoneMail(account: { name: string; email: string }) {
  const name = shownName(account.name);
  return note(text.teamRemovalDoneSubject(name), text.teamRemovalDoneBody(name, account.email));
}

/** To a workspace's other owners, after a teammate's reset. */
export function teamResetMail(actorName: string, account: { name: string; email: string }) {
  const name = shownName(account.name);
  return note(
    text.teamResetSubject(name),
    text.teamResetBody(shownName(actorName), name, account.email),
  );
}

/** The sentence that says how long a link works, for the emails in ee/. */
export const LINK_LASTS = text.linkLasts;
