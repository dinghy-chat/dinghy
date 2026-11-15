---
title: Live chat for your own AI agent, with a person in the loop | Dinghy
nav: AI agents
description: Let Claude Code, Cursor or your own bot answer website chats through MCP or the API. Replies wait as drafts for a person by default. No AI fee.
date: 2026-11-14
updated: 2026-11-14
order: 7
card: Your agent drafts, a person sends
---

# Live chat for your own AI agent

Dinghy doesn't have or sell its own AI. Your agent does the answering: Claude Code, Cursor, any MCP client, or a bot you wrote. It connects to Dinghy's MCP server at `/v1/mcp` or to the HTTP API. A new connection starts in **Drafts only**, so every reply waits for a person to send, edit or discard it. Dinghy Cloud is $7 a month for up to 5 people. No fee per AI answer.

## Connect your agent

**In the browser, with OAuth.** Add the MCP server to Claude Code with one command, then run `/mcp` and pick `dinghy`:

```sh
claude mcp add --transport http dinghy https://app.dinghy.chat/v1/mcp
```

Your browser opens Dinghy's consent page. You pick the workspace, the access and the reply mode, and approve. The agent never sees your password or a secret key. It gets a token for 1 hour and renews it itself. Cursor and other MCP clients use the same address. Only owners and admins can connect an app.

**On a server, with an API key.** A bot on a server or in CI has no browser. So an owner or admin creates a key in **Settings > API & webhooks**, with a name, an access level and a reply mode, and the bot sends it as a header.

Both ways, the connection shows up in **Settings > API & webhooks**, with who approved it and when it was last used. **Disconnect** or **Revoke** stops it right away. Details are in [Use Dinghy with AI agents](/docs/agents#connect).

## How your agent answers

Pick how your agent hears about new messages, depending on where it runs:

- `wait_for_messages`, for an agent on a laptop with no public address.
- `GET /v1/events`, a stream of events for a bot that runs all day. When the bot reconnects, it replays what it missed.
- Webhooks, for a bot with a public `https` address.

It reads the conversation, the visitor's details, their pages and anything your site signed. It can read your team's saved replies before it answers. It shows "is typing..." in the chat while it writes. Its reply carries an ID it made, so a retry can't send twice. Visitors see the bot's name on its replies, with a bot icon.

## Drafts only by default

Every new key and connected app starts in **Drafts only**. The agent's reply shows under the last message as a pale suggestion with the bot's name on it. The visitor can't see it yet. Someone on your team picks **Send**, **Edit** or **Discard**. Once sent, a draft counts as that person's reply. A key in draft mode sends text only, no images or files.

When you trust the drafts, an owner or admin switches the key or app to **Send directly** in **Settings > API & webhooks**. The bot can't change its own reply mode.

## Hand off to people

When the agent can't or shouldn't answer, it calls `hand_off`. Good reasons: the visitor asks for a person, a question about money or an account, a complaint, or anything the agent isn't sure about. In one step, Dinghy sends the agent's last message to the visitor, assigns the conversation to a member or the whole team, adds an internal note with the reason and a summary, and alerts the team.

After that a person owns the conversation, and a bot that sends directly can't reply there. It can still write internal notes, which the visitor never sees. When the person is done, they pick the bot in the conversation's dropdown, or **Give back to bot**, and then it can answer again. A bot can't take a conversation back by itself.

## Pause every bot with one switch

If a bot goes wrong, an owner or admin pauses every bot in the workspace from **Settings > API & webhooks** or the workspace menu. While they're paused, Dinghy refuses every reply, draft and typing signal from a bot. A banner on every page of the operator app says who paused them and when. Bots can still read, write notes and hand off, so a visitor can still reach a person. A bot can't pause or resume itself.

## Keep the agent in its lane

Anyone on the internet can type into your chat, including "ignore your instructions". Dinghy's tool descriptions tell the agent that visitor text is data. Your bot's own prompt should say that too.

Give the agent that answers chats a **Chats** connection. Give the coding agent that installs the chat on your site a separate **Full access** connection. Then text from a visitor can't reach your webhooks or allowed sites. No key or app can manage keys or members, read the signing secret, export or delete the workspace, send its own drafts, or pause bots. A key only writes to the visitor of the conversation it's answering.

## No fee per answer

Dinghy charges nothing for AI. If you use a model provider, you pay them for your agent's tokens. Dinghy Cloud stays $7 a month per workspace for up to 5 people.

Intercom's Fin charges $0.99 per outcome, on top of seats. At 500 outcomes a month that's $495, before the first seat. With Dinghy, 500 bot answers cost whatever your model provider charges. Full comparison in [Dinghy vs Intercom](/compare/intercom).

## Self-host with your own model

Self-hosted Dinghy has every feature for free, including the MCP server, the API, drafts and handoff. Dinghy never calls a model itself, so your agent can use any model you want, even one on your own server. Then no chat leaves your machines. OAuth in the browser needs your Dinghy address on `https`, and the install script sets that up. The install is in the [self-hosting guide](/docs/self-hosting).

## When Dinghy isn't the right fit

- You want a hosted AI agent that learns from your help center and answers with no setup. You bring the agent and run it. Intercom's Fin or Tidio's Lyro do the whole job, for a fee on top of the plan.
- You want a visual chatbot flow builder with buttons and branches. Dinghy doesn't have one.
- You want the bot on WhatsApp, email or social messages too. Dinghy is website chat only.
- More than 5 people answer chats on the cloud. Self-host and there's no limit.

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) for $7 a month, or [host it yourself](/docs/self-hosting) for free. Then follow the [Claude Code guide](/guides/claude-code) or [Use Dinghy with AI agents](/docs/agents). I wrote about that choice in [Bring your own AI agent](/blog/bring-your-own-ai-agent).
