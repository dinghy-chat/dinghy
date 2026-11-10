# Dinghy, for coding agents

Read this before you change Dinghy. It is for the agent that writes code for a contributor. `CONTRIBUTING.md` has the setup and the checks, and `docs/architecture.md` explains how the parts fit together.

## What Dinghy is

A small live support chat that a solo founder or a small team runs on one small server, such as a 2 vCPU, 4 GB machine. Visitors chat in a widget on the team's site, and the team answers in the operator app. Dinghy Cloud runs the same code, plus the billing in `ee/`.

Three things matter more than any feature:

1. **Few moving parts.** One Docker image, Postgres and Valkey. Prefer the change with fewer parts, fewer settings and fewer dependencies. Do not add a plugin system, a queue service or a framework for its own sake.
2. **No lost or leaked data.** Every tenant row has a `workspace_id`, and every query on one runs through `withWorkspace` and filters by it. Row-level security is a second layer, not the only one.
3. **Cheap to run.** A change that needs a bigger server, a third-party account or an API key to self-host is not a small change. Dinghy has no license check and sends no telemetry.

## Rules for the code

- TypeScript is strict. Do not use `any` unless nothing else works. Node strips the types at run time, so do not use `enum` or parameter properties.
- Use Bun for packages. Do not use npm, yarn or pnpm, and do not add a second lockfile.
- A message and its event row commit in one transaction. Valkey carries only signals, and a client catches up from its cursor, so a lost signal must never lose data. Do not use `LISTEN/NOTIFY`.
- Saved data lives in Postgres. Do not add SQLite or another database: several instances share one.
- Background jobs use the event table and `SKIP LOCKED`.
- Alert delivery is at-least-once. Do not claim that an alert is sent exactly once.
- A send carries an ID that the client made, so a retry cannot create a duplicate.
- Migrations are generated with `bun run db:generate`, go forward only and work on existing data. Grants, policies and functions go in a file from `drizzle-kit generate --custom`.
- Every string a user reads has a key, in `apps/operator/src/text.ts` or `packages/widget/src/text.ts`.
- No secret goes in a default or an example value.
- Code in `packages/` must not import from `apps/`. A product feature goes outside `ee/`. Every file in `ee/` keeps its license line.
- The widget must stay small: `packages/widget/src/size.test.ts` holds the limits.
- Every animated boat state also has text, and `prefers-reduced-motion` stops the animation.
- Keep functions short.

## Code quality

- Delete before you add. Remove dead code, unused exports, unused files and unused dependencies in the same pull request that makes them unused. Do not comment code out: git keeps the history.
- Repeat yourself once. Extract a shared function when the third copy appears, and only when the copies change for the same reason. Two similar blocks that serve different features stay separate.
- Build for the callers that exist now, not for one you expect later. No interface with one implementation, no option that no caller passes, no generic parameter that is always the same type.
- Name things after what they hold: `unreadCount`, not `n` or `data`. A boolean reads as a question: `isOpen`, `hasAttachments`. Use the product's words (workspace, operator, visitor, conversation) and one word for each idea.
- No magic values. A number or string with meaning gets a named constant next to the code that uses it, with its unit in the name: `RETRY_DELAY_MS`. A value that a self-hoster may change goes in settings, with a safe default.
- Validate at the edges with Zod and trust the types inside. Do not check again a value that a schema already parsed.
- Make invalid states impossible: a discriminated union beats two optional fields that must not both be set.
- Handle an error where you can do something about it. Do not catch an error only to log it and continue. An error that a user reads has a text key.
- Watch the costs that matter here: one query per list, not one per row; an index for every filter a route uses; no I/O inside a loop when a batch works; no new dependency in the widget. For any other speed-up, show a measurement in the pull request.
- Keep a module's public exports small. Code that other modules import goes through the module's index, not deep paths.
- Comments say why, not what. A comment that repeats the code is noise, and a TODO needs an issue number.
- Match the code around you. If you think a pattern is wrong, change it everywhere in its own pull request, or leave it.

## Tests

Tests use a real Postgres and a real Valkey. Do not mock them. Start them with `bun run dev:services`.

A change that fixes a bug or changes behavior comes with a test that fails without it. Before you finish, run `bun run typecheck`, `bun run lint` and `bun run test`, and `bun run test:e2e` for a change to the widget or the operator app. A change to a route, a doc or the schema has one more step, listed in `CONTRIBUTING.md`.

## Pull requests

One pull request solves one problem. A feature needs an issue that a maintainer approved first. Say in the pull request which model and tool did the work.
