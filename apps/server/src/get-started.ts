import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { workspaceMember } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { MEMBER_ERRORS, MEMBER_WRITE_ERRORS, okContent } from "./errors.ts";
import { OPEN_WHILE_CLOSED, WORKSPACE_PREFIX as PREFIX } from "./member.ts";

const workspaceParams = z.object({ workspaceId: z.uuid() });

const GetStartedSchema = z
  .object({
    // An allowed site loaded the widget.
    install: z.boolean(),
    logo: z.boolean(),
    // The widget's settings were saved once.
    widget: z.boolean(),
    // A second member, or an invite that can still be used.
    team: z.boolean(),
    // Browser notifications on a device of this operator's, or email alerts here.
    notifications: z.boolean(),
    // A conversation, other than the cloud's welcome chat.
    chat: z.boolean(),
    // This member hid the steps.
    dismissed: z.boolean(),
  })
  .openapi("GetStarted");

const readRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/get-started`,
  security: SESSION,
  summary: "Read which first steps are done, for the signed-in member",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "Each step",
      content: { "application/json": { schema: GetStartedSchema } },
    },
    ...MEMBER_ERRORS,
  },
});

const dismissRoute = createRoute({
  method: "post",
  ...OPEN_WHILE_CLOSED,
  path: `${PREFIX}/{workspaceId}/get-started/dismiss`,
  security: SESSION,
  summary: "Hide the first steps for the signed-in member, on every device",
  request: { params: workspaceParams },
  responses: { 200: { description: "Hidden", content: okContent }, ...MEMBER_WRITE_ERRORS },
});

export function registerGetStartedRoutes(app: App, db: Database): void {
  app.openapi(readRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const operatorId = c.get("operatorId");
    // One statement, of short index reads.
    const result = await withWorkspace(db, id, (tx) =>
      tx.execute<z.infer<typeof GetStartedSchema>>(sql`
        select
          coalesce((select widget_seen_at is not null from workspace where id = ${id}), false)
            as install,
          coalesce((select logo_updated_at is not null from widget_settings
            where workspace_id = ${id}), false) as logo,
          coalesce((select customized_at is not null from widget_settings
            where workspace_id = ${id}), false) as widget,
          ((select count(*) from workspace_member
            where workspace_id = ${id} and removed_at is null) > 1
           or exists (select 1 from invite
             where workspace_id = ${id} and used_at is null and revoked_at is null
               and expires_at > now())) as team,
          (exists (select 1 from push_subscription where operator_id = ${operatorId})
           or coalesce((select alert_email from workspace_member
             where workspace_id = ${id} and operator_id = ${operatorId}), false)) as notifications,
          exists (select 1 from conversation where workspace_id = ${id} and not welcome) as chat,
          coalesce((select get_started_dismissed_at is not null from workspace_member
            where workspace_id = ${id} and operator_id = ${operatorId}), false) as dismissed`),
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("The steps query returned no row");
    return c.json(row, 200);
  });

  app.openapi(dismissRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    await withWorkspace(db, id, (tx) =>
      tx
        .update(workspaceMember)
        .set({
          getStartedDismissedAt: sql`coalesce(${workspaceMember.getStartedDismissedAt}, now())`,
        })
        .where(
          and(
            eq(workspaceMember.workspaceId, id),
            eq(workspaceMember.operatorId, c.get("operatorId")),
          ),
        ),
    );
    return c.json({ ok: true as const }, 200);
  });
}
