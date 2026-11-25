// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import type { Meta } from "../../apps/operator/src/api.ts";

/**
 * PostHog for Dinghy Cloud's app: page views, signup steps and session replay. Only the cloud's server
 * names a project, so a self-hosted app loads nothing. PostHog's cookie is shared with dinghy.chat, so
 * a visit to the website and the signup that follows belong to one person.
 *
 * The workspace's screens show customers' chats, so replay blocks them whole: it records the sidebar
 * and the clicks, and an empty box for the rest. Clicks carry no text or attributes, typed text is
 * masked, and addresses lose their query, which can hold a sign-in token.
 */
type Method = "capture" | "identify" | "reset";
type PostHog = Record<Method, (...args: unknown[]) => void>;

/** The Inbox's content area, and the dialogs, toasts and tooltips outside it. */
const CUSTOMER_DATA = ".stage, dialog, .toasts, .tooltip";
const METHODS: Method[] = ["capture", "identify", "reset"];

let operatorId: string | null = null;

/** The stub until PostHog's script loads, then PostHog itself, which replaces it on `window`. */
const posthog = () => (window as unknown as { posthog?: PostHog }).posthog;

/**
 * Drops the query from every address of this app in an event, wherever PostHog put it: properties,
 * person properties, heatmap keys, web vitals and the replay. The match stops before a quote or a
 * backslash, so the JSON stays valid.
 */
function stripQueries<T>(event: T): T {
  if (event === null) return event;
  const origin = location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withQuery = new RegExp(`(${origin}[^"\\\\?#\\s]*)[?#][^"\\\\\\s]*`, "g");
  return JSON.parse(JSON.stringify(event).replace(withQuery, "$1"));
}

/** Loads PostHog with the project the server names, or nothing with none. */
export function startAnalytics(analytics: Meta["analytics"]): void {
  if (analytics === null || posthog() !== undefined) return;
  const config = {
    api_host: analytics.host,
    person_profiles: "identified_only",
    capture_pageview: "history_change",
    // Surveys add inline styles, which the app's CSP blocks.
    disable_surveys: true,
    // Replay blocks the screens a heatmap would show, and their buckets are keyed by full address.
    enable_heatmaps: false,
    // A click's text and attributes can be a customer's.
    mask_all_text: true,
    mask_all_element_attributes: true,
    // PostHog's own requests, which skip before_send, mask these query parameters.
    mask_personal_data_properties: true,
    custom_personal_data_properties: ["token", "for", "workspace"],
    before_send: stripQueries,
    session_recording: {
      maskAllInputs: true,
      blockSelector: CUSTOMER_DATA,
      // Network timings would list the addresses of customers' images.
      maskCapturedNetworkRequestFn: () => null,
    },
  };
  // PostHog's script reads `_i`, then runs the calls queued in this array.
  const stub = Object.assign([] as unknown[], {
    _i: [[analytics.key, config, "posthog"]],
    people: [],
  });
  for (const method of METHODS)
    Object.assign(stub, { [method]: (...args: unknown[]) => stub.push([method, ...args]) });
  // The account may have loaded before the server's settings did.
  if (operatorId !== null) stub.push(["identify", operatorId]);
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
