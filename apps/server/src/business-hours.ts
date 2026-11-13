import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { DAY_RANGES_MAX, type Weekday } from "../../../packages/widget/src/shared.ts";
import { isTimeZone } from "./analytics.ts";
import { SESSION_OR_SETUP_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { businessHours } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  FORBIDDEN,
  jsonAnswer,
  jsonBody,
  KEY_LIMITED,
  MEMBER_ERRORS,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { WORKSPACE_PREFIX } from "./member.ts";
import { maySetUp } from "./team.ts";

const PATH = `${WORKSPACE_PREFIX}/{workspaceId}/business-hours`;

// "24:00" only ends a range, so a day can stay open until midnight.
const START = /^([01]\d|2[0-3]):[0-5]\d$/;
const END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

// Every time has the same five characters, so text order is time order.
const Range = z
  .tuple([z.string().regex(START), z.string().regex(END)])
  .refine(([start, end]) => start < end, "a range ends after it starts");

const Day = z
  .array(Range)
  .max(DAY_RANGES_MAX)
  .refine(
    (ranges) =>
      ranges.every(([start], index) => index === 0 || (ranges[index - 1]?.[1] ?? "") <= start),
    "the ranges are in order and do not overlap",
  );

const Week = z
  .object({ mon: Day, tue: Day, wed: Day, thu: Day, fri: Day, sat: Day, sun: Day })
  .openapi("BusinessWeek") satisfies z.ZodType<Record<Weekday, [string, string][]>>;

/** The hours as the widget's appearance carries them, while they are on. */
export const WidgetHoursSchema = z.object({ timeZone: z.string(), week: Week });

/** What an owner or an admin saves, and what an export carries. */
export const BusinessHoursSchema = z
  .object({
    enabled: z.boolean(),
    timeZone: z.string().refine(isTimeZone, "an IANA time zone, such as Europe/Paris"),
    week: Week,
  })
  .openapi("BusinessHours", {
    example: {
      enabled: true,
      timeZone: "Europe/Paris",
      week: {
        mon: [["09:00", "18:00"]],
        tue: [["09:00", "18:00"]],
        wed: [["09:00", "12:30"]],
        thu: [["09:00", "18:00"]],
        fri: [
          ["09:00", "12:00"],
          ["14:00", "17:00"],
        ],
        sat: [],
        sun: [],
      },
    },
  });

type SavedHours = z.infer<typeof BusinessHoursSchema>;

const params = z.object({ workspaceId: z.uuid() });
const answer = jsonAnswer(
  "The business hours, or null when nobody saved them, which means off",
  BusinessHoursSchema.nullable(),
);

const getRoute = createRoute({
  method: "get",
  path: PATH,
  security: SESSION_OR_SETUP_KEY,
  summary: "Get the business hours",
  request: { params },
  responses: { ...KEY_LIMITED, 200: answer, ...MEMBER_ERRORS },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  security: SESSION_OR_SETUP_KEY,
  summary:
    "Replace the business hours. Outside these hours the widget shows the away message and when the team is back, and asks for an email: before the first message, or after it for a visitor who has chatted. Sites show it within 5 minutes. Owners, admins and Full access (`setup`) API keys only",
  request: { params, body: jsonBody(BusinessHoursSchema) },
  responses: { ...KEY_LIMITED, 200: answer, ...ROLE_WRITE_ERRORS },
});

/** The saved hours, or undefined with none. Run it in the workspace's context. */
export async function readBusinessHours(
  tx: Transaction,
  workspaceId: string,
): Promise<SavedHours | undefined> {
  const [row] = await tx
    .select({
      enabled: businessHours.enabled,
      timeZone: businessHours.timeZone,
      week: businessHours.week,
    })
    .from(businessHours)
    .where(eq(businessHours.workspaceId, workspaceId));
  return row;
}

/** Saves the hours, making the row on the first save. Run it in the workspace's context. */
export async function saveBusinessHours(
  tx: Transaction,
  workspaceId: string,
  hours: SavedHours,
): Promise<void> {
  await tx
    .insert(businessHours)
    .values({ workspaceId, ...hours })
    .onConflictDoUpdate({ target: businessHours.workspaceId, set: hours });
}

/**
 * Settings > Business hours. Every member reads them, and only an owner, an admin or a Setup key
 * changes them. The widget reads them with its appearance, so a save reaches sites as the
 * appearance's cache ends.
 */
export function registerBusinessHoursRoutes(app: App, db: Database): void {
  app.use(putRoute.getRoutingPath(), async (c, next) => {
    if (c.req.method === "PUT" && !maySetUp(c.get("actor"), c.get("memberRole"))) {
      return c.json(FORBIDDEN, 403);
    }
    await next();
  });

  app.openapi(getRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const saved = await withWorkspace(db, id, (tx) => readBusinessHours(tx, id));
    return c.json(saved ?? null, 200);
  });

  app.openapi(putRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const hours = c.req.valid("json");
    await withWorkspace(db, id, (tx) => saveBusinessHours(tx, id, hours));
    return c.json(hours, 200);
  });
}
