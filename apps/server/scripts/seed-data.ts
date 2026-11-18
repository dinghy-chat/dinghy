// The demo workspace that `bun run seed` writes: a team, its labels and saved replies, and the
// conversations, contacts and live visitors that make every screen of the operator app look used.
// Times are relative to the moment the seed runs, so the inbox always shows people waiting now.

export const SITE = "https://acme.example";
export const WORKSPACE_NAME = "Acme";

export type TeamKey = "anna" | "ben" | "chloe" | "diego";

export const TEAM: Record<
  TeamKey,
  { name: string; email: string; role: "owner" | "admin" | "member"; away: boolean }
> = {
  anna: { name: "Anna Lindqvist", email: "anna@acme.example", role: "owner", away: false },
  ben: { name: "Ben Okafor", email: "ben@acme.example", role: "admin", away: false },
  chloe: { name: "Chloé Martin", email: "chloe@acme.example", role: "member", away: false },
  diego: { name: "Diego Ramos", email: "diego@acme.example", role: "member", away: true },
};

export const LABELS = {
  Bug: "red",
  Billing: "blue",
  "Feature request": "purple",
  VIP: "yellow",
} as const;
type LabelName = keyof typeof LABELS;

export const SAVED_REPLIES = [
  {
    shortcut: "refund",
    body: "I've started the refund. It reaches your card within 5 to 10 business days, depending on your bank.",
  },
  {
    shortcut: "invite-team",
    body: "Go to **Settings → Team**, select **Invite**, and enter your teammates' emails. Each gets a link that works for 7 days.",
  },
  {
    shortcut: "shipping-times",
    body: "Orders ship within 1 business day. Delivery takes 2 to 4 days in the US and the EU, and 5 to 8 days elsewhere.",
  },
  {
    shortcut: "bug-thanks",
    body: "Thanks for the details, that helps a lot. I've passed this to our engineers and I'll write here as soon as we have a fix.",
  },
  {
    shortcut: "vat-invoice",
    body: "Add your VAT number in **Settings → Billing → Company details**. The next invoice shows it, and I can reissue the last one.",
  },
];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** `minutes` before the seed runs. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);

/** A local time of day, `days` days before the seed runs. */
function daysAgo(days: number, hour: number, minute = 0): Date {
  const at = new Date(Date.now() - days * DAY_MS);
  at.setHours(hour, minute, 0, 0);
  return at;
}

export interface VisitorSeed {
  /** A signed-in contact of Acme's own app. Without it, the visitor is anonymous. */
  contact?: { userId: string; name: string; email: string; company?: string; plan?: string };
  country: string;
  timeZone: string;
  device: string;
  /** The pages they went through, oldest first. The chat starts on the last one. */
  pages: string[];
}

/** Who wrote a line: the visitor, a teammate, or a teammate's internal note. */
type Author = "visitor" | TeamKey | `note:${TeamKey}`;
/** A line, with the minutes since the line before it. */
export type Line = [Author, string, number?];

export interface ConversationSeed {
  visitor: VisitorSeed;
  startedAt: Date;
  lines: Line[];
  status: "open" | "closed" | "snoozed";
  /** The assignee, when it is not the first teammate who replied. Null leaves it unassigned. */
  assignee?: TeamKey | null;
  labels?: LabelName[];
}

const visitor = (
  country: string,
  timeZone: string,
  device: string,
  pages: string[],
  contact?: VisitorSeed["contact"],
): VisitorSeed => ({ country, timeZone, device, pages, ...(contact && { contact }) });

const NY = ["US", "America/New_York"] as const;
const SF = ["US", "America/Los_Angeles"] as const;
const LONDON = ["GB", "Europe/London"] as const;
const BERLIN = ["DE", "Europe/Berlin"] as const;
const PARIS = ["FR", "Europe/Paris"] as const;
const SAO_PAULO = ["BR", "America/Sao_Paulo"] as const;
const TOKYO = ["JP", "Asia/Tokyo"] as const;
const TORONTO = ["CA", "America/Toronto"] as const;
const SYDNEY = ["AU", "Australia/Sydney"] as const;
const MUMBAI = ["IN", "Asia/Kolkata"] as const;
const MADRID = ["ES", "Europe/Madrid"] as const;
const AMSTERDAM = ["NL", "Europe/Amsterdam"] as const;
const STOCKHOLM = ["SE", "Europe/Stockholm"] as const;
const MILAN = ["IT", "Europe/Rome"] as const;

const MAYA = visitor(...NY, "Chrome on macOS", ["/app/reports", "/account/billing"], {
  userId: "u_1042",
  name: "Maya Patel",
  email: "maya@brightline.io",
  company: "Brightline",
  plan: "Team",
});
const TOM = visitor(
  ...LONDON,
  "Firefox on Windows",
  ["/app/reports", "/app/reports/exports", "/docs/exports"],
  { userId: "u_0877", name: "Tom Becker", email: "tom@northwind.co.uk", company: "Northwind" },
);
const INVITE_VISITOR = visitor(...PARIS, "Safari on macOS", [
  "/",
  "/docs/getting-started",
  "/docs/team",
]);
const NOAH = visitor(...TORONTO, "Chrome on Windows", ["/app/reports", "/changelog"], {
  userId: "u_1311",
  name: "Noah Kim",
  email: "noah@fernhill.ca",
  company: "Fernhill",
  plan: "Starter",
});

/** The visitors who are on the site now, and the tabs the Visitors screen lists. */
export const LIVE = {
  /** Chatting visitors, by their conversation's index in CONVERSATIONS. */
  chatting: [
    { conversation: 0, title: "Billing · Acme" },
    { conversation: 2, title: "Exports · Acme Docs" },
    { conversation: 3, title: "Invite your team · Acme Docs" },
  ],
  /** The visitor whose unsent draft the inbox shows, with `--live`. */
  typing: {
    conversation: 3,
    draft: "I clicked the link in the email but it says the invite has expired, can you",
  },
  /** A known contact on the site who has not chatted. */
  known: { visitor: NOAH, title: "Changelog · Acme" },
  anonymous: [
    {
      page: "/pricing",
      title: "Pricing · Acme",
      referrer: "https://www.google.com",
      country: "US",
      timeZone: "America/Chicago",
      device: "Chrome on Windows",
    },
    {
      page: "/blog/weekly-reports-that-get-read",
      title: "Weekly reports that get read · Acme Blog",
      referrer: "https://news.ycombinator.com",
      country: "IN",
      timeZone: "Asia/Kolkata",
      device: "Firefox on Linux",
    },
    {
      page: "/shop/hub",
      title: "Acme Hub · Acme Shop",
      referrer: "https://x.com",
      country: "AU",
      timeZone: "Australia/Sydney",
      device: "Safari on iPhone",
    },
    {
      page: "/docs/api",
      title: "API reference · Acme Docs",
      referrer: "https://github.com",
      country: "DE",
      timeZone: "Europe/Berlin",
      device: "Chrome on macOS",
    },
  ],
};

/** Contacts from Acme's app who never chatted, so the Contacts list holds more than chatters. */
export const QUIET_CONTACTS: VisitorSeed[] = [
  NOAH,
  visitor(...STOCKHOLM, "Chrome on macOS", ["/app/reports"], {
    userId: "u_0412",
    name: "Elin Andersson",
    email: "elin@nordvik.se",
    company: "Nordvik",
    plan: "Business",
  }),
  visitor(...SF, "Safari on iPad", ["/app/dashboards"], {
    userId: "u_1520",
    name: "Jordan Lee",
    email: "jordan@lumen.dev",
    company: "Lumen",
    plan: "Team",
  }),
  visitor(...MILAN, "Edge on Windows", ["/app/reports"], {
    userId: "u_0990",
    name: "Giulia Bianchi",
    email: "giulia@studiobianchi.it",
    company: "Studio Bianchi",
    plan: "Starter",
  }),
];

export const CONVERSATIONS: ConversationSeed[] = [
  // Waiting for a reply now.
  {
    visitor: MAYA,
    startedAt: minutesAgo(6),
    status: "open",
    labels: ["Billing"],
    lines: [
      [
        "visitor",
        "Hi! I was charged twice for our Team plan this month. Two charges of $290 on the 3rd.",
      ],
      ["visitor", "Can you refund one of them? Happy to send a screenshot of the statement.", 2],
    ],
  },
  {
    visitor: visitor(...BERLIN, "Chrome on Android", ["/shop", "/shop/hub", "/shop/shipping"]),
    startedAt: minutesAgo(11),
    status: "open",
    lines: [
      ["visitor", "Hallo, do you ship the Acme Hub to Germany? And how long does it usually take?"],
    ],
  },
  {
    visitor: TOM,
    startedAt: minutesAgo(58),
    status: "open",
    labels: ["Bug"],
    lines: [
      [
        "visitor",
        "Our CSV exports have been empty since this morning. The report itself shows data.",
      ],
      [
        "ben",
        "Sorry about that, Tom. Which report is it, and roughly how many rows does it have?",
        4,
      ],
      ["visitor", "It's 'Weekly revenue by region', about 1,200 rows. PDF export works fine.", 6],
      ["note:ben", "Looks like the export timeout again on reports over 1k rows. Pinged Diego.", 3],
      ["visitor", "Any update? Our finance team needs it for a 3pm meeting.", 30],
    ],
  },
  {
    visitor: INVITE_VISITOR,
    startedAt: minutesAgo(3),
    status: "open",
    lines: [["visitor", "Hello, how do I add my colleagues to our workspace? I'm the admin."]],
  },
  {
    visitor: visitor(...SAO_PAULO, "Chrome on macOS", ["/app/reports", "/roadmap"], {
      userId: "u_1188",
      name: "Lucas Silva",
      email: "lucas@pixelco.com.br",
      company: "Pixel & Co",
      plan: "Team",
    }),
    startedAt: minutesAgo(95),
    status: "open",
    assignee: "chloe",
    labels: ["Feature request"],
    lines: [
      [
        "visitor",
        "Is dark mode for shared reports on the roadmap? Our clients open them at night.",
      ],
      [
        "chloe",
        "Great question! It's planned, but not scheduled yet. Do you share them as links or PDFs?",
        9,
      ],
      ["visitor", "Mostly links. A dark theme for the link view would be enough for us.", 18],
      ["visitor", "Also, could the logo on shared links be bigger? It's tiny on mobile.", 2],
    ],
  },
  {
    visitor: visitor(...BERLIN, "Safari on macOS", ["/account/billing", "/pricing"], {
      userId: "u_0021",
      name: "Hannah Schmidt",
      email: "hannah.schmidt@kessler.de",
      company: "Kessler GmbH",
      plan: "Business",
    }),
    startedAt: minutesAgo(140),
    status: "open",
    assignee: "anna",
    labels: ["VIP", "Billing"],
    lines: [
      [
        "visitor",
        "Hi Anna, we're renewing for 50 seats next month. Can we switch to annual invoicing?",
      ],
      ["note:ben", "Kessler is our largest account. Annual with 2 months free is pre-approved.", 5],
      ["anna", "Hi Hannah! Yes, absolutely. I'll prepare an annual quote for 50 seats today.", 7],
      [
        "visitor",
        "Perfect. Please address it to our procurement team, procurement@kessler.de.",
        40,
      ],
    ],
  },
  // Answered, open.
  {
    visitor: visitor(...SF, "Safari on iPhone", ["/shop/orders"], {
      userId: "u_1402",
      name: "Oliver Grant",
      email: "oliver.grant@gmail.com",
    }),
    startedAt: minutesAgo(240),
    status: "open",
    lines: [
      ["visitor", "My Hub order #A-20931 says delivered but there's nothing at my door."],
      [
        "chloe",
        "I'm sorry, Oliver! I've opened a claim with the carrier. Could you check with your neighbors meanwhile?",
        6,
      ],
      ["visitor", "Found it! It was with the building manager. Thanks!", 45],
      [
        "chloe",
        "Great news! Enjoy your Hub, and let us know if the setup gives you any trouble.",
        3,
      ],
    ],
  },
  {
    visitor: visitor(...TOKYO, "Chrome on macOS", ["/docs/api", "/docs/api/limits"]),
    startedAt: daysAgo(0, 9, 12),
    status: "open",
    lines: [
      [
        "visitor",
        "What's the rate limit on the reports API? We get 429s at about 10 requests per second.",
      ],
      [
        "diego",
        "The limit is 600 requests per minute per key, so bursts above 10 a second get a 429. Spreading them out, or using the bulk endpoint, fixes it.",
        14,
      ],
    ],
  },
  {
    visitor: visitor(...MILAN, "Chrome on Windows", ["/docs/getting-started", "/docs/import"], {
      userId: "u_1501",
      name: "Sofia Rossi",
      email: "sofia@ventura.it",
      company: "Ventura",
      plan: "Starter",
    }),
    startedAt: daysAgo(0, 8, 40),
    status: "open",
    lines: [
      ["visitor", "Can I import our old reports from a spreadsheet?"],
      [
        "anna",
        "Yes! Go to Reports → Import and drop the .xlsx or .csv file. Each sheet becomes a report.",
        5,
      ],
      ["visitor", "Trying now, thanks.", 2],
      [
        "anna",
        "Let me know how it goes. If a column comes out wrong, send me the file and I'll take a look.",
        1,
      ],
    ],
  },
  {
    visitor: visitor(...NY, "Safari on macOS", ["/login", "/login"], {
      userId: "u_0655",
      name: "Ethan Brooks",
      email: "ethan@harborlabs.com",
      company: "Harbor Labs",
      plan: "Team",
    }),
    startedAt: daysAgo(1, 16, 5),
    status: "open",
    assignee: "diego",
    labels: ["Bug"],
    lines: [
      ["visitor", "I keep getting sent back to the login page after signing in. Only in Safari."],
      [
        "diego",
        "Thanks Ethan. Which Safari version are you on? And do you block cross-site cookies?",
        8,
      ],
      ["visitor", "Safari 18.1, default settings.", 5],
      [
        "note:diego",
        "Reproduced on Safari 18.1. The session cookie lacks Partitioned. Fix in review.",
        25,
      ],
      [
        "diego",
        "Reproduced it, and a fix is in review. It should ship tomorrow. Chrome works meanwhile.",
        2,
      ],
    ],
  },
  {
    visitor: visitor(...AMSTERDAM, "Firefox on macOS", ["/pricing", "/contact-sales"], {
      userId: "u_1610",
      name: "Daan de Vries",
      email: "daan@kanaal.nl",
      company: "Kanaal",
    }),
    startedAt: daysAgo(2, 11, 20),
    status: "snoozed",
    assignee: "ben",
    lines: [
      ["visitor", "We're evaluating Acme for 20 people. Is there a trial of the Business plan?"],
      [
        "ben",
        "Hi Daan! I've turned on a 30-day Business trial for your workspace. I'll check in next week.",
        11,
      ],
      ["visitor", "Great, thank you!", 4],
    ],
  },
  // Closed, over the last 30 days.
  {
    visitor: visitor(...LONDON, "Chrome on macOS", ["/account/billing"], {
      userId: "u_0730",
      name: "Grace Howard",
      email: "grace@thimble.co",
      company: "Thimble",
      plan: "Team",
    }),
    startedAt: daysAgo(1, 10, 15),
    status: "closed",
    labels: ["Billing"],
    lines: [
      ["visitor", "How do I add our VAT number to invoices?"],
      [
        "ben",
        "Add it in Settings → Billing → Company details. The next invoice shows it, and I can reissue the last one.",
        3,
      ],
      ["visitor", "Done. Could you reissue October's?", 4],
      ["ben", "Sent to your billing email just now.", 6],
      ["visitor", "Got it, thanks Ben!", 2],
    ],
  },
  {
    visitor: visitor(...TORONTO, "Edge on Windows", ["/shop/hub", "/shop/checkout"]),
    startedAt: daysAgo(2, 14, 30),
    status: "closed",
    lines: [
      ["visitor", "Does the Hub come with a power adapter for Canada?"],
      ["chloe", "Yes, every Hub ships with a USB-C adapter for your country.", 2],
      ["visitor", "Perfect, ordering now.", 1],
    ],
  },
  {
    visitor: visitor(...SYDNEY, "Chrome on Windows", ["/app/settings", "/docs/sso"], {
      userId: "u_0318",
      name: "Liam Walker",
      email: "liam@coastline.com.au",
      company: "Coastline",
      plan: "Business",
    }),
    startedAt: daysAgo(3, 7, 50),
    status: "closed",
    labels: ["Feature request"],
    lines: [
      ["visitor", "Do you support SSO with Okta?"],
      [
        "anna",
        "We support Google and Microsoft today. Okta is on our roadmap for early next year.",
        12,
      ],
      ["visitor", "OK. Please count this as a vote for Okta, we'd move our whole team over.", 5],
      ["note:anna", "Third Okta request this month. Added to the SSO roadmap card.", 1],
      ["anna", "Counted! I'll write here as soon as it's in beta.", 1],
    ],
  },
  {
    visitor: visitor(...MADRID, "Safari on iPhone", ["/shop/orders"], {
      userId: "u_1250",
      name: "Carmen Ortiz",
      email: "carmen.ortiz@outlook.es",
    }),
    startedAt: daysAgo(4, 18, 10),
    status: "closed",
    lines: [
      ["visitor", "My Hub arrived with a cracked case. What can I do?"],
      [
        "chloe",
        "I'm so sorry, Carmen! I'm sending a replacement today, with a prepaid label for the damaged one.",
        7,
      ],
      ["visitor", "That was fast. Thank you!", 3],
    ],
  },
  {
    visitor: visitor(...NY, "Chrome on macOS", ["/app/integrations"], {
      userId: "u_0982",
      name: "Priya Shah",
      email: "priya@quill.app",
      company: "Quill",
      plan: "Team",
    }),
    startedAt: daysAgo(5, 13, 25),
    status: "closed",
    labels: ["Bug"],
    lines: [
      ["visitor", "Our webhook stopped firing on new reports yesterday."],
      [
        "diego",
        "Checking. It answered 410 Gone from your endpoint, so we turned it off after 3 days of failures.",
        15,
      ],
      ["visitor", "Ah, we moved servers. Updated the URL, and it works again.", 9],
      ["diego", "Great. You can replay the missed events from the webhook's page.", 2],
    ],
  },
  {
    visitor: visitor(...PARIS, "Firefox on Windows", ["/pricing"]),
    startedAt: daysAgo(6, 10, 5),
    status: "closed",
    lines: [
      ["visitor", "Is there a discount for nonprofits?"],
      [
        "anna",
        "Yes, 50% on every plan. Send us your registration document and we'll apply it.",
        20,
      ],
    ],
  },
  {
    visitor: visitor(...STOCKHOLM, "Chrome on macOS", ["/account/billing"], {
      userId: "u_0533",
      name: "Oskar Lund",
      email: "oskar@ferry.se",
      company: "Ferry",
      plan: "Starter",
    }),
    startedAt: daysAgo(7, 15, 40),
    status: "closed",
    labels: ["Billing"],
    lines: [
      ["visitor", "We want to downgrade to Starter. Do we lose any reports?"],
      [
        "ben",
        "No reports are lost. Starter keeps 3 dashboards; the others become read-only until you upgrade again.",
        6,
      ],
      ["visitor", "That works. Downgraded, thanks.", 10],
    ],
  },
  {
    visitor: visitor(...MUMBAI, "Chrome on Android", ["/docs/mobile"]),
    startedAt: daysAgo(8, 11, 0),
    status: "closed",
    labels: ["Feature request"],
    lines: [
      ["visitor", "Is there an Android app?"],
      [
        "chloe",
        "Not yet. The web app works well on Android, and you can add it to your home screen from the browser menu.",
        4,
      ],
      ["visitor", "OK, I'll try that.", 2],
    ],
  },
  {
    visitor: visitor(...LONDON, "Safari on macOS", ["/account/privacy"], {
      userId: "u_0144",
      name: "James Carter",
      email: "james@mosaic.studio",
      company: "Mosaic",
      plan: "Team",
    }),
    startedAt: daysAgo(10, 9, 30),
    status: "closed",
    lines: [
      ["visitor", "For GDPR, can we export everything you store about our workspace?"],
      ["anna", "Yes. Settings → Workspace → Export gives you a full archive of your data.", 9],
      ["visitor", "Found it, thank you.", 6],
    ],
  },
  {
    visitor: visitor(...SAO_PAULO, "Chrome on Windows", ["/shop/hub"]),
    startedAt: daysAgo(12, 17, 45),
    status: "closed",
    lines: [
      ["visitor", "Do you ship to Brazil?"],
      [
        "chloe",
        "We do! Delivery takes 6 to 9 business days, and import taxes are included in the price.",
        5,
      ],
    ],
  },
  {
    visitor: visitor(...BERLIN, "Firefox on Linux", ["/app/reports/schedule"], {
      userId: "u_0711",
      name: "Felix Wagner",
      email: "felix@brandt.dev",
      company: "Brandt",
      plan: "Team",
    }),
    startedAt: daysAgo(14, 8, 20),
    status: "closed",
    labels: ["Feature request"],
    lines: [
      ["visitor", "Can I schedule a report to go out every Monday at 8:00?"],
      [
        "ben",
        "Yes: open the report, select Schedule, and pick weekly on Monday at 8:00. It uses your time zone.",
        3,
      ],
      ["visitor", "Nice. Could it also go to a Slack channel?", 2],
      ["ben", "Not yet, but I've added your vote for Slack delivery.", 4],
    ],
  },
  {
    visitor: visitor(...TOKYO, "Safari on iPhone", ["/login"]),
    startedAt: daysAgo(16, 22, 10),
    status: "closed",
    lines: [
      ["visitor", "I didn't get the password reset email."],
      ["diego", "It went out a minute ago. Could you check your spam folder?", 6],
      ["visitor", "It was in spam. I'm in, thanks!", 3],
    ],
  },
  {
    visitor: visitor(...AMSTERDAM, "Chrome on macOS", ["/account/billing"], {
      userId: "u_0866",
      name: "Sanne Bakker",
      email: "sanne@tulpdesign.nl",
      company: "Tulp Design",
      plan: "Team",
    }),
    startedAt: daysAgo(19, 14, 0),
    status: "closed",
    labels: ["Billing"],
    lines: [
      ["visitor", "Can we pay by bank transfer instead of card?"],
      ["anna", "On the annual Business plan, yes. I can send you an invoice with our IBAN.", 11],
      ["visitor", "Let's do that. Thanks Anna!", 8],
    ],
  },
  {
    visitor: visitor(...NY, "Chrome on Windows", ["/docs/custom-domain"], {
      userId: "u_0291",
      name: "Rachel Green",
      email: "rachel@uptown.agency",
      company: "Uptown Agency",
      plan: "Business",
    }),
    startedAt: daysAgo(22, 12, 35),
    status: "closed",
    labels: ["VIP"],
    lines: [
      ["visitor", "Our custom domain for shared reports shows a certificate error."],
      [
        "diego",
        "Your CNAME points to the old address. Change it to reports.acme.example and the certificate renews within an hour.",
        10,
      ],
      ["visitor", "Fixed, all green now.", 50],
    ],
  },
  {
    visitor: visitor(...SYDNEY, "Safari on macOS", ["/pricing"]),
    startedAt: daysAgo(25, 6, 15),
    status: "closed",
    lines: [
      ["visitor", "Do you have a student discount?"],
      [
        "chloe",
        "We do, Starter is free for students. Sign up with your university email and it applies itself.",
        8,
      ],
    ],
  },
  {
    visitor: visitor(...TORONTO, "Chrome on macOS", ["/account/billing"], {
      userId: "u_0470",
      name: "Ava Thompson",
      email: "ava@maplegrove.ca",
      company: "Maple Grove",
      plan: "Team",
    }),
    startedAt: daysAgo(28, 16, 50),
    status: "closed",
    labels: ["Billing"],
    lines: [
      ["visitor", "Please cancel our subscription at the end of this month."],
      [
        "ben",
        "Done, it ends on the 30th and you won't be charged again. May I ask what we could have done better?",
        7,
      ],
      ["visitor", "Nothing wrong, the project just ended. We'll be back!", 12],
    ],
  },
];

/** Short questions that come back every week, answered and closed, so Analytics has a history. */
const ROUTINE: [question: string, answer: string, thanks: string][] = [
  [
    "Where can I download my invoices?",
    "In Settings → Billing → Invoices, each one has a PDF.",
    "Found them, thanks!",
  ],
  [
    "Can I change the email I sign in with?",
    "Yes, in Settings → Account. We send a link to the new address to confirm it.",
    "Done, thank you.",
  ],
  [
    "How do I track my Hub order?",
    "The tracking link is in your shipping email, and under Shop → Orders.",
    "Got it, thanks.",
  ],
  [
    "Can I share a report with someone outside our team?",
    "Yes: open the report, select Share, and turn on the public link.",
    "Perfect.",
  ],
  [
    "Do you have a template for monthly sales reports?",
    "Yes, in Reports → New → Templates, choose Monthly sales.",
    "That's exactly what I needed.",
  ],
  [
    "Is my data stored in the EU?",
    "Workspaces made in Europe are stored in Frankfurt, and you can see it under Settings → Workspace.",
    "Great, thanks.",
  ],
  [
    "How do I remove a teammate who left?",
    "In Settings → Team, open their menu and select Remove. Their reports stay.",
    "Thanks!",
  ],
  [
    "Can I pay yearly?",
    "Yes, yearly billing gives you 2 months free. Switch under Settings → Billing.",
    "Switched, thanks.",
  ],
  [
    "The Hub doesn't connect to our Wi-Fi.",
    "It needs a 2.4 GHz network. Hold the button 5 seconds to restart setup.",
    "That fixed it, thanks!",
  ],
  [
    "Can I import data from Google Sheets?",
    "Yes, connect it under Integrations → Google Sheets and pick the sheet.",
    "Works great.",
  ],
];

const PLACES = [NY, LONDON, BERLIN, PARIS, TORONTO, SYDNEY, MADRID, AMSTERDAM, SAO_PAULO, MUMBAI];
const DEVICES = [
  "Chrome on macOS",
  "Safari on iPhone",
  "Chrome on Windows",
  "Firefox on Windows",
  "Edge on Windows",
];
const REPLIERS: TeamKey[] = ["chloe", "ben", "anna", "diego"];
/** Routine chats each weekday of the last 30 days, in turn, and fewer on weekends. */
const PER_WEEKDAY = [2, 1, 3, 2, 1];
const HISTORY_DAYS = 29;

function routineDay(days: number, start: number): ConversationSeed[] {
  const weekday = daysAgo(days, 12).getDay();
  const count =
    weekday === 0 || weekday === 6 ? days % 2 : (PER_WEEKDAY[days % PER_WEEKDAY.length] ?? 1);
  return Array.from({ length: count }, (_, one) => {
    const index = start + one;
    const routine = ROUTINE[index % ROUTINE.length];
    if (routine === undefined) throw new Error("No routine chat");
    const [question, answer, thanks] = routine;
    const [country, timeZone] = PLACES[index % PLACES.length] ?? NY;
    return {
      visitor: visitor(country, timeZone, DEVICES[index % DEVICES.length] ?? "Chrome on macOS", [
        "/",
        "/docs",
      ]),
      startedAt: daysAgo(days, 9 + ((index * 5) % 9), (index * 13) % 60),
      status: "closed",
      lines: [
        ["visitor", question],
        [REPLIERS[index % REPLIERS.length] ?? "anna", answer, 1 + (index % 6)],
        ["visitor", thanks, 3],
      ],
    };
  });
}

/** The routine chats of the last 30 days, oldest first. */
export const ROUTINE_CONVERSATIONS: ConversationSeed[] = Array.from(
  { length: HISTORY_DAYS },
  (_, day) => HISTORY_DAYS - day,
).reduce<ConversationSeed[]>((all, days) => [...all, ...routineDay(days, all.length)], []);
