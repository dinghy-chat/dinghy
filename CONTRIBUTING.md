# Contributing to Dinghy

Thank you for helping. This page covers the setup, the checks, how the code is laid out, and the contributor license agreement you sign once.

Dinghy stays small on purpose, and review time is short. So:

- A small fix for a clear bug is welcome as a pull request, with a test that fails without it.
- A feature or a change in behavior needs an issue that a maintainer approved first. A pull request without one may be closed, however good it is.
- A security problem goes to `hello@dinghy.chat`, as [`SECURITY.md`](SECURITY.md) says, not to an issue.

If an agent writes your change, point it to [`AGENTS.md`](AGENTS.md).

## Setup

You need [Bun](https://bun.sh) 1.4, Node 24 and Docker with Compose. Bun manages the packages and Node runs the server, so use Bun for every package command, not npm, yarn or pnpm.

```sh
git clone https://github.com/dinghy-chat/dinghy.git
cd dinghy
bun install
bun run dev
```

`bun run dev` starts Postgres, Valkey and an S3-compatible store in Docker, from `compose.dev.yaml`. They listen on `127.0.0.1` only, on ports 55432, 56379 and 59000. Then it creates the database, runs the migrations, bundles the widget and the operator app, and starts the server and the worker.

- The operator app is at <http://localhost:3000>. The first run creates the owner `owner@example.com` and prints its password once. `bun run dev reset-password` prints a new one.
- A test site with the widget is at <http://localhost:3001>. Its messages reach the operator app.
- If port 3000 or 3001 is taken, run `DINGHY_PORT=4000 bun run dev` to use 4000 and 4001.
- Restart it to pick up a change. Ctrl-C stops the server, and `docker compose -f compose.dev.yaml down` stops the services.
- Its files, such as a generated auth secret and the images, live in `.dev/`, which git ignores. Delete that folder and the `dinghy_dev` database to start over.

## Checks

Run these before you open a pull request. The tests use a real Postgres and a real Valkey, so start them first with `bun run dev:services` if `bun run dev` is not running.

```sh
bun run typecheck
bun run lint
bun run test
```

The browser tests use Playwright:

```sh
bun x playwright install chromium
bun run test:e2e
```

`bun run test:e2e --grep @smoke` runs the short set that pull requests run. CI runs the full set every night in Chromium, and the widget's files in Firefox and WebKit too. A red nightly opens an issue.

Each pull request runs typecheck, lint, the migration check, the unit tests and the smoke browser test. A pull request that changes only `site/` runs just the landing page's tests.

Some changes need one more step:

- A change to `apps/server/src/db/schema.ts` needs a migration. Run `bun run db:generate` and commit the new file in `apps/server/drizzle/`. Migrations go forward only, and must work on existing data. Grants, policies and functions go in a file from `bun x drizzle-kit generate --custom`, run in `apps/server`.
- A change to an API route needs a new `apps/server/openapi.json`. Run `bun run openapi:generate`, then `bun x biome format --write apps/server/openapi.json`.
- A change to `docs/*.md` or `docs/media/` needs the site's docs pages rebuilt. Run `bun run docs:build` and commit the files it writes in `site/public/docs/`. The site tests fail when the two differ.
- A change that users see needs a line in `CHANGELOG.md` under Unreleased.

## How the code is laid out

| Path              | What it holds                                                                           | License      |
| ----------------- | --------------------------------------------------------------------------------------- | ------------ |
| `apps/server`     | The Hono server, the worker, the `chat` command line, the Drizzle schema and migrations | AGPL 3.0     |
| `apps/operator`   | The operator app, a React PWA that the server serves                                    | AGPL 3.0     |
| `packages/widget` | The chat widget for websites, in Preact and Shadow DOM, and its loader                  | MIT          |
| `ee`              | Dinghy Cloud's billing, signup, plan limits and image retention, with their tests       | `ee/LICENSE` |
| `tests/e2e`       | Playwright tests that drive the widget and the operator app against a real server       | AGPL 3.0     |
| `tests/*.test.ts` | Checks across the repository, such as the license boundary and the landing page         | AGPL 3.0     |
| `site/`           | The landing page at dinghy.chat                                                         | AGPL 3.0     |
| `docs/`           | The guides for people who run Dinghy                                                    | AGPL 3.0     |
| `scripts/`        | Install, backup, upgrade and capacity checks that CI runs every night                   | AGPL 3.0     |

[`docs/architecture.md`](docs/architecture.md) explains how the parts fit together: the processes, tenant isolation, messages and their events, live signals and the worker's jobs. Read it before a change to any of them. A few rules hold everywhere:

- Every tenant row has a `workspace_id`, and every query on one runs through `withWorkspace` and filters by it. Row-level security is a second layer, not the only one.
- A message and its event commit in one transaction. Valkey carries only signals, so a lost signal never loses data.
- A send carries an ID that the client made, so a retry cannot create a duplicate.
- Every string a user reads has a key, in `apps/operator/src/text.ts` or `packages/widget/src/text.ts`.
- No secret goes in a default or an example value.
- TypeScript is strict. Do not use `any` unless nothing else works.

## Licenses

Dinghy is open core, and [`LICENSE-NOTICE.md`](LICENSE-NOTICE.md) explains the split. The widget in `packages/widget` uses the [MIT license](packages/widget/LICENSE), so any site can embed it. `ee/` holds the code that only Dinghy Cloud runs, under its own source-available [license](ee/LICENSE). Everything else uses the [AGPL 3.0](LICENSE).

- Code in `packages/` must not import from `apps/`, and `tests/license-boundary.test.ts` checks that.
- Code outside `ee/` reaches it only through `ee/server/index.ts` and the cloud's screens in `ee/operator/`, and only when the cloud's settings are set. The image ships `ee/`, and a self-hosted install never turns it on, so a product feature goes outside it.
- Every file in `ee/` starts with a line that points to `ee/LICENSE`.

## Sign the contributor license agreement

Before we can merge your first pull request, you sign the [contributor license agreement](CLA.md) (CLA). You keep the copyright in your work, and you give OnceByte, LLC, which runs Dinghy, the right to use it and to release it under other licenses too, such as the code under `ee/LICENSE`.

You sign once, on the pull request. A bot comments with the steps: reply with the sentence it gives you, and the check turns green. It covers your later pull requests too.

## Pull requests

- Keep one pull request to one change, with its tests.
- Say what it changes and how you checked it. The template asks for both.
- Tests use the real Postgres and Valkey. Do not mock them.
