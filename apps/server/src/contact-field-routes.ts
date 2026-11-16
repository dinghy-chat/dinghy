import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { contactEvent, visitor } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { jsonAnswer, KEY_LIMITED, MEMBER_ERRORS } from "./errors.ts";
import { WORKSPACE_PREFIX, workspaceParams } from "./member.ts";

// The attribute keys and event names that contacts have, for the Contacts page and the campaign
// editor's suggestions. They come from the contacts seen last, so the read stays small in a
// workspace of any size.

/** How many of the contacts seen last the names come from, and the most names of each kind. */
const RECENT_CONTACTS = 1000;
const NAMES_MAX = 200;

const Named = {
  name: z.string(),
  contacts: z.number().int().openapi({ description: "How many of those contacts have it" }),
};

const ContactFieldsSchema = z
  .object({
    attributes: z.array(
      z.object({
        ...Named,
        lastSeenAt: z.string().openapi({ description: "When one of them was last seen" }),
      }),
    ),
    events: z.array(
      z.object({
        ...Named,
        lastAt: z.string().openapi({ description: "When one of them last did it" }),
      }),
    ),
  })
  .openapi("ContactFields");

const fieldsRoute = createRoute({
  method: "get",
  path: `${WORKSPACE_PREFIX}/{workspaceId}/contact-fields`,
  security: SESSION_OR_KEY,
  summary: "The attribute keys and event names of the contacts seen last",
  description: `It reads the ${RECENT_CONTACTS.toLocaleString("en")} contacts seen last, and leaves out test visitors. Each list is A to Z, with at most ${NAMES_MAX} names.`,
  request: { params: workspaceParams },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer("The attributes and events", ContactFieldsSchema),
    ...MEMBER_ERRORS,
  },
});

type Row = {
  kind: "attribute" | "event";
  name: string;
  contacts: number;
  at: Date | string;
};

async function contactFields(db: Database, workspaceId: string) {
  const result = await withWorkspace(db, workspaceId, (tx) =>
    tx.execute<Row>(sql`
      with recent as (
        select ${visitor.id} as id, ${visitor.attributes} as attributes,
          coalesce(${visitor.lastSeenAt}, ${visitor.createdAt}) as seen
        from ${visitor}
        where ${visitor.workspaceId} = ${workspaceId} and not ${visitor.isTest}
        order by coalesce(${visitor.lastSeenAt}, ${visitor.createdAt}) desc
        limit ${RECENT_CONTACTS}
      )
      (select 'attribute' as kind, key as name, count(*)::int as contacts, max(seen) as at
        from recent, jsonb_object_keys(
          case when jsonb_typeof(attributes) = 'object' then attributes else '{}' end
        ) as key
        group by key order by key limit ${NAMES_MAX})
      union all
      (select 'event', e.name, count(*)::int, max(e.last_at)
        from ${contactEvent} as e join recent
          on e.workspace_id = ${workspaceId} and e.visitor_id = recent.id
        group by e.name order by e.name limit ${NAMES_MAX})`),
  );
  const at = (row: Row) => new Date(row.at).toISOString();
  return {
    attributes: result.rows
      .filter((row) => row.kind === "attribute")
      .map((row) => ({ name: row.name, contacts: row.contacts, lastSeenAt: at(row) })),
    events: result.rows
      .filter((row) => row.kind === "event")
      .map((row) => ({ name: row.name, contacts: row.contacts, lastAt: at(row) })),
  };
}

export function registerContactFieldRoutes(app: App, { db }: { db: Database }): void {
  app.openapi(fieldsRoute, async (c) =>
    c.json(await contactFields(db, c.get("memberWorkspaceId")), 200),
  );
}
