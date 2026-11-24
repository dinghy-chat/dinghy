// The demo workspace that `bun run seed -- --harbor` writes: Harbor Coffee, a small specialty coffee
// roaster with an online shop, for the app's store screenshots and its review account.
// Times are relative to the moment the seed runs, so the inbox always shows people waiting now.
import {
  AMSTERDAM,
  BERLIN,
  CHICAGO,
  COPENHAGEN,
  type ConversationSeed,
  DENVER,
  DUBLIN,
  daysAgo,
  LONDON,
  MELBOURNE,
  minutesAgo,
  NY,
  PARIS,
  PORTLAND,
  type RoutineChat,
  routineHistory,
  type SeedData,
  SF,
  SYDNEY,
  type TeamMember,
  TORONTO,
  VANCOUVER,
  type VisitorSeed,
  visitor,
} from "./seed-shared.ts";

export const SITE = "https://harborcoffee.example";
export const WORKSPACE_NAME = "Harbor Coffee";

type TeamKey = "nora" | "kenji" | "amara" | "lucia";

export const TEAM: Record<TeamKey, TeamMember> = {
  nora: { name: "Nora Hayes", email: "owner@harborcoffee.example", role: "owner", away: false },
  kenji: {
    name: "Kenji Watanabe",
    email: "kenji@harborcoffee.example",
    role: "admin",
    away: false,
  },
  amara: { name: "Amara Mensah", email: "amara@harborcoffee.example", role: "member", away: false },
  lucia: {
    name: "Lucía Fernández",
    email: "lucia@harborcoffee.example",
    role: "member",
    away: true,
  },
};

export const LABELS = {
  Wholesale: "blue",
  Order: "red",
  Subscription: "purple",
  VIP: "yellow",
} as const;
type LabelName = keyof typeof LABELS;

export const SAVED_REPLIES = [
  {
    shortcut: "shipping-times",
    body: "We roast on Mondays and Thursdays and ship within 1 business day. Delivery takes 2 to 4 days in the US, 4 to 7 in Canada, and 5 to 10 to the UK, the EU and Australia.",
  },
  {
    shortcut: "grind-guide",
    body: "A quick guide: **espresso** fine, **V60 and pour-over** medium-fine, like table salt, **drip machine** medium, **French press** coarse, like sea salt. If it tastes sour, go a little finer. If it tastes bitter, a little coarser.",
  },
  {
    shortcut: "pause-subscription",
    body: "Go to **Account → Subscription** and select **Pause**, then pick 1 to 8 weeks. Nothing ships and nothing is charged until it restarts, and we email you a few days before.",
  },
  {
    shortcut: "wholesale-prices",
    body: "Our wholesale prices per kg:\n\n- **10 to 19 kg a month:** $18.50\n- **20 kg and up:** $16.00\n\nShipping is free on wholesale orders, and you can change the amount each month.",
  },
  {
    shortcut: "gift-card",
    body: "Gift cards arrive by email. At checkout, pick the day and time to send it and add a note. Your recipient gets the code at that time, in their own time zone.",
  },
];

const ROSA = visitor(...PORTLAND, "Safari on macOS", ["/wholesale/order-form", "/wholesale"], {
  userId: "c_2210",
  name: "Rosa Delgado",
  email: "rosa@bluedoorcafe.example",
  company: "Blue Door Café",
  plan: "Wholesale",
});
const GIFT_VISITOR = visitor(...NY, "Safari on iPhone", ["/", "/gift-cards"]);
const HANNAH = visitor(...VANCOUVER, "Chrome on macOS", ["/shop", "/shop/brewing-gear"], {
  userId: "c_1457",
  name: "Hannah Brooks",
  email: "hannah.brooks@mapleleaf.example",
  plan: "Subscriber",
});

export const LIVE: SeedData["LIVE"] = {
  chatting: [
    { conversation: 0, title: "Wholesale · Harbor Coffee" },
    { conversation: 2, title: "Coffee subscription · Harbor Coffee" },
    { conversation: 3, title: "Gift cards · Harbor Coffee" },
    { conversation: 4, title: "Ethiopia Guji · Harbor Coffee" },
  ],
  typing: {
    conversation: 3,
    draft: "Also can I add a short note to it, like happy birthday dad from all of",
  },
  known: { visitor: HANNAH, title: "Brewing gear · Harbor Coffee" },
  anonymous: [
    {
      page: "/shop/colombia-huila",
      title: "Colombia Huila · Harbor Coffee",
      referrer: "https://www.instagram.com",
      country: "AU",
      timeZone: "Australia/Sydney",
      device: "Safari on iPhone",
    },
    {
      page: "/shop/harbor-house-espresso",
      title: "Harbor House Espresso · Harbor Coffee",
      referrer: "https://www.google.com",
      country: "US",
      timeZone: "America/Denver",
      device: "Chrome on Windows",
    },
    {
      page: "/shop/kenya-nyeri",
      title: "Kenya Nyeri · Harbor Coffee",
      referrer: "https://sprudge.com",
      country: "GB",
      timeZone: "Europe/London",
      device: "Firefox on macOS",
    },
    {
      page: "/shop/holiday-blend?utm_source=newsletter&utm_campaign=holiday",
      title: "Holiday Blend · Harbor Coffee",
      referrer: "https://mail.google.com",
      country: "DE",
      timeZone: "Europe/Berlin",
      device: "Chrome on Android",
    },
  ],
};

/** Customers who never chatted, so the Contacts list holds more than chatters. */
export const QUIET_CONTACTS: VisitorSeed[] = [
  HANNAH,
  visitor(...DENVER, "Chrome on Windows", ["/account/orders"], {
    userId: "c_0934",
    name: "Marcus Reed",
    email: "marcus@fieldworkstudio.example",
    company: "Fieldwork Studio",
    plan: "Wholesale",
  }),
  visitor(...PARIS, "Safari on macOS", ["/account/subscription"], {
    userId: "c_1622",
    name: "Camille Laurent",
    email: "camille.laurent@lumiere.example",
    plan: "Subscriber",
  }),
  visitor(...SYDNEY, "Safari on iPhone", ["/account/subscription"], {
    userId: "c_1780",
    name: "Jack Nguyen",
    email: "jack.nguyen@saltwater.example",
    plan: "Subscriber",
  }),
];

export const CONVERSATIONS: ConversationSeed<TeamKey, LabelName>[] = [
  // Waiting for a reply now.
  {
    visitor: ROSA,
    startedAt: minutesAgo(46),
    status: "open",
    labels: ["Wholesale", "VIP"],
    lines: [
      [
        "visitor",
        "Hi! We'd like to go from 10 kg to 20 kg a month on our wholesale order, starting next month.",
      ],
      ["visitor", "Is there a better price per kg at that volume?", 1],
      ["note:kenji", "They've ordered every month since March, offer the 20 kg tier.", 3],
      [
        "nora",
        "Hi Rosa, great to hear! Our wholesale prices per kg:\n\n- **10 to 19 kg:** $18.50\n- **20 kg and up:** $16.00\n\nAt 20 kg you'd save $50 a month. Want me to switch your next order?",
        4,
      ],
      ["visitor", "Yes please! Same Harbor House espresso, all 20 kg.", 19],
      ["visitor", "Could delivery move to the first Tuesday of the month? We're closed Mondays", 5],
    ],
  },
  {
    visitor: visitor(
      ...CHICAGO,
      "Safari on iPhone",
      ["/account/orders", "/account/orders/HC-2041"],
      {
        userId: "c_1873",
        name: "Megan Doyle",
        email: "megan@doylefamily.example",
        plan: "Subscriber",
      },
    ),
    startedAt: minutesAgo(4),
    status: "open",
    labels: ["Order"],
    lines: [
      ["visitor", "Hi, where is my order #HC-2041? Tracking hasn't moved since Monday"],
      ["visitor", "Is it stuck somewhere? It's a gift and I need it by Saturday", 3],
    ],
  },
  {
    visitor: visitor(...DUBLIN, "Chrome on Windows", ["/account/subscription", "/subscriptions"], {
      userId: "c_1209",
      name: "Liam O'Connor",
      email: "liam.oconnor@greenfield.example",
      plan: "Subscriber",
    }),
    startedAt: minutesAgo(9),
    status: "open",
    labels: ["Subscription"],
    lines: [
      ["visitor", "Hello! Quick one about my subscription"],
      [
        "visitor",
        "Can I pause it for 3 weeks? I'm traveling and dont want bags piling up at the door",
        1,
      ],
    ],
  },
  {
    visitor: GIFT_VISITOR,
    startedAt: minutesAgo(2),
    status: "open",
    lines: [
      [
        "visitor",
        "Hi! If I buy a gift card for my dad's birthday on Friday, can it arrive by email that morning?",
      ],
    ],
  },
  {
    visitor: visitor(...MELBOURNE, "Chrome on Android", [
      "/brew-guides/v60",
      "/shop/ethiopia-guji",
    ]),
    startedAt: minutesAgo(6),
    status: "open",
    lines: [
      ["visitor", "What grind size should I use for the Ethiopia Guji on a V60?"],
      ["visitor", "Mine keeps tasting a bit sour, using a hand grinder", 2],
    ],
  },
  {
    visitor: visitor(...TORONTO, "Edge on Windows", ["/", "/wholesale", "/office-coffee"]),
    startedAt: minutesAgo(52),
    status: "open",
    labels: ["Wholesale"],
    lines: [
      [
        "visitor",
        "Hello, I manage an office of about 40 people. Do you do regular coffee deliveries for offices?",
      ],
      [
        "kenji",
        "Hi! We do. Most offices get whole beans once a month at our wholesale prices. What do you brew with, a bean-to-cup machine or filter brewers?",
        3,
      ],
      [
        "visitor",
        "A bean to cup machine. Roughly how much would 40 people go through in a month?",
        21,
      ],
    ],
  },
  // Answered, open.
  {
    visitor: visitor(...LONDON, "Safari on macOS", ["/subscriptions", "/shipping"], {
      userId: "c_0388",
      name: "Oliver Bennett",
      email: "oliver@bennett.example",
      plan: "Subscriber",
    }),
    startedAt: minutesAgo(210),
    status: "open",
    labels: ["Subscription"],
    lines: [
      ["visitor", "Do you ship the subscription to the UK? And are there import fees?"],
      [
        "amara",
        "We do! UK delivery takes 5 to 8 business days, and we pay the import fees, so nothing extra at your door.",
        4,
      ],
      ["visitor", "Brilliant, signing up now", 6],
      ["amara", "Welcome aboard, Oliver! Your first bag ships after Thursday's roast.", 2],
    ],
  },
  {
    visitor: visitor(...COPENHAGEN, "Chrome on macOS", ["/wholesale", "/wholesale/samples"], {
      userId: "c_2301",
      name: "Freja Holm",
      email: "freja@kaffenord.example",
      company: "Kaffe Nord",
      plan: "Wholesale",
    }),
    startedAt: daysAgo(2, 10, 40),
    status: "snoozed",
    labels: ["Wholesale"],
    lines: [
      [
        "visitor",
        "Hi, we're looking for a new espresso roaster from January. Could you send a few samples?",
      ],
      [
        "nora",
        "Hi Freja! I've sent 3 espresso samples today, 250 g each. I'll check in once you've had a few days with them.",
        6,
      ],
      ["visitor", "Thank you, looking forward to it!", 9],
    ],
  },
  // Closed, over the last 30 days.
  {
    visitor: visitor(...SF, "Safari on macOS", ["/account/orders"], {
      userId: "c_1544",
      name: "Daniel Park",
      email: "daniel.park@parkhome.example",
    }),
    startedAt: daysAgo(1, 15, 20),
    status: "closed",
    labels: ["Order"],
    lines: [
      ["visitor", "The hand grinder I ordered came with a loose handle, the screw won't tighten"],
      [
        "kenji",
        "Sorry about that, Daniel! I'm sending a new handle today, and you can keep the old one as a spare.",
        3,
      ],
      ["visitor", "That was quick, thanks!", 4],
    ],
  },
  {
    visitor: visitor(...BERLIN, "Firefox on Windows", ["/account/orders"], {
      userId: "c_0817",
      name: "Jonas Weber",
      email: "jonas.weber@weberhaus.example",
      plan: "Subscriber",
    }),
    startedAt: daysAgo(3, 9, 10),
    status: "closed",
    labels: ["Order"],
    lines: [
      ["visitor", "I ordered whole bean but got ground coffee in my last bag."],
      [
        "lucia",
        "I'm sorry, Jonas! A whole bean bag ships today. Keep the ground one, it's great in a French press.",
        5,
      ],
      ["visitor", "Ha, will do. Thank you!", 7],
    ],
  },
  {
    visitor: visitor(...TORONTO, "Chrome on macOS", ["/account/subscription"], {
      userId: "c_1366",
      name: "Priya Raman",
      email: "priya@ramanstudio.example",
      plan: "Subscriber",
    }),
    startedAt: daysAgo(6, 13, 45),
    status: "closed",
    labels: ["Subscription"],
    lines: [
      ["visitor", "Can I switch my subscription from the Brazil to something more fruity?"],
      [
        "amara",
        "Sure! The Ethiopia Guji has blueberry and jasmine notes. I've switched your next bag to it.",
        2,
      ],
      ["visitor", "Perfect, can't wait to try it", 3],
    ],
  },
  {
    visitor: visitor(...AMSTERDAM, "Safari on macOS", ["/gift-cards", "/corporate-gifts"], {
      userId: "c_0442",
      name: "Sanne Visser",
      email: "sanne@tulpagency.example",
      company: "Tulp Agency",
    }),
    startedAt: daysAgo(9, 11, 30),
    status: "closed",
    labels: ["VIP"],
    lines: [
      ["visitor", "We'd like 25 gift boxes for our clients before the holidays. Is that possible?"],
      ["note:kenji", "Holiday Blend stock is fine for 25 boxes. Ships in 2 roasts.", 4],
      [
        "nora",
        "Absolutely! 25 Holiday Blend boxes with a card from your team, shipped by the 12th. I'll send the invoice today.",
        3,
      ],
      ["visitor", "Wonderful, thank you Nora!", 10],
    ],
  },
  {
    visitor: visitor(...NY, "Chrome on Windows", ["/shop/brewing-gear"]),
    startedAt: daysAgo(15, 17, 5),
    status: "closed",
    lines: [
      ["visitor", "Is the gooseneck kettle ok on an induction stove?"],
      ["lucia", "Yes, it works on induction, gas and electric.", 2],
      ["visitor", "Great, ordering one", 1],
    ],
  },
];

/** Short questions that come back every week, answered and closed, so Analytics has a history. */
const ROUTINE: RoutineChat[] = [
  [
    "Do you ship to Canada?",
    "Yes, it takes 4 to 7 business days, and duties are included.",
    "Great, thanks!",
  ],
  [
    "When were these beans roasted?",
    "We roast every Monday and Thursday and ship within a day, so your beans are at most a few days old.",
    "Love that.",
  ],
  [
    "Can I change the delivery day of my subscription?",
    "Yes, under Account → Subscription → Delivery day. It applies from your next bag.",
    "Done, thank you.",
  ],
  [
    "Do you have decaf?",
    "Yes, our Colombia decaf is processed with sugarcane. It's under Shop → Decaf.",
    "Perfect, ordering now.",
  ],
  [
    "Whats the best way to store the beans?",
    "Keep them sealed in the bag, somewhere cool and dark, not the fridge. They're best within 4 weeks of roasting.",
    "Good to know, thanks.",
  ],
  [
    "My discount code isn't working",
    "That code is for first orders only, but I've added 10% to this order anyway. Try checkout again.",
    "It worked, thank you!",
  ],
  [
    "Can I use a gift card on a subscription?",
    "Yes, enter the code at checkout and it covers your bags until the balance runs out.",
    "Great.",
  ],
  [
    "Are the bags recyclable?",
    "The bags are compostable and the boxes are recycled cardboard.",
    "Nice!",
  ],
  ["How much coffee is in one bag?", "Each bag is 250 g, about 15 cups.", "Thanks!"],
  [
    "Which espresso works best with milk?",
    "Harbor House, it has chocolate and caramel notes that come through in a latte.",
    "Ordering that one.",
  ],
];

/** The routine chats of the last 30 days, oldest first: about 42, as the weekdays fall. */
export const ROUTINE_CONVERSATIONS = routineHistory<TeamKey>({
  chats: ROUTINE,
  places: [NY, TORONTO, LONDON, CHICAGO, SYDNEY, BERLIN, VANCOUVER, DUBLIN, SF, AMSTERDAM],
  devices: [
    "Safari on iPhone",
    "Chrome on macOS",
    "Chrome on Android",
    "Chrome on Windows",
    "Safari on macOS",
  ],
  repliers: ["amara", "kenji", "nora", "lucia"],
  pages: ["/", "/shop"],
});
