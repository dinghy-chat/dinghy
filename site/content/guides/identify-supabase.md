---
title: Show signed-in Supabase users in your live chat | Dinghy
nav: Signed-in users: Supabase
description: Tell Dinghy which Supabase Auth user is chatting in a Next.js app. A route signs a token after getUser(), a client component hands it over.
date: 2026-11-09
updated: 2026-11-14
order: 21
card: Show who's chatting with Supabase Auth
logo: supabase
---

# Show signed-in Supabase users in your live chat

In Dinghy, your team sees the Supabase Auth user's email and name. Their chat follows them to every device they sign in on.

A route signs a short token for the current Supabase user, a client component hands that token to the chat, and sign-out clears the chat in that browser.

## What you need

- The Dinghy tag in `app/layout.tsx`, from the [Next.js guide](/guides/nextjs).
- Supabase Auth set up with `@supabase/ssr`, like in Supabase's Next.js guide. That gives you a server client in `lib/supabase/server.ts`, a browser client in `lib/supabase/client.ts`, and the proxy that refreshes sessions.
- The `jose` package. `bun add jose`, or use your package manager.
- Your workspace's signing secret. It's in Settings > Install in the Dinghy operator app, under Identify signed-in users. Put it in `.env.local` as `DINGHY_SIGNING_SECRET`. It never leaves the server.

No server client yet? It looks like this:

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

Use `getUser()` here. It checks the session with the Supabase Auth server, so nobody gets a token for someone else with a forged cookie.

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

Put the `data-key` from your tag in place of `wk_your_public_key`. The `sub` is the Supabase user ID, so the same person gets the same chat everywhere. Google and GitHub sign-ins usually fill `full_name` in the user metadata, and your team sees that `name` in the inbox. If you keep names in a `profiles` table, read it from there. Want more, like a plan? Add an `attributes` object, up to 2 KB of JSON.

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

Supabase fires an event when the page loads with a session, and again on sign-in. Supabase also sends the same user again when a tab gets focus back. The `lastUserId` check stops the chat from restarting then.

The widget gets a function, not a fixed token. So when a token expires, it asks your route for a new one, and a tab left open all day keeps working.

## 3. Clear the chat on sign-out

When `supabase.auth.signOut()` runs in the browser, Supabase fires `SIGNED_OUT` and the component calls `Dinghy.reset()`. That ends the chat in this browser, so the next person on a shared computer can't read it. Visitors who never signed in keep their anonymous chat. Supabase only sends `SIGNED_OUT` after a real sign-out.

But if you sign out on the server, in a route or a server action, the browser gets no event. Call `dinghy("reset")` in the browser before you send that request.

## Good to know

If you replace the signing secret in Dinghy, tokens signed with the old one stop working right away. Update `DINGHY_SIGNING_SECRET` at the same time. [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting) has the full token rules, and what happens to a chat the visitor started before signing in. Different auth library? See the guides for [Clerk](/guides/identify-clerk) and [Better Auth](/guides/identify-better-auth).
