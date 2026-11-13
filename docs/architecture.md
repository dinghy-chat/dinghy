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

A workspace is a tenant. `operator`, its picture, its two-step sign-in and its session tables are global and hold no workspace data. An export leaves the two-step sign-in out, because it belongs to the account. Its TOTP secret is encrypted with AES-256-GCM, with a key derived from `AUTH_SECRET` by HKDF, and its recovery codes are stored as keyed hashes. The operator's `two_factor_on` column says whether it is on, so BetterAuth's one session query also gives the second step's state. A recovery request is global as well: one table, one waiting request per account, which the worker completes after 72 hours. Every other table has a `workspace_id`.

Two layers keep workspaces apart:

1. Every query on a tenant table runs inside `withWorkspace` (`apps/server/src/db/tenant.ts`). It opens a transaction, sets `app.workspace_id`, and the query also filters by `workspace_id`.
2. Row-level security, on every tenant table since the first migration, allows only rows whose `workspace_id` matches `app.workspace_id`.

Table owners and superusers bypass row-level security, so the app never connects as either. `chat migrate` creates four roles (`apps/server/src/db/roles.ts`): `dinghy_migrator` owns the tables and runs migrations, `dinghy_app` and `dinghy_worker` are the `web` and `worker` logins, with `NOBYPASSRLS`, and `dinghy_backup` is the only role that bypasses row-level security, to dump the whole database. `apps/server/src/isolation.test.ts` attacks every route from another workspace.

A workspace API key (`dk_...`) names its workspace in the token, so its lookup runs under that workspace's policy too. So does an OAuth access token (`dko_...`): an approved OAuth grant is a row in `api_key`, so it works as a key of its level. The member check (`apps/server/src/member.ts`) gives a key a member's role in its own workspace and nothing anywhere else, and lets it call only the routes whose OpenAPI `security` lists `apiKey`. MCP at `/v1/mcp` calls the same functions as those routes.

## Messages, events and cursors

A message and its row in the `event` table commit in one Postgres transaction. The first statement takes the workspace row's lock and increments its event sequence, so the order of the sequence matches the order of commits. A client that holds cursor N can never miss an event below N that commits later.

An edit or a delete keeps the message's row and its `seq`, and writes its own event in the same transaction. The message keeps that event's sequence as its change position, and the widget's stream reads messages by change position, so a visitor's cursor also catches every later edit or delete. The operator app reloads a conversation's messages when a `message.updated` or `message.deleted` change names it.

A cursor is `generation.seq`. A restore or an import gives the workspace a new random generation. A client sends its cursor when it reconnects, and the server replays the events after it. When the cursor's generation is old, or its events were pruned, the server answers `resync`, and the client loads everything again.

Each send carries an ID that the client made. A retry with the same ID returns the first message, so it cannot create a duplicate.

A visitor's reply by email comes the same way. A mail forwarder posts the raw email to the web side, signed, and `apps/server/src/inbound-email.ts` writes it as the visitor's messages with `appendMessage`, under the same lock. The reply address names its workspace, as a chat link's token does, so the lookup runs in that workspace's transaction, and its stored conversation is the only one the message can go to. The email's `Message-ID` gives the client ID, so a forwarder's retry finds the first messages. No queue holds the email: the forwarder keeps it until Dinghy answers.

## The widget's settings

How a workspace's widget looks and behaves lives in `widget_settings`, one row per workspace, made in the same transaction as the workspace. Typed columns let the database check each value and hold the defaults. The row is apart from `workspace`, because every message takes the workspace row's lock for its sequence, and a save must not wait for that lock or hold it.

The loader asks for them on each page view at `GET /v1/widget/{key}/appearance`, which any site may read and a browser keeps for 5 minutes, then draws the launcher. The chat bundle uses the same answer. The snippet's attributes and `Dinghy.configure()` win over it. The answer also names up to 3 members who replied last, by first name and picture, so its ETag hashes the whole answer rather than the row's change time.

A logo and an operator's picture are small WebP files in Postgres, in `workspace_logo` and `operator_picture`, and do not count as file storage. Their addresses carry the upload's time, so they cache for good.

## Live signals

Valkey carries only signals: "workspace W has new events". An instance that holds a stream for W reads the new events from Postgres and sends them. Losing a signal never loses data: the next signal, a reconnect or the stream's end makes the client catch up from its cursor. Presence (which operators are online) and rate-limit counts live only in Valkey, and losing them loses nothing that matters.

Dinghy does not use Postgres `LISTEN/NOTIFY`, because `NOTIFY` takes a global lock at commit. It does not use SQLite, because several instances must share one database.

## The worker's jobs

Background work lives in Postgres tables, and the worker claims rows with `FOR UPDATE SKIP LOCKED` and a claim that expires. So several workers can run at once, and a crashed worker's rows come back after the claim ends. One loop, in `apps/server/src/worker.ts`, runs these in order:

1. Fan out alerts: turn new visitor messages into one delivery per operator device and email.
2. Fan out webhooks: turn each event that a workspace's webhooks asked for into one delivery per webhook. An event is flagged for this only when its workspace had an enabled webhook when it committed.
3. Send the claimed deliveries: web push, email and webhooks. Webhooks have their own slots, so a slow receiver never holds an alert back.
4. Delete stored images and files that are queued for deletion.
5. Prune old events and finished rows, expired chat links and reply addresses unused for 90 days. Events go only from the start of a workspace's feed, so a client can tell a gap from its cursor.
6. Purge workspaces that an owner deleted.

The purge is the Postgres function `purge_deleted_workspaces()`. Older tables have a `DELETE` line in it. A new table that a workspace owns declares its `workspace_id` with `ownedByWorkspace()` in `schema.ts` instead. That references `workspace` with `ON DELETE CASCADE`, so its rows go with the workspace row and a new feature does not rewrite the function.

Each step runs on its own, so a step that fails is logged and the others still run. Every 30 seconds at most, a worker records that its loop still finishes, and `/readyz` reports `"worker":"stale"` when no worker did for 5 minutes. On Dinghy Cloud, the subscription lifecycle runs in the same loop with its own 10-minute claim, because one step can wait on Stripe and on email.

A webhook checks every address its host resolves to when it connects, so a name that later points at a private address cannot reach this server's network.

Delivery is at least once. A claim counts as an attempt, and a worker that stops after a send but before its commit sends that alert again. A push carries the event's ID as its tag, so the phone replaces the first notification.

## Core and `ee/`

Everything a self-hosted install uses is outside `ee/`. `ee/` holds what only Dinghy Cloud runs: Stripe billing, signup, the welcome chat, the plan's limits and the 12-month retention of images and files. Core reaches it only through `ee/server/index.ts` and the screens in `ee/operator/`, and only when a cloud setting is set (`STRIPE_*` or `CLOUD_SIGNUP`). [`LICENSE-NOTICE.md`](../LICENSE-NOTICE.md) has the licenses.

The welcome chat needs two more cloud settings, and is off unless both are set. A self-hosted install leaves them unset.

- `CLOUD_WELCOME_WORKSPACE_ID`: Dinghy's own workspace on the same server.
- `CLOUD_WELCOME_OPERATOR_EMAIL`: the operator there who sends the welcome. The web role refuses to start when this operator is not an active member of that workspace.

Each new cloud workspace then starts with one open conversation from that operator, and Dinghy's workspace gets the other side, assigned to them. The two conversations are linked in `welcome_link`, which both workspaces' row-level security lets them read. An operator's or an API key's reply on one side is copied, in the reply's own transaction, as a visitor message on the other side. Visitor messages are never copied, so a copy never makes another. A reply takes both workspace row locks in one order, so two replies that cross cannot deadlock. Nothing is copied when either side blocked its visitor or the other workspace is suspended or deleted, and the reply still goes. The welcome chat is the one exception to the payment states: it takes messages while its workspace waits for its first payment or is read-only, so a copy waits in that inbox, and an operator of a read-only workspace can still reply there in text. An image or a file is copied under the receiving workspace's own key, within its storage limit. Analytics leave welcome chats out, an export leaves the link out, and a deleted workspace's links go with its conversations.

## Scaling

Add `web` instances behind a load balancer, and one or more `worker` instances. They share Postgres and Valkey, and no instance holds state another needs. [Self-hosting](self-hosting.md#running-more-than-one-instance) has the settings.
