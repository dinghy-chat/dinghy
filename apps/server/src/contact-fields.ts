import { and, eq } from "drizzle-orm";
import { type FieldTimes, visitor } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import type { ContactFields } from "./inputs.ts";

// The fields a server or a host token writes on a contact. Each write carries its time, and the
// later write wins for each field and each attribute.

/** A contact's fields that a server or a host token writes, with when each was written. */
interface ContactState {
  name: string | null;
  email: string | null;
  attributes: unknown;
  fieldTimes: FieldTimes;
}

type ContactChange = Pick<ContactState, "name" | "email" | "fieldTimes"> & {
  attributes: Record<string, unknown> | null;
};

const ATTRIBUTE_TIME = "attributes.";

/**
 * A write at `at`, in milliseconds, applied to the contact: each field and each attribute changes
 * only when no later write set it. A null attribute removes the key. Null when nothing changes.
 */
function mergeContact(
  current: ContactState,
  fields: ContactFields,
  at: number,
): ContactChange | null {
  const times = { ...current.fieldTimes };
  const attributes = { ...((current.attributes as Record<string, unknown> | null) ?? {}) };
  const next = { name: current.name, email: current.email };
  let changed = false;
  /** Writes one field when this write is not older than the last one, and says whether it did. */
  const take = (field: string, value: unknown, previous: unknown) => {
    const time = times[field] ?? Number.NEGATIVE_INFINITY;
    if (at < time || (at === time && value === previous)) return false;
    times[field] = at;
    changed = true;
    return true;
  };
  if (fields.name !== undefined && take("name", fields.name, current.name)) next.name = fields.name;
  if (fields.email !== undefined && take("email", fields.email, current.email)) {
    next.email = fields.email;
  }
  for (const [key, value] of Object.entries(fields.attributes ?? {})) {
    const before = attributes[key];
    if (!take(`${ATTRIBUTE_TIME}${key}`, JSON.stringify(value), JSON.stringify(before))) continue;
    if (value === null) delete attributes[key];
    else attributes[key] = value;
  }
  if (!changed) return null;
  const kept = Object.keys(attributes).length > 0 ? attributes : null;
  return { ...next, attributes: kept, fieldTimes: times };
}

const contactState = {
  name: visitor.name,
  email: visitor.email,
  attributes: visitor.attributes,
  fieldTimes: visitor.fieldTimes,
};

/** The fields whose value differs, as conditions name them: `name`, `email`, `attributes.<key>`. */
function changedFields(before: ContactState, after: ContactChange): string[] {
  const asRecord = (value: unknown) => (value ?? {}) as Record<string, unknown>;
  const [old, now] = [asRecord(before.attributes), asRecord(after.attributes)];
  const keys = new Set([...Object.keys(old), ...Object.keys(now)]);
  return [
    ...(before.name === after.name ? [] : ["name", "firstName"]),
    ...(before.email === after.email ? [] : ["email"]),
    ...[...keys]
      .filter((key) => JSON.stringify(old[key]) !== JSON.stringify(now[key]))
      .map((key) => `${ATTRIBUTE_TIME}${key}`),
  ];
}

/**
 * Writes a server's or a host token's fields at `at`, in milliseconds. A read with no lock comes
 * first, so a write that changes nothing, such as the same host token on every request, takes no
 * lock. Answers the fields whose value changed.
 */
async function writeContact(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  fields: ContactFields,
  at: number,
): Promise<string[]> {
  const one = and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId));
  const [seen] = await tx.select(contactState).from(visitor).where(one);
  if (seen === undefined || mergeContact(seen, fields, at) === null) return [];
  const [current] = await tx.select(contactState).from(visitor).where(one).for("no key update");
  const change = current === undefined ? null : mergeContact(current, fields, at);
  if (current === undefined || change === null) return [];
  await tx.update(visitor).set(change).where(one);
  return changedFields(current, change);
}

/**
 * Creates the signed-in contact with this user ID, or writes to the one that exists. `changed` lists
 * the fields whose value changed, for the checks that read the contact.
 */
export async function upsertContact(
  tx: Transaction,
  workspaceId: string,
  userId: string,
  fields: ContactFields,
  at: number,
): Promise<{ visitorId: string; created: boolean; changed: string[] }> {
  const ofUser = and(eq(visitor.workspaceId, workspaceId), eq(visitor.userId, userId));
  let [existing] = await tx.select({ id: visitor.id }).from(visitor).where(ofUser);
  if (existing === undefined) {
    const empty = { name: null, email: null, attributes: null, fieldTimes: {} };
    const [created] = await tx
      .insert(visitor)
      .values({ workspaceId, userId, ...(mergeContact(empty, fields, at) ?? empty) })
      .onConflictDoNothing()
      .returning({ id: visitor.id });
    if (created !== undefined) return { visitorId: created.id, created: true, changed: [] };
    // Two first requests arrived together, and the other one created the row.
    [existing] = await tx.select({ id: visitor.id }).from(visitor).where(ofUser);
    if (existing === undefined) throw new Error("The visitor row is missing");
  }
  const changed = await writeContact(tx, workspaceId, existing.id, fields, at);
  return { visitorId: existing.id, created: false, changed };
}
