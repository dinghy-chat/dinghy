// The shape of a demo workspace, and the helpers its data modules share. demo-harbor.ts holds Harbor
// Coffee, which `bun run seed -- --harbor` and `chat demo` write, and scripts/seed-data.ts holds Acme.
import type { LABEL_COLORS } from "./db/schema.ts";
import { DAY_MS, MINUTE_MS } from "./time.ts";

export interface TeamMember {
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  away: boolean;
}

export interface VisitorSeed {
  /** A signed-in contact of the site's own app. Without it, the visitor is anonymous. */
  contact?: { userId: string; name: string; email: string; company?: string; plan?: string };
  country: string;
  timeZone: string;
  device: string;
  /** The pages they went through, oldest first. The chat starts on the last one. */
  pages: string[];
}

/** Who wrote a line: the visitor, a teammate, or a teammate's internal note. */
type Author<TeamKey extends string> = "visitor" | TeamKey | `note:${TeamKey}`;
/** A line, with the minutes since the line before it. */
type Line<TeamKey extends string> = [Author<TeamKey>, string, number?];

export interface ConversationSeed<
  TeamKey extends string = string,
  LabelName extends string = string,
> {
  visitor: VisitorSeed;
  startedAt: Date;
  lines: Line<TeamKey>[];
  status: "open" | "closed" | "snoozed";
  labels?: LabelName[];
}

/** What the seed and `chat demo` read from a data module. */
export interface DemoData {
  SITE: string;
  WORKSPACE_NAME: string;
  TEAM: Record<string, TeamMember>;
  LABELS: Record<string, (typeof LABEL_COLORS)[number]>;
  SAVED_REPLIES: { shortcut: string; body: string }[];
  /** The visitors who are on the site now, and the tabs the Visitors screen lists. */
  LIVE: {
    /** Chatting visitors, by their conversation's index in CONVERSATIONS. */
    chatting: { conversation: number; title: string }[];
    /** The visitor whose unsent draft the inbox shows, with `--live`. */
    typing: { conversation: number; draft: string };
    /** A known contact on the site who has not chatted. */
    known: { visitor: VisitorSeed; title: string };
    anonymous: {
      page: string;
      title: string;
      referrer: string;
      country: string;
      timeZone: string;
      device: string;
    }[];
  };
  /** Contacts who never chatted, so the Contacts list holds more than chatters. */
  QUIET_CONTACTS: VisitorSeed[];
  CONVERSATIONS: ConversationSeed[];
  ROUTINE_CONVERSATIONS: ConversationSeed[];
}

/** `minutes` before the seed runs. */
export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);

/** A local time of day, `days` days before the seed runs. */
export function daysAgo(days: number, hour: number, minute = 0): Date {
  const at = new Date(Date.now() - days * DAY_MS);
  at.setHours(hour, minute, 0, 0);
  return at;
}

export const visitor = (
  country: string,
  timeZone: string,
  device: string,
  pages: string[],
  contact?: VisitorSeed["contact"],
): VisitorSeed => ({ country, timeZone, device, pages, ...(contact && { contact }) });

type Place = readonly [country: string, timeZone: string];

export const NY: Place = ["US", "America/New_York"];
export const SF: Place = ["US", "America/Los_Angeles"];
export const PORTLAND: Place = ["US", "America/Los_Angeles"];
export const CHICAGO: Place = ["US", "America/Chicago"];
export const DENVER: Place = ["US", "America/Denver"];
export const LONDON: Place = ["GB", "Europe/London"];
export const DUBLIN: Place = ["IE", "Europe/Dublin"];
export const BERLIN: Place = ["DE", "Europe/Berlin"];
export const PARIS: Place = ["FR", "Europe/Paris"];
export const SAO_PAULO: Place = ["BR", "America/Sao_Paulo"];
export const TOKYO: Place = ["JP", "Asia/Tokyo"];
export const TORONTO: Place = ["CA", "America/Toronto"];
export const VANCOUVER: Place = ["CA", "America/Vancouver"];
export const SYDNEY: Place = ["AU", "Australia/Sydney"];
export const MELBOURNE: Place = ["AU", "Australia/Melbourne"];
export const MUMBAI: Place = ["IN", "Asia/Kolkata"];
export const MADRID: Place = ["ES", "Europe/Madrid"];
export const AMSTERDAM: Place = ["NL", "Europe/Amsterdam"];
export const STOCKHOLM: Place = ["SE", "Europe/Stockholm"];
export const COPENHAGEN: Place = ["DK", "Europe/Copenhagen"];
export const MILAN: Place = ["IT", "Europe/Rome"];

/** A short question that comes back every week, its answer, and the visitor's thanks. */
export type RoutineChat = [question: string, answer: string, thanks: string];

interface RoutineMix<TeamKey extends string> {
  chats: RoutineChat[];
  places: Place[];
  devices: string[];
  repliers: TeamKey[];
  /** The pages each routine visitor went through before asking. */
  pages: string[];
}

/** Routine chats each weekday of the last 30 days, in turn, and fewer on weekends. */
const PER_WEEKDAY = [2, 1, 3, 2, 1];
const HISTORY_DAYS = 29;

function routineDay<TeamKey extends string>(
  mix: RoutineMix<TeamKey>,
  days: number,
  start: number,
): ConversationSeed<TeamKey>[] {
  const weekday = daysAgo(days, 12).getDay();
  const count =
    weekday === 0 || weekday === 6 ? days % 2 : (PER_WEEKDAY[days % PER_WEEKDAY.length] ?? 1);
  return Array.from({ length: count }, (_, one) => {
    const index = start + one;
    const routine = mix.chats[index % mix.chats.length];
    const replier = mix.repliers[index % mix.repliers.length];
    const [country, timeZone] = mix.places[index % mix.places.length] ?? NY;
    if (routine === undefined || replier === undefined) throw new Error("No routine chat");
    const [question, answer, thanks] = routine;
    return {
      visitor: visitor(
        country,
        timeZone,
        mix.devices[index % mix.devices.length] ?? "Chrome on macOS",
        mix.pages,
      ),
      startedAt: daysAgo(days, 9 + ((index * 5) % 9), (index * 13) % 60),
      status: "closed",
      lines: [
        ["visitor", question],
        [replier, answer, 1 + (index % 6)],
        ["visitor", thanks, 3],
      ],
    };
  });
}

/** The routine chats of the last 30 days, oldest first: about 42, as the weekdays fall. */
export function routineHistory<TeamKey extends string>(
  mix: RoutineMix<TeamKey>,
): ConversationSeed<TeamKey>[] {
  const history: ConversationSeed<TeamKey>[] = [];
  for (let days = HISTORY_DAYS; days > 0; days--) {
    history.push(...routineDay(mix, days, history.length));
  }
  return history;
}
