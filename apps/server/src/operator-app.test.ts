import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import type { App } from "./app.ts";
import { registerOperatorApp } from "./operator-app.ts";

// The public folder has the same layout as the built one, for every file these tests read.
const PUBLIC = fileURLToPath(new URL("../../operator/public/", import.meta.url));
const FONT = "fonts/gabarito-latin-wght-normal.woff2";

function operatorApp(): App {
  const app: App = new OpenAPIHono();
  registerOperatorApp(app, PUBLIC);
  return app;
}

test("a font is served as its exact bytes, with its type and a long cache", async () => {
  const response = await operatorApp().request(`/assets/${FONT}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("font/woff2");
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000");
  const served = Buffer.from(await response.arrayBuffer());
  expect(served.equals(await readFile(`${PUBLIC}${FONT}`))).toBe(true);
});

test("the page's CSP allows fonts from this server and no inline style", async () => {
  const response = await operatorApp().request("/");
  const csp = response.headers.get("content-security-policy");
  expect(csp).toContain("font-src 'self'");
  expect(csp).toContain("style-src 'self';");
});

test.each([
  "/settings",
  "/settings/team",
  "/settings/workspace",
  "/contacts",
  "/contacts/0b9e4a4e-6f1c-4f7e-9d3a-5c2b1a0f8e7d",
  "/visitors",
  "/analytics",
])("%s opens the app, so each screen has an address of its own", async (path) => {
  const response = await operatorApp().request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
});

test.each(["fonts/OFL.txt", "fonts/../index.html", "sw.js"])(
  "the asset route serves only its fixed list, so %s is not found",
  async (file) => {
    const response = await operatorApp().request(`/assets/${file}`);
    expect(response.status).toBe(404);
  },
);

test("every icon the manifest and the page name is served, and both use one theme color", async () => {
  const manifest: {
    theme_color: string;
    icons: { src: string; type: string; purpose?: string }[];
  } = JSON.parse(await readFile(`${PUBLIC}manifest.webmanifest`, "utf8"));
  const page = await readFile(`${PUBLIC}index.html`, "utf8");
  const touch = page.match(/rel="apple-touch-icon" href="([^"]+)"/)?.[1];
  expect(touch).toBeDefined();
  expect(page).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
  expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
  for (const { src, type } of [...manifest.icons, { src: touch ?? "", type: "image/png" }]) {
    const response = await operatorApp().request(src);
    expect(response.status, src).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
  }
});

test("the OAuth consent page opens the app, and no other site may frame it", async () => {
  const response = await operatorApp().request(
    "/oauth/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fa.example%2Fcb",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});
