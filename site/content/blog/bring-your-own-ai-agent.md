---
title: Bring your own AI agent to your live chat | Dinghy
nav: Bring your own AI agent
description: Dinghy has no AI of its own and charges no AI fee, on purpose. Your own agent connects through MCP or the API, drafts replies first, and hands chats to your team.
date: 2026-11-08
updated: 2026-11-14
order: 2
card: Your agent drafts, your team sends, and the price stays flat
---

# Bring your own AI agent to your live chat

Open any live chat's pricing page and count how often you see "AI". Intercom bills per Fin outcome. Tidio sells Lyro conversations. tawk.to has AI Assist. Crisp puts its AI agent in its Plus plan.

Dinghy has no AI of its own, and sells none. That's on purpose. But if you want a bot to answer chats, your own agent can do it, and a person stays in charge by default. Here's how that works, and why we built it this way.

## A person answers by default

If you're a team of one to five, your support is probably your best feature. A customer writes, and the person who built the thing answers.

A bot puts a filter between your customer and you. Some customers are fine with that. Some write to you precisely because they want a person. So in Dinghy, every answer comes from a person unless you connect a bot, and even then, a person approves its replies until you decide otherwise.

## Per-answer AI pricing changes your bill

AI answers cost money every time they happen, so tools pass that cost on, per resolution or per bundle of conversations. That's fair for them. It also means your bill depends on how busy your month was.

Dinghy charges no AI fee. Dinghy Cloud is one flat price, $7 a month for up to 5 people, and a busy month costs the same as a quiet one. If you connect a bot, you pay your own model provider for what it uses, and nothing more to us.

## Your agent connects through MCP or the API

Dinghy has an MCP server at `/v1/mcp` and an HTTP API. Claude Code, Cursor or any MCP client connects with OAuth in the browser: you approve it on Dinghy's consent page, pick a workspace and an access level, and it never sees your password. A bot on a server uses an API key instead.

With that connection, an agent can:

- Read conversations, the visitor's details and the pages they saw.
- Look up your team's saved replies, so it answers with your facts and in your words.
- Reply, or write an internal note that only your team sees.
- With Full access, install the chat on your site and check that it loads. Our [Claude Code guide](/guides/claude-code) walks through it.

## Drafts first

A new key or connection starts in **Drafts only**. The agent's reply waits under the conversation as a suggestion, marked with the bot's name, and the visitor sees nothing yet. A person clicks **Send**, **Edit** or **Discard**.

When its drafts read well, an owner or admin can switch it to **Send directly**. The bot can't change that itself.

## Handoff, and one switch to stop every bot

When the agent can't or shouldn't answer, such as a question about money, an account or a complaint, it hands the conversation to a person. It gives a reason and a summary, Dinghy adds them as a note, and the team gets an alert. From then on, a person handles that chat. A bot in Drafts only may still suggest replies there, and a bot that sends directly stops.

If a bot misbehaves, an owner or admin pauses every bot in the workspace with one switch. Replies and drafts stop at once. Reads, notes and handoffs still work, so a paused bot can still pass a chat to people.

## A bot on a self-hosted install

On your own server, Dinghy still needs no outside account. A bot is an extra you choose: it needs a model provider of your choice, an API key with them, and a bill from them. It also means sending customer messages to that provider, so pick one whose privacy terms you're happy with. Leave the bot out, and nothing changes.

## When to pick a tool with a hosted AI agent

Some teams want a ready-made AI agent, trained on their help center, with no setup. If you get hundreds of the same three questions a day, or need answers at 3 a.m. with nobody to approve them, that can save real hours.

If that's you, look at [Intercom](/compare/intercom) or [Tidio](/compare/tidio). They're good at it.

If you'd rather write your own bot, or have Claude Code answer with you watching, Dinghy gives it the tools and keeps your team in control. [Use Dinghy with AI agents](/docs/agents) has every tool and the safety rules.
