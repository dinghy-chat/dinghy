import type { OpenAPIHono } from "@hono/zod-openapi";

/** A widget route that needs the visitor's token. */
export const VISITOR_TOKEN = [{ visitorToken: [] }];
/** An operator route: the session cookie from sign-in at /v1/auth. */
export const SESSION = [{ sessionCookie: [] }];

/** The two ways to sign in that the OpenAPI document names. */
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
      "The session cookie that sign-in at POST /v1/auth/sign-in/email sets (BetterAuth). The cookie is `__Secure-better-auth.session_token` on https. A write must also send the server's own Origin.",
  });
}
