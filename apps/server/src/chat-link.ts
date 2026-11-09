import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { html, raw } from "hono/html";
import type { App } from "./app.ts";
import { chatLink, visitor, workspace } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace, workspaceAccess } from "./db/tenant.ts";
import { sha256Hex } from "./identity.ts";
import { limitByIp, type RateLimit } from "./rate-limit.ts";

// A token names its workspace, so a lookup needs no query across workspaces, and 32 random bytes
// make it unguessable. Only its hash is stored.
const PREFIX = "dcl_";
const TOKEN = /^dcl_([0-9a-f]{32})[A-Za-z0-9_-]{43}$/;
export const CHAT_LINK_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

// Every string a person reads has a key, so a locale can be added later.
const CHAT_PAGE_TEXT = {
  title: "Chat",
  expired: "This link has expired, or its conversation was deleted.",
  expiredHelp: "Go back to the site and open the chat to write again.",
  unavailable: "This chat is not available right now.",
  blocked: "You cannot send messages in this chat.",
  noScript: "This chat needs JavaScript.",
};

export const isChatLinkToken = (token: string) => token.startsWith(PREFIX);

const asUuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** The workspace a well-formed token names, or null. */
export function chatLinkWorkspace(token: string): string | null {
  const match = TOKEN.exec(token);
  return match?.[1] === undefined ? null : asUuid(match[1]);
}

/** Makes a link for one visitor's conversation, in the caller's workspace transaction. */
export async function createChatLink(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  conversationId: string,
  now = Date.now(),
): Promise<string> {
  const token = `${PREFIX}${workspaceId.replaceAll("-", "")}${randomBytes(32).toString("base64url")}`;
  await tx.insert(chatLink).values({
    workspaceId,
    tokenHash: sha256Hex(token),
    visitorId,
    conversationId,
    expiresAt: new Date(now + CHAT_LINK_DAYS * DAY_MS),
  });
  return token;
}

export const chatLinkUrl = (publicUrl: string, token: string) =>
  new URL(`/chat/${token}`, publicUrl).href;

/** The visitor a current link belongs to, or null for an unknown or expired one. */
export async function chatLinkVisitor(
  tx: Transaction,
  workspaceId: string,
  token: string,
): Promise<{ visitorId: string; blocked: boolean } | null> {
  const [row] = await tx
    .select({ visitorId: chatLink.visitorId, blockedAt: visitor.blockedAt })
    .from(chatLink)
    .innerJoin(
      visitor,
      and(eq(visitor.workspaceId, chatLink.workspaceId), eq(visitor.id, chatLink.visitorId)),
    )
    .where(
      and(
        eq(chatLink.workspaceId, workspaceId),
        eq(chatLink.tokenHash, sha256Hex(token)),
        gt(chatLink.expiresAt, sql`now()`),
      ),
    );
  return row === undefined ? null : { visitorId: row.visitorId, blocked: row.blockedAt !== null };
}

/** Deletes expired links across workspaces, for the worker. Returns how many went. */
export async function pruneChatLinks(db: Database, limit: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM chat_link WHERE (workspace_id, id) IN (
      SELECT workspace_id, id FROM chat_link WHERE expires_at < now() LIMIT ${limit})`);
  return result.rowCount ?? 0;
}

const SECURITY = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  "x-content-type-options": "nosniff",
};

const NOTICE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// The logo mark, drawn here as in the widget's loader: the server image does not ship packages/.
const LOGO =
  '<svg width="44" height="44" viewBox="0 0 52 52" aria-hidden="true"><path fill="#0b2239" d="M25 2h1.9v38H25zM3 39H49C47.5 45 42 49 36 49H16C10 49 4.5 45 3 39z"/><path fill="#e5352b" d="M28 6C37 14 43 25 45 36H28z"/><path fill="#ffc917" d="M24 12C18 20 12 28 8 36H24z"/></svg>';

/**
 * A plain page that says why the chat cannot open, in the style of the email stop page, with the
 * logo and the reason as its heading. The logo holds still: the page has nothing to wait for.
 */
const notice = (title: string, help?: string) =>
  html`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${CHAT_PAGE_TEXT.title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:#0b2239;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:440px;padding:28px;border-radius:14px;background:#fff;color:#0b2239}h1{margin:14px 0 0;font-size:20px;line-height:1.3;font-weight:650;text-wrap:balance}p{margin:8px 0 0;color:#5f6e80}svg{display:block}</style><main>${raw(LOGO)}<h1>${title}</h1>${help === undefined ? "" : html`<p>${help}</p>`}</main></html>`;

interface ChatPageOptions {
  db: Database;
  rateLimit: RateLimit;
  /** The separate origin for images, if the server has one, for the page's policy. */
  imagesOrigin: string | undefined;
}

/**
 * The page a reply email links to: the visitor's conversation, full page, in the widget's own chat.
 * It runs on this server's origin, and the widget API lets a chat link's token in from here only.
 */
export function registerChatPage(app: App, { db, rateLimit, imagesOrigin }: ChatPageOptions) {
  app.use("/chat/*", limitByIp(rateLimit, "chat-link", 30, 60));
  const images = imagesOrigin === undefined ? "" : ` ${imagesOrigin}`;
  const chatCsp = `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'${images}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

  app.get("/chat/:token", async (c) => {
    const token = c.req.param("token");
    const workspaceId = chatLinkWorkspace(token);
    const refuse = (status: 403 | 404, title: string, help?: string) =>
      c.html(notice(title, help), status, { ...SECURITY, "content-security-policy": NOTICE_CSP });
    if (workspaceId === null)
      return refuse(404, CHAT_PAGE_TEXT.expired, CHAT_PAGE_TEXT.expiredHelp);
    const found = await withWorkspace(db, workspaceId, async (tx) => {
      const link = await chatLinkVisitor(tx, workspaceId, token);
      if (link === null) return null;
      const access = await workspaceAccess(tx, workspaceId);
      const [space] = await tx
        .select({ publicKey: workspace.publicKey, title: workspace.widgetTitle })
        .from(workspace)
        .where(eq(workspace.id, workspaceId));
      return space === undefined ? null : { ...link, ...space, access };
    });
    if (found === null) return refuse(404, CHAT_PAGE_TEXT.expired, CHAT_PAGE_TEXT.expiredHelp);
    if (found.access !== "active") return refuse(403, CHAT_PAGE_TEXT.unavailable);
    if (found.blocked) return refuse(403, CHAT_PAGE_TEXT.blocked);
    return c.html(
      html`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${found.title ?? CHAT_PAGE_TEXT.title}</title><script src="/widget/page.js" data-key="${found.publicKey}" defer></script><script src="/widget/widget.js" defer></script><noscript>${CHAT_PAGE_TEXT.noScript}</noscript></html>`,
      200,
      { ...SECURITY, "content-security-policy": chatCsp },
    );
  });
}
