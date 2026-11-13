import { z } from "@hono/zod-openapi";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { DatabaseError } from "pg";

/**
 * An error that names only the SQLSTATE code and keeps the stack's frames, so an error report can
 * group and place it. The original message is left out, because Drizzle puts the parameters there.
 */
function databaseErrorWithStack(error: unknown, code: string | undefined): Error {
  const safe = new Error(`A database query failed with code ${code ?? "unknown"}.`);
  safe.name = "DatabaseError";
  // The frames come after the message, which holds the parameters and can span many lines.
  const head = error instanceof Error ? `${error.name}: ${error.message}` : "";
  const frames =
    error instanceof Error && error.stack?.startsWith(head)
      ? error.stack
          .slice(head.length)
          .split("\n")
          .filter((line) => line.startsWith("    at "))
      : [];
  safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join("\n");
  return safe;
}

/**
 * What a log may hold about an error. A database error holds the query's parameters and the row's
 * values, which can be chat text and tokens, so it logs only what identifies the failure. It walks
 * the whole chain, because a library can wrap the query's error in its own, and a logger prints
 * every cause.
 */
export function safeErrorFields(error: unknown): Record<string, unknown> {
  const chain: unknown[] = [];
  for (
    let current = error;
    typeof current === "object" && current !== null && !chain.includes(current);
    current = "cause" in current ? current.cause : undefined
  ) {
    chain.push(current);
  }
  const database = chain.find(
    (item): item is DatabaseError =>
      typeof item === "object" && item !== null && "severity" in item,
  );
  if (database !== undefined) {
    const { code, constraint, table, routine } = database;
    return {
      err: databaseErrorWithStack(error, code),
      databaseError: { code, constraint, table, routine },
    };
  }
  const wrapper = chain.findIndex((item) => item instanceof DrizzleQueryError);
  // Only Drizzle's wrapper holds the parameters, so what it wraps is safe to log.
  if (wrapper !== -1) return { err: chain[wrapper + 1] ?? { message: "A query failed." } };
  return { err: error };
}

/**
 * Every code an error answer can carry. Clients branch on these, so the OpenAPI document lists
 * them, and a new one goes here first.
 */
export const ERROR_CODES = [
  "already_active",
  "already_member",
  "bad_endpoint",
  "bad_origin",
  "bad_signature",
  "billing_unavailable",
  "blocked",
  "bots_paused",
  "busy",
  "check_unavailable",
  "checkout_retry_later",
  "conversation_closed",
  "drafts_text_only",
  "email_mismatch",
  "email_rejected",
  "email_taken",
  "email_unavailable",
  "forbidden",
  "human_handling",
  "grant_limit",
  "internal_error",
  "invalid_client",
  "invalid_name",
  "invalid_redirect_uri",
  "invalid_reply_to",
  "invalid_request",
  "invite_invalid",
  "invite_other_email",
  "label_limit",
  "label_name_taken",
  "last_owner",
  "last_workspace",
  "manual_review",
  "length_required",
  "link_invalid",
  "mail_failed",
  "message_seen",
  "name_mismatch",
  "no_setup",
  "no_customer",
  "no_email",
  "no_removal",
  "not_a_member",
  "not_an_image",
  "not_found",
  "operator_limit",
  "origin_not_allowed",
  "payment_pending",
  "payment_required",
  "push_unavailable",
  "read_only",
  "removal_blocked",
  "removal_not_needed",
  "saved_reply_limit",
  "saved_reply_shortcut_taken",
  "signed_in",
  "sign_in_again",
  "site_limit",
  "storage_full",
  "suspended",
  "team_changed",
  "too_large",
  "too_many_attempts",
  "too_many_pixels",
  "too_many_requests",
  "too_many_streams",
  "too_slow",
  "two_factor_off",
  "two_factor_on",
  "two_factor_required",
  "two_factor_unreadable",
  "type_not_allowed",
  "unauthorized",
  "unsupported_media_type",
  "webhook_limit",
  "workspace_deleted",
  "wrong_code",
] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

/** The body of every error answer: a stable code for clients and a sentence for people. */
export const failure = (code: ErrorCode, message: string) => ({ error: { code, message } });

export const NOT_FOUND = failure("not_found", "This does not exist.");
export const FORBIDDEN = failure("forbidden", "Your role does not allow this.");
export const CONVERSATION_CLOSED = failure(
  "conversation_closed",
  "Reopen this conversation to reply.",
);
/** No session, or the account was deleted. */
export const UNAUTHORIZED = failure("unauthorized", "Sign in to continue.");
/** A session of an operator with two-step sign-in on, before it passed the check. */
export const TWO_FACTOR_REQUIRED = failure(
  "two_factor_required",
  "Enter a code from your authenticator app to continue.",
);
/** A write to the operator API from a page that is not this server's own. */
export const WRONG_ORIGIN = failure("origin_not_allowed", "This site may not do this.");
/** A sign-in or join link that expired or was already used. */
export const LINK_INVALID = failure("link_invalid", "This link has expired or was already used.");

const ErrorBody = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      // Only the answers the app itself gives: a route that does not exist, a request that is
      // not valid, a busy workspace and an unexpected failure. It matches the server's log line.
      requestId: z.string().optional(),
    }),
  })
  .openapi("Error", { example: { error: { code: "not_found", message: "This does not exist." } } });

/** The OpenAPI content of an error answer, and of an answer that only says it worked. */
const errorContent = { "application/json": { schema: ErrorBody } };
export const okContent = { "application/json": { schema: z.object({ ok: z.literal(true) }) } };

/** An error answer in a route's OpenAPI responses. */
export const errorAnswer = (description: string) => ({ description, content: errorContent });

/** A required JSON request body. */
export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});

/** A JSON answer. */
export const jsonAnswer = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});

/** The description of a JSON body over the server's 64 KB limit. */
const TOO_LARGE_BODY = "too_large: the body is over 64 KB";
/** The description of an operator write that another site sent. */
export const WRONG_ORIGIN_TEXT =
  "origin_not_allowed: the request did not come from this server's own pages";

/** A request whose parameters, query or body fail validation, or a body that is not JSON. */
export const INVALID = { 400: errorAnswer("invalid_request: the request is not valid") };

/** A lock on the workspace timed out. The client-generated ID makes a retry safe. */
export const BUSY = { 503: errorAnswer("busy: the workspace is busy. Retry after `retry-after`") };

export const RATE_LIMITED = {
  429: errorAnswer("too_many_requests: over the rate limit. Retry after `retry-after`"),
};

/** A route that a workspace API key may call: each key has its own rate limit. */
export const KEY_LIMITED = {
  429: errorAnswer(
    "too_many_requests: over an API key's 300 requests a minute. Retry after `retry-after`",
  ),
};

/** The answers every widget route can give, from the access check and the rate limit. */
export const WIDGET_ERRORS = {
  403: errorAnswer(
    "origin_not_allowed: the key is unknown, the Origin is not an allowed site, or the " +
      "workspace's widget is off: it is suspended, waits for payment, is read-only or was deleted",
  ),
  ...RATE_LIMITED,
};
/** A widget route that needs the visitor's token. */
export const WIDGET_TOKEN_ERRORS = {
  ...WIDGET_ERRORS,
  401: errorAnswer("unauthorized: the browser token or host token is not valid"),
};
/** A widget write that takes a JSON body. */
export const WIDGET_WRITE_ERRORS = {
  ...WIDGET_TOKEN_ERRORS,
  ...INVALID,
  413: errorAnswer(TOO_LARGE_BODY),
};

/** The answers every operator route can give, from the session check. */
export const OPERATOR_ERRORS = {
  401: errorAnswer(
    "unauthorized: no valid session, or the API key is not valid or was revoked. " +
      "two_factor_required: the session has not passed two-step sign-in yet",
  ),
};
/** Any operator request but a GET: it must come from the server's own pages. */
export const OPERATOR_POST_ERRORS = {
  ...OPERATOR_ERRORS,
  403: errorAnswer(WRONG_ORIGIN_TEXT),
};
/** An operator write with a JSON body. */
export const OPERATOR_WRITE_ERRORS = {
  ...OPERATOR_POST_ERRORS,
  ...INVALID,
  413: errorAnswer(TOO_LARGE_BODY),
};

const SUSPENDED_TEXT = "suspended: the server's admin suspended the workspace";

/** A read in a workspace, behind the member check. */
export const MEMBER_ERRORS = {
  ...OPERATOR_ERRORS,
  402: errorAnswer("payment_required: the workspace waits for payment"),
  404: errorAnswer("not_found: it does not exist, or this operator is not a member"),
};
/** A write in a workspace: a suspended or read-only workspace refuses it. */
export const MEMBER_WRITE_ERRORS = {
  ...MEMBER_ERRORS,
  ...OPERATOR_WRITE_ERRORS,
  ...BUSY,
  402: errorAnswer(
    "payment_required: the workspace waits for payment. read_only: the subscription ended, so " +
      "operators can only read and export",
  ),
  403: errorAnswer(`${SUSPENDED_TEXT}. ${WRONG_ORIGIN_TEXT}`),
};
/** A write in a workspace that only some roles may do. */
export const ROLE_WRITE_ERRORS = {
  ...MEMBER_WRITE_ERRORS,
  403: errorAnswer(`forbidden: this role may not do this. ${SUSPENDED_TEXT}. ${WRONG_ORIGIN_TEXT}`),
};

/** An upload's own refusals, on the widget and in the inbox. */
export const UPLOAD_ERRORS = {
  400: errorAnswer(
    "invalid_request: the query is not valid. not_an_image: not a PNG, JPEG or WebP, where only images may come. type_not_allowed: neither an image nor an allowed file, by its name's extension and its first bytes. too_many_pixels: over 16 megapixels",
  ),
  408: errorAnswer("too_slow: the upload took too long"),
  413: errorAnswer("too_large: an image over 5 MB, or another file over 10 MB"),
  503: errorAnswer(
    "busy: too many uploads at once, or the workspace is busy. Retry after `retry-after`",
  ),
  507: errorAnswer("storage_full: the workspace has no room for more images or files"),
};
