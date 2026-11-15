---
title: Install Dinghy and answer chats with Claude Code | Dinghy
nav: Claude Code
description: Connect Claude Code to Dinghy's MCP server. It adds the chat to your site, checks the install, then drafts replies that your team sends.
date: 2026-11-14
updated: 2026-11-14
order: 13
card: One MCP server to install and to answer
---

# Install Dinghy and answer chats with Claude Code

Dinghy has an MCP server at `/v1/mcp`. Connect Claude Code to it and it can put the chat on your site, check that it loads, and later draft answers to your visitors. Dinghy has no AI of its own. Your team decides which drafts to send.

The examples use `https://chat.example.com`. Use your own Dinghy address, the one in `PUBLIC_URL`. On Dinghy Cloud, it's `https://app.dinghy.chat`.

## Add the server

In your site's repository, run:

```sh
claude mcp add --transport http dinghy https://chat.example.com/v1/mcp
```

Then run `/mcp` in Claude Code and pick `dinghy`. Your browser opens Dinghy's consent page. Sign in if you aren't already.

The page shows the app's name. Under it, it shows the site that published the app, or the website it returns to, when that isn't your own computer. Check that line. Any app can call itself Claude Code.

## Pick Full access to install

On the consent page, choose:

- **The workspace.** You only see workspaces where you're an owner or admin.
- **The access.** Pick **Full access**. It can install Dinghy on a site: the snippet, allowed sites, the widget's look, webhooks and test visitors. **Chats** can only read and answer chats.
- **The reply mode.** Keep **Drafts only**.

Claude Code never sees your password or a secret key. It gets an access token for 1 hour and a refresh token for 30 days, and renews them on its own. The connection shows up in Settings > API & webhooks, and **Disconnect** removes it right away.

## Ask it to add the chat

Tell Claude Code to add Dinghy to your site. It calls the tools in this order:

1. `get_install_snippet` with your framework: `html`, `nextjs`, `react`, `vue`, `rails`, `laravel` or `wordpress`. It gets the code, the file it goes in and where in that file. The public key in it is safe to publish.
2. `add_allowed_site` with your site's origin, like `https://www.example.com`. The chat only loads on allowed sites, and `www` and the bare domain are two origins.
3. You deploy the site.
4. `verify_install` with the origin. It tells you if the origin is allowed, if the chat loaded there, which origins got refused in the last 24 hours, how many tabs have it open right now, and what to do next.

After that, `send_test_message` sends a chat as a test visitor, and `delete_test_visitors` cleans up. Claude Code asks you before it calls `delete_test_visitors`, `remove_allowed_site` or any other tool marked destructive.

In the operator app, the Install page has a "Set up with an agent" row with a prompt to copy.

### Show who is chatting

If your app has accounts, ask for `get_identity_setup` with your server's language. It gives server code that reads the signing secret from `DINGHY_SIGNING_SECRET`. It never gives the secret itself. Copy that yourself from Settings > Install, under Identify signed-in users, into your server's environment.

## Answer chats with a second connection

Give the agent that answers chats its own connection, with **Chats** access and **Drafts only**. A visitor can type anything into your chat. With a Chats connection, their text can't reach the install and webhook tools.

In **Drafts only**, every reply waits under the conversation as a suggestion with the bot's name on it. A person clicks **Send**, **Edit** or **Discard**. The visitor sees nothing until then. Once the drafts are good, an owner or admin can switch the connection to **Send directly** in Settings > API & webhooks. The agent can't change its own reply mode.

On a laptop, Claude Code has no public address. So it hears about new messages with `wait_for_messages`, called in a loop with the last answer's cursor. Then it reads the conversation with `get_conversation`, looks up the visitor with `get_contact`, checks your team's saved replies with `list_saved_replies`, and answers with `reply`.

When it shouldn't answer, like a question about money, an account or a complaint, it calls `hand_off` with a reason and a summary. Dinghy adds them as a note and alerts the teammate it picked, or the whole team. From then on, a person handles it.

An owner or admin can pause every bot with one switch, in Settings > API & webhooks or the workspace menu. Reads, notes and handoffs still work while bots are paused.

## Cursor and other MCP clients

Any client that supports remote HTTP MCP servers with OAuth takes the same URL. Cursor reads it from `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dinghy": { "url": "https://chat.example.com/v1/mcp" }
  }
}
```

A bot on a server or a job in CI has no browser. Give it an API key from Settings > API & webhooks instead, and send it as a `Bearer` header.

## If it can't sign in

Use the address in `PUBLIC_URL` for the MCP URL. A client that connects through another name, like the server's IP address, can't sign in. OAuth also needs `PUBLIC_URL` to be `https`, or a `localhost` address while you develop.

See [Use Dinghy with AI agents](/docs/agents) for the tools, handoff rules and instructions to put in your `AGENTS.md` (Claude Code reads it when your `CLAUDE.md` has `@AGENTS.md`).
