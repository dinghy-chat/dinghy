import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { conversation, visitor } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  INVALID,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { PageContextSchema, visitorPages } from "./journey.ts";
import { type Live, OPERATORS } from "./live.ts";
import { WORKSPACE_PREFIX as PREFIX } from "./member.ts";
import { containing, isChat } from "./messages.ts";
import { deleteConversation } from "./moderation.ts";
import type { VisitorPresence } from "./presence.ts";
import { allowed } from "./team.ts";

/** The attribute a host site signs for a person's company, which the list shows. */
const COMPANY_ATTRIBUTE = "company";
const PAGE_SIZE_MAX = 100;
/** Rows read for each part of a CSV export, so a large export never holds them all at once. */
const EXPORT_BATCH = 500;
const NOTE_MAX = 5000;

const SIGNED_IN = failure("signed_in", "The host site sets this person's name and email.");

const workspaceParams = z.object({ workspaceId: z.uuid() });
const contactParams = workspaceParams.extend({ visitorId: z.uuid() });

const ContactSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    externalId: z.string().nullable(),
    // The host site signed who this is, so the name and email are read-only here.
    signedIn: z.boolean(),
    // The signed `company` attribute, when it is text.
    company: z.string().nullable(),
    // ISO 3166-1 alpha-2, from the widget's last beat.
    country: z.string().nullable(),
    // IANA, from the browser's last beat.
    timeZone: z.string().nullable(),
    device: z.string().nullable(),
    lastPage: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    // When the visitor first came: the first seen.
    createdAt: z.string(),
    conversationCount: z.number().int(),
    blocked: z.boolean(),
  })
  .openapi("Contact");

const ContactDetailSchema = ContactSchema.extend({
  // A widget stream of the visitor's is open now. Null when the server cannot tell.
  online: z.boolean().nullable(),
  attributes: z.record(z.string(), z.unknown()).nullable(),
  pageContext: PageContextSchema.nullable(),
  // Private to the team.
  note: z.string().nullable(),
  conversations: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["open", "closed"]),
      createdAt: z.string(),
      updatedAt: z.string(),
      // The newest message's text, or null for an image.
      lastBody: z.string().nullable(),
      // Messages people wrote, not counting deleted ones.
      messageCount: z.number().int(),
      assigneeName: z.string().nullable(),
      // The member or API key that wrote the newest close. Null while open, or when the visitor
      // closed it.
      closedBy: z.string().nullable(),
      // From the start to the first reply from a member or an API key. Null with no reply.
      firstReplySeconds: z.number().int().nullable(),
    }),
  ),
  // The newest pages, newest first, at most 20.
  pages: z.array(
    z.object({ path: z.string(), title: z.string().nullable(), viewedAt: z.string() }),
  ),
}).openapi("ContactDetail");

const SORTS = ["lastSeen", "firstSeen"] as const;
type Sort = (typeof SORTS)[number];

// A page's position: the sort key's time, as CURSOR_TIME_FORMAT writes it, and the visitor's ID.
const CURSOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z,[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** The pattern lets through a day that does not exist, such as February 30, which Postgres refuses. */
function isRealTime(cursor: string): boolean {
  const second = cursor.slice(0, "YYYY-MM-DDTHH:MM:SS".length);
  const time = new Date(`${second}Z`);
  return !Number.isNaN(time.getTime()) && time.toISOString().startsWith(second);
}

const listRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/contacts`,
  security: SESSION,
  summary: "List the people who have a conversation, newest first",
  request: {
    params: workspaceParams,
    query: z.object({
      q: z.string().trim().max(100).optional().openapi({
        description: "Matches the name, email or user ID, ignoring case.",
      }),
      sort: z.enum(SORTS).default("lastSeen"),
      before: z.string().regex(CURSOR).refine(isRealTime).optional().openapi({
        description: "The `next` of the page before.",
      }),
      limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(50),
    }),
  },
  responses: {
    200: {
      description: "A page of contacts",
      content: {
        "application/json": {
          schema: z.object({ contacts: z.array(ContactSchema), next: z.string().nullable() }),
        },
      },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

const exportRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/contacts/export`,
  security: SESSION,
  summary: "Download every contact who has a conversation, as CSV",
  request: { params: workspaceParams },
  responses: {
    200: { description: "The CSV file", content: { "text/csv": { schema: z.string() } } },
    ...MEMBER_ERRORS,
  },
});

const readRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/contacts/{visitorId}`,
  security: SESSION,
  summary: "Get one contact with their conversations, pages and note",
  request: { params: contactParams },
  responses: {
    200: {
      description: "The contact",
      content: { "application/json": { schema: ContactDetailSchema } },
    },
    ...MEMBER_ERRORS,
  },
});

/** One line, as a name is everywhere else. */
const oneLine = z
  .string()
  .trim()
  .max(100)
  .regex(/^[^\p{Cc}]*$/u);

const changeRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/{workspaceId}/contacts/{visitorId}`,
  security: SESSION,
  summary: "Change a contact's note, or a signed-out contact's name and email",
  request: {
    params: contactParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            note: z
              .string()
              .max(NOTE_MAX)
              .regex(/^[^\0]*$/)
              .nullable()
              .optional(),
            name: oneLine.nullable().optional(),
            email: z.email().max(320).nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The contact after the change",
      content: { "application/json": { schema: ContactDetailSchema } },
    },
    ...MEMBER_WRITE_ERRORS,
    409: errorAnswer("signed_in: the host site sets this person's name and email"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: `${PREFIX}/{workspaceId}/contacts/{visitorId}`,
  security: SESSION,
  summary: "Delete a contact with all their conversations, messages and images",
  request: { params: contactParams },
  responses: { 200: { description: "Deleted", content: okContent }, ...ROLE_WRITE_ERRORS },
});

const contactColumns = {
  id: visitor.id,
  name: visitor.name,
  email: visitor.email,
  externalId: visitor.externalId,
  company: sql<string | null>`"visitor"."attributes"->>${COMPANY_ATTRIBUTE}`,
  country: visitor.country,
  timeZone: visitor.timeZone,
  device: visitor.device,
  lastPage: visitor.lastPage,
  lastSeenAt: visitor.lastSeenAt,
  createdAt: visitor.createdAt,
  blockedAt: visitor.blockedAt,
  // Qualified by hand: in a select list, the builder writes a column without its table.
  conversationCount: sql<number>`(
    select count(*)::int from conversation as c
    where c.workspace_id = "visitor"."workspace_id" and c.visitor_id = "visitor"."id")`,
};

interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  company: string | null;
  country: string | null;
  timeZone: string | null;
  device: string | null;
  lastPage: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  blockedAt: Date | null;
  conversationCount: number;
}

const contactView = ({ blockedAt, lastSeenAt, createdAt, ...row }: ContactRow) => ({
  ...row,
  signedIn: row.externalId !== null,
  blocked: blockedAt !== null,
  lastSeenAt: lastSeenAt?.toISOString() ?? null,
  createdAt: createdAt.toISOString(),
});

// An ISO time in UTC to the microsecond, as the cursor carries it.
const CURSOR_TIME_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** The sort key, which an index of each sort holds in this exact form. */
const sortKey = (sort: Sort) =>
  sort === "lastSeen"
    ? sql`coalesce(${visitor.lastSeenAt}, ${visitor.createdAt})`
    : sql`${visitor.createdAt}`;

/**
 * A page of contacts, newest first by the sort, in one statement: a bounded scan of the sort's
 * index, with one probe of the conversation index per visitor for its count.
 */
async function listContacts(
  tx: Transaction,
  workspaceId: string,
  options: { q?: string | undefined; sort: Sort; before?: string | undefined; limit: number },
) {
  const key = sortKey(options.sort);
  const [time, id] = options.before?.split(",") ?? [];
  const pattern = options.q === undefined || options.q === "" ? null : containing(options.q);
  const rows = await tx
    .select({
      ...contactColumns,
      // As text, because Postgres keeps microseconds and a JavaScript date only milliseconds, so
      // a cursor from a date would skip the rows that share its millisecond.
      sortedAt: sql<string>`to_char(${key} at time zone 'UTC', ${CURSOR_TIME_FORMAT})`,
    })
    .from(visitor)
    .where(
      and(
        eq(visitor.workspaceId, workspaceId),
        // A bot's test visitors are not people.
        eq(visitor.isTest, false),
        sql`exists (select 1 from ${conversation} where ${conversation.workspaceId} = ${visitor.workspaceId} and ${conversation.visitorId} = ${visitor.id})`,
        pattern === null
          ? undefined
          : sql`(${visitor.name} ilike ${pattern} or ${visitor.email} ilike ${pattern} or ${visitor.externalId} ilike ${pattern})`,
        time === undefined
          ? undefined
          : sql`(${key}, ${visitor.id}) < (${time}::timestamptz, ${id}::uuid)`,
      ),
    )
    .orderBy(desc(key), desc(visitor.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    contacts: page.map(({ sortedAt: _, ...row }) => contactView(row)),
    next: rows.length > options.limit && last !== undefined ? `${last.sortedAt},${last.id}` : null,
  };
}

// An ISO time in UTC to the millisecond, as a JSON date writes it. A raw statement reads a time as
// Postgres's own text.
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

type ConversationRow = {
  id: string;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  lastBody: string | null;
  messageCount: number;
  assigneeName: string | null;
  closedBy: string | null;
  firstReplySeconds: number | null;
};

/**
 * A contact's conversations, newest activity first, each with its preview and numbers, in one
 * statement: each lateral reads one conversation's run of the message index.
 */
const contactConversations = (tx: Transaction, workspaceId: string, visitorId: string) =>
  tx.execute<ConversationRow>(sql`
    SELECT c.id, c.status,
           to_char(c.created_at AT TIME ZONE 'UTC', ${ISO_FORMAT}) AS "createdAt",
           to_char(c.updated_at AT TIME ZONE 'UTC', ${ISO_FORMAT}) AS "updatedAt",
           newest.body AS "lastBody", stats.message_count AS "messageCount",
           assignee.name AS "assigneeName", closer.name AS "closedBy",
           extract(epoch FROM stats.first_reply_at - c.created_at)::int AS "firstReplySeconds"
    FROM conversation AS c
    LEFT JOIN operator AS assignee ON assignee.id = c.assignee_operator_id
    LEFT JOIN LATERAL (
      SELECT m.body FROM message AS m
      WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id
        AND ${isChat(sql`m.kind`)} AND m.deleted_at IS NULL
      ORDER BY m.seq DESC LIMIT 1
    ) AS newest ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE m.deleted_at IS NULL)::int AS message_count,
             min(m.created_at) FILTER (WHERE m.author_visitor_id IS NULL) AS first_reply_at
      FROM message AS m
      WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id
        AND ${isChat(sql`m.kind`)}
    ) AS stats ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(o.name, k.name) AS name FROM message AS m
      LEFT JOIN operator AS o ON o.id = m.author_operator_id
      LEFT JOIN api_key AS k ON k.workspace_id = m.workspace_id AND k.id = m.author_api_key_id
      WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND m.kind = 'closed'
      ORDER BY m.seq DESC LIMIT 1
    ) AS closer ON c.status = 'closed'
    WHERE c.workspace_id = ${workspaceId} AND c.visitor_id = ${visitorId}
    ORDER BY c.updated_at DESC`);

/** One contact with everything the contact page shows, or null. */
async function readContact(tx: Transaction, workspaceId: string, visitorId: string) {
  const [row] = await tx
    .select({
      ...contactColumns,
      attributes: visitor.attributes,
      pageContext: visitor.pageContext,
      note: visitor.note,
    })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  if (row === undefined) return null;
  const conversations = await contactConversations(tx, workspaceId, visitorId);
  const pages = await visitorPages(tx, workspaceId, visitorId);
  const { attributes, pageContext, note, ...contact } = row;
  return {
    ...contactView(contact),
    attributes: (attributes as Record<string, unknown> | null) ?? null,
    pageContext: PageContextSchema.nullable().catch(null).parse(pageContext),
    note,
    conversations: conversations.rows,
    pages: pages.map((page) => ({ ...page, viewedAt: page.viewedAt.toISOString() })),
  };
}

const CSV_COLUMNS = [
  "name",
  "email",
  "user_id",
  "company",
  "country",
  "time_zone",
  "device",
  "last_page",
  "last_seen",
  "first_seen",
  "conversations",
] as const;

/**
 * One CSV cell. A cell that a spreadsheet would read as a formula starts with a quote mark, so a
 * visitor's name cannot run in the team's spreadsheet.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const csvLine = (contact: ReturnType<typeof contactView>) =>
  `${[
    contact.name,
    contact.email,
    contact.externalId,
    contact.company,
    contact.country,
    contact.timeZone,
    contact.device,
    contact.lastPage,
    contact.lastSeenAt,
    contact.createdAt,
    contact.conversationCount,
  ]
    .map(csvCell)
    .join(",")}\r\n`;

/** Deletes a visitor with their conversations, messages and images. False when there is none. */
export async function deleteContact(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
): Promise<boolean> {
  const conversations = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.visitorId, visitorId)));
  for (const one of conversations) await deleteConversation(tx, workspaceId, one.id, visitorId);
  const deleted = await tx
    .delete(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)))
    .returning({ id: visitor.id });
  return deleted.length > 0;
}

export function registerContactRoutes(
  app: App,
  { db, live, visitorPresence }: { db: Database; live: Live; visitorPresence: VisitorPresence },
): void {
  /** The contact with whether they are on the site now, which Valkey knows, not Postgres. */
  const withPresence = async (
    workspaceId: string,
    found: NonNullable<Awaited<ReturnType<typeof readContact>>>,
  ) => ({ ...found, online: await visitorPresence.online(workspaceId, found.id) });

  app.openapi(listRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const options = c.req.valid("query");
    return c.json(await withWorkspace(db, id, (tx) => listContacts(tx, id, options)), 200);
  });

  app.openapi(exportRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const encoder = new TextEncoder();
    let before: string | undefined;
    let started = false;
    // A page at a time, each in its own short transaction, so a large export holds no connection
    // between pages.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(encoder.encode(`${CSV_COLUMNS.join(",")}\r\n`));
        }
        const page = await withWorkspace(db, id, (tx) =>
          listContacts(tx, id, { q: undefined, sort: "firstSeen", before, limit: EXPORT_BATCH }),
        );
        controller.enqueue(encoder.encode(page.contacts.map(csvLine).join("")));
        if (page.next === null) controller.close();
        else before = page.next;
      },
    });
    return c.body(body, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="contacts.csv"',
    });
  });

  app.openapi(readRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { visitorId } = c.req.valid("param");
    const found = await withWorkspace(db, id, (tx) => readContact(tx, id, visitorId));
    if (found === null) return c.json(NOT_FOUND, 404);
    return c.json(await withPresence(id, found), 200);
  });

  app.openapi(changeRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { visitorId } = c.req.valid("param");
    const { note, name, email } = c.req.valid("json");
    const result = await withWorkspace(db, id, async (tx) => {
      const [row] = await tx
        .select({ externalId: visitor.externalId })
        .from(visitor)
        .where(and(eq(visitor.workspaceId, id), eq(visitor.id, visitorId)));
      if (row === undefined) return "missing" as const;
      const identity = name !== undefined || email !== undefined;
      if (identity && row.externalId !== null) return "signed_in" as const;
      const change = {
        ...(note !== undefined && { note: note?.trim() === "" ? null : note }),
        ...(name !== undefined && { name: name === "" ? null : name }),
        ...(email !== undefined && { email }),
      };
      if (Object.keys(change).length > 0) {
        await tx
          .update(visitor)
          .set(change)
          .where(and(eq(visitor.workspaceId, id), eq(visitor.id, visitorId)));
      }
      return readContact(tx, id, visitorId);
    });
    if (result === "missing" || result === null) return c.json(NOT_FOUND, 404);
    if (result === "signed_in") return c.json(SIGNED_IN, 409);
    return c.json(await withPresence(id, result), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { visitorId } = c.req.valid("param");
    const found = await withWorkspace(db, id, (tx) => deleteContact(tx, id, visitorId));
    if (!found) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    // Their open chats end: the token now names nobody.
    live.revoke(id, visitorId);
    return c.json({ ok: true as const }, 200);
  });
}
