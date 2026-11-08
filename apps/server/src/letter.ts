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
  joinSubject: "Your link to join your team on Dinghy",
  joinBody: (url: string) => [
    "Here's your link to finish joining your team on Dinghy:",
    url,
    text.linkLasts,
    "Didn't ask to join? You can ignore this email, and nothing happens.",
  ],
};

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

/** The link that finishes joining a workspace from its invite. The address is not proven yet. */
export const joinMail = (url: string) => ({
  subject: text.joinSubject,
  body: letter(text.joinBody(url)),
});

/** The sentence that says how long a link works, for the emails in ee/. */
export const LINK_LASTS = text.linkLasts;
