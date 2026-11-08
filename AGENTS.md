# Dinghy, for coding agents

Read this before you change Dinghy. It is for the agent that writes code for a contributor. `CONTRIBUTING.md` has the setup and the checks, and `docs/architecture.md` explains how the parts fit together.

## What Dinghy is

A small live support chat that a solo founder or a small team runs on one small server, such as a 2 vCPU, 4 GB machine. Visitors chat in a widget on the team's site, and the team answers in the operator app. Dinghy Cloud runs the same code, plus the billing in `ee/`.

Three things matter more than any feature:

1. **Few moving parts.** One Docker image, Postgres and Valkey. Prefer the change with fewer parts, fewer settings and fewer dependencies. Do not add a plugin system, a queue service or a framework for its own sake.
2. **No lost or leaked data.** Every tenant row has a `workspace_id`, and every query on one runs through `withWorkspace` and filters by it. Row-level security is a second layer, not the only one.
3. **Cheap to run.** A change that needs a bigger server, a third-party account or an API key to self-host is not a small change.

## Rules for the code

- TypeScript is strict. Do not use `any` unless nothing else works. Node strips the types at run time, so do not use `enum` or parameter properties.
- Use Bun for packages. Do not use npm, yarn or pnpm, and do not add a second lockfile.
- A message and its event row commit in one transaction. Valkey carries only signals, and a client catches up from its cursor, so a lost signal must never lose data. Do not use `LISTEN/NOTIFY`.
- Background jobs use the event table and `SKIP LOCKED`.
- A send carries an ID that the client made, so a retry cannot create a duplicate.
- Migrations are generated with `bun run db:generate`, go forward only and work on existing data. Grants, policies and functions go in a file from `drizzle-kit generate --custom`.
- Every string a user reads has a key, in `apps/operator/src/text.ts` or `packages/widget/src/text.ts`.
- No secret goes in a default or an example value.
- Code in `packages/` must not import from `apps/`. A product feature goes outside `ee/`. Every file in `ee/` keeps its license line.
- The widget must stay small: `packages/widget/src/size.test.ts` holds the limits.
- Comments say why, not what. Keep functions short, and delete before you add.

## Tests

Tests use a real Postgres and a real Valkey. Do not mock them. Start them with `bun run dev:services`.

A change that fixes a bug or changes behavior comes with a test that fails without it. Before you finish, run `bun run typecheck`, `bun run lint` and `bun run test`, and `bun run test:e2e` for a change to the widget or the operator app. A change to a route, a doc or the schema has one more step, listed in `CONTRIBUTING.md`.

## Pull requests

One pull request solves one problem. A feature needs an issue that a maintainer approved first. Say in the pull request which model and tool did the work.
