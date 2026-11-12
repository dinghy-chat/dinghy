import { randomUUID } from "node:crypto";
import type { Server } from "./requests.ts";

/** The site that the test workspaces allow, where the widget runs. */
export const SITE = "https://app.example.com";

interface Visitor {
  visitorId: string;
  token: string;
}

/** A new visitor of the widget with this public key, who has sent nothing yet. */
export async function newVisitor(server: Server, publicKey: string): Promise<Visitor> {
  const created = await server.request(`/v1/widget/${publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  return (await created.json()) as Visitor;
}

/** A visitor's message, as the widget answers it. */
interface SentMessage {
  id: string;
  conversationId: string;
}

/** A visitor's message from the widget, which opens a conversation when none is open. */
export async function visitorSays(
  server: Server,
  publicKey: string,
  token: string,
  body: string,
  extra: { clientId?: string; page?: string | undefined } = {},
): Promise<SentMessage> {
  const sent = await server.request(`/v1/widget/${publicKey}/messages`, {
    method: "POST",
    headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID(), body, ...extra }),
  });
  if (sent.status !== 201) throw new Error(`The visitor's message got ${sent.status}`);
  return (await sent.json()) as SentMessage;
}

/** A new visitor's first message, which opens a conversation. */
export async function visitorStarts(
  server: Server,
  publicKey: string,
  body: string,
  extra: { clientId?: string; page?: string | undefined } = {},
): Promise<Visitor & { conversationId: string; first: SentMessage }> {
  const visitor = await newVisitor(server, publicKey);
  const first = await visitorSays(server, publicKey, visitor.token, body, extra);
  return { ...visitor, conversationId: first.conversationId, first };
}
