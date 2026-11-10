import type { ErrorEvent } from "@sentry/node";
import type { Config } from "./config.ts";

// Drizzle puts a failed query's parameters in its message, and they can hold what people wrote.
const QUERY_FAILED = /^Failed query:/;

/** Removes what an error event must not carry before it leaves the server. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  // A URL can hold a sign-in token, and a header a session.
  delete event.request;
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined && QUERY_FAILED.test(exception.value)) {
      exception.value = "A query failed.";
    }
  }
  return event;
}

/**
 * Sends errors to Sentry when SENTRY_DSN is set: what the logger writes at error and fatal, and
 * uncaught exceptions. Without SENTRY_DSN, the SDK is never loaded and nothing is sent. It sends no
 * request data, no local variables, no logs and no traces.
 */
export async function startErrorReports(
  config: Config,
  role: string,
  version: string,
): Promise<(() => Promise<unknown>) | undefined> {
  if (config.SENTRY_DSN === undefined) return undefined;
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: config.SENTRY_DSN,
    release: `dinghy@${version}`,
    environment: config.SENTRY_ENVIRONMENT,
    // Errors and their stacks only. Local variables, headers and bodies can hold what people wrote.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    initialScope: { tags: { role } },
    integrations: [
      Sentry.pinoIntegration({ error: { levels: ["error", "fatal"] }, log: { levels: [] } }),
    ],
    beforeSend: scrubEvent,
  });
  return () => Sentry.close(2000);
}
