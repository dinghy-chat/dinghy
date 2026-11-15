---
title: Privacy-friendly live chat you can self-host | Dinghy
nav: Privacy
description: What Dinghy's chat widget loads and stores, what the server keeps, and what stays on your server when you self-host. Facts, not legal advice.
date: 2026-11-09
updated: 2026-11-14
order: 6
card: What the widget stores, and what the server keeps
---

# Privacy-friendly live chat

If you host Dinghy yourself, every chat, image, file and visitor record stays on your server. Nothing comes back to us. There's no telemetry and no license check. The widget loads only from your Dinghy address, sets no cookies, and stores nothing in the browser until a visitor uses the chat.

It isn't legal advice, and it doesn't make your site compliant with any law. That depends on how you use it.

## What the widget loads

The tag loads `loader.js` from your Dinghy address. When a visitor opens the chat, the rest of the chat loads from the same address. It talks only to that address, plus a separate address for images and files if you set one up. No fonts, scripts or pixels from anyone else.

The operator app has a live list of visitors. For that, each open tab sends a small beat to your Dinghy address when the page loads, and once a minute while it's visible. A beat holds a random ID that lives only in the page's memory, the page's address without the query string, its title, the referring site on the first beat, and the browser's time zone. Your server looks up the country of the request's address in a database inside the server, then drops the address. If a visitor never chats, their beats stay in Valkey for 90 seconds and never reach Postgres.

Under a Content Security Policy, the widget needs only your Dinghy address in `script-src`, `connect-src` and `img-src`. [The CSP section](/docs/add-to-your-site#if-your-site-has-a-content-security-policy) has the lines.

## What the widget stores in the browser

No cookies. A visitor who never uses the chat gets nothing in `localStorage` or `sessionStorage`. Once they send a message, the widget keeps a token in local storage, under a key that starts with `dinghy:`. That's how their chat is still there after a refresh. It also notes in `sessionStorage` that the chat is open, so a reload in the same tab opens it again. If the browser blocks storage, the chat still works for that page view. `Dinghy.reset()` also writes a short marker there, so other open tabs of your site start over.

If a browser doesn't come back for a year, it starts a new chat. For signed-in users of your app, the widget doesn't store your token at all. Your page passes it again on each load. Call `Dinghy.reset()` at sign-out and the chat ends in that browser.

## What the server keeps

For each visitor, the server keeps:

- The messages, images and files they send.
- The pages they visit once they've started a chat, with each page's title, so your team sees what they were looking at. Only the address and path, never the query string or the part after `#`. A visitor who never chats leaves no page history. The server keeps the newest 100 pages per visitor and deletes them after 90 days.
- A short device line, like "Chrome on macOS", and when they were last seen. Not the full User-Agent.
- Their country and time zone, once they've chatted. Not the IP address it used to find the country.
- An email, only if they type one in, or if your site sends it for a signed-in user.
- Your user ID, name, email and any attributes your server signs, for signed-in users.
- A hash of their browser token, never the token itself.
- The address an email reply came from, if they answer one of your replies from their mail app.
- For signed-out visitors, a keyed hash of their latest IP address, so a block still works after they clear their browser.

While a visitor with an open conversation types, the widget passes their unsent words to your team's open inbox. The server stores none of them. An owner or admin can turn this off in Settings > Workspace, and then the widget sends nothing before a message.

Owners and admins can delete a conversation and its images and files for good, or a contact with all their conversations. An owner can delete the whole workspace. The worker then deletes its conversations, visitors, settings, images and files within minutes. But if you self-host, your nightly backups still hold that data until newer backups replace them.

## Self-hosting keeps the data with you

A self-hosted Dinghy needs no third-party account and no API key, and sends no telemetry. You pick the server and the country it's in.

Dinghy has no AI of its own and sends nothing to an AI service. If you connect your own bot through MCP or the API, it reads conversations with the access you gave it, so the messages go wherever that bot sends them. Run a self-hosted model and they stay on your machines. See [Live chat for AI agents](/for/ai-agents).

Two parts are optional, and both go to services you choose. Email needs a mail server, for sign-in links, reply emails and transcripts. S3 storage is for images, files and backups. Leave both off and Dinghy still works, all on one server.

Phone alerts for your team use web push, which goes through the push service of the operator's browser, like Apple's or Google's. The standard encrypts the payload, so the push service can't read it.

The [self-hosting guide](/docs/self-hosting) has the install. The [architecture page](/docs/architecture) explains how workspaces are kept apart in the database.

## Dinghy Cloud

On Dinghy Cloud, we run the server, so your chats are stored with us. The widget is the same: no cookies, no trackers. If you later want the data on your own machine, an owner downloads an export from Settings > Workspace. It has the conversations, visitors, team, settings, images and files, and it imports into a self-hosted Dinghy. [Moving a workspace](/docs/self-hosting#moving-a-workspace) has the steps.

## When Dinghy isn't the right fit

- You need a vendor to sign specific legal paperwork or certifications for you. Check what you need with your own advisor before you pick any chat tool. If you self-host, that job is yours.
- You can't run a server and need the data in a specific country. [Ask us](mailto:hello@dinghy.chat) where the cloud runs before you sign up.
- You want end-to-end encrypted chat. Dinghy doesn't do that. The server stores messages as they are, so your team can read them in the inbox.

## Get started

[Host it yourself](/docs/self-hosting) for free and keep everything on your server, or [start on Dinghy Cloud](https://app.dinghy.chat/signup) for $7 a month.
