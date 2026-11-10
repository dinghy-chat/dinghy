import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { workspace, workspaceLogo } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createImages, LOGO_MAX_BYTES } from "./images.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const SITE = "https://app.example.com";
const FILES_ORIGIN = "https://files.example.com";
const logger = pino({ level: "silent" });
const ok = async () => {};
const noStore = { put: ok, get: async () => null, delete: ok };

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: ReturnType<typeof createAuth>;
let app: App;
/** The same server with a separate image origin. */
let filesApp: App;
let space: NewWorkspace;

interface Person {
  cookie: string;
}

const person = (role: "owner" | "admin" | "agent"): Promise<Person> =>
  signedInOperator({
    app,
    auth,
    owner,
    email: `${role}-${randomUUID()}@example.com`,
    workspaceId: space.id,
    role,
  });

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: "#1f6bff" } })
    .png()
    .toBuffer();

const logoPath = () => `/v1/operator/workspaces/${space.id}/logo`;

const upload = (as: Person, body: BodyInit, contentType = "image/png", server = app) =>
  server.request(logoPath(), {
    method: "PUT",
    headers: { cookie: as.cookie, origin: ORIGIN, "content-type": contentType },
    body,
  });

const removeLogo = (as: Person) =>
  app.request(logoPath(), { method: "DELETE", headers: { cookie: as.cookie, origin: ORIGIN } });

const settingsOf = async (as: Person) =>
  (await (
    await app.request(`/v1/operator/workspaces/${space.id}/settings`, {
      headers: { cookie: as.cookie },
    })
  ).json()) as { logoUrl: string | null };

/** The widget's presence answer, which carries the logo's address. */
const widgetLogoUrl = async () => {
  const response = await app.request(`/v1/widget/${space.publicKey}/presence`, {
    headers: { origin: SITE },
  });
  return ((await response.json()) as { logoUrl: string | null }).logoUrl;
};

const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const options = { auth, db, logger, checks: { postgres: ok, valkey: ok } };
  app = createApp(options);
  filesApp = createApp({
    ...options,
    images: createImages({
      store: noStore,
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
      origin: FILES_ORIGIN,
    }),
  });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  space = await createWorkspace(db, "Acme", [SITE]);
});

describe("uploading a logo", () => {
  test("an owner's logo is shrunk to fit 256 pixels, stored as WebP and named everywhere", async () => {
    const boss = await person("owner");
    const response = await upload(boss, await png(600, 300));
    expect(response.status).toBe(200);
    const { logoUrl } = (await response.json()) as { logoUrl: string };
    expect(logoUrl).toMatch(
      new RegExp(`^${PUBLIC_URL}/v1/widget/${space.publicKey}/logo\\?v=\\d+$`),
    );
    expect((await settingsOf(boss)).logoUrl).toBe(logoUrl);
    expect(await widgetLogoUrl()).toBe(logoUrl);
    const inbox = await app.request(`/v1/operator/workspaces/${space.id}`, {
      headers: { cookie: boss.cookie },
    });
    expect(await inbox.json()).toEqual({ id: space.id, name: "Acme", logoUrl });

    const served = await app.request(logoUrl);
    expect(served.status).toBe(200);
    const { format, width, height } = await sharp(
      new Uint8Array(await served.arrayBuffer()),
    ).metadata();
    expect({ format, width, height }).toEqual({ format: "webp", width: 256, height: 128 });
  });

  test("a small logo is not enlarged, and a new upload gets a new address", async () => {
    const boss = await person("admin");
    const first = (await (await upload(boss, await png(40, 40))).json()) as { logoUrl: string };
    // The address holds the time in milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = (await (await upload(boss, await png(40, 40))).json()) as { logoUrl: string };
    expect(second.logoUrl).not.toBe(first.logoUrl);
    const served = await app.request(second.logoUrl);
    const { width, height } = await sharp(new Uint8Array(await served.arrayBuffer())).metadata();
    expect([width, height]).toEqual([40, 40]);
  });

  test("a file that is not a PNG, JPEG or WebP is refused, whatever its type says", async () => {
    const boss = await person("owner");
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const response = await upload(boss, svg, "image/png");
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("not_an_image");
    expect((await settingsOf(boss)).logoUrl).toBeNull();
  });

  test("a body over 2 MB is refused, and the logo stays as it was", async () => {
    const boss = await person("owner");
    const kept = (await (await upload(boss, await png(10, 10))).json()) as { logoUrl: string };
    const response = await upload(boss, new Uint8Array(LOGO_MAX_BYTES + 1));
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("too_large");
    expect((await settingsOf(boss)).logoUrl).toBe(kept.logoUrl);
  });

  test("an agent can neither set nor remove the logo", async () => {
    const agent = await person("agent");
    const response = await upload(agent, await png(10, 10));
    expect(response.status).toBe(403);
    expect((await removeLogo(agent)).status).toBe(403);
    expect(await owner.select().from(workspaceLogo)).not.toContainEqual(
      expect.objectContaining({ workspaceId: space.id }),
    );
  });

  test("removing the logo clears its address and stops serving it", async () => {
    const boss = await person("owner");
    const { logoUrl } = (await (await upload(boss, await png(10, 10))).json()) as {
      logoUrl: string;
    };
    const response = await removeLogo(boss);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { logoUrl: string | null }).logoUrl).toBeNull();
    expect(await widgetLogoUrl()).toBeNull();
    expect((await app.request(logoUrl)).status).toBe(404);
  });
});

describe("the public logo route", () => {
  test("serves the logo to an <img>, with no Origin, cached for good and safe to open", async () => {
    const boss = await person("owner");
    const { logoUrl } = (await (await upload(boss, await png(10, 10))).json()) as {
      logoUrl: string;
    };
    const response = await app.request(logoUrl);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    });
  });

  test("answers 404 for an unknown key, a malformed key, or no logo", async () => {
    const unknown = `wk_${"0".repeat(32)}`;
    expect((await app.request(`/v1/widget/${unknown}/logo`)).status).toBe(404);
    expect((await app.request("/v1/widget/not-a-key/logo")).status).toBe(404);
    expect((await app.request(`/v1/widget/${space.publicKey}/logo`)).status).toBe(404);
  });

  test("answers 404 once the workspace is suspended or deleted", async () => {
    const boss = await person("owner");
    const { logoUrl } = (await (await upload(boss, await png(10, 10))).json()) as {
      logoUrl: string;
    };
    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, space.id));
    expect((await app.request(logoUrl)).status).toBe(404);
    await owner
      .update(workspace)
      .set({ suspendedAt: null, deletedAt: new Date() })
      .where(eq(workspace.id, space.id));
    expect((await app.request(logoUrl)).status).toBe(404);
  });

  test("with a separate image origin, only that origin serves it", async () => {
    const boss = await person("owner");
    const response = await upload(boss, await png(10, 10), "image/png", filesApp);
    const { logoUrl } = (await response.json()) as { logoUrl: string };
    expect(logoUrl.startsWith(`${FILES_ORIGIN}/v1/widget/${space.publicKey}/logo?v=`)).toBe(true);
    expect((await filesApp.request(logoUrl)).status).toBe(200);
    const onAppOrigin = logoUrl.replace(FILES_ORIGIN, PUBLIC_URL);
    expect((await filesApp.request(onAppOrigin)).status).toBe(404);
  });
});
