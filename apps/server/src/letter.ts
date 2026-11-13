import { escapeHtml } from "../../../packages/widget/src/markdown.ts";

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
};

// Every email is plain text in one voice: a greeting, a few short paragraphs and the same sign-off.
// Every string has a key here or next to its sender, so a locale can be added later.
const text = {
  hi: "Hi,",
  hiName: (name: string) => `Hi ${name},`,
  signOff: (team: string) => `Cheers,\nThe ${team} team`,
  linkLasts: `The link works once, for the next ${LINK_MINUTES} minutes.`,
  signInSubject: "Your Dinghy sign-in link",
  signInBody: (url: string) => [
    "Here's your link to sign in to Dinghy:",
    url,
    text.linkLasts,
    "Didn't ask for it? You can ignore this email. Nobody gets in without the link.",
  ],
  noAccountSubject: "You don't have a Dinghy account yet",
  // Fixed text only: anyone can type any email on the sign-in page.
  noAccountBody: (signupUrl: string) => [
    "Someone, hopefully you, asked to sign in to Dinghy with this email, but it has no account yet.",
    "To create one, sign up here:",
    signupUrl,
    "Didn't ask? You can ignore this email.",
  ],
  joinSubject: (workspace: string) => `Join ${workspace} on Dinghy`,
  joinBody: (url: string, workspace: string, inviter: string) => [
    ...(inviter === "" ? [] : [`${inviter} invited you to ${workspace}.`]),
    `Open this link to sign in and join ${workspace}:`,
    url,
    text.linkLasts,
    "Didn't ask to join? You can ignore this email, and nothing happens.",
  ],
  deleteAccountSubject: "Confirm that you want to delete your Dinghy account",
  deleteAccountBody: (url: string) => [
    "Here's your link to delete your Dinghy account:",
    url,
    text.linkLasts,
    "Deleting it takes you out of every workspace, and can't be undone. Your old replies stay, from a former team member.",
    "Didn't ask for it? Ignore this email, and nothing happens.",
  ],
  inviteSubject: (workspace: string) => `Join ${workspace} on Dinghy`,
  inviteBody: (url: string, workspace: string, role: "admin" | "member") => [
    `You're invited to join ${workspace} on Dinghy as ${role === "admin" ? "an admin" : "a member"}:`,
    url,
    "The link works once, for the next 7 days.",
    "Didn't expect this? You can ignore this email.",
  ],
};

/** The longest workspace name an invite shows, so a name cannot fill the subject line. */
const WORKSPACE_NAME_MAX = 80;

// One line, so a name cannot add paragraphs of its own.
export const oneLine = (words: string | undefined) => words?.replace(/\s+/g, " ").trim();

/**
 * An email's text. Pass a name only when the person it goes to typed it and proved this address,
 * so a stranger cannot put their own words in someone else's inbox. `team` signs it, and defaults
 * to Dinghy: a workspace signs the emails that its own visitors get. `signOff` replaces the whole
 * sign-off, for emails that a person signs.
 */
export function letter(
  paragraphs: string[],
  name?: string,
  team = "Dinghy",
  signOff?: string,
): string {
  const shown = oneLine(name);
  const greeting = shown ? text.hiName(shown) : text.hi;
  return [greeting, ...paragraphs, signOff ?? text.signOff(oneLine(team) || "Dinghy")].join("\n\n");
}

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
 * and small print under a line. `html` and `footer` are HTML that their maker escaped.
 */
export function letterHtml(page: {
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
export const signInMail = (url: string) => ({
  subject: text.signInSubject,
  body: letter(text.signInBody(url)),
});

/** Sent instead of a sign-in link to an email with no account, so nobody waits for nothing. */
export const noAccountMail = (signupUrl: string) => ({
  subject: text.noAccountSubject,
  body: letter(text.noAccountBody(signupUrl)),
});

/**
 * The link that joins an existing account to a workspace, from an invite that was emailed to it. It
 * names the workspace and who invited, as the invite did.
 */
export function joinMail(url: string, workspaceName: string, inviterName: string) {
  const workspace = (oneLine(workspaceName) ?? "").slice(0, WORKSPACE_NAME_MAX);
  const inviter = (oneLine(inviterName) ?? "").slice(0, WORKSPACE_NAME_MAX);
  return {
    subject: text.joinSubject(workspace),
    body: letter(text.joinBody(url, workspace, inviter)),
  };
}

/** The link that deletes the account, which its operator asked for in the app. */
export const deleteAccountMail = (url: string) => ({
  subject: text.deleteAccountSubject,
  body: letter(text.deleteAccountBody(url)),
});

/** An invite to a workspace. Its admin picked this address and the workspace's name. */
export function inviteMail(url: string, workspaceName: string, role: "admin" | "member") {
  const workspace = (oneLine(workspaceName) ?? "").slice(0, WORKSPACE_NAME_MAX);
  return {
    subject: text.inviteSubject(workspace),
    body: letter(text.inviteBody(url, workspace, role)),
  };
}

/** The sentence that says how long a link works, for the emails in ee/. */
export const LINK_LASTS = text.linkLasts;
