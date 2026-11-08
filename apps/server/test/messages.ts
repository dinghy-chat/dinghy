import { type Database, withWorkspace } from "../src/db/tenant.ts";
import { appendMessage, type StoredMessage } from "../src/messages.ts";

/** Writes an operator reply through the normal transaction, until the operator app exists. */
export async function sendOperatorMessage(
  db: Database,
  workspaceId: string,
  operatorId: string,
  conversationId: string,
  body: string,
  clientId = `reply-${crypto.randomUUID()}`,
): Promise<StoredMessage> {
  const result = await withWorkspace(db, workspaceId, (tx) =>
    appendMessage(
      tx,
      workspaceId,
      { kind: "operator", operatorId, conversationId },
      {
        clientId,
        body,
      },
    ),
  );
  return result.message;
}
