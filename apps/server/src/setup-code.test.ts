import { createHmac, timingSafeEqual } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import { verifyHostToken } from "./identity.ts";
import {
  FRAMEWORKS,
  IDENTITY_LANGUAGES,
  identitySetup,
  installSnippet,
  SECRET_VARIABLE,
  WEBHOOK_LANGUAGES,
  webhookVerification,
} from "./setup-code.ts";
import { signature } from "./webhooks.ts";

const install = {
  serverUrl: "https://chat.example.com",
  publicKey: "wk_0123456789abcdef0123456789abcdef",
};
const SECRET = "a-signing-secret-that-only-the-server-holds";

/**
 * Runs a TypeScript sample as a module would: types stripped, its imports handed in, and its named
 * function returned. Each sample imports one package, so the test passes that package's exports.
 */
function runSample<T>(code: string, name: string, imports: Record<string, unknown>): T {
  const body = stripTypeScriptTypes(code)
    .replace(/^import .*$/gm, "")
    .replace(/^export /gm, "");
  const names = Object.keys(imports);
  const make = new Function(...names, "process", `${body}\nreturn ${name};`);
  return make(...names.map((key) => imports[key]), {
    env: { [SECRET_VARIABLE]: SECRET },
  }) as T;
}

describe("the install snippet", () => {
  test.each(FRAMEWORKS)("%s names a file, a placement and the workspace's key", (framework) => {
    const snippet = installSnippet(framework, install);
    expect(snippet).toMatchObject({ framework, ...install });
    expect(snippet.file).not.toBe("");
    expect(snippet.placement).not.toBe("");
    expect(snippet.code).toContain(install.publicKey);
    expect(snippet.notes.join(" ")).toContain("allowed sites");
  });

  test("a plain site, Rails, Laravel and WordPress get the loader tag before </body>", () => {
    const tag = `<script src="https://chat.example.com/widget/loader.js" data-key="${install.publicKey}" async></script>`;
    for (const framework of ["html", "rails", "laravel", "wordpress"] as const) {
      expect(installSnippet(framework, install).code).toContain(tag);
    }
    expect(installSnippet("rails", install).file).toBe("app/views/layouts/application.html.erb");
    expect(installSnippet("laravel", install).file).toContain(
      "resources/views/layouts/app.blade.php",
    );
    const wordpress = installSnippet("wordpress", install);
    expect(wordpress.code).toMatch(/^add_action\('wp_footer'/);
    expect(wordpress.file).toContain("functions.php");
  });

  test("Next.js loads it with next/script after the page is interactive", () => {
    const next = installSnippet("nextjs", install);
    expect(next.file).toBe("app/layout.tsx");
    expect(next.code).toContain('import Script from "next/script"');
    expect(next.code).toContain('strategy="afterInteractive"');
    expect(next.code).toContain('src="https://chat.example.com/widget/loader.js"');
    expect(next.notes.join(" ")).toContain("pages/_app.tsx");
  });

  test("React and Vue call the npm package's init()", () => {
    for (const framework of ["react", "vue"] as const) {
      const snippet = installSnippet(framework, install);
      expect(snippet.code).toContain('import { init } from "@dinghy-chat/widget"');
      expect(snippet.code).toContain(
        `init({ url: "https://chat.example.com", key: "${install.publicKey}" })`,
      );
    }
    expect(installSnippet("vue", install).file).toBe("src/main.ts");
    expect(installSnippet("react", install).file).toContain("src/main.tsx");
  });
});

/** How each sample names sub, aud, iat, exp, name and email. jose sets the first four itself. */
const CLAIMS: Record<(typeof IDENTITY_LANGUAGES)[number], string[]> = {
  typescript: [
    "setSubject(",
    "setAudience(",
    "setIssuedAt(",
    "setExpirationTime(",
    "name:",
    "email:",
  ],
  python: ['"sub"', '"aud"', '"iat"', '"exp"', '"name"', '"email"'],
  ruby: ["sub:", "aud:", "iat:", "exp:", "name:", "email:"],
  php: ["'sub'", "'aud'", "'iat'", "'exp'", "'name'", "'email'"],
  go: ['"sub"', '"aud"', '"iat"', '"exp"', '"name"', '"email"'],
};

describe("the identity setup", () => {
  test("the TypeScript sample signs a token the server accepts", async () => {
    const { serverCode } = identitySetup("typescript", install.publicKey);
    const sign = runSample<
      (user: { id: string; name?: string; email?: string }) => Promise<string>
    >(serverCode, "dinghyToken", { SignJWT });
    const token = await sign({ id: "user-42", name: "Ada Lovelace", email: "ada@example.com" });
    const identity = await verifyHostToken(token, SECRET, install.publicKey);
    expect(identity).toMatchObject({
      externalId: "user-42",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    // Signed with another secret, the server refuses it.
    expect(await verifyHostToken(token, "another-secret", install.publicKey)).toBeNull();
  });

  test.each(IDENTITY_LANGUAGES)(
    "%s reads the secret from the environment, signs HS256 and sets every claim",
    (language) => {
      const setup = identitySetup(language, install.publicKey);
      expect(setup.serverCode).toContain(SECRET_VARIABLE);
      expect(setup.serverCode).toContain(install.publicKey);
      expect(setup.serverCode).toMatch(/HS256/);
      for (const claim of CLAIMS[language]) expect(setup.serverCode).toContain(claim);
      expect(setup.browserCode).toContain("Dinghy.identify(");
      expect(setup.browserCode).toContain("Dinghy.reset()");
      expect(setup.secretNote).toContain("Settings > Install");
      expect(setup.secretNote).toContain("never paste it in a chat");
    },
  );

  test("no sample holds anything that looks like a secret", () => {
    for (const language of IDENTITY_LANGUAGES) {
      const text = JSON.stringify(identitySetup(language, install.publicKey));
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/whsec_|dk_/);
    }
  });
});

describe("the webhook signature check", () => {
  const body = JSON.stringify({ id: "evt", type: "message.created", data: {} });
  const secret = "whsec_test";
  const check = runSample<(raw: string, header: string | null, key: string) => boolean>(
    webhookVerification("typescript").code,
    "isFromDinghy",
    { createHmac, timingSafeEqual },
  );
  const now = () => Math.floor(Date.now() / 1000);

  test("the TypeScript sample accepts what the real signer sends", () => {
    expect(check(body, signature(secret, now(), body), secret)).toBe(true);
  });

  test("it refuses another body, another secret, an old time and a bad header", () => {
    expect(check(`${body} `, signature(secret, now(), body), secret)).toBe(false);
    expect(check(body, signature("whsec_other", now(), body), secret)).toBe(false);
    expect(check(body, signature(secret, now() - 301, body), secret)).toBe(false);
    expect(check(body, null, secret)).toBe(false);
    expect(check(body, "t=1,v1=zz", secret)).toBe(false);
  });

  test.each(WEBHOOK_LANGUAGES)(
    "%s uses a constant-time compare and a 300 s tolerance",
    (language) => {
      const { code } = webhookVerification(language);
      expect(code).toMatch(/timingSafeEqual|compare_digest|hmac\.Equal/);
      expect(code).toContain("300");
      expect(code).toMatch(/sha256/i);
      expect(code).toContain("v1=");
    },
  );
});
