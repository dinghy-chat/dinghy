// Code that a coding agent copies into a customer's app: the widget's install snippet, the identity
// token signer and the webhook signature check. Pure templates, so a test can run or read each one.

import { MINUTE_SECONDS } from "./time.ts";

export const FRAMEWORKS = [
  "html",
  "nextjs",
  "react",
  "vue",
  "rails",
  "laravel",
  "wordpress",
] as const;
type Framework = (typeof FRAMEWORKS)[number];

export const IDENTITY_LANGUAGES = ["typescript", "python", "ruby", "php", "go"] as const;
type IdentityLanguage = (typeof IDENTITY_LANGUAGES)[number];

export const WEBHOOK_LANGUAGES = ["typescript", "python", "go"] as const;
type WebhookLanguage = (typeof WEBHOOK_LANGUAGES)[number];

/** The environment variable every identity sample reads the signing secret from. */
export const SECRET_VARIABLE = "DINGHY_SIGNING_SECRET";

interface Install {
  /** The Dinghy server's origin, such as https://chat.example.com. */
  serverUrl: string;
  publicKey: string;
}

interface Snippet {
  code: string;
  file: string;
  placement: string;
  notes: string[];
}

const loaderUrl = ({ serverUrl }: Install) => new URL("/widget/loader.js", serverUrl).href;
const scriptTag = (install: Install) =>
  `<script src="${loaderUrl(install)}" data-key="${install.publicKey}" async></script>`;

const NPM_INSTALL =
  "Install the package first: `npm install @dinghy-chat/widget` (or `bun add`, `pnpm add`, `yarn add`, matching the app's lockfile).";
const npmInit = ({ serverUrl, publicKey }: Install) =>
  [
    'import { init } from "@dinghy-chat/widget";',
    "",
    `init({ url: "${serverUrl}", key: "${publicKey}" });`,
  ].join("\n");

const SNIPPETS: Record<Framework, (install: Install) => Snippet> = {
  html: (install) => ({
    code: scriptTag(install),
    file: "Every page's HTML, or the one layout or template that every page shares",
    placement: "Just before the closing </body> tag",
    notes: ["Add it on every page that should show the chat."],
  }),
  nextjs: (install) => ({
    code: [
      'import Script from "next/script";',
      "",
      "export default function RootLayout({ children }: { children: React.ReactNode }) {",
      "  return (",
      '    <html lang="en">',
      "      <body>",
      "        {children}",
      "        <Script",
      `          src="${loaderUrl(install)}"`,
      `          data-key="${install.publicKey}"`,
      '          strategy="afterInteractive"',
      "        />",
      "      </body>",
      "    </html>",
      "  );",
      "}",
    ].join("\n"),
    file: "app/layout.tsx",
    placement:
      "Add the <Script> element as the last child of <body> in the root layout, and keep the layout's existing content",
    notes: [
      "With the pages router, put the same <Script> element in pages/_app.tsx, after <Component {...pageProps} />.",
      "To call Dinghy from code instead, install @dinghy-chat/widget and call its init({ url, key }) once in a client component's useEffect, in place of the <Script> element.",
    ],
  }),
  react: (install) => ({
    code: npmInit(install),
    file: "src/main.tsx (the app's entry file, or src/index.tsx)",
    placement: "Once, at the top level of the entry file, next to createRoot(...)",
    notes: [
      NPM_INSTALL,
      "Call init() only in the browser. With server rendering, call it in a useEffect.",
    ],
  }),
  vue: (install) => ({
    code: npmInit(install),
    file: "src/main.ts",
    placement: "Once, at the top level of src/main.ts, before createApp(App).mount(...)",
    notes: [
      NPM_INSTALL,
      "With Nuxt, call init() in a client-only plugin (plugins/dinghy.client.ts).",
    ],
  }),
  rails: (install) => ({
    code: scriptTag(install),
    file: "app/views/layouts/application.html.erb",
    placement: "Just before the closing </body> tag",
    notes: [
      "If config/initializers/content_security_policy.rb sets a policy, add the Dinghy server to script_src, connect_src and img_src.",
    ],
  }),
  laravel: (install) => ({
    code: scriptTag(install),
    file: "resources/views/layouts/app.blade.php (the layout every page extends)",
    placement: "Just before the closing </body> tag",
    notes: ["If the app uses several layouts, add it to each one that visitors see."],
  }),
  wordpress: (install) => ({
    code: [
      "add_action('wp_footer', function () {",
      `    echo '${scriptTag(install)}';`,
      "});",
    ].join("\n"),
    file: "wp-content/themes/<your-child-theme>/functions.php",
    placement: "At the end of the child theme's functions.php",
    notes: [
      "No plugin is needed. The wp_footer hook prints the tag before </body> on every page.",
      "Use a child theme, so a theme update does not remove it.",
    ],
  }),
};

/** Where and how to add the widget in an app made with `framework`. */
export function installSnippet(framework: Framework, install: Install) {
  const snippet = SNIPPETS[framework](install);
  return {
    framework,
    ...snippet,
    notes: [
      ...snippet.notes,
      `Add the site's origin, such as https://www.example.com, to the allowed sites: the widget does not load anywhere else.`,
      `If the app has a Content Security Policy, allow ${install.serverUrl} in script-src, connect-src and img-src.`,
    ],
    publicKey: install.publicKey,
    serverUrl: install.serverUrl,
  };
}

// Identity ----------------------------------------------------------------------------------------

const SIGNERS: Record<IdentityLanguage, (publicKey: string) => { file: string; code: string }> = {
  typescript: (publicKey) => ({
    file: "A server module, such as src/server/dinghy-token.ts. Needs the jose package.",
    code: `import { SignJWT } from "jose";

const DINGHY_PUBLIC_KEY = "${publicKey}";

/** A token that tells Dinghy who the signed-in user is. Only the user's own session may get it. */
export async function dinghyToken(user: { id: string; name?: string; email?: string }) {
  const secret = process.env.${SECRET_VARIABLE};
  if (!secret) throw new Error("Set ${SECRET_VARIABLE} in the server's environment");
  return new SignJWT({ name: user.name, email: user.email, attributes: {} })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(DINGHY_PUBLIC_KEY)
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}`,
  }),
  python: (publicKey) => ({
    file: "A server module, such as dinghy_token.py. Needs PyJWT (pip install PyJWT).",
    code: `import os
import time

import jwt

DINGHY_PUBLIC_KEY = "${publicKey}"


def dinghy_token(user_id, name=None, email=None, attributes=None):
    """A token that tells Dinghy who the signed-in user is. Only the user's own session may get it."""
    now = int(time.time())
    claims = {"sub": str(user_id), "aud": DINGHY_PUBLIC_KEY, "iat": now, "exp": now + 3600}
    if name:
        claims["name"] = name
    if email:
        claims["email"] = email
    if attributes:
        claims["attributes"] = attributes
    return jwt.encode(claims, os.environ["${SECRET_VARIABLE}"], algorithm="HS256")`,
  }),
  ruby: (publicKey) => ({
    file: "A server file, such as app/services/dinghy_token.rb. Needs the jwt gem.",
    code: `require "jwt"

DINGHY_PUBLIC_KEY = "${publicKey}"

# A token that tells Dinghy who the signed-in user is. Only the user's own session may get it.
def dinghy_token(user_id, name: nil, email: nil, attributes: nil)
  now = Time.now.to_i
  claims = { sub: user_id.to_s, aud: DINGHY_PUBLIC_KEY, iat: now, exp: now + 3600,
             name: name, email: email, attributes: attributes }.compact
  JWT.encode(claims, ENV.fetch("${SECRET_VARIABLE}"), "HS256")
end`,
  }),
  php: (publicKey) => ({
    file: "A server file, such as app/Support/DinghyToken.php. Needs firebase/php-jwt (composer require firebase/php-jwt).",
    code: String.raw`<?php

use Firebase\JWT\JWT;

const DINGHY_PUBLIC_KEY = '${publicKey}';

// A token that tells Dinghy who the signed-in user is. Only the user's own session may get it.
function dinghy_token(string $userId, ?string $name = null, ?string $email = null): string
{
    $now = time();
    $claims = array_filter([
        'sub' => $userId,
        'aud' => DINGHY_PUBLIC_KEY,
        'iat' => $now,
        'exp' => $now + 3600,
        'name' => $name,
        'email' => $email,
    ], fn ($value) => $value !== null);
    return JWT::encode($claims, getenv('${SECRET_VARIABLE}'), 'HS256');
}`,
  }),
  go: (publicKey) => ({
    file: "A server package, such as internal/dinghy/token.go. Needs github.com/golang-jwt/jwt/v5.",
    code: `package dinghy

import (
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const publicKey = "${publicKey}"

// Token tells Dinghy who the signed-in user is. Only the user's own session may get it.
func Token(userID, name, email string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"sub": userID,
		"aud": publicKey,
		"iat": now.Unix(),
		"exp": now.Add(time.Hour).Unix(),
	}
	if name != "" {
		claims["name"] = name
	}
	if email != "" {
		claims["email"] = email
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(os.Getenv("${SECRET_VARIABLE}")))
}`,
  }),
};

const BROWSER_CALL = `// After the user signs in, on every page load:
Dinghy.identify(async () => {
  const response = await fetch("/api/dinghy-token", { method: "POST" });
  return response.text();
});

// When the user signs out:
Dinghy.reset();`;

/** How to sign visitors in with identify(), in `language`. Never holds the signing secret. */
export function identitySetup(language: IdentityLanguage, publicKey: string) {
  const signer = SIGNERS[language](publicKey);
  return {
    language,
    explanation: [
      "Dinghy.identify() tells the chat who the signed-in user is, so their chat follows them to every device and operators see their name and email.",
      "Your server signs a short HS256 token with the workspace's signing secret: sub is your user's ID (up to 255 characters), aud is the workspace's public key, iat and exp are at most 24 hours apart, and name, email and attributes (up to 2 KB of JSON) are optional.",
      "Serve the token from a route that only the signed-in user can call, such as POST /api/dinghy-token, and answer it as plain text. The browser passes a function to identify(), which the widget calls again when the token expires.",
    ],
    serverFile: signer.file,
    serverCode: signer.code,
    browserCode: BROWSER_CALL,
    secretNote: `A person copies the signing secret from Settings > Install into the server environment as ${SECRET_VARIABLE}; never paste it in a chat. No tool or API key can read it.`,
    publicKey,
  };
}

// Webhook signatures ------------------------------------------------------------------------------

/** The oldest `t` a receiver of a Dinghy signature accepts: the samples, and inbound emails. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const SIGNATURE_TOLERANCE_MINUTES = SIGNATURE_TOLERANCE_SECONDS / MINUTE_SECONDS;

const VERIFIERS: Record<WebhookLanguage, string> = {
  typescript: String.raw`import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = ${SIGNATURE_TOLERANCE_SECONDS};

/** True when the request came from Dinghy. Pass the raw body, before any JSON parsing. */
export function isFromDinghy(rawBody: string, header: string | null, secret: string): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (match === null) return false;
  const [, timestamp = "", received = ""] = match;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(timestamp + ".").update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}`,
  python: String.raw`import hashlib
import hmac
import re
import time

TOLERANCE_SECONDS = ${SIGNATURE_TOLERANCE_SECONDS}


def is_from_dinghy(raw_body: bytes, header: str, secret: str) -> bool:
    """True when the request came from Dinghy. Pass the raw body, before any JSON parsing."""
    match = re.fullmatch(r"t=(\d+),v1=([0-9a-f]{64})", header or "")
    if match is None:
        return False
    timestamp, received = match.group(1), match.group(2)
    if abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
        return False
    signed = timestamp.encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, received)`,
  go: String.raw`package dinghy

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"time"
)

const toleranceSeconds = ${SIGNATURE_TOLERANCE_SECONDS}

var signaturePattern = regexp.MustCompile("^t=(\\d+),v1=([0-9a-f]{64})$")

// IsFromDinghy reports whether a request came from Dinghy. Pass the raw body, before any parsing.
func IsFromDinghy(rawBody []byte, header, secret string) bool {
	match := signaturePattern.FindStringSubmatch(header)
	if match == nil {
		return false
	}
	timestamp, err := strconv.ParseInt(match[1], 10, 64)
	age := time.Now().Unix() - timestamp
	if err != nil || age > toleranceSeconds || age < -toleranceSeconds {
		return false
	}
	received, err := hex.DecodeString(match[2])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(match[1] + "."))
	mac.Write(rawBody)
	return hmac.Equal(mac.Sum(nil), received)
}`,
};

/** Code that checks a webhook request's `Dinghy-Signature` header, in `language`. */
export function webhookVerification(language: WebhookLanguage) {
  return {
    language,
    code: VERIFIERS[language],
    notes: [
      "Dinghy-Signature is t=<unix seconds>,v1=<hex>: the HMAC-SHA256 of `<t>.<raw body>` with the webhook's signing secret, which create_webhook answered once.",
      `Check the raw body before parsing it, compare in constant time, and refuse a t older than ${SIGNATURE_TOLERANCE_SECONDS / 60} minutes.`,
      "Delivery is at least once: drop a repeat by its Dinghy-Event-Id header. Answer 2xx quickly, or Dinghy retries for about a day.",
      "Keep the webhook's secret in the receiver's environment, not in code.",
    ],
  };
}
