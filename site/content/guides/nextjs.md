---
title: How to add a live chat widget to a Next.js app | Dinghy
nav: Next.js
description: Add the Dinghy live chat to a Next.js app with next/script in the root layout. And how to show which signed-in user is chatting.
date: 2026-11-08
updated: 2026-11-14
order: 4
card: next/script in the root layout
logo: nextdotjs
---

# Add live chat to Next.js

In Next.js, the chat goes in your root layout with the built-in `Script` component. It loads once and stays across page changes.

## Get your tag

It's in the Dinghy operator app, under Settings > Install. You need two values from it, the script address and the `data-key`:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

Add your site under Allowed sites in Settings > Install, like `https://www.example.com`. For local work, add `http://localhost:3000` too.

## App Router

In `app/layout.tsx`:

```tsx
import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="https://chat.example.com/widget/loader.js"
          data-key="wk_your_public_key"
          strategy="lazyOnload"
        />
      </body>
    </html>
  );
}
```

`lazyOnload` loads the script when the browser is idle. That's what the Next.js docs suggest for chat widgets. The `data-key` attribute goes straight through to the script tag.

## Pages Router

Same component, in `pages/_app.tsx`:

```tsx
import type { AppProps } from "next/app";
import Script from "next/script";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <Script
        src="https://chat.example.com/widget/loader.js"
        data-key="wk_your_public_key"
        strategy="lazyOnload"
      />
    </>
  );
}
```

## Show who is chatting

If your app has accounts, your server can tell Dinghy who the user is. Then their chat follows them across devices, and your team sees their name and email. You can add `attributes` too, like their plan. The [add to your site](/docs/add-to-your-site#show-who-is-chatting) page shows how.

Your server signs a short token with the workspace's signing secret. It's in Settings > Install, under Identify signed-in users. Keep that secret on the server. Add this route handler with the `jose` package:

```tsx
// app/api/dinghy-token/route.ts
import { SignJWT } from "jose";
import { getUser } from "@/lib/auth"; // your own auth

const secret = new TextEncoder().encode(process.env.DINGHY_SIGNING_SECRET);

export async function POST() {
  const user = await getUser();
  if (!user) return new Response("Not signed in", { status: 401 });
  const token = await new SignJWT({ name: user.name, email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("wk_your_public_key")
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  return new Response(token);
}
```

Then, in a client component that renders for signed-in users:

```tsx
"use client";
import { useEffect } from "react";

declare global {
  interface Window {
    Dinghy?: { q?: unknown[][]; identify?: (token: () => Promise<string>) => void };
  }
}

export function DinghyIdentify() {
  useEffect(() => {
    const getToken = async () => (await fetch("/api/dinghy-token", { method: "POST" })).text();
    if (window.Dinghy?.identify) window.Dinghy.identify(getToken);
    else (window.Dinghy ??= { q: [] }).q?.push(["identify", getToken]);
  }, []);
  return null;
}
```

If the component runs before the chat script loads, the call waits in the queue. When the user signs out, call `Dinghy.reset()`, so the next person on that computer can't read the chat. The full token rules are in [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting).

## If you use a Content Security Policy

Allow your Dinghy address in `script-src`, `connect-src` and `img-src`. Dinghy doesn't need `unsafe-inline`.
