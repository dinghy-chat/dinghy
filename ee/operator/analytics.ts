// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import type { Meta } from "../../apps/operator/src/api.ts";

/**
 * Page views and signup steps for Dinghy Cloud's PostHog project, sent with plain requests to its
 * capture API. Only the cloud's server names a project, so a self-hosted app sends nothing. Nothing
 * is stored in the browser: before sign-in the ID lasts as long as the tab, after it the ID is the
 * operator's. The address goes without its query, which can hold a sign-in token.
 */
let project: Meta["analytics"] = null;
let anonymousId = crypto.randomUUID();
let operatorId: string | null = null;

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
  if (id === operatorId) return;
  if (id === null) anonymousId = crypto.randomUUID();
  else send("$identify", id, { $anon_distinct_id: anonymousId });
  operatorId = id;
}

/** A page view of this path, which never has the address's query. */
export function trackPage(path: string): void {
  send("$pageview", operatorId ?? anonymousId, {
    $current_url: location.origin + path,
    $pathname: path,
  });
}

/** A signup step, such as "workspace created". */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  send(event, operatorId ?? anonymousId, properties);
}
