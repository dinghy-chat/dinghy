#!/usr/bin/env bash
# Upgrades a real install by one Postgres major version, with data, including a failed attempt.
# Usage: scripts/upgrade-check.sh <image>
set -euo pipefail

image="${1:?Usage: upgrade-check.sh <image>}"
# The next major version. Move this forward when compose.yaml moves its pin.
next_image="postgres:19rc1-alpine@sha256:0571e712ad11a80278d6850551ae50a224d1e27a0234bbdc7b39e8aed391f924"
next_major=19
old_major=18

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
# shellcheck source=scripts/links.sh
. "$root/scripts/links.sh"
port=$((39600 + $$ % 300))
failures=0
site="https://www.example.com"
base="http://127.0.0.1:$port"
export COMPOSE_PROJECT_NAME="dinghy-upgrade-$$" DINGHY_PORT="$port"

# pg_restore refuses a newer server, so a release that moves the pin also moves the image's client.
# This makes that image, with the next version's client tools in front of today's.
next_app="dinghy-upgrade-check:$$"
docker build -q -t "$next_app" -f - "$work" >/dev/null <<EOF
FROM $image
USER root
RUN apk add --no-cache lz4-libs zstd-libs krb5-libs libldap
COPY --from=$next_image /usr/local/bin/pg_dump /usr/local/bin/pg_restore /usr/local/bin/
COPY --from=$next_image /usr/local/lib/libpq.so.5 /usr/local/lib/
USER node
EOF
export DINGHY_IMAGE="$next_app"

# The release that moves the pin, as an override of today's file.
cat >"$work/next.yaml" <<EOF
services:
  postgres:
    image: \${DINGHY_POSTGRES_IMAGE:-$next_image}
    environment:
      PGDATA: \${DINGHY_POSTGRES_DATA:-/var/lib/postgresql/$next_major/docker}
EOF
current=(docker compose -f "$root/compose.yaml")
next=(docker compose -f "$root/compose.yaml" -f "$work/next.yaml")
upgrade() { COMPOSE_FILE="compose.yaml:$work/next.yaml" "$root/scripts/upgrade-postgres.sh" "$@"; }

pass() { echo "ok - $1"; }
fail() {
  echo "FAILED - $1"
  failures=$((failures + 1))
}
cleanup() {
  "${current[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rmi "$next_app" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

widget() { curl -sf -H "Origin: $site" "$@"; }
send() { # send <text>
  widget -H "Authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"clientId\":\"$RANDOM$RANDOM\",\"body\":\"$1\"}" "$base/v1/widget/$key/messages"
}
messages() { widget -H "Authorization: Bearer $token" "$base/v1/widget/$key/messages"; }
has_message() { messages | grep -q "$1"; }
sign_in() { # opens a new sign-in link, and prints ok once signed in
  local link
  link="$("${current[@]}" exec -T app chat sign-in-link owner@example.com | link_in)"
  press_link "$link"
}
image_opens() {
  local path
  path="$(messages | sed -n 's#.*"url":"http://localhost:[0-9]*\(/v1/files/[^"]*\)".*#\1#p' | tail -1)"
  [ -n "$path" ] && curl -sf -o "$work/fetched.png" "$base$path" && cmp -s "$work/fetched.png" "$work/reencoded.png"
}
run_sql() { # run_sql <compose command...>, with the statement in sql_text
  "$@" exec -T postgres psql -U postgres -d dinghy -tAc "$sql_text"
}
major() { sql_text="show server_version_num" run_sql "$@" | cut -c1-2; }
in_volume() { "${current[@]}" run --rm --no-deps -T --entrypoint sh postgres -c "$1"; }

# ---- A real install on today's version, with data.
"${current[@]}" up -d --wait >"$work/up.log" 2>&1 || {
  tail -30 "$work/up.log"
  fail "the install did not start"
  exit 1
}
setup="$("${current[@]}" exec -T app chat setup --email owner@example.com --name Owner --workspace Acme --origin "$site")"
key="$(sed -n 's/.*data-key="\([^"]*\)".*/\1/p' <<<"$setup")"
token="$(widget -X POST "$base/v1/widget/$key/visitors" | sed 's/.*"token":"\([^"]*\)".*/\1/')"
send "Written on the old version" >/dev/null
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' | base64 -d >"$work/one.png"
curl -s -o /dev/null -H "Origin: $site" -H "Authorization: Bearer $token" -H 'content-type: image/png' \
  --data-binary @"$work/one.png" "$base/v1/widget/$key/images?clientId=image$RANDOM$RANDOM"
path="$(messages | sed -n 's#.*"url":"http://localhost:[0-9]*\(/v1/files/[^"]*\)".*#\1#p' | tail -1)"
curl -sf -o "$work/reencoded.png" "$base$path"
[ "$(major "${current[@]}")" = "$old_major" ] && pass "the install runs on Postgres $old_major" || fail "the install runs on another version"

# ---- With no override and no .env, as the first install in the docs has.
"$root/scripts/upgrade-postgres.sh" >"$work/plain.log" 2>&1 && grep -q "already on Postgres $old_major" "$work/plain.log" && pass "the script runs on a plain install" || fail "the script failed on a plain install: $(tail -1 "$work/plain.log" | cut -c1-120)"

# ---- The new pin with no upgrade: Postgres refuses, so the app cannot come up on an empty database.
"${current[@]}" stop app postgres >/dev/null 2>&1
if "${next[@]}" up -d --wait >"$work/refused.log" 2>&1; then
  fail "the new version started on the old data with no upgrade"
else
  pass "the new version refuses the old data until the upgrade runs"
fi
if curl -sf "$base/readyz" >/dev/null; then fail "the app runs with no upgrade"; else pass "the app stays down"; fi
"${next[@]}" stop >/dev/null 2>&1
"${current[@]}" up -d --wait >/dev/null 2>&1

# ---- A failed upgrade. A table owned by a role that a new server does not have stops the restore.
sql_text="create role stranger; create table blocks_the_restore (id int); alter table blocks_the_restore owner to stranger; grant select on blocks_the_restore to dinghy_backup" \
  run_sql "${current[@]}" >/dev/null
if upgrade >"$work/failed.log" 2>&1; then
  fail "the upgrade passed with a dump that cannot load"
else
  grep -q "Your Postgres $old_major data is unchanged" "$work/failed.log" && pass "a failed upgrade says that the old data is unchanged" || fail "wrong message: $(tail -2 "$work/failed.log" | cut -c1-140)"
fi
grep -q 'blocks_the_restore\|stranger' "$work/failed.log" && pass "the failure came from the restore" || fail "it failed for another reason: $(grep -i error "$work/failed.log" | tail -1 | cut -c1-140)"
listing="$(in_volume "ls /var/lib/postgresql")"
grep -q upgrading <<<"$listing" && fail "a failed upgrade left its working directory" || pass "a failed upgrade leaves no working directory"
in_volume "test ! -e /var/lib/postgresql/$next_major/docker/PG_VERSION" && pass "a failed upgrade leaves no new data" || fail "a failed upgrade left new data"
"${current[@]}" up -d --wait >"$work/back.log" 2>&1 || fail "the old compose.yaml did not start after a failed upgrade"
[ "$(major "${current[@]}")" = "$old_major" ] && has_message "Written on the old version" &&
  pass "the old compose.yaml runs on the old data" || fail "the old data is not usable after a failed upgrade"
[ "$(sign_in)" = ok ] && pass "and the owner can sign in" || fail "sign-in failed after a failed upgrade"
send "Written after the failed upgrade" >/dev/null

# ---- The upgrade again, with the cause gone.
sql_text="drop table blocks_the_restore; drop role stranger" run_sql "${current[@]}" >/dev/null
if upgrade >"$work/upgrade.log" 2>&1; then pass "the upgrade runs"; else
  tail -30 "$work/upgrade.log"
  fail "the upgrade failed"
  exit 1
fi
[ "$(major "${next[@]}")" = "$next_major" ] && pass "the install now runs on Postgres $next_major" || fail "the version did not change"
has_message "Written on the old version" && has_message "Written after the failed upgrade" && pass "the messages came along" || fail "messages are missing"
image_opens && pass "an image opens" || fail "the image does not open"
[ "$(sign_in)" = ok ] && pass "the owner signs in" || fail "the owner cannot sign in after the upgrade"
send "Written on the new version" >/dev/null && has_message "Written on the new version" && pass "a visitor sends a new message" || fail "a new message failed"
owned="$(sql_text="select count(*) from pg_tables where schemaname = 'public' and tableowner = 'dinghy_app'" run_sql "${next[@]}")"
[ "$owned" = 0 ] && pass "the app role still owns no table" || fail "the app role owns $owned tables"
in_volume "test -s /var/lib/postgresql/$old_major/docker/PG_VERSION" && pass "the old version's files stay until the owner removes them" || fail "the old files are gone"

upgrade >"$work/again.log" 2>&1 && grep -q "already on Postgres $next_major" "$work/again.log" && pass "a second run does nothing" || fail "a second run did something: $(tail -1 "$work/again.log" | cut -c1-120)"
"${next[@]}" restart postgres app >/dev/null 2>&1
for _ in $(seq 1 30); do curl -sf "$base/readyz" >/dev/null && break; sleep 1; done
has_message "Written on the new version" && pass "the data survives a restart" || fail "the data is gone after a restart"

# ---- A run that stopped between moving the data and starting the app finishes on the next run.
"${next[@]}" stop app >/dev/null 2>&1
upgrade >"$work/resume.log" 2>&1 && curl -sf "$base/readyz" >/dev/null && pass "a run after a stop starts the app" || fail "a run after a stop did not start the app"

# ---- Going back, taking messages, and upgrading again.
"${next[@]}" stop >/dev/null 2>&1
"${current[@]}" up -d --wait >/dev/null 2>&1
send "Written after going back" >/dev/null
"${current[@]}" stop >/dev/null 2>&1
if upgrade >"$work/stale.log" 2>&1; then
  fail "the upgrade accepted out-of-date new data"
else
  grep -q 'out of date' "$work/stale.log" && pass "after going back, the upgrade stops and says why" || fail "wrong message: $(tail -1 "$work/stale.log" | cut -c1-120)"
fi
in_volume "rm -rf /var/lib/postgresql/$next_major"
upgrade >"$work/second.log" 2>&1 && has_message "Written after going back" && pass "after removing that copy, the upgrade keeps those messages" || fail "the second upgrade lost messages: $(tail -1 "$work/second.log" | cut -c1-120)"

echo
if [ "$failures" != 0 ]; then
  echo "$failures checks failed"
  exit 1
fi
echo "All checks passed"
