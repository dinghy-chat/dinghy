/**
 * Builds the docs section of dinghy.chat from docs/*.md, which stay the source of truth.
 * Run `bun run docs:build` after a change to a doc, and commit the pages it writes.
 * tests/site.test.ts fails when a committed page differs from what this script makes now.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { type Token, type Tokens, Marked } from "marked";

const REPO = "https://github.com/dinghy-chat/dinghy";
const SITE = "https://dinghy.chat";
/** Dinghy's own chat, on every page of the site, from Dinghy Cloud. The CSP in _headers allows it. */
const WIDGET =
  '<script src="https://app.dinghy.chat/widget/loader.js" data-key="wk_f2dce993672e6c0e4e08e116323ffe7e" async></script>';
export const OUT = "site/public/docs";

interface Page {
  source: string;
  slug: string;
  nav: string;
  group: string;
  /** The page's summary, under its title. Without it, the doc's first paragraph moves there. */
  description?: string;
}

/** The pages in sidebar order. An empty slug is the docs home, at /docs/. */
const PAGES: Page[] = [
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
];

const pathOf = (page: Page) => (page.slug ? `/docs/${page.slug}` : "/docs/");

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

/** A link from a doc, rewritten to its page on this site or to the file on GitHub. */
function rewriteLink(href: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path = "", hash] = href.split("#");
  const target = posix.normalize(posix.join("docs", path));
  const suffix = hash ? `#${hash}` : "";
  const page = PAGES.find((candidate) => `docs/${candidate.source}` === target);
  if (page) return pathOf(page) + suffix;
  if (target.startsWith("docs/media/")) return `/${target}`;
  return `${REPO}/blob/main/${target}${suffix}`;
}

const ICON_GITHUB =
  '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
const ICON_CHEVRON =
  '<svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path class="duo" d="M208,96l-80,80L48,96Z"/><path d="M215.39,92.94A8,8,0,0,0,208,88H48a8,8,0,0,0-5.66,13.66l80,80a8,8,0,0,0,11.32,0l80-80A8,8,0,0,0,215.39,92.94ZM128,164.69,67.31,104H188.69Z"/></svg>';

const CODE_LABELS: Record<string, string> = {
  sh: "Terminal",
  html: "HTML",
  js: "JavaScript",
  nginx: "nginx",
  text: "Text",
};

/** Paints tokens that match `pattern`: each named group becomes a span of that class. */
function paint(line: string, pattern: RegExp): string {
  let html = "";
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    html += escape(line.slice(last, index));
    const [kind, text = ""] =
      Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined) ?? [];
    html += kind ? `<span class="code-${kind}">${escape(text)}</span>` : escape(match[0]);
    last = index + match[0].length;
  }
  return html + escape(line.slice(last));
}

const HIGHLIGHT: Record<string, RegExp> = {
  html: /(?<tag><\/?[a-zA-Z][\w-]*|\/?>)|(?<attr>(?<=\s)[\w-]+(?==))|(?<string>"[^"]*")/g,
  js: /(?<comment>\/\/.*$)|(?<string>"[^"]*"|`[^`]*`)|(?<keyword>\b(?:import|from|export|function|const|return|async|await|new)\b)/g,
  nginx: /(?<comment>#.*$)|(?<keyword>^\s*[a-z_]+(?=\s))|(?<string>\$[a-z_]+)/g,
};

/** A shell line: a full comment, or a command with an optional comment at the end. */
function shellLine(line: string): string {
  if (line.startsWith("#")) return `<span class="term-note">${escape(line)}</span>`;
  const [, command = line, note] = line.match(/^(.*?)(\s+#\s.*)?$/) ?? [];
  const tail = note ? `<span class="code-comment">${escape(note)}</span>` : "";
  return `<span class="term-line">${escape(command)}${tail}</span>`;
}

function codeBlock(text: string, lang: string, id: string): string {
  const label = CODE_LABELS[lang] ?? "Code";
  const lines = text.split("\n");
  const pattern = HIGHLIGHT[lang];
  const body =
    lang === "sh"
      ? lines.filter((line) => line.trim()).map(shellLine)
      : lines.map((line) => (pattern ? paint(line, pattern) : escape(line)));
  const kind = lang === "sh" ? "" : " terminal-plain";
  return `<div class="terminal doc-code${kind}">
<div class="terminal-bar"><span>${label}</span><button class="copy" type="button" data-copy="${id}"><span data-copy-label>Copy</span></button></div>
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
        const target = rewriteLink(href);
        const inner = this.parser.parseInline(tokens);
        return `<a href="${escape(target)}">${inner}</a>`;
      },
      image({ href, text }) {
        const target = rewriteLink(href);
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
        const head = token.header.map((item) => `<th>${inline(item)}</th>`).join("");
        // On a phone, each row stacks, and each cell after the first shows its column's name.
        const rows = token.rows
          .map(
            (row) =>
              `<tr>${row.map((item, index) => `<td data-label="${labels[index]}">${inline(item)}</td>`).join("")}</tr>`,
          )
          .join("\n");
        return `<div class="doc-table"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table></div>\n`;
      },
    },
  });
  const tokens: Token[] = marked.lexer(readFileSync(join("docs", page.source), "utf8"));
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

function head(page: Page, title: string, description: string): string {
  const url = SITE + pathOf(page);
  const fullTitle = page.slug ? `${title}: Dinghy docs` : "Dinghy docs";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(fullTitle)}</title>
  <meta name="description" content="${escape(description)}">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#ffc917">
  <meta property="og:type" content="website">
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
  <script type="module" src="/js/docs.js"></script>
  ${WIDGET}
</head>`;
}

/** The site header, as on every page. The Docs link is current here. */
export const HEADER = `  <header class="site-header">
    <div class="header-bar">
      <a class="logo" href="/" aria-label="Dinghy home"><img src="/favicon.svg" width="32" height="32" alt=""><span>dinghy</span></a>
      <nav aria-label="Main">
        <a data-wave-link href="/#features">Features</a>
        <a data-wave-link href="/#install">Install</a>
        <a data-wave-link href="/#pricing">Pricing</a>
        <a data-wave-link href="/docs/" aria-current="page">Docs</a>
        <a class="github-link" data-wave-link href="${REPO}">${ICON_GITHUB}<span>GitHub</span></a>
      </nav>
      <div class="header-end">
        <a data-wave-link href="https://app.dinghy.chat">Log in</a>
        <a class="btn btn-navy btn-small" href="https://app.dinghy.chat/signup">Get started</a>
      </div>
    </div>
  </header>`;

const FOOTER = `  <footer>
    <div class="sand">
      <div class="wrap sand-row">
        <span>&copy; 2026 Dinghy, a project by <a href="https://oncebyte.com/" target="_blank" rel="noopener">OnceByte, LLC</a></span>
        <a class="sand-mail" href="mailto:hello@dinghy.chat">hello@dinghy.chat</a>
      </div>
    </div>
  </footer>`;

function pageList(current: Page): string {
  const groups = [...new Set(PAGES.map((page) => page.group))];
  return groups
    .map((group) => {
      const links = PAGES.filter((page) => page.group === group)
        .map((page) => {
          const here = page === current ? ' aria-current="page"' : "";
          return `<li><a href="${pathOf(page)}"${here}>${page.nav}</a></li>`;
        })
        .join("\n          ");
      const title = group ? `\n        <p class="docs-group">${group}</p>` : "";
      return `${title}\n        <ul>\n          ${links}\n        </ul>`;
    })
    .join("");
}

const BAND = (page: Page, title: string, lede: string) => `    <section class="docs-band" data-hero data-pause-offscreen>
      <div class="docs-grid docs-band-grid">
        <div class="docs-band-text">
          <h1>${title}</h1>
          ${lede ? `<p class="lede">${lede}</p>` : ""}
        </div>
      </div>
      <div class="water docs-water" data-scene="band" aria-hidden="true">
        <canvas data-water-back></canvas>
        <div class="water-boats" data-boats></div>
        <canvas data-water-front></canvas>
      </div>
    </section>`;

function buildPage(page: Page): { html: string; images: string[] } {
  const doc = render(page);
  const description = page.description ?? plain(doc.lede);
  const toc = doc.sections
    .map((section) => `<li><a href="#${section.id}">${escape(section.text)}</a></li>`)
    .join("\n          ");
  const current = page.nav;
  const html = `${head(page, page.nav, description)}
<body>
  <a class="skip-link" href="#main">Skip to the content</a>

${HEADER}

  <main id="main">
${BAND(page, doc.title, page.description ? escape(page.description) : doc.lede)}

    <div class="docs-grid docs-body${page.slug ? "" : " docs-home"}">
      <details class="docs-menu">
        <summary><span class="docs-menu-label">Docs</span><b>${current}</b>${ICON_CHEVRON}</summary>
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

/** Every file the docs section needs, by path, with the contents it should have now. */
export function buildDocs(): Map<string, string | Buffer> {
  const files = new Map<string, string | Buffer>();
  for (const page of PAGES) {
    const { html, images } = buildPage(page);
    files.set(join(OUT, `${page.slug || "index"}.html`), html);
    for (const image of images) files.set(join("site/public", image), readFileSync(image));
  }
  return files;
}

if (import.meta.main) {
  rmSync(OUT, { recursive: true, force: true });
  const files = buildDocs();
  for (const [path, contents] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  console.log(`Wrote ${files.size} files to ${OUT}.`);
}

export const docsFiles = () =>
  readdirSync(OUT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
