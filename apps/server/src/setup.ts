import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import type { Actor } from "./api-keys.ts";
import { SESSION_OR_SETUP_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { widgetSiteSeen, workspace } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  KEY_LIMITED,
  MEMBER_ERRORS,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { normalizeOrigin } from "./identity.ts";
import type { LiveVisitors } from "./live-visitors.ts";
import { OPEN_WHILE_CLOSED, WORKSPACE_PREFIX } from "./member.ts";
import { FRAMEWORKS, IDENTITY_LANGUAGES, identitySetup, installSnippet } from "./setup-code.ts";
import { badOrigin, MAX_ORIGINS, maySetUp } from "./team.ts";
import { DAY_MS, HOUR_MS } from "./time.ts";

/** Refused origins a workspace keeps as a hint, newest first, for a day. */
const REFUSED_MAX = 20;
const refusedKey = (workspaceId: string) => `dinghy:refused-sites:${workspaceId}`;

export const SITE_LIMIT = failure(
  "site_limit",
  `A workspace can have ${MAX_ORIGINS} allowed sites. Remove one first.`,
);

/**
 * The origins whose widget calls were refused, only in Valkey: a sorted set by time, capped and
 * kept a day. Losing it loses only a hint for the install check.
 */
function createRefusedSites(valkey: Redis | null, logger: Logger) {
  const attempt = async <T>(fallback: T, work: (client: Redis) => Promise<T>): Promise<T> => {
    if (valkey === null) return fallback;
    try {
      return await work(valkey);
    } catch (err) {
      logger.warn({ err }, "the refused sites are unavailable");
      return fallback;
    }
  };
  return {
    record(workspaceId: string, origin: string): Promise<void> {
      return attempt(undefined, async (client) => {
        const key = refusedKey(workspaceId);
        const now = Date.now();
        await client
          .multi()
          .zadd(key, now, origin)
          .zremrangebyscore(key, "-inf", now - DAY_MS)
          .zremrangebyrank(key, 0, -(REFUSED_MAX + 1))
          .pexpire(key, DAY_MS)
          .exec();
      });
    },
    list(workspaceId: string): Promise<{ origin: string; lastSeenAt: string }[]> {
      return attempt([], async (client) => {
        const flat = await client.zrevrangebyscore(
          refusedKey(workspaceId),
          "+inf",
          Date.now() - DAY_MS,
          "WITHSCORES",
        );
        const rows: { origin: string; lastSeenAt: string }[] = [];
        for (let index = 0; index + 1 < flat.length; index += 2) {
          const time = new Date(Number(flat[index + 1])).toISOString();
          rows.push({ origin: flat[index] ?? "", lastSeenAt: time });
        }
        return rows;
      });
    },
  };
}

interface SiteRow {
  origin: string;
  allowed: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

/** What to do next, in one sentence for the agent or person who installs the widget. */
export function nextStep(state: {
  origin: string | undefined;
  allowedOrigins: string[];
  sites: SiteRow[];
  refused: { origin: string }[];
}): string {
  const { origin, allowedOrigins, sites, refused } = state;
  if (origin !== undefined && !allowedOrigins.includes(origin)) {
    return `Add ${origin} to the allowed sites, then open a page of it once.`;
  }
  const firstRefused = refused[0]?.origin;
  if (allowedOrigins.length === 0) {
    return firstRefused === undefined
      ? "Add the site's origin, such as https://www.example.com, to the allowed sites."
      : `Add ${firstRefused} to the allowed sites: the widget tried to load there and was refused.`;
  }
  const loaded = sites.find(
    (site) =>
      site.allowed && site.lastSeenAt !== null && (origin === undefined || site.origin === origin),
  );
  if (loaded !== undefined) {
    return `Installed: the widget loaded from ${loaded.origin} at ${loaded.lastSeenAt}.`;
  }
  if (origin === undefined && firstRefused !== undefined) {
    return `The widget was refused on ${firstRefused}. If that site is yours, add it to the allowed sites.`;
  }
  return `Deploy the snippet and open ${origin ?? "the site"} once in a browser, then check again.`;
}

/**
 * Every allowed site, and every site that loaded the widget and is no longer allowed, the latest
 * load first, so the check names the latest one.
 */
function siteRows(
  allowedOrigins: string[],
  seen: { origin: string; firstSeenAt: Date; lastSeenAt: Date }[],
): SiteRow[] {
  const seenRow = (row: (typeof seen)[number] | undefined) => ({
    firstSeenAt: row?.firstSeenAt.toISOString() ?? null,
    lastSeenAt: row?.lastSeenAt.toISOString() ?? null,
  });
  const allowed = allowedOrigins.map((origin) => ({
    origin,
    allowed: true,
    ...seenRow(seen.find((row) => row.origin === origin)),
  }));
  const others = seen
    .filter((row) => !allowedOrigins.includes(row.origin))
    .map((row) => ({ origin: row.origin, allowed: false, ...seenRow(row) }));
  return [...allowed, ...others].sort((x, y) =>
    (y.lastSeenAt ?? "").localeCompare(x.lastSeenAt ?? ""),
  );
}

type SiteChange = { sites: string[] } | "bad_origin" | "limit";

/** The allowed sites, when the widget first loaded, and where it loaded. */
async function installState(tx: Transaction, workspaceId: string) {
  const [row] = await tx
    .select({ allowedOrigins: workspace.allowedOrigins, seenAt: workspace.widgetSeenAt })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  const seen = await tx
    .select()
    .from(widgetSiteSeen)
    .where(eq(widgetSiteSeen.workspaceId, workspaceId));
  return { allowedOrigins: row?.allowedOrigins ?? [], seenAt: row?.seenAt ?? null, seen };
}

/**
 * Where a workspace's widget may load and where it did: what the routes do for an owner, an admin
 * or a Setup key, and MCP's tools do for a Setup key.
 */
export function createSetup({
  db,
  logger,
  valkey,
  liveVisitors,
}: {
  db: Database;
  logger: Logger;
  valkey: Redis | null;
  liveVisitors: LiveVisitors;
}) {
  const refused = createRefusedSites(valkey, logger);
  // Origins this process wrote recently, so a beat writes each one at most once an hour.
  const seenWrites = new Map<string, number>();
  /** Runs one UPDATE of the list, so concurrent changes cannot pass the cap. Null: no row changed. */
  const changeSites = async (
    workspaceId: string,
    actor: Actor,
    sites: SQL,
    only: SQL,
  ): Promise<string[] | null> => {
    const [row] = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .update(workspace)
        .set({ allowedOrigins: sites })
        .where(and(eq(workspace.id, workspaceId), only))
        .returning({ sites: workspace.allowedOrigins }),
    );
    if (row === undefined) return null;
    // Origins are public, as every page that embeds the widget shows its own.
    audit(logger, "origins.changed", {
      workspaceId,
      ...(actor.kind === "operator"
        ? { operatorId: actor.operatorId }
        : { apiKeyId: actor.apiKeyId }),
      allowedOrigins: row.sites,
    });
    return row.sites;
  };

  return {
    async publicKey(workspaceId: string): Promise<string> {
      const [row] = await withWorkspace(db, workspaceId, (tx) =>
        tx
          .select({ publicKey: workspace.publicKey })
          .from(workspace)
          .where(eq(workspace.id, workspaceId)),
      );
      if (row === undefined) throw new Error("The workspace row is missing");
      return row.publicKey;
    },

    async sites(workspaceId: string): Promise<string[]> {
      const [row] = await withWorkspace(db, workspaceId, (tx) =>
        tx
          .select({ sites: workspace.allowedOrigins })
          .from(workspace)
          .where(eq(workspace.id, workspaceId)),
      );
      return row?.sites ?? [];
    },

    /** Adds one origin, unless it is there already. */
    async addSite(workspaceId: string, actor: Actor, value: string): Promise<SiteChange> {
      const origin = normalizeOrigin(value);
      if (origin === null) return "bad_origin";
      const list = workspace.allowedOrigins;
      const added = await changeSites(
        workspaceId,
        actor,
        sql`array_append(${list}, ${origin}::text)`,
        sql`not (${origin}::text = any(${list})) and cardinality(${list}) < ${MAX_ORIGINS}`,
      );
      if (added !== null) return { sites: added };
      const sites = await this.sites(workspaceId);
      return sites.includes(origin) ? { sites } : "limit";
    },

    async removeSite(workspaceId: string, actor: Actor, value: string): Promise<SiteChange> {
      const origin = normalizeOrigin(value);
      if (origin === null) return "bad_origin";
      const list = workspace.allowedOrigins;
      const removed = await changeSites(
        workspaceId,
        actor,
        sql`array_remove(${list}, ${origin}::text)`,
        sql`${origin}::text = any(${list})`,
      );
      return { sites: removed ?? (await this.sites(workspaceId)) };
    },

    /** Notes that an allowed site loaded the widget. Its first write in an hour reaches Postgres. */
    async siteSeen(workspaceId: string, origin: string): Promise<void> {
      const key = `${workspaceId} ${origin}`;
      const now = Date.now();
      if (now - (seenWrites.get(key) ?? 0) < HOUR_MS) return;
      seenWrites.set(key, now);
      await withWorkspace(db, workspaceId, (tx) =>
        tx
          .insert(widgetSiteSeen)
          .values({ workspaceId, origin })
          .onConflictDoUpdate({
            target: [widgetSiteSeen.workspaceId, widgetSiteSeen.origin],
            set: { lastSeenAt: sql`now()` },
          }),
      );
    },

    /** Notes a widget call refused for its origin, as a hint for the install check. */
    siteRefused(workspaceId: string, value: string): Promise<void> {
      const origin = normalizeOrigin(value);
      return origin === null ? Promise.resolve() : refused.record(workspaceId, origin);
    },

    /** Whether the widget is installed, and the one thing to do next, for `value` if given. */
    async check(workspaceId: string, value: string | undefined) {
      const origin = value === undefined ? undefined : normalizeOrigin(value);
      if (origin === null) return "bad_origin" as const;
      const [state, recentlyRefused, liveTabs] = await Promise.all([
        withWorkspace(db, workspaceId, (tx) => installState(tx, workspaceId)),
        refused.list(workspaceId),
        liveVisitors.count(workspaceId),
      ]);
      const { allowedOrigins } = state;
      const sites = siteRows(allowedOrigins, state.seen);
      const stillRefused = recentlyRefused.filter((row) => !allowedOrigins.includes(row.origin));
      return {
        allowed: origin === undefined ? null : allowedOrigins.includes(origin),
        widgetSeenAt: state.seenAt?.toISOString() ?? null,
        sites,
        refused: stillRefused,
        liveTabs,
        nextStep: nextStep({ origin, allowedOrigins, sites, refused: stillRefused }),
      };
    },
  };
}
export type Setup = ReturnType<typeof createSetup>;

/** The widget's notes about where it loaded, which the beat and the access check call. */
export type SiteSignals = Pick<Setup, "siteSeen" | "siteRefused">;

// Routes ------------------------------------------------------------------------------------------

const PREFIX = `${WORKSPACE_PREFIX}/{workspaceId}`;
const workspaceParams = z.object({ workspaceId: z.uuid() });
const Origin = z.string().trim().max(300).describe("An origin, such as https://www.example.com");
const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});
const denied = {
  ...MEMBER_ERRORS,
  403: errorAnswer("forbidden: this role, or a Conversations API key, may not do this"),
};
const BAD_ORIGIN_ANSWER = {
  400: errorAnswer("invalid_request: the request is not valid. bad_origin: not a valid origin"),
};

const Snippet = z
  .object({
    framework: z.enum(FRAMEWORKS),
    code: z.string(),
    file: z.string(),
    placement: z.string(),
    notes: z.array(z.string()),
    publicKey: z.string(),
    serverUrl: z.string(),
  })
  .openapi("InstallSnippet");

const Sites = z.object({ sites: z.array(z.string()) }).openapi("AllowedSites");

const InstallCheck = z
  .object({
    // Whether the origin asked about is allowed. Null when none was asked about.
    allowed: z.boolean().nullable(),
    // When an allowed site first loaded the widget, or null.
    widgetSeenAt: z.string().nullable(),
    sites: z.array(
      z.object({
        origin: z.string(),
        allowed: z.boolean(),
        firstSeenAt: z.string().nullable(),
        lastSeenAt: z.string().nullable(),
      }),
    ),
    // Origins whose widget calls were refused in the last 24 hours, newest first. A hint only.
    refused: z.array(z.object({ origin: z.string(), lastSeenAt: z.string() })),
    // Tabs with the widget open now. Null when the live view is unavailable.
    liveTabs: z.number().int().nullable(),
    nextStep: z.string(),
  })
  .openapi("InstallCheck");

const IdentitySetup = z
  .object({
    language: z.enum(IDENTITY_LANGUAGES),
    explanation: z.array(z.string()),
    serverFile: z.string(),
    serverCode: z.string(),
    browserCode: z.string(),
    secret: z.string(),
    publicKey: z.string(),
  })
  .openapi("IdentitySetup");

const snippetRoute = createRoute({
  method: "get",
  path: `${PREFIX}/install/snippet`,
  security: SESSION_OR_SETUP_KEY,
  summary: "The code that adds the widget to an app made with a framework, and where it goes",
  request: { params: workspaceParams, query: z.object({ framework: z.enum(FRAMEWORKS) }) },
  responses: { ...KEY_LIMITED, 200: json("The snippet", Snippet), ...denied },
});

const checkRoute = createRoute({
  method: "get",
  path: `${PREFIX}/install/check`,
  security: SESSION_OR_SETUP_KEY,
  summary:
    "Whether the widget is installed: the allowed sites, where it loaded, and what to do next",
  request: { params: workspaceParams, query: z.object({ origin: Origin.optional() }) },
  responses: {
    ...KEY_LIMITED,
    200: json("The install's state", InstallCheck),
    ...denied,
    ...BAD_ORIGIN_ANSWER,
  },
});

const identityRoute = createRoute({
  method: "get",
  path: `${PREFIX}/install/identity`,
  security: SESSION_OR_SETUP_KEY,
  summary:
    "Server code that signs the identity token for `Dinghy.identify()`, in a language. Never the signing secret",
  request: { params: workspaceParams, query: z.object({ language: z.enum(IDENTITY_LANGUAGES) }) },
  responses: { ...KEY_LIMITED, 200: json("The code and its steps", IdentitySetup), ...denied },
});

const listSitesRoute = createRoute({
  method: "get",
  path: `${PREFIX}/sites`,
  security: SESSION_OR_SETUP_KEY,
  summary: "The allowed sites: the origins where the widget may load",
  request: { params: workspaceParams },
  responses: { ...KEY_LIMITED, 200: json("The allowed sites", Sites), ...denied },
});

const addSiteRoute = createRoute({
  method: "post",
  path: `${PREFIX}/sites`,
  security: SESSION_OR_SETUP_KEY,
  summary: `Allow the widget on one more origin. A workspace has at most ${MAX_ORIGINS}`,
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ origin: Origin }) } },
    },
  },
  responses: {
    ...KEY_LIMITED,
    200: json("The allowed sites", Sites),
    ...ROLE_WRITE_ERRORS,
    ...BAD_ORIGIN_ANSWER,
    409: errorAnswer(`site_limit: the workspace has ${MAX_ORIGINS} allowed sites already`),
  },
});

const removeSiteRoute = createRoute({
  method: "delete",
  ...OPEN_WHILE_CLOSED,
  path: `${PREFIX}/sites`,
  security: SESSION_OR_SETUP_KEY,
  summary: "Stop the widget on an origin. Its open chats end at their next check",
  request: { params: workspaceParams, query: z.object({ origin: Origin }) },
  responses: {
    ...KEY_LIMITED,
    200: json("The allowed sites", Sites),
    ...ROLE_WRITE_ERRORS,
    ...BAD_ORIGIN_ANSWER,
  },
});

/** `serverUrl` is this server's origin, which the snippets load the widget from. */
export function registerSetupRoutes(app: App, setup: Setup, serverUrl: string): void {
  app.openapi(snippetRoute, async (c) => {
    if (!maySetUp(c.get("actor"), c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const publicKey = await setup.publicKey(c.get("memberWorkspaceId"));
    const { framework } = c.req.valid("query");
    return c.json(installSnippet(framework, { serverUrl, publicKey }), 200);
  });

  app.openapi(checkRoute, async (c) => {
    if (!maySetUp(c.get("actor"), c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const { origin } = c.req.valid("query");
    const checked = await setup.check(c.get("memberWorkspaceId"), origin);
    if (checked === "bad_origin") return c.json(badOrigin(origin ?? ""), 400);
    return c.json(checked, 200);
  });

  app.openapi(identityRoute, async (c) => {
    if (!maySetUp(c.get("actor"), c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const publicKey = await setup.publicKey(c.get("memberWorkspaceId"));
    return c.json(identitySetup(c.req.valid("query").language, publicKey), 200);
  });

  app.openapi(listSitesRoute, async (c) => {
    if (!maySetUp(c.get("actor"), c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    return c.json({ sites: await setup.sites(c.get("memberWorkspaceId")) }, 200);
  });

  app.openapi(addSiteRoute, async (c) => {
    if (!maySetUp(c.get("actor"), c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const { origin } = c.req.valid("json");
    const changed = await setup.addSite(c.get("memberWorkspaceId"), c.get("actor"), origin);
    if (changed === "bad_origin") return c.json(badOrigin(origin), 400);
    if (changed === "limit") return c.json(SITE_LIMIT, 409);
    return c.json(changed, 200);
  });

  app.openapi(removeSiteRoute, async (c) => {
    if (!maySetUp(c.get("actor"), c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const { origin } = c.req.valid("query");
    const changed = await setup.removeSite(c.get("memberWorkspaceId"), c.get("actor"), origin);
    if (typeof changed === "string") return c.json(badOrigin(origin), 400);
    return c.json(changed, 200);
  });
}
