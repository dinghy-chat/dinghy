---
title: Show signed-in Supabase users in your live chat | Dinghy
nav: Signed-in users: Supabase
description: Tell Dinghy which Supabase Auth user is chatting in a Next.js app. A route signs a token after getUser(), and a client component hands it to the chat.
date: 2026-11-09
updated: 2026-11-14
order: 21
card: Show who's chatting with Supabase Auth
logo: supabase
---

# Show signed-in Supabase users in your live chat

If your Next.js app signs people in with Supabase Auth, your team can see who they're talking to in the Dinghy inbox. The chat shows the user's email and name, and their conversation follows them to every device they sign in on.

It takes three pieces. A route signs a short token for the current Supabase user, a client component hands that token to the chat, and sign-out clears the chat in that browser.

## What you need

- The Dinghy tag in `app/layout.tsx`, from the [Next.js guide](/guides/nextjs).
- Supabase Auth set up with `@supabase/ssr`, as in Supabase's Next.js guide. That gives you a server client in `lib/supabase/server.ts`, a browser client in `lib/supabase/client.ts`, and the proxy that refreshes sessions.
- The `jose` package. Install it with `bun add jose` or your package manager.
- Your workspace's signing secret, from Settings > Install in the Dinghy operator app, under Identify signed-in users. Put it in `.env.local` as `DINGHY_SIGNING_SECRET`. It stays on the server.

If you don't have the server client yet, this is the shape of it:

```ts
// lib/supabase/server.ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component. The proxy refreshes the session instead.
          }
        },
      },
    },
  );
}
```

## 1. Sign a token for the current user

Use `getUser()` here. It checks the session with the Supabase Auth server, so a forged cookie can't get a token for someone else.

```ts
// app/api/dinghy-token/route.ts
import { SignJWT } from "jose";
import { createClient } from "@/lib/supabase/server";

const secret = new TextEncoder().encode(process.env.DINGHY_SIGNING_SECRET);

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in", { status: 401 });

  const name = user.user_metadata?.full_name;
  const token = await new SignJWT({
    name: typeof name === "string" ? name : undefined,
    email: user.email,
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

Replace `wk_your_public_key` with the `data-key` from your tag. The `sub` is the Supabase user ID, so the same person gets the same chat everywhere. Google and GitHub sign-ins usually fill `full_name` in the user metadata, and your team sees that `name` in the inbox. If you keep names in a `profiles` table, read it from there instead. To show more, like a plan, add an `attributes` object, up to 2 KB of JSON.

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

Then a client component that listens to Supabase's auth events:

```tsx
// app/dinghy-identify.tsx
"use client";
import { useEffect } from "react";
import { dinghy, getDinghyToken } from "@/lib/dinghy";
import { createClient } from "@/lib/supabase/client";

export function DinghyIdentify() {
  useEffect(() => {
    const supabase = createClient();
    let lastUserId: string | null = null;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        dinghy("reset");
        lastUserId = null;
      } else if (session && session.user.id !== lastUserId) {
        lastUserId = session.user.id;
        dinghy("identify", getDinghyToken);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return null;
}
```

Render it once in `app/layout.tsx`, next to the Dinghy `Script`:

```tsx
<DinghyIdentify />
```

Supabase fires an event when the page loads with a session, and again on sign-in. The `lastUserId` check stops the chat from restarting when Supabase sends the same user twice, which it does when a tab gets focus back.

The widget gets a function, not a fixed token, so it asks your route for a new token when the old one expires. A tab left open all day keeps working.

## 3. Clear the chat on sign-out

When `supabase.auth.signOut()` runs in the browser, Supabase fires `SIGNED_OUT` and the component calls `Dinghy.reset()`. That ends the chat in this browser, so the next person on a shared computer can't read it. Visitors who never signed in keep their anonymous chat, because Supabase only sends `SIGNED_OUT` after a real sign-out.

If you sign out on the server instead, in a route or a server action, the browser gets no event. Call `dinghy("reset")` in the browser before you send that request.

## Good to know

If you replace the signing secret in Dinghy, tokens signed with the old one stop working at once, so update `DINGHY_SIGNING_SECRET` at the same time. [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting) has the full token rules, and what happens to a chat the visitor started before signing in. Using another auth library? See the guides for [Clerk](/guides/identify-clerk) and [Better Auth](/guides/identify-better-auth).
