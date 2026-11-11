// Licensed under the Dinghy Enterprise License. See ee/LICENSE.

/**
 * What a cloud workspace's billing is in, as the server works it out and the app shows it. A leaf
 * module, so the server and the browser both import it.
 */
export const BILLING_STATES = [
  "pending",
  "free",
  "active",
  "ending",
  "payment_failed",
  "read_only",
] as const;

export type BillingStateName = (typeof BILLING_STATES)[number];
