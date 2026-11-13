import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { App } from "./app.ts";
import { operatorPicture } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { errorAnswer, INVALID, NOT_FOUND } from "./errors.ts";
import { PUBLIC_IMAGE_TYPE } from "./uploads.ts";
import { PUBLIC_KEY } from "./workspaces.ts";

/** The address carries the upload's time, so an image can stay in any cache for good. */
const CACHE_FOREVER = "public, max-age=31536000, immutable";

/** The addresses of the public images. Each is null when there is no image. */
export interface ImageUrls {
  logo(publicKey: string, updatedAt: Date | null): string | null;
  picture(operatorId: string, updatedAt: Date | null): string | null;
}

/** Addresses on `origin`: the image origin when there is one, as for every user image. */
export function imageUrls(origin: string): ImageUrls {
  const base = origin.replace(/\/$/, "");
  const at = (path: string, updatedAt: Date | null) =>
    updatedAt === null ? null : `${base}${path}?v=${updatedAt.getTime()}`;
  return {
    logo: (publicKey, updatedAt) => at(`/v1/widget/${publicKey}/logo`, updatedAt),
    picture: (operatorId, updatedAt) => at(`/v1/pictures/${operatorId}`, updatedAt),
  };
}

const imageAnswer = {
  description: "The image. Its address changes with each upload, so it caches for a year.",
  content: { [PUBLIC_IMAGE_TYPE]: { schema: z.string().openapi({ format: "binary" }) } },
};
const version = z.object({ v: z.string().optional() });

const logoRoute = createRoute({
  method: "get",
  path: "/v1/widget/{key}/logo",
  summary: "Get the workspace's logo, as WebP. Use the address that the widget's appearance gives.",
  request: { params: z.object({ key: z.string() }), query: version },
  responses: {
    200: imageAnswer,
    404: errorAnswer("not_found: the key is unknown, its workspace is deleted, or it has no logo"),
  },
});

const pictureRoute = createRoute({
  method: "get",
  path: "/v1/pictures/{operatorId}",
  summary: "Get an operator's picture, as WebP. Use the address that a member or a message gives.",
  request: { params: z.object({ operatorId: z.uuid() }), query: version },
  responses: {
    200: imageAnswer,
    ...INVALID,
    404: errorAnswer("not_found: this operator has no picture"),
  },
});

/**
 * The logo and the operators' pictures, to anyone, because an <img> sends no Origin and no token,
 * and these images are public. With a separate image origin, only that origin serves them. Register
 * this before the widget routes, whose access check would refuse a logo.
 */
export function registerPublicImages(app: App, db: Database, uploadsOrigin: string | undefined) {
  const filesHost = uploadsOrigin === undefined ? undefined : new URL(uploadsOrigin).host;
  const serve = async (c: Context, read: () => Promise<Uint8Array | null>) => {
    if (filesHost !== undefined && new URL(c.req.url).host !== filesHost) {
      return c.json(NOT_FOUND, 404);
    }
    const data = await read();
    if (data === null) return c.json(NOT_FOUND, 404);
    return c.body(new Uint8Array(data), 200, {
      "content-type": PUBLIC_IMAGE_TYPE,
      "content-length": String(data.byteLength),
      "cache-control": CACHE_FOREVER,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    }) as never;
  };

  app.openapi(logoRoute, (c) =>
    serve(c, async () => {
      const { key } = c.req.valid("param");
      if (!PUBLIC_KEY.test(key)) return null;
      // Any workspace that is not deleted, as its dashboard shows the logo while the widget is off.
      const result = await db.execute<{ data: Buffer }>(
        sql`select data from workspace_logo_by_key(${key})`,
      );
      return result.rows[0]?.data ?? null;
    }),
  );

  app.openapi(pictureRoute, (c) =>
    serve(c, async () => {
      const { operatorId } = c.req.valid("param");
      // Global, as the operator is. An account's delete removes its picture.
      const [row] = await db
        .select({ data: operatorPicture.data })
        .from(operatorPicture)
        .where(eq(operatorPicture.operatorId, operatorId));
      return row?.data ?? null;
    }),
  );
}
