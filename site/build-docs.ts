/**
/**
 * Builds the generated pages of dinghy.chat: the docs from docs/*.md, the content pages from
 * site/content/**\/*.md, and sitemap.xml, llms.txt and llms-full.txt from both. The Markdown is the
 * only source. The files it writes are not committed: the Site workflow builds them before it tests
 * and deploys. Run `bun run docs:build` to preview the site locally.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { type Token, type Tokens, Marked } from "marked";
import {
  type CodeLanguage,
  type CodeLine,
  highlight,
  isCodeLanguage,
} from "../packages/widget/src/highlight.ts";

const REPO = "https://github.com/dinghy-chat/dinghy";
const SITE = "https://dinghy.chat";
/** Dinghy's own chat, on every page of the site, from Dinghy Cloud. The CSP in _headers allows it. */
const WIDGET =
  '<script src="https://app.dinghy.chat/widget/loader.js" data-key="wk_f2dce993672e6c0e4e08e116323ffe7e" async></script>';
const PUBLIC = "site/public";
const CONTENT = "site/content";
/** The folders this script owns. It empties them before it writes. */
export const OWNED_DIRS = ["docs", "for", "compare", "guides", "blog"].map((dir) => join(PUBLIC, dir));

interface Page {
  kind: "docs" | "content";
  /** The Markdown file, from the repository root. */
  file: string;
  /** The page's address on the site. */
  path: string;
  nav: string;
  group: string;
  /** The page's summary, under its title. Without it, the doc's first paragraph moves there. */
  description?: string | undefined;
  /** The browser title of a content page. A docs page's comes from its nav label. */
  title?: string | undefined;
  /** For content pages: when it was first published and last checked, as YYYY-MM-DD. */
  date?: string | undefined;
  updated?: string | undefined;
  /** For content pages: the short line and the optional chip on the cards that link here. */
  card?: string | undefined;
  stat?: string | undefined;
  /** For content pages: a logo in site/public/img/logos, by file name without .svg. */
  logo?: string | undefined;
  order: number;
}

interface DocEntry {
  source: string;
  slug: string;
  nav: string;
  group: string;
  description?: string;
}

/** The docs pages in sidebar order. An empty slug is the docs home, at /docs/. */
const DOCS: DocEntry[] = [
  { source: "README.md", slug: "", nav: "Overview", group: "" },
  {
    source: "self-hosting.md",
    slug: "self-hosting",
    nav: "Self-hosting",
    group: "Get started",
    description:
      "Run Dinghy on one small Linux server. One install script, no third-party account and no API key.",
  },
  {
    source: "add-to-your-site.md",
    slug: "add-to-your-site",
    nav: "Add the chat to your site",
    group: "Get started",
    description:
      "Put the Dinghy chat on your website with one tag. Set its colors, open it from your own button and show who is chatting.",
  },
  { source: "operator-guide.md", slug: "operator-guide", nav: "Operator guide", group: "Use it" },
  {
    source: "agents.md",
    slug: "agents",
    nav: "AI agents",
    group: "Use it",
    description:
      "Connect Claude Code or your own bot with OAuth or an API key, install the chat, answer chats with drafts first, and hand off to people.",
  },
  {
    source: "troubleshooting.md",
    slug: "troubleshooting",
    nav: "Troubleshooting",
    group: "Help",
    description:
      "What to check when the install, the chat widget, alerts, sign-in or backups do not work.",
  },
  {
    source: "runbooks.md",
    slug: "runbooks",
    nav: "Runbooks",
    group: "Help",
    description:
      "What to do when the disk is full, Postgres or Valkey is down, mail fails, a release breaks or backups fail.",
  },
  {
    source: "deploy-coolify-dokploy.md",
    slug: "deploy-coolify-dokploy",
    nav: "Deploy on Coolify or Dokploy",
    group: "Help",
    description: "How Dinghy's Compose file fits Coolify and Dokploy, behind the platform's own proxy.",
  },
  {
    source: "architecture.md",
    slug: "architecture",
    nav: "Architecture",
    group: "Develop",
    description:
      "How Dinghy's processes, tenant isolation, messages and events, live signals and background jobs fit together.",
  },
  {
    source: "api.md",
    slug: "api",
    nav: "API",
    group: "Develop",
    description:
      "Dinghy's HTTP API: versioning, sign-in, errors, live streams with cursors, and the OpenAPI document.",
  },
  {
    source: "measurements.md",
    slug: "measurements",
    nav: "Measurements",
    group: "Develop",
    description:
      "Load tests of the full install on one Hetzner CX23: open streams, message rates, uploads and memory, with what they did not measure.",
  },
];

const DOCS_PAGES: Page[] = DOCS.map((entry, index) => ({
  kind: "docs",
  file: `docs/${entry.source}`,
  path: entry.slug ? `/docs/${entry.slug}` : "/docs/",
  nav: entry.nav,
  group: entry.group,
  description: entry.description,
  order: index,
}));

/** The content folders, in sidebar order, with the heading each gets. */
const GROUPS: [string, string][] = [
  ["", "Why Dinghy"],
  ["compare", "Compare"],
  ["for", "Use cases"],
  ["guides", "Install guides"],
  ["blog", "Blog"],
];

/** Splits the `key: value` lines between two `---` lines from the Markdown under them. */
function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: text.slice(match[0].length) };
}

function contentPages(): Page[] {
  return readdirSync(CONTENT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      const { meta } = frontMatter(readFileSync(file, "utf8"));
      const folder = relative(CONTENT, entry.parentPath);
      const name = entry.name.slice(0, -3);
      const group = GROUPS.find(([dir]) => dir === folder);
      if (!group) throw new Error(`${file}: put content pages in one of ${GROUPS.map(([dir]) => dir || "the root")}`);
      for (const key of ["title", "nav", "description", "date"])
        if (!meta[key]) throw new Error(`${file} needs "${key}" in its front matter`);
      const base = folder ? `/${folder}/` : "/";
      return {
        kind: "content" as const,
        file,
        path: name === "index" ? base : `${base}${name}`,
        nav: meta.nav ?? name,
        group: group[1],
        description: meta.description,
        title: meta.title,
        date: meta.date,
        updated: meta.updated ?? meta.date,
        card: meta.card,
        stat: meta.stat,
        logo: meta.logo,
        order: Number(meta.order ?? 50),
      };
    })
    .sort(
      (a, b) =>
        GROUPS.findIndex(([, name]) => name === a.group) -
          GROUPS.findIndex(([, name]) => name === b.group) ||
        a.order - b.order ||
        a.nav.localeCompare(b.nav),
    );
}

const CONTENT_PAGES = contentPages();
const ALL_PAGES = [...DOCS_PAGES, ...CONTENT_PAGES];

const fileFor = (path: string) => join(PUBLIC, path.endsWith("/") ? `${path}index.html` : `${path}.html`);

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** GitHub's heading IDs, so links written for GitHub land on the same section here. */
const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

/** A link from a page, rewritten to its page on this site or to the file on GitHub. */
function rewriteLink(href: string, from: Page): string {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;
  const [path = "", hash] = href.split("#");
  const target = posix.normalize(posix.join(posix.dirname(from.file), path));
  const suffix = hash ? `#${hash}` : "";
  const page = ALL_PAGES.find((candidate) => candidate.file === target);
  if (page) return page.path + suffix;
  if (target.startsWith("docs/media/")) return `/${target}`;
  return `${REPO}/blob/main/${target}${suffix}`;
}

const ICON_GITHUB =
  '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
const ICON_CHEVRON =
  '<svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path class="duo" d="M208,96l-80,80L48,96Z"/><path d="M215.39,92.94A8,8,0,0,0,208,88H48a8,8,0,0,0-5.66,13.66l80,80a8,8,0,0,0,11.32,0l80-80A8,8,0,0,0,215.39,92.94ZM128,164.69,67.31,104H188.69Z"/></svg>';

const CODE_LABELS: Record<CodeLanguage, string> = {
  sh: "Terminal",
  html: "HTML",
  css: "CSS",
  js: "JavaScript",
  ts: "TypeScript",
  json: "JSON",
  nginx: "nginx",
  text: "Text",
};

const PROMPT_CLASS: Record<CodeLine["prompt"], string> = {
  command: "term-line",
  continued: "term-line term-more",
  none: "term-note",
};

function lineHtml(line: CodeLine, language: CodeLanguage): string {
  const html = line.tokens
    .map(({ kind, text }) => (kind ? `<span class="code-${kind}">${escape(text)}</span>` : escape(text)))
    .join("");
  return language === "sh" ? `<span class="${PROMPT_CLASS[line.prompt]}">${html}</span>` : html;
}

/** Fences the highlighter does not name: each is colored as a language it knows, under its own label. */
const ALIASES: Record<string, [CodeLanguage, string]> = {
  jsx: ["js", "JavaScript"],
  tsx: ["ts", "TypeScript"],
  astro: ["html", "Astro"],
  liquid: ["html", "Liquid"],
  php: ["html", "PHP"],
  python: ["text", "Python"],
  go: ["text", "Go"],
};

function codeBlock(text: string, fence: string, id: string): string {
  const [lang, label] = ALIASES[fence] ?? [fence, undefined];
  if (!isCodeLanguage(lang)) throw new Error(`A code block has no known language: "${fence}".`);
  const lines = highlight(text, lang).filter(
    (line) => lang !== "sh" || line.tokens.some((token) => token.text.trim()),
  );
  const body = lines.map((line) => lineHtml(line, lang));
  const kind = lang === "sh" ? "" : " terminal-plain";
  return `<div class="terminal doc-code${kind}">
<div class="terminal-bar"><span>${label ?? CODE_LABELS[lang]}</span><button class="copy" type="button" data-copy="${id}"><span data-copy-label>Copy</span></button></div>
<pre class="terminal-code" id="${id}"><code>${body.join("\n")}</code></pre>
</div>\n`;
}

/** Reads a PNG's size from its header, so the page saves the image's room before it loads. */
function pngSize(file: string): [number, number] {
  const header = readFileSync(file);
  return [header.readUInt32BE(16), header.readUInt32BE(20)];
}

interface Rendered {
  title: string;
  lede: string;
  html: string;
  sections: { id: string; text: string }[];
  images: string[];
}

function render(page: Page): Rendered {
  const liftLede = !page.description;
  const sections: { id: string; text: string }[] = [];
  const images: string[] = [];
  const seen = new Map<string, number>();
  let blocks = 0;
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const base = slugify(plain(inner));
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count ? `${base}-${count}` : base;
        if (depth === 2) sections.push({ id, text: plain(inner) });
        return `<h${depth} id="${id}"><a class="heading-link" href="#${id}">${inner}</a></h${depth}>\n`;
      },
      code({ text, lang }) {
        blocks += 1;
        return codeBlock(text, (lang ?? "").split(/\s/)[0] ?? "", `code-${blocks}`);
      },
      link({ href, tokens }) {
        const target = rewriteLink(href, page);
        const inner = this.parser.parseInline(tokens);
        return `<a href="${escape(target)}">${inner}</a>`;
      },
      image({ href, text }) {
        const target = rewriteLink(href, page);
        images.push(target.slice(1));
        const [width, height] = pngSize(target.slice(1));
        return `<img src="${escape(target)}" width="${width}" height="${height}" alt="${escape(text)}" loading="lazy">`;
      },
      codespan({ text }) {
        // A short name never breaks across lines. A long value, such as a URL, may.
        const long = text.length > 32 ? ' class="code-long"' : "";
        return `<code${long}>${escape(text)}</code>`;
      },
      table(token: Tokens.Table) {
        const inline = (item: Tokens.TableCell) => this.parser.parseInline(item.tokens);
        const labels = token.header.map((item) => escape(plain(inline(item))));
        // A column or a row about Dinghy stands out, and a cell that starts with a price reads as one.
        const ours = (text: string) => /^Dinghy\b/.test(text);
        const column = labels.findIndex((label, index) => index > 0 && ours(label));
        const cls = (...names: (string | false)[]) => {
          const list = names.filter(Boolean).join(" ");
          return list ? ` class="${list}"` : "";
        };
        const head = token.header
          .map(
            (item, index) =>
              `<th${cls(index === column && "is-us", (labels[index] ?? "").length <= 12 && "nowrap")}>${inline(item)}</th>`,
          )
          .join("");
        // On a phone, each row stacks, and each cell after the first shows its column's name.
        const rows = token.rows
          .map((row) => {
            const mine = column < 0 && ours(plain(inline(row[0] as Tokens.TableCell)));
            const cells = row
              .map((item, index) => {
                const html = inline(item);
                const text = plain(html);
                const price = index > 0 && /^\$\d/.test(text) && text.length <= 45 && !text.includes(". ");
                const short = price && text.length <= 14;
                return `<td${cls(index === column && "is-us", price && "cell-price", short && "nowrap")} data-label="${labels[index]}">${html}</td>`;
              })
              .join("");
            return `<tr${cls(mine && "is-us")}>${cells}</tr>`;
          })
          .join("\n");
        return `<div class="doc-table"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table></div>\n`;
      },
    },
  });
  const { body: source } = frontMatter(readFileSync(page.file, "utf8"));
  const tokens: Token[] = marked.lexer(source);
  const titleAt = tokens.findIndex((token) => token.type === "heading" && token.depth === 1);
  const title = tokens[titleAt]?.type === "heading" ? (tokens[titleAt] as Tokens.Heading).text : "";
  const next = tokens.slice(titleAt + 1).findIndex((token) => token.type !== "space");
  const ledeAt = titleAt + 1 + next;
  const ledeToken = tokens[ledeAt];
  const isLede =
    liftLede &&
    ledeToken?.type === "paragraph" &&
    !(ledeToken as Tokens.Paragraph).tokens.some((token) => token.type === "image");
  const lede = isLede ? marked.parseInline((ledeToken as Tokens.Paragraph).text) : "";
  const body = tokens.filter((_, index) => index !== titleAt && (!lede || index !== ledeAt));
  const html = marked.parser(body);
  return { title, lede: typeof lede === "string" ? lede : "", html, sections, images };
}

const MONTHS = "January February March April May June July August September October November December".split(" ");
const longDate = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}, ${year}`;
};

/** Structured data for a content page. The CSP allows it: a browser never runs a JSON block. */
function articleData(page: Page, headline: string, description: string): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline,
    description,
    datePublished: page.date,
    dateModified: page.updated,
    mainEntityOfPage: SITE + page.path,
    image: `${SITE}/og.png`,
    author: { "@type": "Organization", name: "Dinghy", url: `${SITE}/` },
    publisher: { "@type": "Organization", name: "Dinghy", url: `${SITE}/` },
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `\n  <script type="application/ld+json">${json}</script>`;
}

function head(page: Page, heading: string, description: string): string {
  const url = SITE + page.path;
  const docs = page.kind === "docs";
  const fullTitle = docs ? (page.path === "/docs/" ? "Dinghy docs" : `${page.nav}: Dinghy docs`) : (page.title ?? heading);
  const data = docs ? "" : articleData(page, heading, description);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(fullTitle)}</title>
  <meta name="description" content="${escape(description)}">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#ffc917">
  <meta property="og:type" content="${docs ? "website" : "article"}">
  <meta property="og:site_name" content="Dinghy">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${escape(fullTitle)}">
  <meta property="og:description" content="${escape(description)}">
  <meta property="og:image" content="${SITE}/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="A boat on the water, with the words: Live chat for solo founders and small teams.">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escape(fullTitle)}">
  <meta name="twitter:description" content="${escape(description)}">
  <meta name="twitter:image" content="${SITE}/og.png">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/fonts/gabarito-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/hanken-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/site.css">
  <script type="module" src="/js/${docs ? "docs" : "page"}.js"></script>${data}
  ${WIDGET}
</head>`;
}

/** The site header, as on every page. On a docs page, the Docs link is current and GitHub shows. */
export function header(kind: Page["kind"]): string {
  const docs = kind === "docs";
  const current = docs ? ' aria-current="page"' : "";
  const github = docs
    ? `\n        <a class="github-link" data-wave-link href="${REPO}">${ICON_GITHUB}<span>GitHub</span></a>`
    : "";
  return `  <header class="site-header">
    <div class="header-bar">
      <a class="logo" href="/" aria-label="Dinghy home"><img src="/favicon.svg" width="32" height="32" alt=""><span>dinghy</span></a>
      <nav aria-label="Main">
        <a data-wave-link href="/#features">Features</a>
        <a data-wave-link href="/#install">Install</a>
        <a data-wave-link href="/#pricing">Pricing</a>
        <a data-wave-link href="/docs/"${current}>Docs</a>${github}
      </nav>
      <div class="header-end">
        <a data-wave-link href="https://app.dinghy.chat">Log in</a>
        <a class="btn btn-navy btn-small" href="https://app.dinghy.chat/signup">Get started</a>
      </div>
    </div>
  </header>`;
}

const FOOTER = `  <footer>
    <div class="sand">
      <div class="wrap sand-row">
        <span>&copy; 2026 Dinghy, a project by <a href="https://oncebyte.com/" target="_blank" rel="noopener">OnceByte, LLC</a></span>
        <a class="sand-mail" href="mailto:hello@dinghy.chat">hello@dinghy.chat</a>
      </div>
    </div>
  </footer>`;

function pageList(current: Page): string {
  const pages = current.kind === "docs" ? DOCS_PAGES : CONTENT_PAGES;
  const groups = [...new Set(pages.map((page) => page.group))];
  return groups
    .map((group) => {
      const links = pages
        .filter((page) => page.group === group)
        .map((page) => {
          const here = page === current ? ' aria-current="page"' : "";
          return `<li><a href="${page.path}"${here}>${page.nav}</a></li>`;
        })
        .join("\n          ");
      const title = group ? `\n        <p class="docs-group">${group}</p>` : "";
      return `${title}\n        <ul>\n          ${links}\n        </ul>`;
    })
    .join("");
}

const BAND = (heading: string, lede: string, meta: string, extra = "") => `    <section class="docs-band${extra ? ` ${extra}` : ""}" data-hero data-pause-offscreen>
      <div class="docs-grid docs-band-grid">
        <div class="docs-band-text">
          ${heading}
          ${lede ? `<p class="lede">${lede}</p>` : ""}${meta}
        </div>
      </div>
      <div class="water docs-water" data-scene="band" aria-hidden="true">
        <canvas data-water-back></canvas>
        <div class="water-boats" data-boats></div>
        <canvas data-water-front></canvas>
      </div>
    </section>`;

/** What a content folder is called above a page's title, and where that label links. */
const SECTION: Record<string, { label: string; path: string }> = {
  "Why Dinghy": { label: "Why Dinghy", path: "/open-source-live-chat" },
  Compare: { label: "Compare", path: "/compare/" },
  "Use cases": { label: "Use cases", path: "/for/" },
  "Install guides": { label: "Install guides", path: "/guides/" },
  Blog: { label: "Blog", path: "/blog/" },
};

/** A content page's title, from its Markdown, for the cards that link to it. */
function headingOf(page: Page): string {
  const { body } = frontMatter(readFileSync(page.file, "utf8"));
  return (body.match(/^# (.+)$/m)?.[1] ?? page.nav).replace(/[`*_]/g, "");
}

const minutesToRead = (page: Page) => {
  const { body } = frontMatter(readFileSync(page.file, "utf8"));
  return Math.max(1, Math.round(body.split(/\s+/).length / 230));
};

const isIndex = (page: Page) => page.path.endsWith("/");

/** The pages of a group, in reading order. Blog posts go newest first. */
function groupPages(group: string): Page[] {
  const pages = CONTENT_PAGES.filter((page) => page.group === group && !isIndex(page));
  return group === "Blog"
    ? [...pages].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.order - a.order)
    : pages;
}

const CARD_ACTION: Record<string, string> = {
  Compare: "Compare",
  "Use cases": "See how",
  "Install guides": "Open the guide",
  Blog: "Read the post",
  "Why Dinghy": "Read more",
};

function cards(pages: Page[], from?: Page): string {
  const items = pages
    .map((page) => {
      const title = page.group === "Install guides" ? page.nav : headingOf(page);
      const kicker =
        page.group === "Blog" && page.date
          ? `${longDate(page.date)} · ${minutesToRead(page)} min read`
          : from && from.group !== page.group
            ? (SECTION[page.group]?.label ?? "")
            : "";
      const logo = page.logo
        ? `\n          <img class="card-logo" src="/img/logos/${page.logo}.svg" width="28" height="28" alt="">`
        : "";
      const top = `${logo}${kicker ? `\n          <span class="card-kicker">${escape(kicker)}</span>` : ""}`;
      const stat = page.stat
        ? `<span class="card-stat"><span>${escape(page.stat)}</span>${/^(\$|Free)/.test(page.stat) ? '<span class="card-stat-us">Dinghy $7</span>' : ""}</span>`
        : "";
      return `<a class="card" href="${page.path}">
${top}
          <span class="card-title">${escape(title)}</span>
          <span class="card-text">${escape(page.card ?? page.description ?? "")}</span>${stat}
          <span class="card-go">${CARD_ACTION[page.group] ?? "Read"}<span aria-hidden="true"> &rarr;</span></span>
        </a>`;
    })
    .join("\n        ");
  return `<div class="cards">\n        ${items}\n      </div>`;
}

/** Up to three other pages to read next: the ones after this page in its group, then from the start. */
function related(page: Page): Page[] {
  const pool =
    page.group === "Why Dinghy"
      ? CONTENT_PAGES.filter((other) => other.group === "Why Dinghy" || other.path === "/compare/" || other.path === "/for/")
      : groupPages(page.group);
  const at = pool.indexOf(page);
  return [...pool.slice(at + 1), ...pool.slice(0, Math.max(at, 0))].filter((other) => other !== page).slice(0, 3);
}

/** The home page's footer, with its section links pointed back at the home page. */
const SITE_FOOTER = (() => {
  const home = readFileSync(join(PUBLIC, "index.html"), "utf8");
  const footer = home.match(/ {2}<footer class="site-footer"[\s\S]*?<\/footer>/)?.[0];
  if (!footer) throw new Error("site/public/index.html has no site footer");
  return footer.replaceAll('href="#', 'href="/#');
})();

const CTA = `      <aside class="story-cta" aria-label="Try Dinghy">
        <div>
          <p class="story-cta-title">Try Dinghy on your site</p>
          <p>$7 a month for up to 5 people on Dinghy Cloud, or free on your own server.</p>
        </div>
        <div class="story-cta-actions">
          <a class="btn btn-navy" href="https://app.dinghy.chat/signup">Get started</a>
          <a class="btn btn-outline" href="/docs/self-hosting">Host it yourself</a>
        </div>
      </aside>`;

const logoTile = (page: Page) =>
  page.logo
    ? `<span class="band-logo"><img src="/img/logos/${page.logo}.svg" width="36" height="36" alt=""></span>\n          `
    : "";

/** A blog post, comparison, use case or guide: one reading column, then what to read next. */
function buildStory(page: Page): { html: string; images: string[] } {
  const doc = render(page);
  const description = page.description ?? plain(doc.lede);
  const section = SECTION[page.group];
  const index = isIndex(page);
  const eyebrow =
    section && section.path !== page.path
      ? `<a class="band-eyebrow" href="${section.path}">${section.label}</a>`
      : `<span class="band-eyebrow">${section?.label ?? ""}</span>`;
  let meta = "";
  if (page.group === "Blog" && !index && page.date)
    meta = `${longDate(page.date)} · ${minutesToRead(page)} min read`;
  // A comparison's date is the day its prices were checked. Its updated date can be later, for a change to Dinghy's side.
  else if (page.group === "Compare" && page.date) meta = `Prices checked ${longDate(page.date)}`;
  const metaLine = meta ? `\n          <p class="doc-meta">${meta}</p>` : "";
  let body = doc.html.trim();
  body = body.replace(/<!-- pages(?: (\d+)-(\d+))? -->/g, (_, from?: string, to?: string) =>
    cards(
      groupPages(page.group).filter(
        (other) => from === undefined || (other.order >= Number(from) && other.order <= Number(to)),
      ),
    ),
  );
  const next = index ? [] : related(page);
  const nextBlock = next.length
    ? `\n      <section class="story-next" aria-labelledby="next-title">
        <h2 id="next-title">Keep reading</h2>
        ${cards(next, page)}
      </section>`
    : "";
  const html = `${head(page, plain(doc.title), description)}
<body>
  <a class="skip-link" href="#main">Skip to the content</a>

${header(page.kind)}

  <main id="main">
${BAND(`${logoTile(page)}${eyebrow}\n          <h1>${doc.title}</h1>`, page.description ? escape(page.description) : doc.lede, metaLine, "story-band")}

    <div class="story">
      <article class="doc story-doc">
${body}
      </article>
${CTA}${nextBlock}
    </div>
    <p class="visually-hidden" role="status" data-copy-status></p>
  </main>

${SITE_FOOTER}
</body>
</html>
`;
  return { html, images: doc.images };
}

function buildPage(page: Page): { html: string; images: string[] } {
  if (page.kind === "content") return buildStory(page);
  const doc = render(page);
  const description = page.description ?? plain(doc.lede);
  const toc = doc.sections
    .map((section) => `<li><a href="#${section.id}">${escape(section.text)}</a></li>`)
    .join("\n          ");
  const home = page.path === "/docs/";
  const html = `${head(page, plain(doc.title), description)}
<body>
  <a class="skip-link" href="#main">Skip to the content</a>

${header(page.kind)}

  <main id="main">
${BAND(`<h1>${doc.title}</h1>`, page.description ? escape(page.description) : doc.lede, "")}

    <div class="docs-grid docs-body${home ? " docs-home" : ""}">
      <details class="docs-menu">
        <summary><span class="docs-menu-label">Docs</span><b>${page.nav}</b>${ICON_CHEVRON}</summary>
        <nav aria-label="Docs pages">${pageList(page)}
        </nav>
      </details>
      <nav class="docs-side" aria-label="Docs">${pageList(page)}
      </nav>
      <article class="doc">
${doc.html.trim()}
      </article>
      <aside class="docs-toc" aria-label="On this page">
        <p class="docs-group">On this page</p>
        <ol>
          ${toc}
        </ol>
      </aside>
    </div>
    <p class="visually-hidden" role="status" data-copy-status></p>
  </main>

${FOOTER}
</body>
</html>
`;
  return { html, images: doc.images };
}

/** A doc's Markdown with its relative links made absolute, as a file outside the site reads them. */
function absoluteLinks(markdown: string, page: Page): string {
  return markdown.replace(/(\]\()([^)\s]+)\)/g, (_match, open: string, href: string) => {
    const target = rewriteLink(href, page);
    return `${open}${target.startsWith("/") ? SITE + target : target})`;
  });
}

/** Every doc in sidebar order, in one Markdown file, as llmstxt.org suggests for llms-full.txt. */
function llmsFull(): string {
  const docs = DOCS_PAGES.map((page) => {
    const [title = "", ...rest] = readFileSync(page.file, "utf8").split("\n");
    const body = absoluteLinks(rest.join("\n").trim(), page);
    return `${title}\n\nSource: ${SITE}${page.path}\n\n${body}\n`;
  });
  const header = `# Dinghy docs, in full

> Dinghy is a small, open-source live support chat. This file holds every page of its docs, from ${REPO}/tree/main/docs. The short index is ${SITE}/llms.txt.
`;
  return [header, ...docs].join("\n---\n\n");
}

/** Every page on the site, for search engines. The hand-written pages come first, and the 404 page is left out. */
function sitemap(): string {
  const entries = [
    ...["/", "/terms", "/privacy"].map((path) => ({ path, updated: undefined as string | undefined })),
    ...ALL_PAGES.map((page) => ({ path: page.path, updated: page.updated })),
  ]
    .map(({ path, updated }) => {
      const lastmod = updated ? `<lastmod>${updated}</lastmod>` : "";
      return `  <url><loc>${SITE}${path}</loc>${lastmod}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

/** llms.txt: site/llms.md, which already points to the docs, with a link to every content page before its Optional section. */
function llms(): string {
  const [intro = "", optional] = readFileSync("site/llms.md", "utf8").trim().split("\n## Optional\n");
  const lists = GROUPS.map(([, group]) => {
    const links = CONTENT_PAGES.filter((page) => page.group === group)
      .map((page) => `- [${page.nav}](${SITE}${page.path}): ${page.description}`)
      .join("\n");
    return `## ${group}\n\n${links}`;
  });
  const tail = optional === undefined ? [] : [`## Optional\n${optional}`];
  return `${[intro.trim(), ...lists, ...tail].join("\n\n")}\n`;
}

/** Every file this script makes, by path, with the contents it should have now. */
export function buildSite(): Map<string, string | Buffer> {
  const files = new Map<string, string | Buffer>();
  for (const page of ALL_PAGES) {
    const { html, images } = buildPage(page);
    files.set(fileFor(page.path), html);
    for (const image of images) files.set(join(PUBLIC, image), readFileSync(image));
  }
  files.set(join(PUBLIC, "sitemap.xml"), sitemap());
  files.set(join(PUBLIC, "llms.txt"), llms());
  files.set(join(PUBLIC, "llms-full.txt"), llmsFull());
  return files;
}

/** Writes every generated file afresh, and returns how many it wrote. */
export function writeSite(): number {
  for (const dir of OWNED_DIRS) rmSync(dir, { recursive: true, force: true });
  const files = buildSite();
  for (const [path, contents] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return files.size;
}

if (import.meta.main) console.log(`Wrote ${writeSite()} files to ${PUBLIC}.`);
