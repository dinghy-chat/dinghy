import type { Logger } from "pino";

/**
 * One audit line: a change to who can do what, or a sign-in that failed. It holds IDs and hashes
 * only, never an email, a token or a secret. Tests and log searches find these by `msg: "audit"`.
 */
export function audit(
  logger: Logger,
  event: string,
  fields: Record<string, unknown>,
  level: "info" | "warn" = "info",
): void {
  logger[level]({ event, ...fields }, "audit");
}
