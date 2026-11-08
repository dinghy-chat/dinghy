import type { Transaction } from "./db/tenant.ts";
import { failure } from "./errors.ts";

export type StreamKind = "widget" | "operator";

export interface Usage {
  operators: { used: number; limit: number };
  imageBytes: { used: number; limit: number };
}

/**
 * The plan's limits. Dinghy Cloud answers these from `ee/`. A self-hosted install has no limits, so
 * each answer is yes and costs nothing: see NO_LIMITS.
 */
export interface Limits {
  /** May the workspace hand out one more invite? Runs in the caller's workspace transaction. */
  mayInvite(tx: Transaction, workspaceId: string): Promise<boolean>;
  /**
   * Is the workspace within its operator limit, counting the member this transaction just added?
   * It runs after the member's row is written, so the lock order matches every other team change.
   */
  operatorsFit(tx: Transaction, workspaceId: string): Promise<boolean>;
  /** May the workspace store this many more image bytes? Runs in the transaction that stores them. */
  mayStore(tx: Transaction, workspaceId: string, bytes: number): Promise<boolean>;
  /**
   * Admits one open stream, which counts until `release` or until `leaseMs` passes. Null means the
   * workspace has as many as it may.
   */
  openStream(
    workspaceId: string,
    kind: StreamKind,
    leaseMs: number,
  ): Promise<{ release(): void } | null>;
  /** What Settings shows, or null with no limits. */
  usage(tx: Transaction, workspaceId: string): Promise<Usage | null>;
}

const yes = async () => true;

export const NO_LIMITS: Limits = {
  mayInvite: yes,
  operatorsFit: yes,
  mayStore: yes,
  openStream: async () => ({ release() {} }),
  usage: async () => null,
};

/** A member would take the workspace past its operator limit. The transaction rolls back. */
export class OperatorLimitError extends Error {
  constructor() {
    super("The workspace has as many operators as its plan allows.");
  }
}

/** An image would take the workspace past its storage limit. The transaction rolls back. */
export class StorageFullError extends Error {
  constructor() {
    super("The workspace has no room for this image.");
  }
}

/** The answers for a limit, as one place for the routes to share. */
export const OPERATOR_LIMIT = failure(
  "operator_limit",
  "This workspace has as many operators as its plan allows.",
);

export const STREAM_LIMIT = failure(
  "too_many_streams",
  "This workspace has too many open connections. Try again later.",
);

/** How long a refused stream waits before it tries again. */
export const STREAM_RETRY_SECONDS = 30;
