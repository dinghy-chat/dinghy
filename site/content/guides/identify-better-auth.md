---
title: Show signed-in Better Auth users in your live chat | Dinghy
nav: Signed-in users: Better Auth
description: Tell Dinghy which Better Auth user is chatting in a Next.js app. A route signs a token from auth.api.getSession(), a client component passes it on.
date: 2026-11-09
updated: 2026-11-14
order: 22
card: Show who's chatting with Better Auth
logo: betterauth
---

# Show signed-in Better Auth users in your live chat

In Dinghy, your team sees the Better Auth user's email and name. Their chat follows them to every device they sign in on.

A route signs a short token for the current user, a client component hands that token to the chat, and sign-out clears the chat in that browser.

## What you need

- The Dinghy tag in `app/layout.tsx`, from the [Next.js guide](/guides/nextjs).
- Better Auth set up for Next.js, with your server instance in `lib/auth.ts` and a React client in `lib/auth-client.ts` made with `createAuthClient` from `better-auth/react`.
- The `jose` package. `bun add jose`, or use your package manager.
- Your workspace's signing secret. It's in Settings > Install in the Dinghy operator app, under Identify signed-in users. Put it in `.env.local` as `DINGHY_SIGNING_SECRET`. It never leaves the server.

## 1. Sign a token for the current user

`auth.api.getSession()` reads the session from the request's cookies. Pass it the request headers:

```ts
// app/api/dinghy-token/route.ts
import { SignJWT } from "jose";
import { auth } from "@/lib/auth";

const secret = new TextEncoder().encode(process.env.DINGHY_SIGNING_SECRET);

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response("Not signed in", { status: 401 });
  const { user } = session;

  const token = await new SignJWT({ name: user.name, email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("wk_your_public_key")
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);

  return new Response(token);
}
```

Put the `data-key` from your tag in place of `wk_your_public_key`. The `sub` is the Better Auth user ID, so the same person gets the same chat everywhere. Your team sees the `name` and `email` in the inbox. Want more, like a plan or a link to the user in your admin? Add an `attributes` object, up to 2 KB of JSON. A value that starts with `https://` shows as a link.

## 2. Hand the token to the chat

Put the queue helper in its own file. If you already added `DinghyIdentify` from the Next.js guide, delete it, because this replaces it. The helper works whether the chat script has loaded yet or not:

```ts
// lib/dinghy.ts
declare global {
  interface Window {
    Dinghy?: {
      q?: unknown[][];
      identify?: (token: () => Promise<string>) => void;
      reset?: () => void;
    };
  }
}

export const getDinghyToken = async () =>
  (await fetch("/api/dinghy-token", { method: "POST" })).text();

export function dinghy(...call: ["identify", () => Promise<string>] | ["reset"]) {
  const api = (window.Dinghy ??= { q: [] });
  if (api.q) api.q.push(call);
  else if (call[0] === "identify") api.identify?.(call[1]);
  else api.reset?.();
}
```

Then a client component that watches the session with `useSession()`:

```tsx
// app/dinghy-identify.tsx
"use client";
import { useEffect, useRef } from "react";
import { authClient } from "@/lib/auth-client";
import { dinghy, getDinghyToken } from "@/lib/dinghy";

export function DinghyIdentify() {
  const { data: session, isPending } = authClient.useSession();
  const userId = session?.user.id ?? null;
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (isPending) return;
    if (userId && userId !== lastUserId.current) dinghy("identify", getDinghyToken);
    if (!userId && lastUserId.current) dinghy("reset");
    lastUserId.current = userId;
  }, [isPending, userId]);

  return null;
}
```

Render it once in `app/layout.tsx`, next to the Dinghy `Script`:

```tsx
<DinghyIdentify />
```

The widget gets a function, not a fixed token. So when a token expires, it asks your route for a new one, and a tab left open all day keeps working.

## 3. Clear the chat on sign-out

`authClient.signOut()` clears the session on the client too. So `useSession()` goes to `null` and the component calls `Dinghy.reset()`. That ends the chat in this browser, so the next person on a shared computer can't read it. Visitors who never signed in keep their anonymous chat. The component only resets after it has seen a user.

But if your sign-out does a full page load, the component never sees the change. Call reset first:

```ts
import { authClient } from "@/lib/auth-client";
import { dinghy } from "@/lib/dinghy";

export async function signOut() {
  dinghy("reset");
  await authClient.signOut();
}
```

If you sign out on the server, call `dinghy("reset")` in the browser before you send that request.

## Good to know

If you replace the signing secret in Dinghy, tokens signed with the old one stop working right away. Update `DINGHY_SIGNING_SECRET` at the same time. [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting) has the full token rules, and what happens to a chat the visitor started before signing in. Different auth library? See the guides for [Clerk](/guides/identify-clerk) and [Supabase](/guides/identify-supabase).
