# Coolify and Dokploy

**We have not tested Dinghy on Coolify or Dokploy yet.** This page says how the existing `compose.yaml` should fit them, from how Dinghy works and from their docs. If you try it, tell us what worked and what did not at `hello@dinghy.chat`, or open an issue.

Both platforms run a Docker Compose file and put their own proxy, Traefik, in front of it. Dinghy then runs as it does [behind your own reverse proxy](self-hosting.md#behind-your-own-reverse-proxy): without its own Caddy, with the platform's proxy sending HTTPS traffic to the `app` service on port 3000.

## What to keep

- Use `compose.yaml` from a release tag as it is, such as `v0.15.0`. Do not split it into separate services.
- Keep every service. `init` writes the secrets and exits, `migrate` creates the database roles and runs migrations and exits, and `app` starts only after both. The platform must not report these two exits as failures or restart them.
- Keep the named volumes. Each service mounts only the secrets it needs, and the data lives in `postgres`, `images` and `backups`.
- Do not turn on the `tls` profile. The platform's proxy owns ports 80 and 443, and Caddy would fail to start on them.

## Settings

Set these as the platform's environment variables for the Compose project. `settings.example` lists the others.

| Setting | Value |
|---|---|
| `CHAT_DOMAIN` | The domain you give the `app` service, such as `chat.example.com`. It sets `PUBLIC_URL` to `https://` and this domain, and `TRUSTED_PROXY_HOPS` to 1 |
| `COMPOSE_PROFILES` | Leave it empty |
| `DINGHY_PORT` | A free port on the server, if 3000 is taken. The app binds it on `127.0.0.1` only |

Put no password or secret in these variables. The `init` service creates them on the first start.

If the platform's proxy sits behind Cloudflare's proxy too, set `TRUSTED_PROXY_HOPS` to 2.

## Coolify

1. Create a resource from a Git repository, or from a Docker Compose file, with Dinghy's `compose.yaml`.
2. Give the `app` service your domain with port 3000, such as `https://chat.example.com:3000`. The `:3000` tells Coolify's proxy which container port to use. It does not appear in the address people open.
3. Set the variables above, then deploy.
4. Open a terminal on the `app` container, and run `chat setup` once. It prints a sign-in link, which works once for 15 minutes, and the tag for your site.
5. Restart the `app` service, which turns on web push with the keys that `chat setup` made.

## Dokploy

1. Create a Compose service from Dinghy's repository or its `compose.yaml`, in the plain Docker Compose mode, not Stack mode.
2. Under Domains, add your domain for the `app` service with container port 3000, and turn on HTTPS.
3. Set the variables above, then deploy.
4. Open a terminal on the `app` container, and run `chat setup` once.
5. Restart the `app` service to turn on web push.

## Things to check after the first start

- `https://chat.example.com/readyz` answers.
- You can sign in, and the snippet in Settings uses your domain, not `localhost`.
- A message from the widget on your site reaches the operator app at once. If it arrives late or only after a reload, the proxy buffers the live stream. See [the proxy rules](self-hosting.md#behind-your-own-reverse-proxy).
- An image of a few MB sends.

## Backups

The installer's nightly backup does not exist here. `chat backup` runs in the `migrate` service, which has exited, so a scheduled command inside a running container cannot run it.

If you have a shell on the server, add a cron line that runs `docker compose -p <project> run --rm -T migrate chat backup`, with the project name the platform gave it. `docker compose ls` lists the names and the Compose files. [Backups](self-hosting.md#backups) has the full line, which logs failures. Set `BACKUP_S3_*` to keep a copy off the server.

## Upgrades

Change the image tag or the release tag of the Compose file, and deploy again. A migration runs at each start, under a lock, with a backup first if it would change existing data. Read [the changelog](../CHANGELOG.md) before each upgrade.
