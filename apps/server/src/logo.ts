import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { App } from "./app.ts";
import { workspaceLogo } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { errorAnswer, NOT_FOUND } from "./errors.ts";
import { LOGO_TYPE } from "./images.ts";
import { widgetWorkspace } from "./workspaces.ts";

// As the widget routes check it, before the lookup.
const PUBLIC_KEY = /^wk_[0-9a-f]{32}$/;
/** The address carries the upload's time, so a logo can stay in any cache for good. */
const CACHE_FOREVER = "public, max-age=31536000, immutable";

/** A workspace's logo address, or null with no logo. */
export type LogoUrl = (publicKey: string, updatedAt: Date | null) => string | null;

/** Logo addresses on `origin`: the image origin when there is one, as for every user image. */
export function logoUrls(origin: string): LogoUrl {
  const base = origin.replace(/\/$/, "");
  return (publicKey, updatedAt) =>
    updatedAt === null ? null : `${base}/v1/widget/${publicKey}/logo?v=${updatedAt.getTime()}`;
}

const logoRoute = createRoute({
  method: "get",
  path: "/v1/widget/{key}/logo",
  summary: "Get the workspace's logo, as WebP. Use the address that the widget's presence gives.",
  request: {
    params: z.object({ key: z.string() }),
    query: z.object({ v: z.string().optional() }),
  },
  responses: {
    200: {
      description: "The logo. Its address changes with each upload, so it caches for a year.",
      content: { [LOGO_TYPE]: { schema: z.string().openapi({ format: "binary" }) } },
    },
    404: errorAnswer(
      "not_found: the key is unknown, its widget is off, or the workspace has no logo",
    ),
  },
});

/**
 * Serves a logo to anyone, because an <img> sends no Origin and no token, and a logo is public.
 * Register this before the widget routes, whose access check would refuse it. With a separate image
 * origin, only that origin serves it.
 */
export function registerLogoFile(app: App, db: Database, imagesOrigin: string | undefined) {
  const filesHost = imagesOrigin === undefined ? undefined : new URL(imagesOrigin).host;
  app.openapi(logoRoute, async (c) => {
    if (filesHost !== undefined && new URL(c.req.url).host !== filesHost) {
      return c.json(NOT_FOUND, 404);
    }
    const { key } = c.req.valid("param");
    if (!PUBLIC_KEY.test(key)) return c.json(NOT_FOUND, 404);
    const found = await widgetWorkspace(db, key);
    if (found === null || found.logoUpdatedAt === null) return c.json(NOT_FOUND, 404);
    const [row] = await withWorkspace(db, found.id, (tx) =>
      tx
        .select({ data: workspaceLogo.data, contentType: workspaceLogo.contentType })
        .from(workspaceLogo)
        .where(eq(workspaceLogo.workspaceId, found.id)),
    );
    // Only the type the server encodes, whatever is stored.
    if (row === undefined || row.contentType !== LOGO_TYPE) return c.json(NOT_FOUND, 404);
    return c.body(new Uint8Array(row.data), 200, {
      "content-type": LOGO_TYPE,
      "content-length": String(row.data.byteLength),
      "cache-control": CACHE_FOREVER,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    }) as never;
  });
}
