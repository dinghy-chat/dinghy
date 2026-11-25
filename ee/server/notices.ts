// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { CloudNotice, NoticeCloud } from "../../apps/server/src/cloud-notice.ts";
import { operator, workspace, workspaceMember } from "../../apps/server/src/db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { memberCount } from "./limits.ts";
import { elapsed, type Notice, type Notify } from "./telegram.ts";

interface NoticeOptions {
  db: Database;
  logger: Logger;
  notify: Notify;
  maxOperators: number;
}

async function workspaceOf(tx: Transaction, workspaceId: string) {
  const [found] = await tx
    .select({ name: workspace.name, createdAt: workspace.createdAt })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  return found;
}

/** The notice for a change in core, or none when its rows are gone. */
async function noticeFor(
  tx: Transaction,
  event: CloudNotice,
  maxOperators: number,
): Promise<Notice | undefined> {
  const { workspaceId } = event;
  const found = await workspaceOf(tx, workspaceId);
  if (found === undefined) return undefined;
  const named: [string, { name: string; id: string }] = [
    "Workspace",
    { name: found.name, id: workspaceId },
  ];
  if (event.kind === "widget_installed") {
    return {
      title: "Widget installed",
      fields: [
        named,
        ["Site", event.origin],
        ["Installed", `${elapsed(found.createdAt, new Date())} after signup`],
      ],
    };
  }
  const [joined] = await tx
    .select({ email: operator.email, role: workspaceMember.role })
    .from(workspaceMember)
    .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.operatorId, event.operatorId),
      ),
    );
  if (joined === undefined) return undefined;
  const operators = await memberCount(tx, workspaceId);
  return {
    title: "Operator joined",
    fields: [
      named,
      ["Operator", joined.email],
      ["Role", joined.role],
      ["Operators", `${operators} of ${maxOperators}`],
    ],
  };
}

/** Posts core's notices to the signups topic, after their commit and out of the request's way. */
export function createCloudNotice({
  db,
  logger,
  notify,
  maxOperators,
}: NoticeOptions): NoticeCloud {
  return (event) => {
    withWorkspace(db, event.workspaceId, (tx) => noticeFor(tx, event, maxOperators))
      .then((notice) => notice && notify("signups", notice))
      .catch((err: unknown) =>
        logger.warn({ err, kind: event.kind }, "a Telegram notice could not be made"),
      );
  };
}
