import { randomUUID } from "node:crypto";
import type { Auth } from "../src/auth.ts";
import { operator, workspaceMember } from "../src/db/schema.ts";
import type { Database } from "../src/db/tenant.ts";
import type { Role } from "../src/team.ts";
import { PUBLIC_URL } from "./env.ts";

export const TEST_PASSWORD = "a-long-test-password";
const ORIGIN = new URL(PUBLIC_URL).origin;

/** Anything that answers a request like `App.request`, such as an app or a test server. */
interface Server {
  request(path: string, init: RequestInit): Response | Promise<Response>;
}

export interface OperatorOptions {
  auth: Auth;
  /** A connection that can insert operators and members, such as the migrator. */
  owner: Database;
  email?: string;
  name?: string;
  password?: string;
  /** With a workspace, the operator joins it with `role`, which defaults to owner. */
  workspaceId?: string;
  role?: Role;
}

/** An operator with a password, and optionally a member of one workspace. */
export async function addOperator({
  auth,
  owner,
  email = `op-${randomUUID()}@example.com`,
  name = email,
  password = TEST_PASSWORD,
  workspaceId,
  role = "owner",
}: OperatorOptions): Promise<{ id: string; email: string }> {
  const context = await auth.$context;
  const [row] = await owner
    .insert(operator)
    .values({ name, email, emailVerified: true })
    .returning({ id: operator.id });
  if (row === undefined) throw new Error("The operator insert returned no row");
  await context.internalAdapter.linkAccount({
    userId: row.id,
    providerId: "credential",
    accountId: row.id,
    password: await context.password.hash(password),
  });
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

/** Signs in through the API and returns the session cookie. */
export async function signIn(
  app: Server,
  email: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const response = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) throw new Error(`Sign-in failed with ${response.status}`);
  return cookieOf(response);
}

/** `addOperator`, then a sign-in through `app`. */
export async function signedInOperator(
  options: OperatorOptions & { app: Server },
): Promise<{ id: string; email: string; cookie: string }> {
  const added = await addOperator(options);
  return { ...added, cookie: await signIn(options.app, added.email, options.password) };
}
