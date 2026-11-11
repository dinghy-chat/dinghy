# Self-hosting Dinghy

Dinghy runs on one small server with Docker. It needs no third-party account and no API key. Email and S3 storage are optional.

## The quick way

On a new Linux server, run:

```sh
git clone -b v0.20.0 https://github.com/dinghy-chat/dinghy.git
cd dinghy
sudo ./install.sh
```

The installer asks for your domain, your email, your name, your company and your website. Then it:

1. Installs Docker if it is missing.
2. Checks that your domain points at this server, and that ports 80 and 443 are free.
3. Writes your settings to `.env`, and starts everything with a real HTTPS certificate.
4. Creates your owner login, and adds a nightly backup if the server runs cron. If it cannot, it says so.
5. Prints your backup key, the tag for your website and a sign-in link.

Save the backup key when it prints it, because nothing shows it again. The sign-in link works once, for 15 minutes, and `docker compose exec app chat sign-in-link <email>` prints a new one. Then read [your next steps](README.md).

Leave the domain empty to try Dinghy on this machine, at <http://localhost:3000>. Nobody else can reach it in that mode.

If something stops it, fix what it says and run it again. A second run keeps your settings and your data. `./install.sh --help` shows how to run it with no questions.

If you ran it with `sudo`, and your user is not in the `docker` group, use `sudo docker compose` for the commands in these docs.

This one line does the same on a new server:

```sh
curl -fsSL https://raw.githubusercontent.com/dinghy-chat/dinghy/v0.20.0/install.sh | sudo bash
```

## What you need

- A Linux server. We measured a Hetzner CX23, with 2 vCPUs and 4 GB of memory. The full install used about 185 MB when idle and under 600 MB with 5,000 open streams, as [the measurements](measurements.md) show. We have not tested a smaller server.
- For a real site, a domain with an A record that points at the server, and ports 80 and 443 open. A cloud firewall counts here. On Hetzner, for example, allow both ports in the server's firewall.

The installer has run on Ubuntu 26.04. On a system without `apt`, it uses Docker's own install script.

## Install it by hand

Use this if you already run Docker and want to see each step.

To try it on this machine:

```sh
docker compose up -d --wait
docker compose exec app chat setup
docker compose restart app
```

`chat setup` asks for your email, your name, your company and your website's address. In a script, pass them as `--email`, `--name`, `--workspace` and `--origin`. It prints a sign-in link, which works once for 15 minutes, and the tag to put on your site. The restart turns on web push, with the keys that `chat setup` made. Then open <http://localhost:3000>. If port 3000 is taken, set `DINGHY_PORT` first.

On a server:

```sh
cp settings.example .env
chmod 600 .env
# Set CHAT_DOMAIN in .env, such as chat.example.com.
docker compose --profile tls up -d --wait
docker compose exec app chat setup
docker compose restart app
```

The restart turns on web push, with the keys that `chat setup` made. Sign in at your domain's root, such as `https://chat.example.com`.

The first certificate and each restart take a few seconds, and a request in that time can fail. To check the install, run `curl https://chat.example.com/readyz`.

Keep `.env` next to `compose.yaml`, because every later command reads it. It holds your mail and bucket credentials, so only root and you should read it. To avoid typing the profile each time, set `COMPOSE_PROFILES=tls` in `.env`.

## Settings

All settings go in `.env`, next to `compose.yaml`. After a change, run `docker compose up -d --wait`. `settings.example` lists them all.

| Setting | Purpose |
|---|---|
| `CHAT_DOMAIN` | Your domain, for HTTPS. It also sets `PUBLIC_URL` to `https://` and the domain |
| `PUBLIC_URL` | The address people open, such as `https://chat.example.com`, with no path. Set it only when `CHAT_DOMAIN` does not give the right one, such as behind a proxy on another port. Without either, it is `http://localhost:3000`, and sign-in, the widget tag and links in emails all point there |
| `COMPOSE_PROFILES=tls` | Starts Caddy with every command |
| `DINGHY_PORT` | The local port when there is no domain |
| `SMTP_URL`, `MAIL_FROM` | A mail server, such as `smtp://user:password@mail.example.com:587`. Sign-in links, operator alerts by email and replies to visitors who left all need it. Without one, `chat sign-in-link` makes the sign-in links |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Keeps images in a bucket, not on this disk |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | An encrypted copy of each backup in another place |
| `BACKUP_HEARTBEAT_URL` | An address that `chat backup` pings after each backup that worked, such as a [healthchecks.io](https://healthchecks.io) check, so a monitor tells you when a night has none. Optional |
| `IMAGES_ORIGIN` | A separate origin for images that visitors and operators send, such as `https://files.example.com`. Optional. See below |
| `TRUSTED_PROXY_HOPS` | See below |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` or `silent` |
| `METRICS_TOKEN` | Turns on Prometheus metrics at `/metrics`, with this token as the bearer token. At least 16 characters |
| `WEBHOOK_ALLOW_PRIVATE` | `true` lets [webhooks](api.md#webhooks) go over `http` and to private addresses, such as a service on your own network. Off by default: a webhook then goes only to an `https` address that is on the public internet, checked each time it sends |
| `SENTRY_DSN` | Sends errors to your own [Sentry](https://sentry.io) project: what the server logs as an error, and crashes. It sends no request data, no logs and no traces. Optional. Without it, nothing is sent anywhere |
| `HTTP_PORT`, `HTTPS_PORT` | The ports Caddy listens on with the `tls` profile, 80 and 443 by default. Certificates need those two ports from the internet, so change these only when something in front forwards them here |

Without a mail server, Dinghy still works. Operators sign in with a link that you make for them, with `docker compose exec app chat sign-in-link <email>`, and the sign-in page tells them to ask you. Inviting someone shows you a link instead of emailing it. Someone new who opens it signs in at once, and nothing checks their email, so send each invite link only to the person it is for.

### A separate origin for images

Images come from visitors you do not know. Dinghy re-encodes each one and serves it with headers that stop scripts, but a second origin adds one more wall: nothing served there can ever act as the app. To use one:

1. Point a second hostname at this server, such as `files.example.com`. A different registrable domain, such as `example-files.com`, is stronger still, because it shares no cookies with your site.
2. Have your proxy pass it to the app, like your main domain. The bundled Caddy serves only `CHAT_DOMAIN`, so this needs your own proxy (see below).
3. Set `IMAGES_ORIGIN=https://files.example.com` in `.env`, and run `docker compose up -d`.

Image links then use that origin, with the same short-lived signed URLs. It answers only the image route, and the app's own origin stops serving images. Every image goes out with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff` and `Content-Disposition: inline`, and only as PNG, JPEG or WebP, never as HTML or SVG. A host site with a Content Security Policy must allow the new origin in `img-src` for the widget's images.

## Behind your own reverse proxy

Use this when nginx, Traefik, Caddy or a platform such as Coolify already owns ports 80 and 443. The installer stops when those ports are taken, so install by hand.

1. In `.env`, set `CHAT_DOMAIN` to your domain, and leave `COMPOSE_PROFILES` unset. Without the `tls` profile, Dinghy starts no Caddy and opens no port 80 or 443.
2. Start it with `docker compose up -d --wait`, and run `docker compose exec app chat setup` once.
3. Point your proxy at the app. The app listens on `127.0.0.1:3000` on this machine, or on `app:3000` from a container on the same Docker network. `DINGHY_PORT` changes the port on this machine.

Your proxy must:

- Serve HTTPS for the domain. `CHAT_DOMAIN` makes the app expect `https://` and that domain, and sign-in refuses a request from any other origin. For another address, such as a port, set `PUBLIC_URL` instead.
- Pass the `Host` and `Origin` headers through unchanged, and add the client's address to `X-Forwarded-For`.
- Accept request bodies of at least 6 MB, because an image can be 5 MB. nginx allows 1 MB unless you set `client_max_body_size`.
- Pass `Strict-Transport-Security` through, or set your own. The app sends `max-age=31536000` when `PUBLIC_URL` starts with `https://`, and so does the bundled Caddy. It tells browsers to use HTTPS for a year, so serve the domain over HTTPS first.
- Not buffer the live streams. The app sends `X-Accel-Buffering: no` on them, which nginx follows. Another proxy may need streaming or flushing turned on for `text/event-stream`. A stream sends a heartbeat every 25 seconds, so an idle timeout of 60 seconds or more is enough.

For nginx, the core of a server block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
    client_max_body_size 6m;
}
```

Then set `TRUSTED_PROXY_HOPS` to the number of proxies that add to `X-Forwarded-For`. It decides which address the rate limits and blocks use.

| In front of the app | Value |
|---|---|
| Nothing | 0 |
| Caddy from this file | 1, which is the default when `CHAT_DOMAIN` is set |
| One proxy of your own, such as nginx | 1, which is the default when `CHAT_DOMAIN` is set |
| Cloudflare's proxy, then your own proxy | 2 |

Too low, and all visitors share one address, so one abuser limits everyone. Too high, and a visitor can choose their own address.

To run on Coolify or Dokploy, read [Coolify and Dokploy](deploy-coolify-dokploy.md).

## What each container holds

| Container | Purpose | Secrets it can read |
|---|---|---|
| `init` | Writes the secrets on the first start, and then exits | All, to write them |
| `postgres` | Saved data | The admin password |
| `valkey` | Live signals and rate limit counts, with nothing saved | Its password |
| `migrate` | Creates the database roles and runs migrations, and then exits. Backups and restores run here | The admin, role and backup passwords, and the app's secrets, read and write, for backup and restore |
| `app` | The server and the worker | Its own two database logins, the Valkey login, the auth secret and the web push keys |
| `caddy` | HTTPS, with the `tls` profile | None |

Valkey needs a password. `init` writes it, and the app's `valkey_url` secret holds it. An install from a release before this one gets one on its first start after the upgrade, with nothing to do: `init` writes it, and Valkey and the app restart with it. Valkey still listens only on Compose's private network, so never publish its port.

Every container runs with `no-new-privileges` and drops all Linux capabilities, except the few that `init`, Postgres and Caddy need to set up files and ports. The app's secrets stay writable, because `chat setup` saves the web push keys there.

## Running more than one instance

The image runs in one of three roles, the word after the image in `command`:

- `all`, the default, runs the web server and the worker in one process. One server needs nothing else.
- `web` answers requests and holds the live streams. It needs `DATABASE_URL`, `VALKEY_URL` and `AUTH_SECRET`, as `app` gets them from its secrets. `VALKEY_URL` carries Valkey's password, as `redis://:<password>@valkey:6379`.
- `worker` sends alerts and emails, deletes files and workspaces, and prunes old events. It also needs `WORKER_DATABASE_URL`.

To grow, run more `web` instances behind one load balancer, and one or more `worker` instances. They share Postgres and Valkey, so any instance can answer any request. Several workers are safe, because each claims its jobs with `SKIP LOCKED`. [Architecture](architecture.md) explains how the parts fit together.

## Common commands

| Task | Command |
|---|---|
| List the workspaces and their IDs | `docker compose run --rm migrate chat workspaces` |
| Back up the database | `docker compose run --rm migrate chat backup` |
| Make a sign-in link for an operator | `docker compose exec app chat sign-in-link <email>` |
| Export a workspace | `docker compose exec app chat export <workspace-id> /tmp/export.tar`, then `docker compose cp -a app:/tmp/export.tar .` |
| Import a workspace | `docker compose cp -a export.tar app:/tmp/export.tar`, then `docker compose exec app chat import /tmp/export.tar` |
| Suspend a workspace | `docker compose run --rm migrate chat suspend <workspace-id> [reason]` |
| Lift a suspension | `docker compose run --rm migrate chat unsuspend <workspace-id>` |

`chat workspaces` prints each workspace's ID, public key, state and name. The state is `active`, `suspended`, `read_only`, `waiting_payment` or `waiting_cloud`, the last three only on Dinghy Cloud. `chat setup` also prints the ID of the workspace it creates.

A suspended workspace cannot send messages or images, its widget answers as if it did not exist, and its open chats close at once. Its operators can still sign in, read and export, and a banner tells them it is suspended. The reason is for you, and they do not see it.

## Moving a workspace

An export holds a workspace's conversations, visitors, team, settings and images. It moves a workspace from one Dinghy server to another, such as from the cloud to your own server.

1. On the old server, an owner selects **Download an export** in **Settings > Workspace**. Or run the export command from the table above.
2. Install the new server. If you sign up there with the same email as on the old one, your account joins the imported workspace.
3. Import the file with the import command above. It refuses a workspace that is already on this server.
4. The import names the operators who had no account on this server. They sign in with a link sent to their email, or, with no mail server, one from `docker compose exec app chat sign-in-link <email>`.
5. Change the widget tag on your site to load from the new server's address. The public key and the allowed sites stay the same.
6. The workspace gets a new signing secret. If your site signs users in with a host token, copy the new secret from **Settings > Install** to your site's server, because tokens signed with the old one fail.
7. API keys come in revoked, because their tokens never leave the old server. Create new keys in **Settings > API & webhooks**, and give them to your scripts and AI assistants.
8. An export does not hold webhooks. Add them again in **Settings > API & webhooks**, and give each receiving app its new signing secret.

## Deleting a workspace

An owner deletes a workspace in **Settings > Workspace**, with **Delete workspace**. The dialog gives the number of conversations and images it deletes, and the number of team members who lose access. Their Dinghy accounts stay. It offers **Download an export first**, then asks for the workspace's name. A self-hosted server keeps its last workspace, so the delete is refused when only one is left, and the dialog says why. The workspace is gone for its team and its widget at once. Within a few minutes, the worker deletes its conversations, visitors, settings and images, then the workspace itself. Operator accounts stay, because one login can belong to other workspaces. The nightly backups on this disk still hold the workspace until the newest 7 have replaced them, and a backup bucket keeps it until its own lifecycle rule expires it.

## Backups

`chat backup` writes one private file to the `backups` volume, with the database, the images in local storage and the app's secrets. It keeps the newest 7. It does not hold `.env`, which has your domain and your mail and bucket credentials, so keep a copy of `.env` in a safe place, with your backup key. A backup file and `.env` are all a new server needs. When the server runs cron, the installer adds a nightly run in `/etc/cron.d/dinghy`. If cron is missing, the installer says so and adds nothing.

Each file is about the size of the database plus the images in local storage, and the 7 copies share the disk with Postgres. Plan for 8 times that, because a new copy is written before the oldest goes, and an upgrade adds one. Images in S3 keep backups small. Postgres stops when the disk is full, so a backup refuses to start unless twice its size is free, and says so. Each container keeps at most 30 MB of logs.

The nightly run sends its output to the system log, tagged `dinghy-backup`, and adds a line with `FAILED` when the backup fails. To read it:

```sh
journalctl -t dinghy-backup --since yesterday
```

On a server without journald, look in `/var/log/syslog`. A backup that fails every night looks like a backup that runs, unless someone reads this, so check it now and then, or send that log to your monitoring.

To hear about it without reading logs, set `BACKUP_HEARTBEAT_URL` in `.env` to a dead man's switch, such as a free [healthchecks.io](https://healthchecks.io) check with a period of one day. `chat backup` posts to it only after a backup, and its upload, succeed, so a missing ping is the alert. It prints `Pinged the backup heartbeat.` and never the address, which can hold a token. A monitor that does not answer does not fail the backup.

If you installed by hand, add a line like this to `/etc/cron.d/dinghy`:

```text
17 3 * * * root cd /path/to/dinghy && { docker compose run --rm -T migrate chat backup || logger -p user.err -t dinghy-backup 'The nightly Dinghy backup FAILED.'; } 2>&1 | logger -t dinghy-backup
```

A backup on this disk does not survive the loss of this disk. To keep a copy elsewhere, set `BACKUP_S3_*` in `.env`. Each backup then also uploads a copy encrypted to a public key. `chat setup` printed the private key once. Keep it away from this server, because nothing else can open that copy. If you lost it or set up an earlier release, run `docker compose run --rm migrate chat backup-key`, and take a new backup.

The newest-7 rule covers only this disk, so the backup bucket keeps every copy, including chats you later deleted. Add a lifecycle rule to that bucket to expire old copies.

Images in S3 are not in a backup. That bucket's own durability protects them.

### Restore

This replaces the server's data. Restore only a backup you made. The database dump loads as the role that owns the tables, not as the Postgres administrator, so a dump that holds something only an administrator can make, such as an event trigger, is refused. Of the secrets in the file, only the auth secret and the web push keys are restored. If it fails, the old data stays, and so do the secrets, unless you bind-mounted some of them one by one. Have free space for about three times the backup, plus a second copy of the database, because it unpacks and loads everything before the swap. A backup from a newer release than the image is refused. This server's backup key stays as it is, so a restore cannot bring back a key you replaced.

For a backup that is still on this server, use the name that `chat backup` printed. To list them, run `docker compose run --rm --entrypoint ls migrate /data/backups`.

```sh
docker compose stop app
docker compose run --rm migrate chat restore /data/backups/<file>
docker compose up -d --wait
```

To keep a copy elsewhere yourself, run `docker compose cp migrate:/data/backups/<file> .`. For a file from elsewhere, such as on a new server, the app's user must be able to read it. So give it to user 1000, and mount it:

```sh
sudo chown 1000 <file>
docker compose stop app
docker compose run --rm -v "$PWD/<file>:/restore/backup:ro" migrate chat restore /restore/backup
docker compose up -d --wait
```

For an encrypted copy, pass the private key without putting it in your shell history. Run `read -rs BACKUP_PRIVATE_KEY && export BACKUP_PRIVATE_KEY`, paste the key, and add `-e BACKUP_PRIVATE_KEY` to the `run` command. Open clients catch up by themselves after a restore.

## Upgrading

Read [the changelog](../CHANGELOG.md) first. Then get the new release, and start again:

```sh
git fetch --tags
git switch --detach v0.20.0   # the release you want
docker compose up -d --wait
```

`chat migrate` takes a backup first if a migration would change your data, and prints its path: `Backed up to /data/backups/<file> before migrating`. That file is your way back. `docker compose logs migrate` shows the line again later. If it says `The database is up to date` instead, the release changed no data.

You can move from any release to any later one. If the data comes from a newer release than the image, it stops with a clear error and changes nothing. If a future release drops that promise for very old data, it stops in the same way, and the changelog names the release to go through.

### Going back

If a release does not work for you, go back to the one you had. How depends on whether the upgrade ran a migration.

**No migration ran** (`docker compose logs migrate` says `The database is up to date`). Switch back, and nothing is lost:

```sh
git switch --detach <previous-tag>   # the release you had
docker compose up -d --wait
```

**A migration ran.** The older image refuses the newer data with "This database comes from a newer release", so restore the backup that `chat migrate` took, with the older release:

```sh
docker compose stop app
git switch --detach <previous-tag>   # the release you had
docker compose run --rm migrate chat restore /data/backups/<file>   # the file chat migrate printed
docker compose up -d --wait
```

Messages, conversations and settings changed since that backup are lost, so do it soon, or stay on the new release and wait for a fix. If you no longer have the path, list the backups with `docker compose run --rm --entrypoint ls migrate /data/backups` and take the newest one from before the upgrade.

## Upgrading Postgres

Most releases do not change the Postgres major version. If one does, the release notes say so, and Postgres refuses to start on the old data until you run this, so the app cannot come up on an empty database.

```sh
git switch --detach v0.20.0   # the release that moved Postgres
scripts/upgrade-postgres.sh
```

The script stops the app, takes a normal backup on the old version, loads it on the new version, and starts the app. The app is down for all of that, and the time grows with the database. It needs free space for that backup, plus what a restore needs.

If your own Compose override sets the Postgres `image` or `PGDATA`, remove those lines first, because the script cannot change them.

If any step fails, it says so and your old data is unchanged. Fix the error and run it again, or go back to your previous `compose.yaml`.

The old version's files stay in the `postgres` volume after a success, and the script prints the command to remove them. Until you run that command, your previous `compose.yaml` still runs on them, without the messages written since the upgrade. If you go back and take new messages, the script later stops and tells you to remove the out-of-date copy before you upgrade again. Do not start the new `compose.yaml` before that, because it would run on that copy.

## Keeping it running

A migration runs at each start, under a lock, with a backup first if it would change an install that holds data. The Postgres major version is pinned, because a new major version needs `scripts/upgrade-postgres.sh`.

The secret volumes hold the database passwords that the running install uses. If you lose them, the database on this server cannot be reached. A `chat backup` file and a copy of `.env` restore everything on a new server, because the new install makes its own database passwords, and a restore writes the auth secret and the web push keys from the backup.
