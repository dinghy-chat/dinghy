#!/usr/bin/env bash
# Runs install.sh as a new owner would, on a copy of the release's files.
# Usage: scripts/installer-check.sh <image>
set -euo pipefail

image="${1:?Usage: installer-check.sh <image>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
port=$((36000 + $$ % 900))
failures=0
export COMPOSE_PROJECT_NAME="dinghy-installer-$$" DINGHY_IMAGE="$image" DINGHY_PORT="$port"
cp "$root/compose.yaml" "$root/settings.example" "$work/"
# shellcheck source=scripts/links.sh
. "$root/scripts/links.sh"

pass() { echo "ok - $1"; }
fail() {
  echo "FAILED - $1"
  failures=$((failures + 1))
}
cleanup() {
  (cd "$work" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$work"
}
trap cleanup EXIT
# Through a pipe, as the one-line install does, so a command that reads standard input would eat the script.
install_with() { (cd / && DINGHY_DIR="$work" setsid bash -s -- "$@" <"$root/install.sh"); }

# The script and the file that it installs name one release.
script_version="$(sed -n 's/^version="\(.*\)"$/\1/p' "$root/install.sh")"
grep -q "ghcr.io/dinghy-chat/dinghy:$script_version}" "$root/compose.yaml" && pass "install.sh and compose.yaml name one release ($script_version)" || fail "install.sh names $script_version, and compose.yaml names another"

# Refusals, which change nothing.
if install_with --domain https://chat.example.com --email a@example.com --name A --workspace B --origin https://www.example.com >"$work/url.log" 2>&1; then
  fail "it accepted a URL as a domain"
else
  grep -q 'Give only the domain' "$work/url.log" && pass "a URL in place of a domain gets a clear error" || fail "wrong error: $(tail -1 "$work/url.log")"
fi
if install_with --domain no-such-name.invalid --email a@example.com --name A --workspace B --origin https://www.example.com >"$work/dns.log" 2>&1; then
  fail "it accepted a domain with no DNS record"
else
  grep -q 'no DNS record' "$work/dns.log" && pass "a domain with no DNS record gets a clear error" || fail "wrong error: $(tail -1 "$work/dns.log")"
fi
if install_with --local >"$work/no-terminal.log" 2>&1; then
  fail "it ran with no answers and no terminal"
else
  grep -q 'Pass --email' "$work/no-terminal.log" && pass "with no terminal, it names the missing flag" || fail "wrong error: $(tail -1 "$work/no-terminal.log")"
fi
[ ! -e "$work/.env" ] && pass "a refusal writes no settings" || fail "a refusal wrote settings"

# An answer that the setup refuses, then the same run again with a good one.
if install_with --local --no-backup-cron --email not-an-email --name Owner --workspace Acme --origin https://www.example.com >"$work/bad.log" 2>&1; then
  fail "it accepted a bad email"
else
  pass "a bad email stops the setup"
fi

# The install.
output="$(install_with --local --no-backup-cron --email owner@example.com --name Owner --workspace Acme --origin https://www.example.com 2>&1)" || {
  printf '%s\n' "$output" | tail -30
  fail "the install failed"
  exit 1
}
link="$(link_in <<<"$output")"
[ -n "$link" ] && pass "it prints a sign-in link" || fail "it printed no sign-in link"
grep -qi 'password' <<<"$output" && fail "it still mentions a password" || pass "it mentions no password"
grep -q 'data-key=' <<<"$output" && pass "it prints the tag for the site" || fail "it printed no tag"
grep -q 'Backup private key' <<<"$output" && pass "it prints the backup key" || fail "it printed no backup key"
grep -q 'Restart to turn on' <<<"$output" && fail "it tells the owner to do a restart that it already did" || pass "it does the restart itself"
grep -q "Dinghy is running at http://localhost:$port" <<<"$output" && pass "it says where Dinghy runs" || fail "it did not say where Dinghy runs"
[ "$(stat -c %a "$work/.env")" = 600 ] && pass "the settings are private" || fail "the settings have mode $(stat -c %a "$work/.env")"
alerts="$(cd "$work" && docker compose exec -T app sh -c 'ls /secrets' | grep -c vapid || true)"
[ "$alerts" -ge 1 ] && pass "web push keys exist" || fail "no web push keys"
code="$(press_link "$link")"
[ "$code" = ok ] && pass "the owner signs in with that link" || fail "sign-in answered $code"

# A second run, with no answers and no terminal, changes nothing. The port now comes from the settings.
sed -i "s/^DINGHY_PORT=.*/DINGHY_PORT=$port/" "$work/.env"
unset DINGHY_PORT
second="$(install_with --no-backup-cron 2>&1)" && pass "a second run succeeds with no answers" || fail "a second run failed: $(tail -1 <<<"$second")"
grep -q "Dinghy is running at http://localhost:$port" <<<"$second" && pass "a second run reads the port from the settings" || fail "a second run did not find the port"
grep -q 'Backup private key' <<<"$second" && fail "a second run made a new owner" || pass "a second run makes no new owner"
code="$(press_link "$(cd "$work" && docker compose exec -T app chat sign-in-link owner@example.com | link_in)")"
[ "$code" = ok ] && pass "chat sign-in-link still signs the owner in" || fail "sign-in answered $code after a second run"

if install_with --domain other.example.com >"$work/domain.log" 2>&1; then
  fail "a second run accepted another domain"
else
  grep -q 'already has settings' "$work/domain.log" && pass "a second run refuses to change the domain" || fail "wrong error: $(tail -1 "$work/domain.log")"
fi

echo
if [ "$failures" != 0 ]; then
  echo "$failures checks failed"
  exit 1
fi
echo "All checks passed"
