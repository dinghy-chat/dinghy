import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { etag } from "hono/etag";
import {
  firstName,
  RADIUS_MAX_PX,
  type SavedAppearance,
  TEXT_MAX,
  TITLE_MAX,
  type WidgetSettings,
} from "../../../packages/widget/src/shared.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import {
  message,
  operator,
  widgetEmailAsk,
  widgetLauncher,
  widgetPosition,
  widgetSettings,
  widgetTheme,
  workspace,
  workspaceLogo,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { errorAnswer, FORBIDDEN, MEMBER_ERRORS, NOT_FOUND, ROLE_WRITE_ERRORS } from "./errors.ts";
import { visitorAuthorId } from "./identity.ts";
import { processLogo, refuseImage } from "./images.ts";
import { type Live, OPERATORS } from "./live.ts";
import { recordWorkspaceChange } from "./messages.ts";
import type { ImageUrls } from "./public-images.ts";
import { limitByIp, type RateLimit } from "./rate-limit.ts";
import { allowed } from "./team.ts";
import { PUBLIC_KEY, widgetWorkspace } from "./workspaces.ts";

const PREFIX = "/v1/operator/workspaces/{workspaceId}/widget";
/** How long a site keeps the appearance, so a saved change reaches it within 5 minutes. */
const APPEARANCE_CACHE = "public, max-age=300";
/** The members the widget's header shows. */
const TEAM_FACES = 3;
/** Appearance requests one address may make in a minute: one per page view, cached for 5. */
const APPEARANCE_PER_MINUTE = 600;

/** The widget's own words. Null means the widget's default, and the operator app sends no blank. */
const widgetText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u)
    .nullable();
// The same check as the column's, which goes into the host page's CSS.
const color = z
  .string()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/)
  .nullable();

/** What an owner or an admin saves. The widget and the operator app share its type. */
export const WidgetSettingsSchema = z
  .object({
    title: widgetText(TITLE_MAX),
    greeting: widgetText(TEXT_MAX),
    away: widgetText(TEXT_MAX),
    primary: color,
    accent: color,
    position: z.enum(widgetPosition.enumValues),
    theme: z.enum(widgetTheme.enumValues),
    launcher: z.enum(widgetLauncher.enumValues),
    mascot: z.boolean(),
    radius: z.number().int().min(0).max(RADIUS_MAX_PX),
    emailAsk: z.enum(widgetEmailAsk.enumValues),
    branding: z.boolean(),
  })
  .openapi("WidgetSettings") satisfies z.ZodType<WidgetSettings>;

const SavedAppearanceSchema = WidgetSettingsSchema.extend({
  // The chat sends the visitor's unsent words, so operators see them as they type. Workspace
  // settings change it, not this tab's save.
  typingPreview: z.boolean(),
  // The logo's address, which changes with each upload. Null with no logo.
  logoUrl: z.string().nullable(),
  // Up to 3 members, the ones who sent the latest replies. Who is on the team, not who is online.
  team: z.array(z.object({ id: z.string(), name: z.string(), pictureUrl: z.string().nullable() })),
}).openapi("WidgetAppearance") satisfies z.ZodType<SavedAppearance>;

const workspaceParams = z.object({ workspaceId: z.uuid() });
const appearanceAnswer = {
  description: "The widget's settings, with its logo and the members it shows",
  content: { "application/json": { schema: SavedAppearanceSchema } },
};

const getRoute = createRoute({
  method: "get",
  path: PREFIX,
  security: SESSION,
  summary: "Get the widget's look, words and behavior",
  request: { params: workspaceParams },
  responses: { 200: appearanceAnswer, ...MEMBER_ERRORS },
});

const putRoute = createRoute({
  method: "put",
  path: PREFIX,
  security: SESSION,
  summary: "Replace the widget's look, words and behavior. Sites show it within 5 minutes.",
  request: {
    params: workspaceParams,
    body: { required: true, content: { "application/json": { schema: WidgetSettingsSchema } } },
  },
  responses: { 200: appearanceAnswer, ...ROLE_WRITE_ERRORS },
});

const setLogoRoute = createRoute({
  method: "put",
  path: `${PREFIX}/logo`,
  security: SESSION,
  summary:
    "Set the logo from a PNG, JPEG or WebP of at most 2 MB, as the raw request body. The server shrinks it to fit 256 pixels and stores it as WebP.",
  request: { params: workspaceParams },
  responses: {
    200: appearanceAnswer,
    ...ROLE_WRITE_ERRORS,
    400: errorAnswer("not_an_image: not a PNG, JPEG or WebP. too_many_pixels: over 16 megapixels"),
    413: errorAnswer("too_large: the logo is over 2 MB"),
  },
});

const typingPreviewRoute = createRoute({
  method: "put",
  path: `${PREFIX}/typing-preview`,
  security: SESSION,
  summary:
    "Turn on or off whether operators see what visitors type before they send it. Sites follow within 5 minutes.",
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ enabled: z.boolean() }) } },
    },
  },
  responses: { 200: appearanceAnswer, ...ROLE_WRITE_ERRORS },
});

const removeLogoRoute = createRoute({
  method: "delete",
  path: `${PREFIX}/logo`,
  security: SESSION,
  summary: "Remove the logo, so the widget shows its boat again",
  request: { params: workspaceParams },
  responses: { 200: appearanceAnswer, ...ROLE_WRITE_ERRORS },
});

const appearanceRoute = createRoute({
  method: "get",
  path: "/v1/widget/{key}/appearance",
  summary:
    "Get the widget's saved look and words. Any site may read them, as the widget shows them.",
  description:
    "The loader asks for this on each page view, before it draws the launcher. It caches for 5 minutes and answers 304 to a matching If-None-Match. The snippet's attributes and Dinghy.configure() win over these values.",
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: appearanceAnswer,
    304: { description: "Not changed since the ETag in If-None-Match" },
    404: errorAnswer(
      "not_found: the key is unknown, or the workspace's widget is off: it is suspended, waits, is read-only or was deleted",
    ),
    429: errorAnswer("too_many_requests: over the rate limit. Retry after `retry-after`"),
  },
});

/** The members who replied last, newest first. Each needs one short read of an index. */
function recentRepliers(tx: Transaction, workspaceId: string) {
  const lastReply = sql`(select max(${message.seq}) from ${message} where ${message.workspaceId} = ${workspaceMember.workspaceId} and ${message.authorOperatorId} = ${workspaceMember.operatorId})`;
  return tx
    .select({ id: operator.id, name: operator.name, pictureUpdatedAt: operator.pictureUpdatedAt })
    .from(workspaceMember)
    .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.removedAt),
        isNotNull(lastReply),
      ),
    )
    .orderBy(desc(lastReply))
    .limit(TEAM_FACES);
}

/** The settings as the widget reads them. Run it in the workspace's context. */
async function readAppearance(
  tx: Transaction,
  urls: ImageUrls,
  workspaceId: string,
): Promise<SavedAppearance> {
  const [row] = await tx
    .select({ publicKey: workspace.publicKey, settings: widgetSettings })
    .from(widgetSettings)
    .innerJoin(workspace, eq(workspace.id, widgetSettings.workspaceId))
    .where(eq(widgetSettings.workspaceId, workspaceId));
  if (row === undefined) throw new Error("The widget settings row is missing");
  const {
    workspaceId: _workspace,
    logoUpdatedAt,
    customizedAt: _customized,
    ...settings
  } = row.settings;
  const team = await recentRepliers(tx, workspaceId);
  return {
    ...settings,
    logoUrl: urls.logo(row.publicKey, logoUpdatedAt),
    team: team.map((member) => ({
      id: visitorAuthorId(member.id),
      name: firstName(member.name),
      pictureUrl: urls.picture(member.id, member.pictureUpdatedAt),
    })),
  };
}

/**
 * The widget's settings in the operator app. Every member reads them, and only an owner or an
 * admin changes them. An API key and MCP cannot reach them: the routes take a session only.
 */
export function registerWidgetSettingsRoutes(
  app: App,
  db: Database,
  urls: ImageUrls,
  live: Live,
): void {
  // Every change takes an owner or an admin. Before the routes, so a member's logo upload is
  // refused before it is read.
  for (const path of [
    putRoute.getRoutingPath(),
    setLogoRoute.getRoutingPath(),
    typingPreviewRoute.getRoutingPath(),
  ]) {
    app.use(path, async (c, next) => {
      if (c.req.method !== "GET" && !allowed.settings(c.get("memberRole"))) {
        return c.json(FORBIDDEN, 403);
      }
      await next();
    });
  }

  /**
   * Runs a change of the logo, which the workspace menu shows too, so open apps read `me` again on
   * the event. A lost signal only delays it until the next one.
   */
  const changeLogo = async (workspaceId: string, write: (tx: Transaction) => Promise<unknown>) => {
    const saved = await change(workspaceId, async (tx) => {
      await write(tx);
      await recordWorkspaceChange(tx, workspaceId);
    });
    live.wake(workspaceId, OPERATORS);
    return saved;
  };

  /** Runs a change, and answers with the settings after it. */
  const change = (workspaceId: string, write: (tx: Transaction) => Promise<unknown>) =>
    withWorkspace(db, workspaceId, async (tx) => {
      await write(tx);
      return readAppearance(tx, urls, workspaceId);
    });

  app.openapi(getRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    return c.json(await withWorkspace(db, id, (tx) => readAppearance(tx, urls, id)), 200);
  });

  app.openapi(putRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const saved = await change(id, (tx) =>
      tx
        .update(widgetSettings)
        .set({
          ...c.req.valid("json"),
          customizedAt: sql`coalesce(${widgetSettings.customizedAt}, now())`,
        })
        .where(eq(widgetSettings.workspaceId, id)),
    );
    return c.json(saved, 200);
  });

  app.openapi(typingPreviewRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { enabled } = c.req.valid("json");
    const saved = await change(id, (tx) =>
      tx
        .update(widgetSettings)
        .set({ typingPreview: enabled })
        .where(eq(widgetSettings.workspaceId, id)),
    );
    return c.json(saved, 200);
  });

  app.openapi(setLogoRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const logo = await processLogo(new Uint8Array(await c.req.arrayBuffer()));
    if (typeof logo === "string") return refuseImage(c, logo);
    const saved = await changeLogo(id, async (tx) => {
      await tx
        .insert(workspaceLogo)
        .values({ workspaceId: id, data: logo })
        .onConflictDoUpdate({ target: workspaceLogo.workspaceId, set: { data: logo } });
      await tx
        .update(widgetSettings)
        .set({ logoUpdatedAt: new Date() })
        .where(eq(widgetSettings.workspaceId, id));
    });
    return c.json(saved, 200);
  });

  app.openapi(removeLogoRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const saved = await changeLogo(id, async (tx) => {
      await tx.delete(workspaceLogo).where(eq(workspaceLogo.workspaceId, id));
      await tx
        .update(widgetSettings)
        .set({ logoUpdatedAt: null })
        .where(eq(widgetSettings.workspaceId, id));
    });
    return c.json(saved, 200);
  });
}

/**
 * The widget's appearance, for the loader on any site. It is public, as the widget shows all of it,
 * so it answers every origin and skips the widget's access check: register it before the widget
 * routes. The ETag hashes the whole answer, because the team in it changes without a save.
 */
export function registerWidgetAppearance(
  app: App,
  db: Database,
  urls: ImageUrls,
  rateLimit: RateLimit,
) {
  const path = appearanceRoute.getRoutingPath();
  app.use(path, async (c, next) => {
    await next();
    // After the answer, so a 304 and a refusal carry it too. A closed workspace's 404 must reach
    // the loader, or it would draw the launcher anyway.
    c.header("access-control-allow-origin", "*");
  });
  app.use(path, limitByIp(rateLimit, "widget-appearance", APPEARANCE_PER_MINUTE, 60));
  app.use(path, etag());
  app.openapi(appearanceRoute, async (c) => {
    const { key } = c.req.valid("param");
    const found = PUBLIC_KEY.test(key) ? await widgetWorkspace(db, key) : null;
    if (found === null) return c.json(NOT_FOUND, 404);
    const appearance = await withWorkspace(db, found.id, (tx) =>
      readAppearance(tx, urls, found.id),
    );
    c.header("cache-control", APPEARANCE_CACHE);
    return c.json(appearance, 200);
  });
}
