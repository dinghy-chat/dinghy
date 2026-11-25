// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import type { Meta } from "../../apps/operator/src/api.ts";

/**
 * PostHog for Dinghy Cloud's app: page views, signup steps and session replay. Only the cloud's server
 * names a project, so a self-hosted app loads nothing. PostHog's cookie is shared with dinghy.chat, so
 * a visit to the website and the signup that follows belong to one person.
 *
 * A signed-in operator's screens show their customers' chats, so replay masks all text there and
 * blocks images in messages. Typed text is always masked. Addresses lose their query, which can hold
 * a sign-in token.
 */
type Method = "capture" | "identify" | "reset";
type PostHog = Record<Method, (...args: unknown[]) => void>;

/** Pages that show only the operator's own account, where replay keeps the text. */
const OWN_PAGES = new Set(["/signup", "/link", "/billing/return"]);
const METHODS: Method[] = ["capture", "identify", "reset"];

let operatorId: string | null = null;

/** The stub until PostHog's script loads, then PostHog itself, which replaces it on `window`. */
const posthog = () => (window as unknown as { posthog?: PostHog }).posthog;

/** Drops the query from this app's own addresses, wherever an event carries one. */
function withoutQuery(value: unknown): unknown {
  return typeof value === "string" && value.startsWith(location.origin)
    ? value.split("?")[0]
    : value;
}

function stripQueries(event: { properties?: Record<string, unknown> } | null) {
  const properties = event?.properties;
  for (const bag of [properties, properties?.$set, properties?.$set_once]) {
    if (typeof bag !== "object" || bag === null) continue;
    const values = bag as Record<string, unknown>;
    for (const key of Object.keys(values)) values[key] = withoutQuery(values[key]);
  }
  return event;
}

const maskText = (text: string) =>
  operatorId === null || OWN_PAGES.has(location.pathname) ? text : text.replace(/\S/g, "*");

/** Loads PostHog with the project the server names, or nothing with none. */
export function startAnalytics(analytics: Meta["analytics"]): void {
  if (analytics === null || posthog() !== undefined) return;
  const config = {
    api_host: analytics.host,
    person_profiles: "identified_only",
    capture_pageview: "history_change",
    // Surveys add inline styles, which the app's CSP blocks.
    disable_surveys: true,
    before_send: stripQueries,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      maskTextFn: maskText,
      blockSelector: ".msg img",
      maskCapturedNetworkRequestFn: (request: { name: string }) => ({
        ...request,
        name: request.name.split("?")[0],
      }),
    },
  };
  // PostHog's script reads `_i`, then runs the calls queued in this array.
  const stub = Object.assign([] as unknown[], {
    _i: [[analytics.key, config, "posthog"]],
    people: [],
  });
  for (const method of METHODS)
    Object.assign(stub, { [method]: (...args: unknown[]) => stub.push([method, ...args]) });
  (window as unknown as { posthog: unknown }).posthog = stub;
  const script = document.createElement("script");
  script.src = `${analytics.host.replace(".i.posthog.com", "-assets.i.posthog.com")}/static/array.js`;
  script.async = true;
  script.crossOrigin = "anonymous";
  document.head.append(script);
}

/** Ties the visit to the operator once they sign in, and starts a new visitor at sign-out. */
export function identifyOperator(id: string | null): void {
  if (id === operatorId) return;
  if (id === null) posthog()?.reset();
  else posthog()?.identify(id);
  operatorId = id;
}

/** A signup step, such as "workspace created". */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  posthog()?.capture(event, properties);
}
