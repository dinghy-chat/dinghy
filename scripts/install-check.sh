#!/usr/bin/env bash
# Installs Dinghy from compose.yaml as a new owner would, sends a message, and checks that the install
# keeps its promises. Usage: scripts/install-check.sh <image>
set -euo pipefail

image="${1:?Usage: install-check.sh <image>}"
project="dinghy-install-$$"
port=$((38000 + $$ % 1000))
# No PUBLIC_URL, because the app must get its address from the published port.
export DINGHY_IMAGE="$image" DINGHY_PORT="$port"
compose=(docker compose -p "$project" -f "$(dirname "$0")/../compose.yaml")
failures=0
site="https://www.example.com"
base="http://127.0.0.1:$port"
work="$(mktemp -d)"
# shellcheck source=scripts/links.sh
. "$(dirname "$0")/links.sh"

pass() { echo "ok - $1"; }
fail() {
  echo "FAILED - $1"
  failures=$((failures + 1))
}
cleanup() {
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

config="$("${compose[@]}" config --format json)"
if grep -Eiq '"(POSTGRES_PASSWORD|AUTH_SECRET|DATABASE_URL)"' <<<"$config"; then
  fail "compose.yaml sets a secret directly"
else
  pass "compose.yaml sets no password or secret"
fi

"${compose[@]}" up -d --wait >"$work/up.log" 2>&1 || {
  tail -30 "$work/up.log"
  "${compose[@]}" logs --tail 40 || true
  fail "the install did not start"
  exit 1
}
pass "docker compose up starts everything, with no account and no settings"

setup="$("${compose[@]}" exec -T app chat setup --email owner@example.com --name Owner --workspace Acme --origin "$site")"
link="$(link_in <<<"$setup")"
key="$(sed -n 's/.*data-key="\([^"]*\)".*/\1/p' <<<"$setup")"
[ -n "$link" ] && [ -n "$key" ] && pass "chat setup prints a sign-in link and the snippet" || fail "chat setup printed no link or snippet"
grep -qi 'password' <<<"$setup" && fail "chat setup still mentions a password" || pass "chat setup prints no password"
if "${compose[@]}" exec -T app chat setup --email other@example.com --name Other --workspace Other --origin "$site" >/dev/null 2>&1; then
  fail "a second chat setup ran"
else
  pass "chat setup runs once"
fi

# A visitor sends a message, through the routes the widget uses.
widget() { curl -sf -H "Origin: $site" -H 'content-type: application/json' "$@"; }
visitor="$(widget -X POST "$base/v1/widget/$key/visitors")"
token="$(sed 's/.*"token":"\([^"]*\)".*/\1/' <<<"$visitor")"
sent="$(widget -H "Authorization: Bearer $token" -d '{"clientId":"install-check","body":"Hello from the install check"}' "$base/v1/widget/$key/messages")"
grep -q '"id"' <<<"$sent" && pass "a visitor sends a message" || fail "a visitor could not send"

# The owner signs in, and reads it.
cookies="$work/cookies"
open_link() { press_link "$1" "$cookies"; }
signin() { open_link "$("${compose[@]}" exec -T app chat sign-in-link owner@example.com | link_in)"; }
[ "$(open_link "$link")" = ok ] && pass "the owner signs in with the link from setup" || fail "the setup's link did not sign in"
[ "$(open_link "$link")" = ok ] && fail "the setup's link worked twice" || pass "the setup's link works once"
operator() { curl -sf -b "$cookies" "$@"; }
me="$(operator "http://localhost:$port/v1/operator/me")"
workspace="$(sed 's/.*"workspaceId":"\([^"]*\)".*/\1/' <<<"$me")"
list="$(operator "http://localhost:$port/v1/operator/workspaces/$workspace/conversations")"
grep -q "Hello from the install check" <<<"$list" && pass "the owner reads the message" || fail "the owner cannot read the message"

# Web push turns on after the restart that setup asks for.
"${compose[@]}" restart app >/dev/null 2>&1
for _ in $(seq 1 30); do curl -sf "$base/readyz" >/dev/null && break; sleep 1; done
[ "$(signin)" = ok ] || fail "the owner could not sign in after a restart"
alerts="$(operator "http://localhost:$port/v1/operator/workspaces/$workspace/alerts")"
if grep -q '"pushKey":"' <<<"$alerts"; then pass "web push is on after the restart"; else fail "web push is off: $alerts"; fi

# Valkey needs the password that init wrote, and no service can gain privileges.
noauth="$("${compose[@]}" exec -T valkey valkey-cli ping 2>&1 || true)"
grep -q NOAUTH <<<"$noauth" && pass "Valkey refuses a client with no password" || fail "Valkey answers with no password: $noauth"
for service in app valkey postgres; do
  id="$("${compose[@]}" ps -q "$service")"
  settings="$(docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' "$id")"
  grep -q 'ALL' <<<"$settings" && grep -q 'no-new-privileges' <<<"$settings" && pass "$service drops its capabilities" || fail "$service runs with $settings"
done

# The app holds only its own logins.
inside="$("${compose[@]}" exec -T app sh -c 'ls /secrets')"
if grep -Eq 'admin|backup|migrator' <<<"$inside"; then
  fail "the app can see another service's secret: $inside"
else
  pass "the app holds no admin or backup password"
fi
owner_of() { "${compose[@]}" exec -T postgres psql -U postgres -d dinghy -tAc "$1"; }
[ "$(owner_of "select rolsuper from pg_roles where rolname = 'dinghy_app'")" = f ] && pass "the app role is not a superuser" || fail "the app role is a superuser"
[ "$(owner_of "select count(*) from pg_tables where schemaname = 'public' and tableowner = 'dinghy_app'")" = 0 ] && pass "the app role owns no table" || fail "the app role owns a table"
[ "$(owner_of "select has_table_privilege('dinghy_app', 'pg_authid', 'select')")" = f ] && pass "the app role cannot read another role's password" || fail "the app role can read passwords"
[ "$(owner_of "select count(*) from pg_stat_activity where usename = 'postgres' and application_name not like 'psql%' and backend_type = 'client backend'")" = 0 ] && pass "nothing stays connected as the admin" || fail "something stays connected as the admin"

# pg_restore refuses a newer server, so a Postgres upgrade needs these two to match.
client_major="$("${compose[@]}" exec -T app pg_restore --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
server_major="$("${compose[@]}" exec -T postgres sh -c 'echo "$PG_MAJOR"')"
[ "$client_major" = "$server_major" ] && pass "the image's Postgres tools match the pinned server ($server_major)" || fail "the image has client $client_major, and compose.yaml pins server $server_major"
server_data="$("${compose[@]}" exec -T postgres sh -c 'echo "$PGDATA"')"
[ "$server_data" = "/var/lib/postgresql/$server_major/docker" ] && pass "the data path in compose.yaml matches that version" || fail "compose.yaml sets $server_data for Postgres $server_major"

# A backup runs in the service that holds its login.
backup="$("${compose[@]}" run --rm -T migrate chat backup)"
grep -q 'Wrote ' <<<"$backup" && pass "a backup runs from the migrate service" || fail "the backup failed: $backup"

# A later start keeps everything.
"${compose[@]}" down >/dev/null 2>&1
"${compose[@]}" up -d --wait >"$work/up2.log" 2>&1 || {
  tail -20 "$work/up2.log"
  fail "the second start failed"
}
operator "http://localhost:$port/v1/operator/me" >/dev/null && pass "the session survives a stop and start, so init changed no secret" || fail "the secrets changed on a second start"
list="$(operator "http://localhost:$port/v1/operator/workspaces/$workspace/conversations" || true)"
grep -q "Hello from the install check" <<<"$list" && pass "the messages survive a stop and start" || fail "the messages are gone after a restart"

# The tls profile, with Caddy's own certificate for localhost, on high ports so that it needs no free 443.
"${compose[@]}" down >/dev/null 2>&1
https_port=$((port + 1))
export HTTP_PORT=$((port + 2)) HTTPS_PORT="$https_port"
tls_url="https://localhost:$https_port"
CHAT_DOMAIN=localhost PUBLIC_URL="$tls_url" "${compose[@]}" --profile tls up -d --wait >"$work/up3.log" 2>&1 || {
  tail -20 "$work/up3.log"
  fail "the tls profile did not start"
}
ready=0
for _ in $(seq 1 30); do
  curl -skf "$tls_url/readyz" >/dev/null && {
    ready=1
    break
  }
  sleep 1
done
[ "$ready" = 1 ] && pass "the tls profile serves over HTTPS through Caddy" || fail "the tls profile does not answer"
hsts="$(curl -skI "$tls_url/healthz" | grep -ic '^strict-transport-security: max-age=31536000' || true)"
[ "$hsts" = 1 ] && pass "HTTPS answers carry one HSTS header" || fail "HTTPS answers carry $hsts HSTS headers"
hops="$("${compose[@]}" exec -T app printenv TRUSTED_PROXY_HOPS || true)"
[ "$hops" = 1 ] && pass "a domain sets the proxy count to 1" || fail "the proxy count is '$hops'"
# Through the proxy, as a browser does, so an open stream must not be buffered.
visitor="$(curl -skf -H "Origin: $site" -X POST "$tls_url/v1/widget/$key/visitors" || true)"
token="$(sed 's/.*"token":"\([^"]*\)".*/\1/' <<<"$visitor")"
stream="$(timeout 5 curl -skN -H "Origin: $site" -H "Authorization: Bearer $token" "$tls_url/v1/widget/$key/stream" || true)"
grep -q 'event: ready' <<<"$stream" && pass "a stream reaches the browser through Caddy" || fail "a stream does not pass through Caddy"
# A forged header must not escape a rate limit. Visitors are limited to 20 an hour per address.
last=0
for index in $(seq 1 25); do
  last="$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Origin: $site" \
    -H "X-Forwarded-For: 192.0.2.$index" "$tls_url/v1/widget/$key/visitors" || true)"
done
[ "$last" = 429 ] && pass "a forged X-Forwarded-For does not escape a limit behind Caddy" || fail "a forged header escaped the limit: $last"
CHAT_DOMAIN=localhost "${compose[@]}" --profile tls down >/dev/null 2>&1

echo
if [ "$failures" != 0 ]; then
  echo "$failures checks failed"
  exit 1
fi
echo "All checks passed"
