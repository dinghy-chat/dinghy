import { and, eq, gt, inArray } from "drizzle-orm";
import { verification } from "./db/schema.ts";
import type { Database, Transaction } from "./db/tenant.ts";
import { emailAddressHash, nativeEmailCodeIdentifier } from "./identity.ts";
import { MINUTE_MS } from "./time.ts";

/**
 * After the app review account's delete, sign-in answers as for an unknown email for this long,
 * so the reviewer sees the delete work. The account then signs in again for the next review.
 */
const REVIEW_DELETED_MINUTES = 10;
// Keyed by the email, so a new review account set during the window is not refused.
const reviewDeleted = (email: string) => `app-review-deleted:${emailAddressHash(email)}`;

/** Starts the review account's deleted time, and drops any code it has. Run it in the delete. */
export async function markReviewDeleted(tx: Transaction, email: string): Promise<void> {
  await tx
    .delete(verification)
    .where(
      inArray(verification.identifier, [reviewDeleted(email), nativeEmailCodeIdentifier(email)]),
    );
  await tx.insert(verification).values({
    identifier: reviewDeleted(email),
    value: "",
    expiresAt: new Date(Date.now() + REVIEW_DELETED_MINUTES * MINUTE_MS),
  });
}

/** True while the review account's deleted time runs. */
export async function reviewLooksDeleted(db: Database, email: string): Promise<boolean> {
  const [found] = await db
    .select({ id: verification.id })
    .from(verification)
    .where(
      and(
        eq(verification.identifier, reviewDeleted(email)),
        gt(verification.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return found !== undefined;
}
