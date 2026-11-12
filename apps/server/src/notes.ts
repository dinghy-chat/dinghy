import { z } from "@hono/zod-openapi";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { conversation, event, note } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { authorNames, nextSeq, wantsWebhook } from "./messages.ts";

export const NoteSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    // Its place among the messages: notes and messages share one sequence.
    seq: z.string(),
    authorKind: z.enum(["operator", "key"]),
    authorOperatorId: z.string().nullable(),
    authorApiKeyId: z.string().nullable(),
    // The operator's current name, or the key's name.
    authorName: z.string().nullable(),
    clientId: z.string(),
    body: z.string(),
    createdAt: z.string(),
  })
  .openapi("Note");
export type NoteView = z.infer<typeof NoteSchema>;

/** Who writes a note: an operator or a key. A visitor never sees or writes one. */
export type NoteAuthor =
  | { kind: "operator"; operatorId: string }
  | { kind: "key"; apiKeyId: string };

const noteColumns = {
  id: note.id,
  conversationId: note.conversationId,
  seq: note.seq,
  authorOperatorId: note.authorOperatorId,
  authorApiKeyId: note.authorApiKeyId,
  clientId: note.clientId,
  body: note.body,
  createdAt: note.createdAt,
};
type NoteRow = typeof note.$inferSelect;

function noteView(
  row: Pick<NoteRow, keyof typeof noteColumns>,
  names: Map<string, string>,
): NoteView {
  const author = row.authorOperatorId ?? row.authorApiKeyId ?? "";
  return {
    ...row,
    seq: row.seq.toString(),
    authorKind: row.authorOperatorId === null ? "key" : "operator",
    authorName: names.get(author) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Writes a note and its event, under the workspace row lock, so it sorts with the messages. A retry
 * with the same clientId returns the first. Null when the conversation does not exist.
 */
export async function appendNote(
  tx: Transaction,
  workspaceId: string,
  author: NoteAuthor,
  conversationId: string,
  input: { clientId: string; body: string },
): Promise<{ note: NoteView; created: boolean } | null> {
  const seq = await nextSeq(tx, workspaceId);
  const sender =
    author.kind === "operator"
      ? eq(note.authorOperatorId, author.operatorId)
      : eq(note.authorApiKeyId, author.apiKeyId);
  const [existing] = await tx
    .select(noteColumns)
    .from(note)
    .where(and(eq(note.workspaceId, workspaceId), sender, eq(note.clientId, input.clientId)));
  const named = async (row: Pick<NoteRow, keyof typeof noteColumns>) =>
    noteView(row, await authorNames(tx, workspaceId, [row]));
  if (existing !== undefined) return { note: await named(existing), created: false };
  const [target] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  if (target === undefined) return null;
  const [row] = await tx
    .insert(note)
    .values({
      workspaceId,
      conversationId,
      seq,
      clientId: input.clientId,
      body: input.body,
      ...(author.kind === "operator"
        ? { authorOperatorId: author.operatorId }
        : { authorApiKeyId: author.apiKeyId }),
    })
    .returning(noteColumns);
  if (row === undefined) throw new Error("The note insert returned no row");
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: "note.created",
    payload: { conversationId, noteId: row.id },
    needsWebhook: wantsWebhook(workspaceId),
  });
  return { note: await named(row), created: true };
}

/** A conversation's notes after a position and up to another, in order. */
export async function listNotes(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  after: bigint,
  upTo: bigint | null,
): Promise<NoteView[]> {
  const rows = await tx
    .select(noteColumns)
    .from(note)
    .where(
      and(
        eq(note.workspaceId, workspaceId),
        eq(note.conversationId, conversationId),
        gt(note.seq, after),
        upTo === null ? undefined : lte(note.seq, upTo),
      ),
    )
    .orderBy(asc(note.seq));
  const names = await authorNames(tx, workspaceId, rows);
  return rows.map((row) => noteView(row, names));
}

/** One note, for a webhook or a key's event. Null when it is gone. */
export async function findNote(
  tx: Transaction,
  workspaceId: string,
  noteId: string,
): Promise<NoteView | null> {
  const [row] = await tx
    .select(noteColumns)
    .from(note)
    .where(and(eq(note.workspaceId, workspaceId), eq(note.id, noteId)));
  if (row === undefined) return null;
  return noteView(row, await authorNames(tx, workspaceId, [row]));
}
