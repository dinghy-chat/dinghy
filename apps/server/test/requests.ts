import { PUBLIC_URL } from "./env.ts";

/** Anything that answers a request like `App.request`, such as an app or a test server. */
export interface Server {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/** The server's own Origin, which a session's write sends. */
export const ORIGIN = new URL(PUBLIC_URL).origin;

/** A request with these headers, and a JSON body when there is one. */
const send = (
  server: Server,
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
) =>
  server.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A request as a session: the cookie and the server's own Origin. */
export const asOperator = (
  server: Server,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
) => send(server, { cookie, origin: ORIGIN }, method, path, body);

/** A request as a script sends it: a bearer header and no Origin. */
export const withKey = (
  server: Server,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => send(server, { authorization: `Bearer ${token}` }, method, path, body);

interface ToolAnswer {
  isError: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

/** Calls a tool of the MCP server with a key, and returns the tool's answer. */
export async function callTool(
  server: Server,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolAnswer> {
  const response = await server.request("/v1/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const answer = (await response.json()) as { result?: ToolAnswer };
  if (answer.result === undefined) {
    throw new Error(`The tool ${name} answered ${response.status} ${JSON.stringify(answer)}`);
  }
  return answer.result;
}
