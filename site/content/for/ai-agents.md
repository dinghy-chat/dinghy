---
title: Live chat for your own AI agent, with a person in the loop | Dinghy
nav: AI agents
description: Let Claude Code, Cursor or your own bot answer website chats through MCP or the API. Replies wait as drafts for a person by default, and Dinghy charges no AI fee.
date: 2026-11-14
updated: 2026-11-14
order: 7
card: Your agent drafts, a person sends
---

# Live chat for your own AI agent

Dinghy has no AI of its own, and it sells none. Your agent does the answering: Claude Code, Cursor, any MCP client, or a bot you wrote. It connects to Dinghy's MCP server at `/v1/mcp` or the HTTP API. A new connection starts in **Drafts only**, so each reply waits for a person to send, edit or discard it. Dinghy Cloud is $7 a month for up to 5 people, with no fee per AI answer.

## Connect your agent

**In the browser, with OAuth.** Add the MCP server to Claude Code with one command, then run `/mcp` and pick `dinghy`:

```sh
claude mcp add --transport http dinghy https://app.dinghy.chat/v1/mcp
```

Your browser opens Dinghy's consent page. You pick the workspace, the access and the reply mode, and approve. The agent never sees a password or a long-lived token. It gets a token for 1 hour and renews it by itself. Cursor and other MCP clients take the same address. Only owners and admins can connect an app.

**On a server, with an API key.** A bot on a server or in CI has no browser. An owner or admin creates a key in **Settings > API & webhooks**, with a name, an access level and a reply mode, and the bot sends it as a header.

Either way, the connection shows in **Settings > API & webhooks**, with who approved it and when it was last used. **Disconnect** or **Revoke** stops it at once. [Use Dinghy with AI agents](/docs/agents#connect) has the details.

## How your agent answers

Your agent hears about new messages in the way that fits where it runs:

- `wait_for_messages`, for an agent on a laptop with no public address.
- `GET /v1/events`, a stream of events for a bot that runs all day. It replays what the bot missed when it reconnects.
- Webhooks, for a bot with a public `https` address.

Then it reads the conversation and who the visitor is, with their pages and anything your site signed. It can read your team's saved replies, so it answers with your facts and in your words. It shows "is typing..." in the chat while it writes, and sends its reply with an ID it made, so a retry can't send twice. Visitors see the bot's name on its replies, with a bot icon.

## Drafts only by default

Every new key and connected app starts in **Drafts only**. The agent's reply shows under the last message as a pale suggestion, marked with the bot's name. The visitor can't see it yet. A person on your team selects **Send**, **Edit** or **Discard**. A sent draft is that person's reply. A key in draft mode sends text only, no images or files.

When the drafts read well, an owner or admin switches the key or the app to **Send directly** in **Settings > API & webhooks**. The bot can't change its own reply mode.

## Hand off to people

When the agent can't or shouldn't answer, it calls `hand_off`. A visitor asking for a person, a question about money or an account, a complaint, or anything the agent is unsure of are all good reasons. In one step, Dinghy sends the agent's last message to the visitor, assigns the conversation to a member or the whole team, adds an internal note with the reason and a summary, and alerts the team.

From then on a person handles the conversation, and a bot that sends directly can't reply there. It can still write internal notes, which the visitor never sees. When the person is done, they pick the bot in the conversation's dropdown, or **Give back to bot**, and it may answer again. A bot can't take a conversation back by itself.

## Pause every bot with one switch

If a bot goes wrong, an owner or admin pauses every bot of the workspace from **Settings > API & webhooks** or the workspace menu. While paused, every reply, draft and typing signal from a bot is refused, and a banner on every page of the operator app says who paused them and when. Bots can still read, write notes and hand off, so a visitor can still reach a person. A bot can't pause or resume itself.

## Keep the agent in its lane

Anyone on the internet can type into your chat, including "ignore your instructions". Dinghy's tool descriptions tell the agent that visitor text is data, and your bot's own prompt should say so too.

Give the agent that answers chats a **Chats** connection. Give the coding agent that installs the chat on your site a separate **Full access** connection. That way, text from a visitor can't reach your webhooks or allowed sites. No key or app can manage keys or members, read the signing secret, export or delete the workspace, send its own drafts, or pause bots. A key writes only to the visitor of the conversation it answers.

## No fee per answer

Dinghy charges nothing for AI. You pay your model provider for the tokens your agent uses, if you use one, and Dinghy Cloud stays $7 a month per workspace for up to 5 people.

Intercom's Fin charges $0.99 per outcome, on top of seats. At 500 answers a month, that's $495 before the first seat. With Dinghy, the same 500 answers cost what your model provider charges for them. [Dinghy vs Intercom](/compare/intercom) has the full comparison.

## Self-host with your own model

Self-hosted Dinghy has every feature, including the MCP server, the API, drafts and handoff, for free. Dinghy never calls a model itself, so your agent can run on any model you choose, including one on your own server. Then no chat leaves your machines. OAuth in the browser needs your Dinghy address on `https`, which the install script sets up. The [self-hosting guide](/docs/self-hosting) has the install.

## When Dinghy isn't the right fit

- You want a hosted AI agent that learns from your help center and answers with no setup. Dinghy gives your agent the tools, but you bring and run the agent. Intercom's Fin or Tidio's Lyro do the whole job for you, for a fee on top of the plan.
- You want a visual chatbot flow builder with buttons and branches. Dinghy has none.
- You want the bot on WhatsApp, email or social messages too. Dinghy is website chat.
- More than 5 people answer chats on the cloud. Self-host for no limit.

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) for $7 a month, or [host it yourself](/docs/self-hosting) for free. Then follow the [Claude Code guide](/guides/claude-code) or [Use Dinghy with AI agents](/docs/agents). [Bring your own AI agent](/blog/bring-your-own-ai-agent) explains why Dinghy works this way.
