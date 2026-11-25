import { readStored, store } from "./stored.ts";

// The changes an operator sees under What's new in the sidebar, and dinghy.chat/changelog shows.
// CHANGELOG.md lists every change for self-hosters, with the API and the settings. This list keeps
// the ones a team notices, in plain words. The entries are in English only, as the site is.

/** What an update is, shown as a tag beside it. */
export type UpdateKind = "feature" | "improvement" | "fix";

export interface Update {
  /** Never changes once released: the app remembers the newest one each operator saw. */
  id: string;
  /** The day it shipped, as YYYY-MM-DD. */
  date: string;
  kind: UpdateKind;
  title: string;
  text: string;
  /** A docs page with more, such as "campaigns" or "agents#ask-to-change". */
  docs?: string;
}

/** Newest first. Add a new entry at the top, in the pull request that makes the change. */
export const UPDATES: Update[] = [
  {
    id: "nudge-card",
    date: "2026-11-25",
    kind: "feature",
    title: "Offer help from your page",
    text: "Your site can show a short message above the chat button, such as after a failed save, and start the visitor's message with an error ID. Message cards above the chat button look cleaner too.",
    docs: "add-to-your-site#offer-help-from-your-page",
  },
  {
    id: "chat-history-and-inbox-fixes",
    date: "2026-11-25",
    kind: "fix",
    title: "Older chats and read receipts",
    text: "The mobile inbox includes older open conversations in its list and search. Visitors keep their read receipts when they sign in and their chat histories merge.",
  },
  {
    id: "link-previews",
    date: "2026-11-25",
    kind: "feature",
    title: "Link previews",
    text: "When a reply has a link, the box shows the page's title and picture before you send it. Remove it with ✕, or send it, and the visitor sees it under your reply. Only the first link gets one, so a reply with many links stays short.",
  },
  {
    id: "visitor-history",
    date: "2026-11-24",
    kind: "improvement",
    title: "A visitor's earlier chats",
    text: "When someone chatted signed out and then signs in on the same browser, their earlier chats move to the signed-in contact. A contact also shows the conversations of other visitors with the same email, on the web and in the mobile app.",
  },
  {
    id: "live-chat-by-dinghy",
    date: "2026-11-24",
    kind: "improvement",
    title: "Live chat by Dinghy",
    text: 'The line under the chat says "Live chat by Dinghy" and shows on every chat. Appearance no longer has a switch to hide it.',
  },
  {
    id: "whats-new-sheet",
    date: "2026-11-23",
    kind: "improvement",
    title: "What's new opens on the right",
    text: "What's new opens as a sheet on the right, and its icon in the sidebar is a gift. On a tablet, the top bar keeps two rows, with the sections in the second.",
  },
  {
    id: "sonar-and-lighthouse",
    date: "2026-11-23",
    kind: "improvement",
    title: "A sonar and a lighthouse",
    text: "While nobody is on your site, Visitors shows a sonar sweeping for people. Analytics with no conversations yet shows a lighthouse keeping watch.",
  },
  {
    id: "welcome-contact-details",
    date: "2026-11-23",
    kind: "fix",
    title: "The welcome contact has its details",
    text: "On Dinghy Cloud, the founder's contact in a new workspace shows a company, a country and when it was last seen.",
  },
  {
    id: "billing-page",
    date: "2026-11-23",
    kind: "feature",
    title: "A Billing page in Settings",
    text: "On Dinghy Cloud, owners see the plan, its price, the usage, the card that pays and the recent invoices in Settings > Billing. Each invoice opens on Stripe, with its PDF.",
    docs: "operator-guide#billing",
  },
  {
    id: "get-started-next-step",
    date: "2026-11-23",
    kind: "improvement",
    title: "Get started shows the next step",
    text: "Get started in the sidebar now names the next step. Inviting a teammate is optional, so it no longer counts.",
  },
  {
    id: "welcome-contact",
    date: "2026-11-23",
    kind: "improvement",
    title: "The welcome chat has its contact panel",
    text: "The welcome chat shows the contact panel beside it, and Contacts show the founder's picture. Empty charts show a grey shape, and Analytics shows the gull until the first conversations come.",
  },
  {
    id: "email-links",
    date: "2026-11-23",
    kind: "improvement",
    title: "Links in emails sit behind words",
    text: 'Emails from Dinghy show each link behind a few words, such as "sign in to Dinghy", in place of the whole address.',
  },
  {
    id: "close-opens-next",
    date: "2026-11-23",
    kind: "improvement",
    title: "Close moves on to the next conversation",
    text: "Close now opens the next conversation in the list, as Shift+E does. It stays on the conversation while a reply is still sending, so you can retry it.",
  },
  {
    id: "ask-to-change",
    date: "2026-11-21",
    kind: "feature",
    title: "Ask a bot to change its draft",
    text: 'Under a bot\'s draft, type what to change, such as "shorter" or "in Spanish", and the bot answers with a new draft. An owner or admin turns it on for a key in Settings > API & webhooks.',
    docs: "agents#ask-to-change",
  },
  {
    id: "site-analytics",
    date: "2026-11-18",
    kind: "improvement",
    title: "Your site's numbers in Analytics",
    text: "Analytics shows visits, page views, the chat rate, the busiest moment, top pages and sources for 7, 30 or 90 days, next to the support numbers. Dinghy counts them with no cookie and no stored ID.",
  },
  {
    id: "visitors-waiting",
    date: "2026-11-18",
    kind: "improvement",
    title: "See who waits in Visitors",
    text: "Visitors has a Waiting filter, and a visitor whose message has no reply shows how long they have waited. New tiles count countries and devices.",
  },
  {
    id: "filter-card-edge",
    date: "2026-11-17",
    kind: "fix",
    title: "The filter card keeps its edge",
    text: "The Inbox's filter card no longer loses its left edge when the conversation list is narrow. It opens over the page, lined up with its button.",
  },
  {
    id: "gull",
    date: "2026-11-17",
    kind: "improvement",
    title: "A gull watches the empty inbox",
    text: "An empty inbox shows a pixel gull on a mooring post. It sleeps when every conversation is closed and looks through its telescope when a search finds nothing. A new workspace gets a board to send itself a test chat.",
  },
  {
    id: "duplicate-campaign",
    date: "2026-11-17",
    kind: "feature",
    title: "Duplicate a campaign",
    text: "Duplicate saves a copy of a campaign as a new draft and opens it. It is the main button on an ended campaign.",
  },
  {
    id: "contact-fields",
    date: "2026-11-16",
    kind: "feature",
    title: "The attributes and events your app sends",
    text: "Contacts > Attributes and events lists what your app sends about the 1,000 contacts seen last, how many of them have each one, and the campaigns that read it.",
  },
  {
    id: "campaigns",
    date: "2026-11-16",
    kind: "feature",
    title: "Campaigns",
    text: "Send messages by a rule: who gets them, when, what they say and how often. A campaign starts on a page visit, an event from your server, a schedule or a contact who starts to match, and counts its results per day and per A/B variant.",
    docs: "campaigns",
  },
  {
    id: "outbound-messages",
    date: "2026-11-15",
    kind: "feature",
    title: "Write to a visitor first",
    text: "Send one visitor a message before they write, with Message on a contact or in Visitors, from your server or from an AI agent. A conversation starts when they answer.",
    docs: "outbound-messages",
  },
  {
    id: "shift-e",
    date: "2026-11-15",
    kind: "improvement",
    title: "Shift+E closes a conversation",
    text: "E alone closed it before, so one stray key could close a chat.",
  },
  {
    id: "addresses",
    date: "2026-11-14",
    kind: "fix",
    title: "A reload stays on the same screen",
    text: "A reload or a copied link used to go back to the Inbox. Now it stays on Contacts, a contact, Visitors, Analytics or the open conversation.",
  },
  {
    id: "reload-card",
    date: "2026-11-13",
    kind: "fix",
    title: "A failed screen offers Reload",
    text: "A screen that fails to load shows a card with Reload, not a blank page.",
  },
  {
    id: "saved-replies",
    date: "2026-11-13",
    kind: "feature",
    title: "Saved replies",
    text: "Write common answers once in Settings > Saved replies. Type / in the reply box to insert one, and change it before you send.",
  },
  {
    id: "files",
    date: "2026-11-13",
    kind: "feature",
    title: "Files in the chat",
    text: "Visitors and your team can send PDFs, documents, spreadsheets, ZIP files and short videos of up to 10 MB. Turn on visitors' files in Settings > Appearance.",
  },
  {
    id: "mentions",
    date: "2026-11-13",
    kind: "feature",
    title: "Mention a teammate in a note",
    text: "Type @ in a note to pick a teammate. They get an alert with the note, and the conversation is unread for them.",
  },
  {
    id: "business-hours",
    date: "2026-11-13",
    kind: "feature",
    title: "Business hours",
    text: "Set your hours in Settings > Business hours. Outside them, the chat says when you are back, on the visitor's own clock, and asks for an email.",
  },
  {
    id: "widget-languages",
    date: "2026-11-13",
    kind: "feature",
    title: "The chat speaks French and Spanish",
    text: "Pick a language in Settings > Appearance, or let the chat follow the visitor's browser. Reply emails and transcripts follow it too.",
  },
  {
    id: "email-replies",
    date: "2026-11-13",
    kind: "feature",
    title: "Visitors reply by email",
    text: "On a server set up for it, a visitor's answer to a reply email goes into the conversation, and reopens it when it was closed.",
  },
  {
    id: "two-factor",
    date: "2026-11-13",
    kind: "feature",
    title: "Two-step sign-in",
    text: "Turn it on in Profile with an authenticator app. Each new sign-in then asks for a 6-digit code after the email link, and Settings > Team shows who has it on.",
  },
  {
    id: "labels",
    date: "2026-11-13",
    kind: "feature",
    title: "Labels",
    text: "Press L to put a colored label such as billing or bugs on a conversation. The Inbox filters by label, and Analytics counts conversations by label.",
  },
  {
    id: "bulk-actions",
    date: "2026-11-13",
    kind: "feature",
    title: "Bulk actions in the Inbox",
    text: "Pick conversations with the box on each row or with X, then close, assign, label, mark read or delete them at once.",
  },
  {
    id: "keyboard-shortcuts",
    date: "2026-11-13",
    kind: "feature",
    title: "Keyboard shortcuts",
    text: "Press ? to see them all. / searches, J and K move through the Inbox, R replies, N writes a note, and G then a letter opens a page. A switch in the list turns the single keys off.",
    docs: "operator-guide#keyboard-shortcuts",
  },
  {
    id: "selection-readable",
    date: "2026-11-12",
    kind: "fix",
    title: "Selected text stays readable in the chat",
    text: "On a site that styles its own text selection, text selected in the chat no longer turns invisible.",
  },
  {
    id: "ai-agents",
    date: "2026-11-12",
    kind: "feature",
    title: "Connect Claude Code and other AI agents",
    text: "An AI agent connects with OAuth in the browser, with no secret to copy. It can write drafts for your team to send, hand a chat to a person, and stop when you pause every bot with one switch.",
    docs: "agents",
  },
  {
    id: "notes",
    date: "2026-11-12",
    kind: "feature",
    title: "Internal notes",
    text: "Choose Note above the reply box to write something only your team sees.",
  },
  {
    id: "snooze",
    date: "2026-11-12",
    kind: "feature",
    title: "Snooze",
    text: "Snooze a conversation until the visitor replies, until tomorrow or until next Monday. It does not count as waiting until then.",
  },
  {
    id: "unread",
    date: "2026-11-12",
    kind: "feature",
    title: "Unread conversations",
    text: "The Inbox shows the conversations you have not read in bold, with a blue dot. Each teammate reads on their own.",
  },
  {
    id: "header-faces",
    date: "2026-11-12",
    kind: "improvement",
    title: "Your team's faces in the chat",
    text: "The chat's header shows the teammates online now, or the ones you choose, and can say how fast you usually reply.",
  },
  {
    id: "away",
    date: "2026-11-12",
    kind: "feature",
    title: "Available or away",
    text: "Set yourself away in the menu under your name. While you are away, the chat does not count you online.",
  },
  {
    id: "visitors",
    date: "2026-11-12",
    kind: "feature",
    title: "Visitors: who is on your site now",
    text: "See everyone on your site on a world map, with their page, local time, device and where they came from. Click a country to zoom in.",
  },
  {
    id: "contacts",
    date: "2026-11-12",
    kind: "feature",
    title: "Contacts",
    text: "Contacts lists everyone who has chatted, with search and a CSV export. A contact's page shows every conversation, the pages they visited and a private note.",
  },
  {
    id: "typing-preview",
    date: "2026-11-12",
    kind: "feature",
    title: "See what a visitor types",
    text: "Read a visitor's message while they type it, before they send. Dinghy stores none of it, and Settings > Workspace turns it off.",
  },
  {
    id: "formatting",
    date: "2026-11-12",
    kind: "feature",
    title: "Formatting in messages",
    text: "Bold, italic, code, links and lists show in the chat, in the app and in reply emails. The reply box has a button for each.",
  },
  {
    id: "receipts",
    date: "2026-11-12",
    kind: "feature",
    title: "Read receipts",
    text: "Under your last reply, the thread shows whether it was sent, emailed or read in the chat, and it changes as the visitor reads.",
  },
  {
    id: "quote-reply",
    date: "2026-11-12",
    kind: "feature",
    title: "Reply to one message",
    text: "Quote a message in your reply, as in WhatsApp or Slack. Each message also has a menu to copy, edit, delete or link to it.",
  },
  {
    id: "transcripts",
    date: "2026-11-12",
    kind: "feature",
    title: "Transcripts by email",
    text: "A visitor who gave an email can get the conversation by email 5 minutes after it closes, once your team has replied. Settings > Appearance turns it off.",
  },
  {
    id: "get-started",
    date: "2026-11-12",
    kind: "feature",
    title: "Get started",
    text: "Owners and admins see six first steps at the foot of the sidebar, from installing the chat to sending a test chat.",
  },
  {
    id: "settings",
    date: "2026-11-11",
    kind: "improvement",
    title: "Settings on one page",
    text: "Settings groups its pages into You, Workspace, Chat widget and Developers, and each page has its own address.",
  },
  {
    id: "appearance",
    date: "2026-11-11",
    kind: "feature",
    title: "Change the chat's look without code",
    text: "Settings > Appearance sets the words, the colors, the side, the theme and the chat button, with a live preview.",
  },
  {
    id: "pictures",
    date: "2026-11-11",
    kind: "improvement",
    title: "Profile pictures",
    text: "Add a picture in Profile. Visitors see it with your first name on each of your replies.",
  },
  {
    id: "api",
    date: "2026-11-10",
    kind: "feature",
    title: "API keys, webhooks and MCP",
    text: "Connect your own tools and bots from Settings > API & webhooks. An AI agent can answer chats through the MCP server, and its replies show the key's name.",
    docs: "api",
  },
  {
    id: "invites",
    date: "2026-11-10",
    kind: "feature",
    title: "Invite by email",
    text: "Invite a teammate with their email address. Someone new joins with only their name.",
  },
  {
    id: "dark-theme",
    date: "2026-11-09",
    kind: "feature",
    title: "Dark theme",
    text: "The app follows your device's theme, or stays light or dark.",
  },
  {
    id: "search-analytics",
    date: "2026-11-09",
    kind: "feature",
    title: "Search and Analytics",
    text: "Search conversations by name, email or message text. Analytics shows conversations per day, the first reply time and the busiest hours.",
  },
  {
    id: "sign-in-links",
    date: "2026-11-08",
    kind: "feature",
    title: "Sign in with an email link",
    text: "Dinghy has no passwords. Each sign-in link works once, for 15 minutes.",
  },
];

/** Each operator has their own, as two can share one browser. */
const seenKey = (operatorId: string) => `dinghy.updates.seen.${operatorId}`;

/**
 * How many updates came after the one with `seenId`. Nothing seen yet means all of them. An ID
 * this list does not have counts as all seen: it is gone, or a newer app in another tab saved it.
 */
export function updatesAfter(seenId: string | null): number {
  if (seenId === null) return UPDATES.length;
  return Math.max(
    0,
    UPDATES.findIndex((update) => update.id === seenId),
  );
}

export const unseenCount = (operatorId: string) => updatesAfter(readStored(seenKey(operatorId)));

/** Saves the newest update as seen, unless a newer app already saved one this list lacks. */
export function markUpdatesSeen(operatorId: string): void {
  const saved = readStored(seenKey(operatorId));
  const newest = UPDATES[0];
  if (newest && (saved === null || UPDATES.some((update) => update.id === saved)))
    store(seenKey(operatorId), newest.id);
}

/** Calls `onChange` when another tab saves what an operator has seen. */
export function onSeenElsewhere(operatorId: string, onChange: () => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key === seenKey(operatorId)) onChange();
  };
  addEventListener("storage", listener);
  return () => removeEventListener("storage", listener);
}
