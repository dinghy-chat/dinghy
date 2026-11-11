import type { OpenAPIHono } from "@hono/zod-openapi";

/** A widget route that needs the visitor's token. */
export const VISITOR_TOKEN = [{ visitorToken: [] }];
/** An operator route: the session cookie from sign-in at /v1/auth. */
export const SESSION = [{ sessionCookie: [] }];
/**
 * An operator route that a workspace API key may also call. The member check reads this, so the
 * list of what a key can do is the API document's.
 */
export const SESSION_OR_KEY = [{ sessionCookie: [] }, { apiKey: [] }];
/**
 * An operator route that a Setup API key may also call, such as the webhooks. A Conversations key
 * gets 403 `forbidden`. The member check reads this too.
 */
export const SESSION_OR_SETUP_KEY = [{ sessionCookie: [] }, { setupKey: [] }];
/** A route that takes only a workspace API key, such as MCP. */
export const API_KEY = [{ apiKey: [] }];

/** The ways to sign in that the OpenAPI document names. */
export function registerSecuritySchemes(registry: OpenAPIHono["openAPIRegistry"]): void {
  registry.registerComponent("securitySchemes", "visitorToken", {
    type: "http",
    scheme: "bearer",
    description:
      "The browser token from POST /v1/widget/{key}/visitors, or a host token: an HS256 JWT that the host site signs with the workspace's signing secret.",
  });
  registry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    // BetterAuth adds the __Secure- prefix on an https server.
    name: "better-auth.session_token",
    description:
      "The session cookie that POST /v1/auth/magic-link/verify sets when it uses a sign-in link (BetterAuth). The cookie is `__Secure-better-auth.session_token` on https. A write must also send the server's own Origin.",
  });
  registry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description:
      "A workspace API key, `dk_...`, that an owner or admin creates in Settings. It works only in its own workspace, with a member's permissions: read, search, reply, close, reopen and assign conversations. It needs no Origin.",
  });
  registry.registerComponent("securitySchemes", "setupKey", {
    type: "http",
    scheme: "bearer",
    description:
      "A workspace API key, `dk_...`, made with the Setup access level. It reaches what a Conversations key does, and the webhooks: list, add, change, delete, rotate a secret, test and read deliveries. It never reaches keys, members, billing, export or the workspace's deletion.",
  });
}
