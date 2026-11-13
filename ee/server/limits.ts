// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { and, count, eq, gt, isNull, sql, sum } from "drizzle-orm";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { attachment, invite, workspaceMember } from "../../apps/server/src/db/schema.ts";
import type { Transaction } from "../../apps/server/src/db/tenant.ts";
import type { Limits, StreamKind } from "../../apps/server/src/limits.ts";
import { createSlots } from "../../apps/server/src/rate-limit.ts";

/** The plan's limits, confirmed by the owner on 2026-11-07. */
export const MAX_OPERATORS = 5;
/**
 * Images and files, counted from the stored bytes after an image's re-encode, in decimal units like
 * the price page.
 */
const MAX_STORED_BYTES = 1_000_000_000;
/**
 * A CX23 held 20,000 open streams in about 1 GB (docs/measurements.md). A widget stream is open
 * only while a visitor's tab is visible with the chat open or a conversation going, so 2,000 at
 * once is far past a small team's traffic, and one workspace can take a tenth of a server at most.
 */
const MAX_WIDGET_STREAMS = 2000;
/** Five operators, each with up to ten visible tabs or devices. */
const MAX_OPERATOR_STREAMS = 50;

export interface LimitOptions {
  maxOperators?: number;
  maxStoredBytes?: number;
  maxStreams?: Record<StreamKind, number>;
}

/**
 * The same lock that message writes take, so an admission counts from data no other admission can
 * change until this transaction ends. A message write already holds it, and taking it again is free.
 */
async function lockWorkspace(tx: Transaction, workspaceId: string): Promise<void> {
  await tx.execute(sql`select 1 from workspace where id = ${workspaceId} for no key update`);
}

async function members(tx: Transaction, workspaceId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), isNull(workspaceMember.removedAt)));
  return row?.n ?? 0;
}

async function storedBytes(tx: Transaction, workspaceId: string): Promise<number> {
  const [row] = await tx
    .select({ bytes: sum(attachment.byteSize) })
    .from(attachment)
    .where(eq(attachment.workspaceId, workspaceId));
  return Number(row?.bytes ?? 0);
}

export function createLimits(
  valkey: Redis | null,
  logger: Logger,
  {
    maxOperators = MAX_OPERATORS,
    maxStoredBytes = MAX_STORED_BYTES,
    maxStreams = { widget: MAX_WIDGET_STREAMS, operator: MAX_OPERATOR_STREAMS },
  }: LimitOptions = {},
): Limits {
  const slots = createSlots(valkey, logger);
  return {
    // Members and the invites that could still become members, so a link the app hands out works.
    async mayInvite(tx, workspaceId) {
      await lockWorkspace(tx, workspaceId);
      const [pending] = await tx
        .select({ n: count() })
        .from(invite)
        .where(
          and(
            eq(invite.workspaceId, workspaceId),
            isNull(invite.usedAt),
            isNull(invite.revokedAt),
            gt(invite.expiresAt, sql`now()`),
          ),
        );
      return (await members(tx, workspaceId)) + (pending?.n ?? 0) < maxOperators;
    },
    // Members alone, with the new one: the invite it used was one of the pending ones. A join that
    // waited for the lock sees the members that the one before it committed.
    async operatorsFit(tx, workspaceId) {
      await lockWorkspace(tx, workspaceId);
      return (await members(tx, workspaceId)) <= maxOperators;
    },
    async mayStore(tx, workspaceId, bytes) {
      await lockWorkspace(tx, workspaceId);
      return (await storedBytes(tx, workspaceId)) + bytes <= maxStoredBytes;
    },
    // In Valkey, because a stream has no stored row, and it must not take the lock that message
    // writes need. During a Valkey outage it admits everything, as the rate limits do.
    openStream: (workspaceId, kind, leaseMs) =>
      slots.take(`dinghy:streams:${kind}:${workspaceId}`, maxStreams[kind], leaseMs),
    async usage(tx, workspaceId) {
      return {
        operators: { used: await members(tx, workspaceId), limit: maxOperators },
        imageBytes: { used: await storedBytes(tx, workspaceId), limit: maxStoredBytes },
      };
    },
  };
}
