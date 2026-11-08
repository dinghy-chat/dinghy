# Runbooks

What to do when the server breaks. Each part has what you see, how to confirm it and the fix. Run the commands in the folder with `compose.yaml`, which is `/opt/dinghy` after the install script.

## The disk is full

**What you see.** Visitors' messages fail, the app turns unhealthy, or the nightly backup logs `Not enough free disk space for a backup`. Postgres stops accepting writes when the disk is full.

**Confirm it.**

```sh
df -h /
docker system df
docker compose run --rm --entrypoint du migrate -sh /data/backups /data/images
```

**Fix it.**

1. Remove old Docker images, which each upgrade leaves behind: `docker image prune -a`. It keeps the images of running containers.
2. If backups take the space, keep a copy elsewhere first, then remove the oldest ones. List them with `docker compose run --rm --entrypoint ls migrate /data/backups`, and remove one with `docker compose run --rm --entrypoint rm migrate /data/backups/<file>`.
3. Logs rotate by themselves, at 30 MB per container. A container created before your `compose.yaml` had the `logging` setting keeps its old log until it is recreated: `docker compose up -d --force-recreate`.
4. When there is room again, check that Postgres and the app are healthy with `docker compose ps`, then take a backup: `docker compose run --rm -T migrate chat backup`.

For good, move images to S3 (see [Settings](self-hosting.md#settings)), or give the server a bigger disk.

## Postgres is down

**What you see.** `/readyz` answers 503 with `"postgres":"failed"`, and the app logs connection errors.

**Confirm it.**

```sh
docker compose ps postgres
docker compose logs --tail 50 postgres
```

**Fix it.**

- It stopped: `docker compose up -d --wait`.
- The log says the disk is full: see [The disk is full](#the-disk-is-full).
- The log names an older or newer data format: a release moved the Postgres major version. Run `scripts/upgrade-postgres.sh`, as [Upgrading Postgres](self-hosting.md#upgrading-postgres) explains.
- The data is damaged: restore the newest backup, as [Restore](self-hosting.md#restore) explains.

## Valkey is down

**What you see.** `/readyz` still answers 200, with `"valkey":"failed"`. Messages still save, because Postgres holds them, but live updates wait until a client reconnects, and the sign-in limits are off.

**Confirm it.**

```sh
docker compose ps valkey
docker compose logs --tail 50 valkey
```

**Fix it.** `docker compose up -d --wait`. Valkey holds no data worth keeping, so a restart loses nothing, and clients catch up from their last cursor.

## Mail is not sent

**What you see.** Sign-in links, email alerts or replies to visitors who left do not arrive. Until it is fixed, `docker compose exec app chat sign-in-link <email>` prints a link for an operator.

**Confirm it.**

```sh
grep -q '^SMTP_URL=.' .env && echo "SMTP_URL is set" || echo "SMTP_URL is empty"
docker compose logs --since 1h app | grep -i -E 'email|alert failed|smtp'
```

The first command prints no value, because `SMTP_URL` holds a password.

**Fix it.**

- `SMTP_URL` is empty: set it and `MAIL_FROM` in `.env`, then run `docker compose up -d --wait`.
- A refused login or a timeout: check `SMTP_URL`, including the port (587 or 465), and that the server's provider does not block outgoing mail. Many block port 25.
- Mail is sent but lands in spam: the sender domain needs SPF and DKIM records for your mail server.

An alert email that failed is sent again later, so a fixed mail server delivers the backlog. An alert can arrive twice.

## A release does not work

**What you see.** The app does not start after an upgrade, or something that worked before is broken.

**Confirm it.**

```sh
docker compose ps
docker compose logs --tail 100 migrate app
```

**Fix it.** Go back to the release you had, as [Going back](self-hosting.md#going-back) explains. Without a migration, nothing is lost. With one, you restore the backup that `chat migrate` took, and lose what was written since. Then email `hello@dinghy.chat` with the logs, after checking they hold no password.

## Backups fail

**What you see.** `journalctl -t dinghy-backup` shows `FAILED`, or your heartbeat monitor says a night had no backup.

**Confirm it.** Run one by hand and read the error: `docker compose run --rm -T migrate chat backup`.

**Fix it.** A full disk is the usual cause: see [The disk is full](#the-disk-is-full). For an upload error, check the `BACKUP_S3_*` settings and that the key may write to the bucket.
