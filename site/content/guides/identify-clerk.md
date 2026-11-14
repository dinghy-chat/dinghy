---
title: Show signed-in Clerk users in your live chat | Dinghy
nav: Signed-in users: Clerk
description: Tell Dinghy which Clerk user is chatting in a Next.js app. One route signs a token with currentUser(), and a small client component hands it to the chat.
date: 2026-11-09
updated: 2026-11-14
order: 20
card: Show who's chatting with Clerk
logo: clerk
---

# Show signed-in Clerk users in your live chat

If your Next.js app uses Clerk, your team can see who they're talking to in the Dinghy inbox. The chat shows the user's email and name, and their conversation follows them to every device they sign in on.

It takes three pieces. A route signs a short token for the current Clerk user, a client component hands that token to the chat, and sign-out clears the chat in that browser.

## What you need

- The Dinghy tag in `app/layout.tsx`, from the [Next.js guide](/guides/nextjs).
- Clerk set up with `clerkMiddleware()`, as in Clerk's Next.js quickstart. Its default matcher covers `/api` routes, which the token route needs.
- The `jose` package. Install it with `bun add jose` or your package manager.
- Your workspace's signing secret, from Settings > Install in the Dinghy operator app, under Identify signed-in users. Put it in `.env.local` as `DINGHY_SIGNING_SECRET`. It stays on the server.

## 1. Sign a token for the current user

`currentUser()` from `@clerk/nextjs/server` returns the signed-in user in a route handler, or `null` when nobody is signed in.

```ts
// app/api/dinghy-token/route.ts
import { currentUser } from "@clerk/nextjs/server";
import { SignJWT } from "jose";

const secret = new TextEncoder().encode(process.env.DINGHY_SIGNING_SECRET);

export async function POST() {
  const user = await currentUser();
  if (!user) return new Response("Not signed in", { status: 401 });

  const token = await new SignJWT({
    name: user.fullName ?? undefined,
    email: user.primaryEmailAddress?.emailAddress,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("wk_your_public_key")
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);

  return new Response(token);
}
```

Replace `wk_your_public_key` with the `data-key` from your tag. The `sub` is the Clerk user ID, so the same person gets the same chat everywhere. Your team sees the `name` and `email` in the inbox. To show more, like a plan or an org name, add an `attributes` object, up to 2 KB of JSON. A value that starts with `https://` shows as a link.

`currentUser()` calls Clerk's Backend API, and that counts toward Clerk's rate limit. The chat asks for a token once per full page load and again when one expires, so that's a small number of calls per user.

## 2. Hand the token to the chat

Put the queue helper in its own file. If you added `DinghyIdentify` from the Next.js guide, delete it. This file replaces it. The helper works whether or not the chat script has loaded yet:

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

Then a client component that watches Clerk's auth state with `useAuth()`:

```tsx
// app/dinghy-identify.tsx
"use client";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import { dinghy, getDinghyToken } from "@/lib/dinghy";

export function DinghyIdentify() {
  const { isLoaded, userId } = useAuth();
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (userId && userId !== lastUserId.current) dinghy("identify", getDinghyToken);
    if (!userId && lastUserId.current) dinghy("reset");
    lastUserId.current = userId ?? null;
  }, [isLoaded, userId]);

  return null;
}
```

Render it once in `app/layout.tsx`, inside `<ClerkProvider>`, next to the Dinghy `Script`:

```tsx
<DinghyIdentify />
```

The widget gets a function, not a fixed token, so it asks your route for a new token when the old one expires. A tab left open all day keeps working.

## 3. Clear the chat on sign-out

When `userId` goes from a user to `null` without a page reload, the component above calls `Dinghy.reset()`. That ends the chat in this browser, so the next person on a shared computer can't read it. Visitors who never signed in keep their anonymous chat, because the component only resets after it has seen a user.

If your sign-out does a full page load, the component never sees that change. In that case, call reset yourself before signing out:

```tsx
"use client";
import { useClerk } from "@clerk/nextjs";
import { dinghy } from "@/lib/dinghy";

export function SignOutButton() {
  const { signOut } = useClerk();
  return (
    <button
      onClick={() => {
        dinghy("reset");
        signOut({ redirectUrl: "/" });
      }}
    >
      Sign out
    </button>
  );
}
```

## Good to know

If you replace the signing secret in Dinghy, tokens signed with the old one stop working at once, so update `DINGHY_SIGNING_SECRET` at the same time. [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting) has the full token rules, and what happens to a chat the visitor started before signing in. Using another auth library? See the guides for [Supabase](/guides/identify-supabase) and [Better Auth](/guides/identify-better-auth).
