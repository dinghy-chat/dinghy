import type { components, paths } from "./openapi.ts";
import type { Answer, MethodOf, RequestArgs, WorkspacePath } from "./request.ts";

/** The typed request that every resource group calls. */
export type Request = <P extends WorkspacePath, M extends MethodOf<P>>(
  method: M,
  path: P,
  ...args: RequestArgs<P, M>
) => Promise<Answer<P, M>>;

type JsonOf<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<P extends WorkspacePath, M extends MethodOf<P>> = JsonOf<
  NonNullable<NonNullable<paths[P][M]>["requestBody"]>
>;
type QueryOf<P extends WorkspacePath, M extends MethodOf<P>> = NonNullable<
  NonNullable<paths[P][M]>["parameters"]["query"]
>;
/** A send's body, where `clientId` is optional: the SDK makes one. */
type Send<T> = Omit<T, "clientId"> & { clientId?: string };

const IN_WORKSPACE = "/v1/operator/workspaces/{workspaceId}";
const CONVERSATIONS = `${IN_WORKSPACE}/conversations` as const;
const CONVERSATION = `${CONVERSATIONS}/{conversationId}` as const;
const MESSAGES = `${CONVERSATION}/messages` as const;
const CONTACT_BY_USER = `${IN_WORKSPACE}/contacts/by-user/{userId}` as const;
const OUTBOUND = `${IN_WORKSPACE}/outbound-messages` as const;
const WEBHOOKS = `${IN_WORKSPACE}/webhooks` as const;
const WEBHOOK = `${WEBHOOKS}/{webhookId}` as const;

const withClientId = <T extends { clientId?: string }>(input: T) => ({
  ...input,
  clientId: input.clientId ?? crypto.randomUUID(),
});

type Reply = Send<Omit<Body<typeof MESSAGES, "post">, "note" | "mentions">>;
type Note = Send<Omit<Body<typeof MESSAGES, "post">, "note">>;
type Upload = { file: Blob | Uint8Array<ArrayBuffer> } & Send<
  QueryOf<`${typeof CONVERSATION}/uploads`, "post">
>;
type Handoff = Send<Body<`${typeof CONVERSATION}/handoff`, "post">>;

export function conversations(request: Request) {
  const at = (conversationId: string) => ({ path: { conversationId } });
  return {
    list: (query: QueryOf<typeof CONVERSATIONS, "get"> = {}) =>
      request("get", CONVERSATIONS, { query }),
    search: (q: string) => request("get", `${CONVERSATIONS}/search`, { query: { q } }),
    messages: (conversationId: string, query: QueryOf<typeof MESSAGES, "get"> = {}) =>
      request("get", MESSAGES, { ...at(conversationId), query }),
    reply: (conversationId: string, input: Reply) =>
      request("post", MESSAGES, { ...at(conversationId), body: withClientId(input) }),
    note: (conversationId: string, input: Note) =>
      request("post", MESSAGES, {
        ...at(conversationId),
        body: { ...withClientId(input), note: true },
      }),
    upload: (conversationId: string, { file, ...query }: Upload) =>
      request("post", `${CONVERSATION}/uploads`, {
        ...at(conversationId),
        query: withClientId(query),
        bytes: file,
      }),
    receipt: (conversationId: string, messageId: string) =>
      request("get", `${MESSAGES}/{messageId}/receipt`, { path: { conversationId, messageId } }),
    close: (conversationId: string) =>
      request("patch", CONVERSATION, { ...at(conversationId), body: { status: "closed" } }),
    reopen: (conversationId: string) =>
      request("patch", CONVERSATION, { ...at(conversationId), body: { status: "open" } }),
    snooze: (conversationId: string, snooze: components["schemas"]["Snooze"]) =>
      request("patch", CONVERSATION, { ...at(conversationId), body: { snooze } }),
    /** Assigns a member by operator ID, or unassigns with null. */
    assign: (conversationId: string, operatorId: string | null) =>
      request("put", `${CONVERSATION}/assignee`, { ...at(conversationId), body: { operatorId } }),
    addLabel: (conversationId: string, labelId: string) =>
      request("put", `${CONVERSATION}/labels/{labelId}`, { path: { conversationId, labelId } }),
    removeLabel: (conversationId: string, labelId: string) =>
      request("delete", `${CONVERSATION}/labels/{labelId}`, { path: { conversationId, labelId } }),
    handoff: (conversationId: string, input: Handoff) =>
      request("post", `${CONVERSATION}/handoff`, {
        ...at(conversationId),
        body: withClientId(input),
      }),
    typing: (conversationId: string, typing = true) =>
      request("post", `${CONVERSATION}/typing`, { ...at(conversationId), body: { typing } }),
  };
}

type Upsert = { userId: string } & Body<typeof CONTACT_BY_USER, "put">;

export function contacts(request: Request) {
  return {
    /** Creates or updates the contact with this user ID, as a host token would. */
    upsert: ({ userId, ...body }: Upsert) =>
      request("put", CONTACT_BY_USER, { path: { userId }, body }),
  };
}

type Cancel = { id: string } | Body<`${typeof OUTBOUND}/cancel`, "post">;

export function outboundMessages(request: Request) {
  return {
    send: (input: Send<Body<typeof OUTBOUND, "post">>) =>
      request("post", OUTBOUND, { body: withClientId(input) }),
    get: (id: string) => request("get", `${OUTBOUND}/{id}`, { path: { id } }),
    list: (query: QueryOf<typeof OUTBOUND, "get"> = {}) => request("get", OUTBOUND, { query }),
    /** Cancels by ID, or by the visitor and the `dedupeKey` it was sent with. */
    cancel: (input: Cancel) =>
      "id" in input
        ? request("post", `${OUTBOUND}/{id}/cancel`, { path: { id: input.id } })
        : request("post", `${OUTBOUND}/cancel`, { body: input }),
  };
}

type NewWebhook = Body<typeof WEBHOOKS, "post">;

/** The webhook routes, which need a Full access (setup) key. */
export function webhookRoutes(request: Request) {
  const at = (webhookId: string) => ({ path: { webhookId } });
  return {
    list: () => request("get", WEBHOOKS),
    create: (body: NewWebhook) => request("post", WEBHOOKS, { body }),
    update: (webhookId: string, body: Body<typeof WEBHOOK, "patch">) =>
      request("patch", WEBHOOK, { ...at(webhookId), body }),
    delete: (webhookId: string) => request("delete", WEBHOOK, at(webhookId)),
    rotateSecret: (webhookId: string) => request("post", `${WEBHOOK}/rotate-secret`, at(webhookId)),
    test: (webhookId: string) => request("post", `${WEBHOOK}/test`, at(webhookId)),
    deliveries: (webhookId: string) => request("get", `${WEBHOOK}/deliveries`, at(webhookId)),
    replay: (webhookId: string, deliveryId: string) =>
      request("post", `${WEBHOOK}/deliveries/{deliveryId}/replay`, {
        path: { webhookId, deliveryId },
      }),
  };
}

/** The install, sites, widget, business hours and test visitor routes, for a setup key. */
export function setup(request: Request) {
  return {
    snippet: (query: QueryOf<`${typeof IN_WORKSPACE}/install/snippet`, "get">) =>
      request("get", `${IN_WORKSPACE}/install/snippet`, { query }),
    checkInstall: (query: QueryOf<`${typeof IN_WORKSPACE}/install/check`, "get">) =>
      request("get", `${IN_WORKSPACE}/install/check`, { query }),
    identitySetup: (query: QueryOf<`${typeof IN_WORKSPACE}/install/identity`, "get">) =>
      request("get", `${IN_WORKSPACE}/install/identity`, { query }),
    sites: () => request("get", `${IN_WORKSPACE}/sites`),
    addSite: (origin: string) => request("post", `${IN_WORKSPACE}/sites`, { body: { origin } }),
    removeSite: (origin: string) =>
      request("delete", `${IN_WORKSPACE}/sites`, { query: { origin } }),
    widget: () => request("get", `${IN_WORKSPACE}/widget`),
    updateWidget: (body: Body<`${typeof IN_WORKSPACE}/widget`, "put">) =>
      request("put", `${IN_WORKSPACE}/widget`, { body }),
    businessHours: () => request("get", `${IN_WORKSPACE}/business-hours`),
    updateBusinessHours: (body: Body<`${typeof IN_WORKSPACE}/business-hours`, "put">) =>
      request("put", `${IN_WORKSPACE}/business-hours`, { body }),
    testVisitorMessage: (body: Body<`${typeof IN_WORKSPACE}/test-visitors/messages`, "post">) =>
      request("post", `${IN_WORKSPACE}/test-visitors/messages`, { body }),
    clearTestVisitors: () => request("delete", `${IN_WORKSPACE}/test-visitors`),
  };
}

export function workspace(request: Request) {
  return { get: () => request("get", IN_WORKSPACE) };
}

export function labels(request: Request) {
  return { list: () => request("get", `${IN_WORKSPACE}/labels`) };
}

export function savedReplies(request: Request) {
  return { list: () => request("get", `${IN_WORKSPACE}/saved-replies`) };
}

export function analytics(request: Request) {
  return {
    get: (query: QueryOf<`${typeof IN_WORKSPACE}/analytics`, "get"> = {}) =>
      request("get", `${IN_WORKSPACE}/analytics`, { query }),
  };
}
