import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { PAGES, pathOf, writeDocs } from "../site/build-docs.ts";

const PUBLIC = "site/public";
// The docs pages are built, not committed, so the tests check the pages that docs/*.md make now.
writeDocs();
/** Dinghy's own chat, the one script from another origin, as its opening tag. */
const WIDGET_TAG =
  '<script src="https://app.dinghy.chat/widget/loader.js" data-key="wk_f2dce993672e6c0e4e08e116323ffe7e" async>';

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

const pages = filesUnder(PUBLIC)
  .filter((file) => file.endsWith(".html"))
  .map((file) => relative(PUBLIC, file));
const readPage = (page: string) => readFileSync(join(PUBLIC, page), "utf8");

/** Maps a site path to the file that serves it, as `auto-trailing-slash` does. */
function fileForPath(path: string): string | undefined {
  const clean = path.endsWith("/") ? `${path}index.html` : path;
  return [clean, `${clean}.html`]
    .map((candidate) => join(PUBLIC, candidate))
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function hasId(html: string, id: string): boolean {
  return new RegExp(`\\sid="${id}"`).test(html);
}

function attributeValues(html: string, attribute: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${attribute}="([^"]*)"`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

describe.each(pages)("%s", (page) => {
  const html = readPage(page);

  test("each internal link and source resolves", () => {
    const targets = [...attributeValues(html, "href"), ...attributeValues(html, "src")].filter(
      (target) => !/^(https?:|mailto:)/.test(target),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const [path = "", id] = target.split("#");
      const file = path ? fileForPath(path) : join(PUBLIC, page);
      expect(file, `${target} has no file`).toBeDefined();
      if (id && file)
        expect(hasId(readFileSync(file, "utf8"), id), `${target} has no id`).toBe(true);
    }
  });

  test("it loads scripts, styles and fonts only from this site, and Dinghy's own chat", () => {
    const tags = html.match(/<(script|link|img)\b[^>]*>/g) ?? [];
    const loaded = tags.filter((tag) => !/rel="canonical"/.test(tag) && tag !== WIDGET_TAG);
    for (const tag of loaded) expect(tag).not.toMatch(/\s(src|href)="https?:/);
  });

  test("it has Dinghy's chat once", () => {
    expect(html.split(`${WIDGET_TAG}</script>`)).toHaveLength(2);
  });

  test("it has no inline style or handler, which the CSP would block", () => {
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  test("its head is complete", () => {
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/<meta name="description" content="[^"]+">/);
    expect(html).toMatch(/<link rel="canonical" href="https:\/\/dinghy\.chat\/[^"]*">/);
    expect(html).toMatch(/<meta property="og:image" content="https:\/\/dinghy\.chat\/og\.png">/);
  });

  test("it has one h1", () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });
});

test("the share image exists", () => {
  expect(existsSync(join(PUBLIC, "og.png"))).toBe(true);
});

test("_headers sets the CSP, which allows Dinghy's chat, and caches fonts for a year", () => {
  const headers = readFileSync(join(PUBLIC, "_headers"), "utf8");
  expect(headers).toContain(
    "Content-Security-Policy: default-src 'none'; script-src 'self' https://app.dinghy.chat; style-src 'self'; img-src 'self' data: https://app.dinghy.chat https://img.dinghychat.com; font-src 'self'; connect-src https://app.dinghy.chat https://img.dinghychat.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  expect(headers).toMatch(/\/fonts\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
});

const textFiles = filesUnder("site").filter(
  (file) => !file.includes(".wrangler") && /\.(html|css|js|toml|txt|svg)$|_headers$/.test(file),
);

test.each(textFiles.map((file) => relative("site", file)))("%s has no banned words", (file) => {
  const text = readFileSync(join("site", file), "utf8");
  expect(text.toLowerCase()).not.toContain("fee per seat");
  if (!file.endsWith("OFL.txt")) expect(text).not.toContain("—");
});

test("the self-hosting page installs and upgrades to the release in compose.yaml", () => {
  const release = readFileSync("compose.yaml", "utf8").match(
    /ghcr\.io\/dinghy-chat\/dinghy:([\d.]+)/,
  )?.[1];
  expect(release).toBeDefined();
  const page = readPage("docs/self-hosting.html");
  expect(page).toContain(`git clone -b v${release} https://github.com/dinghy-chat/dinghy.git`);
  const versions = page.match(/\bv\d+\.\d+\.\d+\b/g) ?? [];
  expect(versions.length).toBeGreaterThanOrEqual(2);
  for (const version of versions) expect(version).toBe(`v${release}`);
});

test("each doc in the sidebar has its page, and its code blocks name a language", () => {
  const docs = pages.filter((page) => page.startsWith("docs/"));
  const sidebar = readPage("docs/index.html").match(/<nav class="docs-side"[\s\S]*?<\/nav>/)?.[0];
  const links = attributeValues(sidebar ?? "", "href");
  expect(links.length).toBeGreaterThanOrEqual(9);
  for (const href of links) expect(fileForPath(href), href).toBeDefined();
  for (const page of docs) {
    const html = readPage(page);
    const labels = [...html.matchAll(/<div class="terminal-bar"><span>([^<]+)<\/span>/g)];
    for (const [, label] of labels) expect(label, page).not.toBe("Code");
    if (labels.some(([, label]) => label !== "Text"))
      expect(html, page).toMatch(/<span class="(code|term)-[a-z]+/);
  }
});

// The repository link is in the docs header only, not on the marketing pages.
test.each(pages)(
  "%s links to the docs, and only docs pages to the repository, from its header",
  (page) => {
    const header =
      readPage(page).match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header).toContain('href="/docs/"');
    const github = 'href="https://github.com/dinghy-chat/dinghy"';
    if (page.startsWith("docs/")) expect(header).toContain(github);
    else expect(header).not.toContain(github);
  },
);

test("the old self-host address moves to the docs", () => {
  expect(readFileSync(join(PUBLIC, "_redirects"), "utf8")).toMatch(
    /^\/self-host \/docs\/self-hosting 301$/m,
  );
});

test("llms-full.txt holds every doc, with its title and its page's address", () => {
  const full = readFileSync(join(PUBLIC, "llms-full.txt"), "utf8");
  expect(full.startsWith("# Dinghy docs, in full\n")).toBe(true);
  for (const page of PAGES) {
    const title = readFileSync(join("docs", page.source), "utf8").split("\n")[0] ?? "";
    expect(title, page.source).toMatch(/^# \S/);
    expect(full, page.source).toContain(`${title}\n\nSource: https://dinghy.chat${pathOf(page)}\n`);
  }
  expect(full).not.toMatch(/\]\((?!https?:|mailto:|#)/);
});
