import type { BulkAction, BulkResult } from "./api.ts";
import type { TextId } from "./text.ts";

/** What a toast says once each action is done, for one conversation and for more. */
const DONE_TEXT: Record<BulkAction["action"], [TextId, TextId]> = {
  close: ["bulkClosedOne", "bulkClosedMany"],
  assign: ["bulkAssignedOne", "bulkAssignedMany"],
  label: ["bulkLabeledOne", "bulkLabeledMany"],
  mark_read: ["bulkReadOne", "bulkReadMany"],
  delete: ["bulkDeletedOne", "bulkDeletedMany"],
};

/**
 * What the toast says after an action: how many changed, how many were as asked already, how many
 * were skipped, and the failure that stopped it partway, if one did.
 */
export function bulkToast(
  results: BulkResult[],
  action: BulkAction["action"],
  failure: TextId | null,
): { sentences: TextId[]; ok: boolean; values: Record<string, number> } {
  const count = (...kinds: BulkResult[]) => results.filter((one) => kinds.includes(one)).length;
  const done = count("ok");
  const unchanged = count("unchanged");
  const skipped = count("not_found");
  const [doneOne, doneMany] = DONE_TEXT[action];
  const sentences: TextId[] = [];
  if (done > 0) sentences.push(done === 1 ? doneOne : doneMany);
  if (unchanged > 0) sentences.push(unchanged === 1 ? "bulkUnchangedOne" : "bulkUnchangedMany");
  if (skipped > 0) sentences.push(skipped === 1 ? "bulkSkippedOne" : "bulkSkippedMany");
  if (failure !== null && results.length > 0) sentences.push("bulkRestFailed");
  if (failure !== null) sentences.push(failure);
  return { sentences, ok: skipped === 0 && failure === null, values: { done, unchanged, skipped } };
}
