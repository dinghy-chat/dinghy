import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type Auth, signInLink } from "../src/auth.ts";
import { operator, workspaceMember } from "../src/db/schema.ts";
import type { Database } from "../src/db/tenant.ts";
import type { Mailer } from "../src/mailer.ts";
import type { Role } from "../src/team.ts";

/** Anything that answers a request like `App.request`, such as an app or a test server. */
interface Server {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

export interface OperatorOptions {
  auth: Auth;
  /** A connection that can insert operators and members, such as the migrator. */
  owner: Database;
  email?: string;
  name?: string;
  /** With a workspace, the operator joins it with `role`, which defaults to owner. */
  workspaceId?: string;
  role?: Role;
}

/** An operator, and optionally a member of one workspace. */
export async function addOperator({
  owner,
  email = `op-${randomUUID()}@example.com`,
  name = email,
  workspaceId,
  role = "owner",
}: OperatorOptions): Promise<{ id: string; email: string }> {
  const [row] = await owner
    .insert(operator)
    .values({ name, email, emailVerified: true })
    .returning({ id: operator.id });
  if (row === undefined) throw new Error("The operator insert returned no row");
  if (workspaceId !== undefined) {
    await owner.insert(workspaceMember).values({ workspaceId, operatorId: row.id, role });
  }
  return { id: row.id, email };
}

/** The `cookie` header that sends back every cookie a response set. */
export const cookieOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** The path and query of a link, which `app.request` takes. */
const pathOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/** Opens a link through `app`, as a browser or a mail scanner would. It uses nothing. */
export const openLink = async (app: Server, url: string): Promise<Response> =>
  app.request(pathOf(url));

/** Selects the button on the page a link opens: it posts the link's token, as the app does. */
export function pressLinkButton(app: Server, url: string): Promise<Response> | Response {
  const parsed = new URL(url);
  const paths: Record<string, string> = {
    join: "/v1/invites/open",
    "delete-account": "/v1/account/delete",
  };
  const path = paths[parsed.searchParams.get("for") ?? ""] ?? "/v1/auth/magic-link/verify";
  return app.request(path, {
    method: "POST",
    headers: { origin: parsed.origin, "content-type": "application/json" },
    body: JSON.stringify({ token: parsed.searchParams.get("token") }),
  });
}

/** Opens a link, selects its button and returns the session cookie, or throws if it did not sign in. */
export async function openSignInLink(app: Server, url: string): Promise<string> {
  await openLink(app, url);
  const response = await pressLinkButton(app, url);
  if (response.status !== 200) {
    throw new Error(`Sign-in failed with ${response.status} ${await response.text()}`);
  }
  return cookieOf(response);
}

/** Signs in with a new link, as `chat sign-in-link` makes, and returns the session cookie. */
export async function signIn(app: Server, auth: Auth, email: string): Promise<string> {
  return openSignInLink(app, await signInLink(auth, email));
}

/** `addOperator`, then a sign-in through `app`. */
export async function signedInOperator(
  options: OperatorOptions & { app: Server },
): Promise<{ id: string; email: string; cookie: string }> {
  const added = await addOperator(options);
  return { ...added, cookie: await signIn(options.app, options.auth, added.email) };
}

export interface SentMail {
  to: string;
  subject: string;
  text: string;
}

/** A mailer that keeps what it sends, so a test reads a link the way a person would. */
export function captureMail(): Mailer & {
  sent: SentMail[];
  /** Waits for email number `index` to `to`, and returns its first link. */
  linkTo(to: string, index?: number): Promise<string>;
  countTo(to: string): number;
} {
  const sent: SentMail[] = [];
  const to = (address: string) => sent.filter((mail) => mail.to === address);
  return {
    sent,
    async send(address, subject, text) {
      sent.push({ to: address, subject, text });
    },
    countTo: (address) => to(address).length,
    async linkTo(address, index = 0) {
      // Links go out after the answer, so the email can arrive a moment later.
      for (let waited = 0; waited < 5000; waited += 20) {
        const link = to(address)[index]?.text.match(/https?:\/\/\S+/)?.[0];
        if (link !== undefined) return link;
        await delay(20);
      }
      throw new Error(`No email with a link reached ${address}`);
    },
  };
}
