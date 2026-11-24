/**
 * The App Store listing of the Dinghy Chat app, in en-US. `scripts/app-store.ts push` writes it to
 * App Store Connect, and `check` compares it with what App Store Connect has.
 * Apple's limits: name and subtitle 30 characters, promotional text 170, keywords 100, description
 * 4000. Apple refuses other apps' names in the keywords.
 */
export const LISTING = {
  locale: "en-US",
  name: "Dinghy Chat",
  subtitle: "Live chat inbox for your site",
  promotionalText:
    "Answer the people on your website from your phone. See who is on your site, reply in seconds and hand a chat to a teammate.",
  description: `Dinghy is live chat for your website. This app is for your support team: it puts your chat inbox on your phone.

Reply from anywhere
• Read every chat from your website's widget and answer it from your phone.
• Write with bold, lists and links, or insert one of your team's saved replies.
• Leave a private note that only your team sees.
• A reply written without a connection waits on the phone and sends when the connection returns.

Know who you are talking to
• See the visitors on your site right now and the page each one reads.
• Open a contact to read their past chats, their company, their country and their local time.

Work as a team
• Assign a chat to yourself or to a teammate, and close it when it is done.
• Set yourself available or away.
• Get a notification when a new chat arrives.

Track your support
• See how many chats came in, how fast your team answered and how many got a reply within 5 minutes.

The app needs a Dinghy account. Sign in to Dinghy Cloud, or enter the address of your own Dinghy server: Dinghy is open source, and you can host it yourself.`,
  keywords:
    "live chat,support,helpdesk,customer service,inbox,website chat,chat widget,crm,messaging",
  supportUrl: "https://dinghy.chat/support",
  marketingUrl: "https://dinghy.chat",
  privacyPolicyUrl: "https://dinghy.chat/privacy",
  copyright: "2026 OnceByte, LLC",
  primaryCategory: "BUSINESS",
  secondaryCategory: "PRODUCTIVITY",
  /** The review notes. The demo account's email and code come from the environment at push time. */
  reviewNotes: `Dinghy is a live chat tool for websites. This app is for the support team that answers the chats.

Sign in with the demo account: enter the email and tap "Email me a code", then enter the code and tap "Continue". The code is fixed for this account, so no email is needed. The account belongs to a demo workspace, Harbor Coffee, with conversations, contacts and visitors.`,
} as const;

/** The screenshots in App Store order, each with the headline the compose step puts above it. */
export const SLIDES = [
  { name: "01-inbox", headline: "Live chat for your site,", accent: "on your iPhone" },
  { name: "02-conversation", headline: "Reply to customers", accent: "in real time" },
  { name: "03-visitors", headline: "See who is on", accent: "your website now" },
  { name: "04-contact", headline: "See each customer's", accent: "details and chats" },
  { name: "05-analytics", headline: "Track how fast", accent: "your team replies" },
] as const;
