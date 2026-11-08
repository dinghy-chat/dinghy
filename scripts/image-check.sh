#!/usr/bin/env bash
# Checks a built image against real Postgres and Valkey containers. It runs each role, and proves
# the install order, the backup and a clean stop. Usage: scripts/image-check.sh <image> [platform]
set -euo pipefail

image="${1:?Usage: image-check.sh <image> [platform]}"
platform="${2:-}"
name="dinghy-check-$$"
network="$name"
work="$(mktemp -d)"
secrets="$work/secrets"
failures=0
platform_args=()
[ -n "$platform" ] && platform_args=(--platform "$platform")

pass() { echo "ok - $1"; }
fail() {
  echo "FAILED - $1"
  failures=$((failures + 1))
}

cleanup() {
  docker ps -aq --filter "name=$name" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  # Files the container wrote belong to its user, so a container removes them.
  docker run --rm -v "$work:/work" alpine:3 rm -rf /work/backups /work/images >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

newsecret() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

mkdir -p "$secrets" "$work/backups" "$work/images"
for role in migrator app worker backup; do newsecret >"$secrets/$role"; done
admin_password="$(newsecret)"
chmod -R a+rX "$secrets"
chmod 777 "$work/backups" "$work/images"
auth_secret="$(newsecret)$(newsecret)"

docker network create "$network" >/dev/null
docker run -d --name "$name-pg" --network "$network" --network-alias pg \
  -e POSTGRES_PASSWORD="$admin_password" -e POSTGRES_DB=dinghy postgres:18-alpine >/dev/null
docker run -d --name "$name-valkey" --network "$network" --network-alias valkey \
  valkey/valkey:9-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name-pg" pg_isready -U postgres -d dinghy >/dev/null 2>&1 && break
  sleep 1
done

admin_url="postgres://postgres:$admin_password@pg:5432/dinghy"
tool() {
  # As the plan's `docker compose run --rm migrate chat backup` does, with the image's own entrypoint.
  docker run --rm "${platform_args[@]}" --network "$network" \
    -e ADMIN_DATABASE_URL="$admin_url" -e ROLE_SECRETS_DIR=/secrets \
    -v "$secrets:/secrets:ro" -v "$work/backups:/data/backups" \
    "$image" chat "$@"
}
sql() { docker exec "$name-pg" psql -U postgres -d dinghy -tAc "$1"; }

# The image runs as a normal user, with sharp's native part for this architecture.
user="$(docker run --rm "${platform_args[@]}" --entrypoint id "$image" -u)"
[ "$user" != "0" ] && pass "runs as a normal user ($user)" || fail "runs as root"
if docker run --rm "${platform_args[@]}" --workdir /app/apps/server --entrypoint node "$image" \
  --input-type=module -e "import sharp from 'sharp'; \
    const png = await sharp({create:{width:2,height:2,channels:3,background:'#123'}}).png().toBuffer(); \
    const meta = await sharp(png).metadata(); if (meta.width !== 2) process.exit(1);"; then
  pass "sharp processes an image on this architecture"
else
  fail "sharp does not work"
fi

# Instances that start together.
pids=()
for index in 1 2 3; do
  tool migrate >"$work/migrate-$index.log" 2>&1 &
  pids+=($!)
done
migrate_failed=0
for pid in "${pids[@]}"; do wait "$pid" || migrate_failed=1; done
[ "$migrate_failed" = 0 ] && pass "three migrate runs at once all succeed" || {
  cat "$work"/migrate-*.log
  fail "a migrate run failed"
}
ran="$(grep -l 'Ran ' "$work"/migrate-*.log | wc -l)"
[ "$ran" = 1 ] && pass "only one of them ran the migrations" || fail "$ran runs ran migrations"
[ -z "$(ls -A "$work/backups")" ] && pass "a first install takes no backup" || fail "a first install took a backup"

# With nothing pending.
second_run="$(tool migrate)"
grep -q "up to date" <<<"$second_run" && pass "a second run finds nothing to do" || fail "a second run did something"
[ -z "$(ls -A "$work/backups")" ] && pass "no pending migration means no backup" || fail "it took a backup with nothing pending"

# The backup, through the role that holds that credential.
output="$(tool backup)"
file="$(ls "$work/backups" | head -1)"
listing=""
[ -n "$file" ] && listing="$(docker run --rm "${platform_args[@]}" -v "$work/backups:/data/backups" --entrypoint sh "$image" \
  -c "tar -xOf /data/backups/$file database.dump | pg_restore --list")"
# Not a pipe into grep -q, which closes early, and pipefail then reports the writer's broken pipe.
if grep -q "TABLE DATA public message" <<<"$listing"; then
  pass "chat backup writes an archive with a dump that pg_restore can read: $output"
else
  fail "chat backup did not write a readable dump"
fi
mode="$(stat -c %a "$work/backups/$file")"
case "$mode" in
*00) pass "the backup is private ($mode)" ;;
*) fail "the backup has mode $mode" ;;
esac
docker run --rm "${platform_args[@]}" -v "$work/backups:/data/backups" --entrypoint sh "$image" -c 'rm -f /data/backups/*'

# A role cannot do more than it should.
superuser="$(sql "select rolsuper from pg_roles where rolname = 'dinghy_app'")"
[ "$superuser" = "f" ] && pass "the app role is not a superuser" || fail "the app role is a superuser"
owned="$(sql "select count(*) from pg_tables where schemaname = 'public' and tableowner = 'dinghy_app'")"
[ "$owned" = "0" ] && pass "the app role owns no table" || fail "the app role owns $owned tables"

app_url="postgres://dinghy_app:$(cat "$secrets/app")@pg:5432/dinghy"
worker_url="postgres://dinghy_worker:$(cat "$secrets/worker")@pg:5432/dinghy"
run_role() {
  docker run -d "${platform_args[@]}" --name "$name-$1" --network "$network" \
    -e DATABASE_URL="$app_url" -e WORKER_DATABASE_URL="$worker_url" \
    -e VALKEY_URL=redis://valkey:6379 -e AUTH_SECRET="$auth_secret" \
    -e PUBLIC_URL=http://localhost:3000 -e PORT=3000 \
    -v "$work/images:/data/images" -p "127.0.0.1::3000" "$image" "$1" >/dev/null
}

# Each role starts, with no shell in front of it, so a stop reaches Node.
for role in web worker all; do
  run_role "$role"
  case "$role" in
  worker) wanted='worker started' ;;
  all) wanted='worker started' ;;
  *) wanted='listening' ;;
  esac
  started=0
  for _ in $(seq 1 60); do
    if docker logs "$name-$role" 2>&1 | grep -q "$wanted"; then
      started=1
      break
    fi
    sleep 1
  done
  [ "$started" = 1 ] && pass "the $role role starts" || {
    docker logs "$name-$role" 2>&1 | tail -20
    fail "the $role role did not start"
  }
done

port="$(docker port "$name-web" 3000/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$port/readyz" >/dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$port/readyz" >/dev/null && pass "the web role is ready, with real services" || fail "the web role is not ready"
curl -sf "http://127.0.0.1:$port/widget/loader.js" >/dev/null && pass "it serves the widget" || fail "it does not serve the widget"
page="$(curl -sf "http://127.0.0.1:$port/" || true)"
grep -q 'id="root"' <<<"$page" && pass "it serves the operator app" || fail "it does not serve the operator app"

# A stop drains. A workspace and an open stream make this real.
docker exec -e DATABASE_URL="$app_url" -e VALKEY_URL=redis://valkey:6379 -e AUTH_SECRET="$auth_secret" \
  -e PUBLIC_URL=http://localhost:3000 "$name-web" chat create-operator owner@example.com Owner \
  --workspace Check --origin http://check.example.com >"$work/operator.log"
key="$(sql "select public_key from workspace limit 1")"
token="$(curl -sf -X POST -H 'Origin: http://check.example.com' "http://127.0.0.1:$port/v1/widget/$key/visitors" | sed 's/.*"token":"\([^"]*\)".*/\1/')"
curl -sN -H "Authorization: Bearer $token" -H 'Origin: http://check.example.com' \
  "http://127.0.0.1:$port/v1/widget/$key/stream" >"$work/stream.log" &
stream=$!
for _ in $(seq 1 20); do
  grep -q 'event: ready' "$work/stream.log" && break
  sleep 0.5
done
grep -q 'event: ready' "$work/stream.log" && pass "a real stream opens" || fail "the stream did not open"
started_at=$(date +%s)
docker stop -t 10 "$name-web" >/dev/null
took=$(($(date +%s) - started_at))
code="$(docker inspect -f '{{.State.ExitCode}}' "$name-web")"
wait "$stream" 2>/dev/null || true
[ "$code" = "0" ] && pass "the web role exits cleanly on stop (${took}s)" || fail "the web role exited with $code"
[ "$took" -lt 10 ] && pass "it stops before Docker's kill" || fail "it took ${took}s to stop"
grep -q 'event: close' "$work/stream.log" && pass "the stream gets a close event" || fail "the stream got no close event"
for role in worker all; do
  docker stop -t 10 "$name-$role" >/dev/null
  code="$(docker inspect -f '{{.State.ExitCode}}' "$name-$role")"
  [ "$code" = "0" ] && pass "the $role role exits cleanly on stop" || fail "the $role role exited with $code"
done

# The image holds no secret.
environment="$(docker inspect "$image" --format '{{json .Config.Env}}')"
if grep -Eiq 'secret|password|_key=' <<<"$environment"; then
  fail "the image's environment names a secret"
else
  pass "the image's environment holds no secret"
fi

echo
if [ "$failures" != 0 ]; then
  echo "$failures checks failed"
  exit 1
fi
echo "All checks passed"
