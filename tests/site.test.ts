import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDocs, docsFiles } from "../site/build-docs.ts";

const PUBLIC = "site/public";

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

  test("it loads scripts, styles and fonts only from this site", () => {
    const tags = html.match(/<(script|link|img)\b[^>]*>/g) ?? [];
    const loaded = tags.filter((tag) => !/rel="canonical"/.test(tag));
    for (const tag of loaded) expect(tag).not.toMatch(/\s(src|href)="https?:/);
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

test("_headers sets the CSP and caches fonts for a year", () => {
  const headers = readFileSync(join(PUBLIC, "_headers"), "utf8");
  expect(headers).toContain(
    "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

test("the docs pages match docs/*.md: run `bun run docs:build` after changing a doc", () => {
  const expected = buildDocs();
  expect(docsFiles().sort()).toEqual([...expected.keys()].sort());
  for (const [file, contents] of expected) {
    expect(readFileSync(file).equals(Buffer.from(contents)), `${file} is out of date`).toBe(true);
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
