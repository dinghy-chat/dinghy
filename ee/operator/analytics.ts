// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import type { Meta } from "../../apps/operator/src/api.ts";

/**
 * Page views and signup steps for Dinghy Cloud's PostHog project, sent with plain requests to its
 * capture API. Only the cloud's server names a project, so a self-hosted app sends nothing. Nothing
 * is stored in the browser: before sign-in the ID lasts as long as the tab, after it the ID is the
 * operator's. The address goes without its query, which can hold a sign-in token.
 */
let project: Meta["analytics"] = null;
// Made on first use, because crypto.randomUUID throws outside HTTPS, where a self-hosted app may run.
let anonymousId: string | null = null;
let operatorId: string | null = null;
let lastPath: string | null = null;

function currentId(): string {
  if (operatorId !== null) return operatorId;
  anonymousId ??= crypto.randomUUID();
  return anonymousId;
}

function send(event: string, distinctId: string, properties: Record<string, unknown> = {}): void {
  if (project === null) return;
  void fetch(`${project.host}/i/v0/e/`, {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: project.key,
      event,
      distinct_id: distinctId,
      timestamp: new Date().toISOString(),
      properties: {
        $lib: "dinghy-operator",
        $current_url: location.origin + location.pathname,
        $host: location.host,
        $pathname: location.pathname,
        $screen_width: screen.width,
        $screen_height: screen.height,
        // A visitor who is not signed in gets no person profile, as on the website.
        ...(operatorId === null && event !== "$identify" ? { $process_person_profile: false } : {}),
        ...properties,
      },
    }),
  }).catch(() => {});
}

/** Turns analytics on with the project the server names, or leaves it off with none. */
export function startAnalytics(analytics: Meta["analytics"]): void {
  project = analytics;
}

/** Ties this tab's earlier events to the operator once they sign in, and starts over at sign-out. */
export function identifyOperator(id: string | null): void {
  if (id === operatorId || project === null) return;
  // Only a tab's anonymous events join the operator. A switch between two accounts joins nothing.
  if (id !== null && operatorId === null && anonymousId !== null)
    send("$identify", id, { $anon_distinct_id: anonymousId });
  // Without a join, the new ID gets its own view of the screen on show.
  else lastPath = null;
  operatorId = id;
  anonymousId = null;
}

/** A page view of this path, which never has the address's query. A repeat of the last path is skipped. */
export function trackPage(path: string = location.pathname): void {
  if (project === null || path === lastPath) return;
  lastPath = path;
  send("$pageview", currentId(), {
    $current_url: location.origin + path,
    $pathname: path,
  });
}

/** A signup step, such as "workspace created". */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (project === null) return;
  send(event, currentId(), properties);
}
