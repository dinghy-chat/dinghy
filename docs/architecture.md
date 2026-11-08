# Architecture

How Dinghy's parts fit together, for contributors and for anyone who reviews its security. The code layout is in [`CONTRIBUTING.md`](../CONTRIBUTING.md), and the HTTP API is in [the API page](api.md).

## Processes

```text
 visitors' browsers           operators' browsers
 (widget, Shadow DOM)         (React PWA)
        │  POST to send, SSE to receive  │
        └───────────────┬────────────────┘
                 [ caddy, optional ]
                        │
          [ app: web role + worker role ]──── Valkey: signals, presence, rate limits
                        │
                    Postgres: every saved thing, and the job queue
```

One Docker image runs every process. Its first word picks the role:

- `web` serves the API, the operator app, the widget files and the live streams.
- `worker` runs the background jobs.
- `all` runs both in one Node process. A single server uses this.
- `chat ...` runs a command, such as `chat migrate` or `chat backup`.

Compose adds two one-shot services from the same image: `init` writes the secrets on the first start, and `migrate` creates the database roles and runs the migrations before the app starts. Clients send with `POST` and receive with server-sent events (SSE). There are no WebSockets.

## Tenant isolation

A workspace is a tenant. `operator` and its session tables are global and hold no workspace data. Every other table has a `workspace_id`.

Two layers keep workspaces apart:

1. Every query on a tenant table runs inside `withWorkspace` (`apps/server/src/db/tenant.ts`). It opens a transaction, sets `app.workspace_id`, and the query also filters by `workspace_id`.
2. Row-level security, on every tenant table since the first migration, allows only rows whose `workspace_id` matches `app.workspace_id`.

Table owners and superusers bypass row-level security, so the app never connects as either. `chat migrate` creates four roles (`apps/server/src/db/roles.ts`): `dinghy_migrator` owns the tables and runs migrations, `dinghy_app` and `dinghy_worker` are the `web` and `worker` logins, with `NOBYPASSRLS`, and `dinghy_backup` is the only role that bypasses row-level security, to dump the whole database. `apps/server/src/isolation.test.ts` attacks every route from another workspace.

## Messages, events and cursors

A message and its row in the `event` table commit in one Postgres transaction. The first statement takes the workspace row's lock and increments its event sequence, so the order of the sequence matches the order of commits. A client that holds cursor N can never miss an event below N that commits later.

A cursor is `generation.seq`. A restore or an import gives the workspace a new random generation. A client sends its cursor when it reconnects, and the server replays the events after it. When the cursor's generation is old, or its events were pruned, the server answers `resync`, and the client loads everything again.

Each send carries an ID that the client made. A retry with the same ID returns the first message, so it cannot create a duplicate.

## Live signals

Valkey carries only signals: "workspace W has new events". An instance that holds a stream for W reads the new events from Postgres and sends them. Losing a signal never loses data: the next signal, a reconnect or the stream's end makes the client catch up from its cursor. Presence (which operators are online) and rate-limit counts live only in Valkey, and losing them loses nothing that matters.

Dinghy does not use Postgres `LISTEN/NOTIFY`, because `NOTIFY` takes a global lock at commit. It does not use SQLite, because several instances must share one database.

## The worker's jobs

Background work lives in Postgres tables, and the worker claims rows with `FOR UPDATE SKIP LOCKED` and a claim that expires. So several workers can run at once, and a crashed worker's rows come back after the claim ends. One loop, in `apps/server/src/worker.ts`, runs these in order:

1. Fan out alerts: turn new visitor messages into one delivery per operator device and email.
2. Send the claimed deliveries: web push and email.
3. Delete stored image files that are queued for deletion.
4. Prune old events and finished rows. Events go only from the start of a workspace's feed, so a client can tell a gap from its cursor.
5. Purge workspaces that an owner deleted.

Each step runs on its own, so a step that fails is logged and the others still run. Every 30 seconds at most, a worker records that its loop still finishes, and `/readyz` reports `"worker":"stale"` when no worker did for 5 minutes. On Dinghy Cloud, the subscription lifecycle runs in the same loop with its own 10-minute claim, because one step can wait on Stripe and on email.

Delivery is at least once. A claim counts as an attempt, and a worker that stops after a send but before its commit sends that alert again. A push carries the event's ID as its tag, so the phone replaces the first notification.

## Core and `ee/`

Everything a self-hosted install uses is outside `ee/`. `ee/` holds what only Dinghy Cloud runs: Stripe billing, signup, the plan's limits and image retention. Core reaches it only through `ee/server/index.ts` and the screens in `ee/operator/`, and only when a cloud setting is set (`STRIPE_*` or `CLOUD_SIGNUP`). [`LICENSE-NOTICE.md`](../LICENSE-NOTICE.md) has the licenses.

## Scaling

Add `web` instances behind a load balancer, and one or more `worker` instances. They share Postgres and Valkey, and no instance holds state another needs. [Self-hosting](self-hosting.md#running-more-than-one-instance) has the settings.
