/** How long a sign-in link works. Every email that carries one says so. */
export const LINK_MINUTES = 15;

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
  joinSubject: "Your link to join your team on Dinghy",
  joinBody: (url: string) => [
    "Here's your link to finish joining your team on Dinghy:",
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
const oneLine = (words: string | undefined) => words?.replace(/\s+/g, " ").trim();

/**
 * An email's text. Pass a name only when the person it goes to typed it and proved this address,
 * so a stranger cannot put their own words in someone else's inbox. `team` signs it, and defaults
 * to Dinghy: a workspace signs the emails that its own visitors get.
 */
export function letter(paragraphs: string[], name?: string, team = "Dinghy"): string {
  const shown = oneLine(name);
  const greeting = shown ? text.hiName(shown) : text.hi;
  return [greeting, ...paragraphs, text.signOff(oneLine(team) || "Dinghy")].join("\n\n");
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

/** The link that joins an existing account to a workspace, from an invite that was emailed to it. */
export const joinMail = (url: string) => ({
  subject: text.joinSubject,
  body: letter(text.joinBody(url)),
});

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
