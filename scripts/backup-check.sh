#!/usr/bin/env bash
# Restores backups on clean installs, as a real recovery does, and upgrades from each previous release
# given. Usage:
#   scripts/backup-check.sh <image> [previous-release-image...]
set -euo pipefail

image="${1:?Usage: backup-check.sh <image> [previous-image...]}"
previous_images=("${@:2}")
base_project="dinghy-bk-$$"
base_port=$((39000 + $$ % 500))
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
# shellcheck source=scripts/links.sh
. "$root/scripts/links.sh"
failures=0
site="https://www.example.com"
projects=()
# The smallest real PNG: one pixel.
png_base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
printf '%s' "$png_base64" | base64 -d >"$work/one.png"

pass() { echo "ok - $1"; }
fail() {
  echo "FAILED - $1"
  failures=$((failures + 1))
}
check() { # check <description> <command...>
  local description="$1"
  shift
  if "$@"; then pass "$description"; else fail "$description"; fi
}

compose() { # compose <project> <args...>, with COMPOSE_YAML for another release's file
  local project="$1"
  shift
  docker compose -p "$project" -f "${COMPOSE_YAML:-$root/compose.yaml}" "$@"
}
cleanup() {
  for project in "${projects[@]}"; do
    compose "$project" down -v --remove-orphans >/dev/null 2>&1 || true
  done
  docker rm -f "$base_project-push" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

start() { # start <project> <port> <image>
  projects+=("$1")
  DINGHY_IMAGE="$3" DINGHY_PORT="$2" compose "$1" up -d --wait >"$work/$1.log" 2>&1 || {
    tail -30 "$work/$1.log"
    compose "$1" logs --tail 30 || true
    fail "$1 did not start"
    exit 1
  }
}
setup() { # setup <project>, which sets key and backup_key
  local output
  output="$(compose "$1" exec -T app chat setup --email owner@example.com --name Owner --workspace Acme --origin "$site")"
  key="$(sed -n 's/.*data-key="\([^"]*\)".*/\1/p' <<<"$output")"
  backup_key="$(sed -n 's/^Backup private key, shown only now: //p' <<<"$output")"
}
widget() { curl -sf -H "Origin: $site" "$@"; }
new_visitor() { widget -X POST "http://127.0.0.1:$1/v1/widget/$key/visitors" | sed 's/.*"token":"\([^"]*\)".*/\1/'; }
send() { # send <port> <token> <text>
  widget -H "Authorization: Bearer $2" -H 'content-type: application/json' \
    -d "{\"clientId\":\"$RANDOM$RANDOM\",\"body\":\"$3\"}" "http://127.0.0.1:$1/v1/widget/$key/messages"
}
send_image() { # send_image <port> <token>
  curl -s -H "Origin: $site" -H "Authorization: Bearer $2" -H 'content-type: image/png' \
    --data-binary @"$work/one.png" "http://127.0.0.1:$1/v1/widget/$key/images?clientId=image$RANDOM$RANDOM"
}
read_stream() { # read_stream <port> <token> <query>, for a few seconds
  timeout 4 curl -sN -H "Origin: $site" -H "Authorization: Bearer $2" \
    "http://127.0.0.1:$1/v1/widget/$key/stream$3" || true
}
cursor_of() { sed -n 's/.*"cursor":"\([^"]*\)".*/\1/p' | tail -1; }
sign_in() { # sign_in <project> <port> <jar>: opens a new sign-in link, and prints ok once signed in
  local link
  link="$(DINGHY_IMAGE="$image" DINGHY_PORT="$2" compose "$1" exec -T app chat sign-in-link owner@example.com | link_in)"
  press_link "$link" "$3"
}
take_backup() { # take_backup <project> <port> <image> <file>
  local name output
  output="$(DINGHY_IMAGE="$3" DINGHY_PORT="$2" compose "$1" run --rm -T migrate chat backup)"
  name="$(sed -n 's#^Wrote /data/backups/\(.*\)\.$#\1#p' <<<"$output")"
  DINGHY_IMAGE="$3" DINGHY_PORT="$2" compose "$1" run --rm -T --entrypoint cat migrate "/data/backups/$name" >"$4"
}
restore() { # restore <project> <port> <image> <file> [extra run arguments]
  local project="$1" port="$2" img="$3" file="$4"
  shift 4
  DINGHY_IMAGE="$img" DINGHY_PORT="$port" compose "$project" stop app >/dev/null 2>&1
  DINGHY_IMAGE="$img" DINGHY_PORT="$port" compose "$project" run --rm -T \
    -v "$file:/restore/backup:ro" "$@" migrate chat restore /restore/backup
  DINGHY_IMAGE="$img" DINGHY_PORT="$port" compose "$project" up -d --wait >/dev/null 2>&1
}
image_url() { # image_url <port> <token>, the newest image message's path
  widget -H "Authorization: Bearer $2" "http://127.0.0.1:$1/v1/widget/$key/messages" |
    sed -n 's#.*"url":"http://localhost:[0-9]*\(/v1/files/[^"]*\)".*#\1#p' | tail -1
}
image_opens() { # image_opens <port> <token>
  local path
  path="$(image_url "$1" "$2")"
  [ -n "$path" ] && curl -sf -o "$work/fetched.png" "http://127.0.0.1:$1$path" && cmp -s "$work/fetched.png" "$work/reencoded.png"
}

# ---- A clean host, with images in the local volume.
a="$base_project-a"
a_port=$base_port
start "$a" "$a_port" "$image"
setup "$a"
[ -n "$backup_key" ] && pass "setup prints a backup private key" || fail "setup printed no backup key"
key_a="$key"
token="$(new_visitor "$a_port")"
send "$a_port" "$token" "Hello before the backup" >/dev/null
send_image "$a_port" "$token" >/dev/null
path="$(image_url "$a_port" "$token")"
curl -sf -o "$work/reencoded.png" "http://127.0.0.1:$a_port$path"
old_cursor="$(read_stream "$a_port" "$token" "" | cursor_of)"
[ -n "$old_cursor" ] && pass "a client holds a cursor: $old_cursor" || fail "no cursor before the backup"
jar_a="$work/jar-a"
[ "$(sign_in "$a" "$a_port" "$jar_a")" = ok ] || fail "the owner could not sign in"
workspace="$(curl -sf -b "$jar_a" "http://localhost:$a_port/v1/operator/me" | sed 's/.*"workspaceId":"\([^"]*\)".*/\1/')"
push_key_a="$(curl -sf -b "$jar_a" "http://localhost:$a_port/v1/operator/workspaces/$workspace/alerts" | sed -n 's/.*"pushKey":\("[^"]*"\|null\).*/\1/p')"
DINGHY_IMAGE="$image" DINGHY_PORT="$a_port" compose "$a" restart app >/dev/null 2>&1
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$a_port/readyz" >/dev/null && break; sleep 1; done
sign_in "$a" "$a_port" "$jar_a" >/dev/null
push_key_a="$(curl -sf -b "$jar_a" "http://localhost:$a_port/v1/operator/workspaces/$workspace/alerts" | sed -n 's/.*"pushKey":"\([^"]*\)".*/\1/p')"
take_backup "$a" "$a_port" "$image" "$work/a.tar"
check "the backup is one tar file with the database, images and secrets" \
  sh -c "tar -tf '$work/a.tar' | grep -q '^database.dump\$' && tar -tf '$work/a.tar' | grep -q '^images/' && tar -tf '$work/a.tar' | grep -q '^secrets/auth_secret\$'"
if tar -tf "$work/a.tar" | grep -q 'database_url\|admin'; then fail "the backup holds a database login"; else pass "the backup holds no database login"; fi

# ---- Another clean host, restored from that file.
b="$base_project-b"
b_port=$((base_port + 1))
start "$b" "$b_port" "$image"
restore "$b" "$b_port" "$image" "$work/a.tar" | tail -1 | cut -c1-90
jar_b="$work/jar-b"
key="$key_a"
[ "$(sign_in "$b" "$b_port" "$jar_b")" = ok ] && pass "the owner signs in by link on the new host" || fail "the owner cannot sign in after a restore"
check "the visitor's browser keeps its chat" sh -c "curl -sf -H 'Origin: $site' -H 'Authorization: Bearer $token' 'http://127.0.0.1:$b_port/v1/widget/$key/messages' | grep -q 'Hello before the backup'"
check "an image opens on the new host" image_opens "$b_port" "$token"
push_key_b="$(curl -sf -b "$jar_b" "http://localhost:$b_port/v1/operator/workspaces/$workspace/alerts" | sed -n 's/.*"pushKey":"\([^"]*\)".*/\1/p')"
[ -n "$push_key_b" ] && [ "$push_key_b" = "$push_key_a" ] && pass "the push keys came along, so existing devices keep working" || fail "the push keys changed: '$push_key_a' and '$push_key_b'"

# A real push, from the restored worker, to a stand-in for a push service.
network="${b}_default"
docker run -d --name "$base_project-push" --network "$network" --network-alias fakepush --entrypoint node "$image" \
  -e "require('http').createServer((q,s)=>{console.log('PUSH '+q.url);q.resume();q.on('end',()=>{s.writeHead(201);s.end()})}).listen(8080)" >/dev/null
sleep 1
compose "$b" exec -T postgres psql -U postgres -d dinghy -q -c \
  "insert into push_subscription (operator_id, endpoint, p256dh, auth) select id, 'http://fakepush:8080/device', 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', 'tBHItJI5svbpez7KI4CCXg' from operator limit 1" >/dev/null
send "$b_port" "$token" "Sent after the restore" >/dev/null
pushed=0
for _ in $(seq 1 20); do
  if docker logs "$base_project-push" 2>&1 | grep -q 'PUSH /device'; then
    pushed=1
    break
  fi
  sleep 1
done
[ "$pushed" = 1 ] && pass "the restored server sends a real push" || fail "no push after the restore"

# A cursor from before the restore gets a resync, and then the next message.
stream="$(read_stream "$b_port" "$token" "?after=$old_cursor")"
grep -q 'event: resync' <<<"$stream" && pass "a cursor from before the restore gets a resync" || fail "an old cursor got no resync"
grep -q 'Sent after the restore' <<<"$stream" && pass "that client receives the next message" || fail "an old cursor missed the next message"
cursor_one="$(cursor_of <<<"$stream")"

# The same backup again.
restore "$b" "$b_port" "$image" "$work/a.tar" | tail -1 | cut -c1-60
check "a message from after the backup is gone" sh -c "! curl -sf -H 'Origin: $site' -H 'Authorization: Bearer $token' 'http://127.0.0.1:$b_port/v1/widget/$key/messages' | grep -q 'Sent after the restore'"
send "$b_port" "$token" "After the second restore" >/dev/null
stream="$(read_stream "$b_port" "$token" "?after=$cursor_one")"
grep -q 'event: resync' <<<"$stream" && pass "after restoring one backup twice, the first restore's cursor also gets a resync" || fail "a cursor from the first restore got no resync"
grep -q 'After the second restore' <<<"$stream" && pass "and it receives the next message" || fail "it missed the next message"

# A restore while the app runs is refused, and changes nothing.
if DINGHY_IMAGE="$image" DINGHY_PORT="$b_port" compose "$b" run --rm -T -v "$work/a.tar:/restore/backup:ro" migrate chat restore /restore/backup >"$work/busy.log" 2>&1; then
  fail "a restore ran while the app was connected"
else
  grep -q 'Stop the app first' "$work/busy.log" && pass "a restore refuses to run while the app is connected" || fail "a restore failed for another reason: $(tail -1 "$work/busy.log" | cut -c1-120)"
fi
check "the data is still there after that refusal" sh -c "curl -sf -H 'Origin: $site' -H 'Authorization: Bearer $token' 'http://127.0.0.1:$b_port/v1/widget/$key/messages' | grep -q 'After the second restore'"

# A file that the app's user cannot read gets a clear error.
cp "$work/a.tar" "$work/unreadable.tar"
chmod 000 "$work/unreadable.tar"
DINGHY_IMAGE="$image" DINGHY_PORT="$b_port" compose "$b" stop app >/dev/null 2>&1
if DINGHY_IMAGE="$image" DINGHY_PORT="$b_port" compose "$b" run --rm -T -v "$work/unreadable.tar:/restore/backup:ro" migrate chat restore /restore/backup >"$work/unreadable.log" 2>&1; then
  fail "a restore ran from an unreadable file"
else
  grep -q 'Nothing was restored.*cannot read' "$work/unreadable.log" && pass "an unreadable backup file gets a clear error" || fail "wrong error: $(tail -1 "$work/unreadable.log" | cut -c1-120)"
fi
DINGHY_IMAGE="$image" DINGHY_PORT="$b_port" compose "$b" up -d --wait >/dev/null 2>&1

# A backup from a newer release is refused before the swap, so this host keeps its data.
in_b() { DINGHY_IMAGE="$image" DINGHY_PORT="$b_port" compose "$b" "$@"; }
b_sql() { in_b exec -T postgres psql -U postgres -d dinghy -tAc "$1"; }
b_sql "insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-the-future', 99999999999999)" >/dev/null
take_backup "$b" "$b_port" "$image" "$work/future.tar"
b_sql "delete from drizzle.__drizzle_migrations where hash = 'from-the-future'" >/dev/null
in_b stop app >/dev/null 2>&1
if in_b run --rm -T -v "$work/future.tar:/restore/backup:ro" migrate chat restore /restore/backup >"$work/future.log" 2>&1; then
  fail "a backup from a newer release was restored"
else
  grep -q 'Nothing was restored.*newer release' "$work/future.log" && pass "a backup from a newer release is refused with a clear error" || fail "wrong error: $(tail -1 "$work/future.log" | cut -c1-120)"
fi
in_b up -d --wait >/dev/null 2>&1
check "this host still has its data after that refusal" sh -c "curl -sf -H 'Origin: $site' -H 'Authorization: Bearer $token' 'http://127.0.0.1:$b_port/v1/widget/$key/messages' | grep -q 'After the second restore'"
[ "$(sign_in "$b" "$b_port" "$work/jar-refused")" = ok ] && pass "and its secrets" || fail "the refused restore broke sign-in"

# A restore does not bring back a backup key that this server replaced.
in_b stop app >/dev/null 2>&1
in_b run --rm -T migrate chat backup-key >/dev/null 2>&1
replaced="$(b_sql "select value from instance_setting where key = 'backup_public_key'")"
in_b run --rm -T -v "$work/a.tar:/restore/backup:ro" migrate chat restore /restore/backup >/dev/null 2>&1 || fail "the restore after a new key failed"
after="$(b_sql "select value from instance_setting where key = 'backup_public_key'")"
[ -n "$replaced" ] && [ "$after" = "$replaced" ] && pass "a restore keeps this server's backup key" || fail "a restore brought back the old backup key"
in_b up -d --wait >/dev/null 2>&1

# ---- The encrypted remote copy, and images in a bucket.
c="$base_project-c"
c_port=$((base_port + 2))
projects+=("$c")
rustfs="$(grep -m1 'image: rustfs' "$root/compose.dev.yaml" | sed 's/.*image: //')"
cat >"$work/bucket.yaml" <<YAML
services:
  s3:
    image: $rustfs
    environment:
      RUSTFS_ACCESS_KEY: dinghy-check
      RUSTFS_SECRET_KEY: dinghy-check-secret
YAML
in_bucket_install() {
  env DINGHY_IMAGE="$image" DINGHY_PORT="$c_port" \
    BACKUP_S3_ENDPOINT=http://s3:9000 BACKUP_S3_REGION=us-east-1 BACKUP_S3_BUCKET=dinghy-backups \
    BACKUP_S3_ACCESS_KEY_ID=dinghy-check BACKUP_S3_SECRET_ACCESS_KEY=dinghy-check-secret \
    S3_ENDPOINT=http://s3:9000 S3_REGION=us-east-1 S3_BUCKET=dinghy-images \
    S3_ACCESS_KEY_ID=dinghy-check S3_SECRET_ACCESS_KEY=dinghy-check-secret \
    docker compose -p "$c" -f "$root/compose.yaml" -f "$work/bucket.yaml" "$@"
}
s3() { # s3 <method> <path>: prints the body, from a container on the bucket's network
  docker run --rm --network "${c}_default" --workdir /app/apps/server --entrypoint node "$image" --input-type=module -e "
    import { AwsClient } from 'aws4fetch';
    const c = new AwsClient({ accessKeyId: 'dinghy-check', secretAccessKey: 'dinghy-check-secret', service: 's3', region: 'us-east-1' });
    const r = await c.fetch('http://s3:9000$2', { method: '$1' });
    process.stdout.write(Buffer.from(await r.arrayBuffer()));
    if (!r.ok && r.status !== 409) process.exit(1);"
}
in_bucket_install up -d s3 >/dev/null 2>&1
ready=0
for _ in $(seq 1 30); do
  if s3 PUT /dinghy-backups >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || fail "the bucket did not start"
s3 PUT /dinghy-images >/dev/null
in_bucket_install up -d --wait >"$work/c.log" 2>&1 || {
  tail -20 "$work/c.log"
  fail "the bucket install did not start"
}
setup "$c"
key_c="$key"
secret_key="$backup_key"
token_c="$(new_visitor "$c_port")"
send "$c_port" "$token_c" "A RECOGNIZABLE SECRET MESSAGE" >/dev/null
send_image "$c_port" "$token_c" >/dev/null
path_c="$(image_url "$c_port" "$token_c")"
curl -sf -o "$work/reencoded.png" "http://127.0.0.1:$c_port$path_c"
if ls_images="$(s3 GET '/dinghy-images?list-type=2')" && grep -q "$key_c\|<Key>" <<<"$ls_images"; then
  pass "images go to the bucket in this install"
else
  fail "the bucket holds no image"
fi

output="$(in_bucket_install run --rm -T migrate chat backup)"
grep -q 'Uploaded an encrypted copy' <<<"$output" && pass "a backup uploads an encrypted copy" || fail "no encrypted copy: $output"
remote_name="$(sed -n 's/^Uploaded an encrypted copy: //p' <<<"$output")"
s3 GET "/dinghy-backups/$remote_name" >"$work/remote.enc"
[ -s "$work/remote.enc" ] && pass "the copy is in the bucket" || fail "the copy is empty"
if grep -aq 'RECOGNIZABLE SECRET MESSAGE\|database.dump\|auth_secret' "$work/remote.enc"; then
  fail "the bucket holds plaintext"
else
  pass "the bucket holds no plaintext"
fi
[ "$(head -c 9 "$work/remote.enc")" = DINGHYBK1 ] && pass "it is our encrypted format" || fail "it is not encrypted"

# The server is lost, and the bucket survives.
in_bucket_install stop app postgres valkey >/dev/null 2>&1
in_bucket_install rm -f app postgres valkey init migrate >/dev/null 2>&1
for volume in postgres images backups secrets-postgres secrets-migrate secrets-app secrets-valkey; do
  docker volume rm "${c}_$volume" >/dev/null 2>&1
done
in_bucket_install up -d --wait >"$work/c2.log" 2>&1 || fail "the second bucket host did not start"
in_bucket_install stop app >/dev/null 2>&1

if in_bucket_install run --rm -T -v "$work/remote.enc:/restore/backup:ro" migrate chat restore /restore/backup >"$work/nokey.log" 2>&1; then
  fail "an encrypted restore ran with no key"
else
  grep -q 'BACKUP_PRIVATE_KEY' "$work/nokey.log" && pass "an encrypted restore without the key says what it needs" || fail "wrong error with no key: $(tail -1 "$work/nokey.log" | cut -c1-100)"
fi
if in_bucket_install run --rm -T -e BACKUP_PRIVATE_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -v "$work/remote.enc:/restore/backup:ro" migrate chat restore /restore/backup >"$work/badkey.log" 2>&1; then
  fail "a wrong key opened the backup"
else
  grep -q 'Nothing was restored' "$work/badkey.log" && pass "a wrong key restores nothing" || fail "wrong error with a bad key: $(tail -1 "$work/badkey.log" | cut -c1-100)"
fi
in_bucket_install run --rm -T -e BACKUP_PRIVATE_KEY="$secret_key" -v "$work/remote.enc:/restore/backup:ro" migrate chat restore /restore/backup | tail -1 | cut -c1-90
in_bucket_install up -d --wait >/dev/null 2>&1
key="$key_c"
check "the private key restores the data on a clean host" sh -c "curl -sf -H 'Origin: $site' -H 'Authorization: Bearer $token_c' 'http://127.0.0.1:$c_port/v1/widget/$key/messages' | grep -q 'RECOGNIZABLE SECRET MESSAGE'"
check "an image opens from the bucket after the restore" image_opens "$c_port" "$token_c"

# ---- An upgrade from each previous release keeps data: the first release, and the latest one, which
# is what installs upgrade from.
upgrade=0
for previous in "${previous_images[@]}"; do
  d="$base_project-d$upgrade"
  d_port=$((base_port + 3 + upgrade))
  upgrade=$((upgrade + 1))
  from="${previous##*:}"
  # That release's own compose.yaml, as an install has it until it upgrades.
  previous_yaml="$work/compose-$from.yaml"
  git -C "$root" show "v$from:compose.yaml" >"$previous_yaml"
  COMPOSE_YAML="$previous_yaml" start "$d" "$d_port" "$previous"
  COMPOSE_YAML="$previous_yaml" setup "$d"
  token_d="$(new_visitor "$d_port")"
  send "$d_port" "$token_d" "Written on the previous release" >/dev/null
  send_image "$d_port" "$token_d" >/dev/null
  path_d="$(image_url "$d_port" "$token_d")"
  curl -sf -o "$work/reencoded.png" "http://127.0.0.1:$d_port$path_d"
  COMPOSE_YAML="$previous_yaml" DINGHY_IMAGE="$previous" DINGHY_PORT="$d_port" compose "$d" down >/dev/null 2>&1
  start "$d" "$d_port" "$image"
  check "an upgrade from $from keeps messages" sh -c "curl -sf -H 'Origin: $site' -H 'Authorization: Bearer $token_d' 'http://127.0.0.1:$d_port/v1/widget/$key/messages' | grep -q 'Written on the previous release'"
  check "and images, from $from" image_opens "$d_port" "$token_d"
  noauth="$(DINGHY_IMAGE="$image" DINGHY_PORT="$d_port" compose "$d" exec -T valkey valkey-cli ping 2>&1 || true)"
  grep -q NOAUTH <<<"$noauth" && pass "Valkey has a password after the upgrade from $from" || fail "Valkey answers with no password after the upgrade from $from: $noauth"
  jar_d="$work/jar-d$upgrade"
  [ "$(sign_in "$d" "$d_port" "$jar_d")" = ok ] && pass "and the owner signs in by link, from $from" || fail "the owner cannot sign in after an upgrade from $from"
  # A release with no new migration leaves the data alone, so it takes no backup.
  if DINGHY_IMAGE="$image" DINGHY_PORT="$d_port" compose "$d" logs migrate | grep -q 'The database is up to date'; then
    pass "the upgrade from $from had no migration to run"
  else
    backups="$(DINGHY_IMAGE="$image" DINGHY_PORT="$d_port" compose "$d" run --rm -T --entrypoint ls migrate /data/backups)"
    grep -q 'dinghy-.*\.tar' <<<"$backups" && pass "the upgrade from $from took a backup first" || fail "the upgrade from $from took no backup: $backups"
  fi
  # Going back is refused, and says why. The previous release may not hold this check, so it uses this one.
  DINGHY_IMAGE="$image" DINGHY_PORT="$d_port" compose "$d" exec -T postgres psql -U postgres -d dinghy -q -c \
    "insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-the-future', 99999999999999)" >/dev/null
  if DINGHY_IMAGE="$image" DINGHY_PORT="$d_port" compose "$d" run --rm -T migrate chat migrate >"$work/jump.log" 2>&1; then
    fail "data from a newer release was accepted"
  else
    grep -q 'newer release' "$work/jump.log" && pass "data from a newer release stops with a clear error" || fail "wrong error: $(tail -1 "$work/jump.log" | cut -c1-100)"
  fi
  # Frees the memory before the next release starts.
  DINGHY_IMAGE="$image" DINGHY_PORT="$d_port" compose "$d" down -v >/dev/null 2>&1 || true
done

echo
if [ "$failures" != 0 ]; then
  echo "$failures checks failed"
  exit 1
fi
echo "All checks passed"
