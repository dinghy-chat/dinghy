#!/usr/bin/env bash
# Moves the data to the Postgres major version that compose.yaml pins, after a release changes that pin.
# It takes a normal backup on the old version and restores it on the new one. The old version's files
# stay as they are, so a failure at any step leaves them usable. See docs/self-hosting.md.
#
# Usage: scripts/upgrade-postgres.sh, on the server, with the new compose.yaml in place.
set -euo pipefail

cd "$(dirname "$0")/.."

data=/var/lib/postgresql
# A new major version loads here, and takes its real name only after the restore works. So a crash at
# any point cannot leave a data directory that looks finished.
loading="$data/upgrading"
in_volume() { docker compose run --rm --no-deps -T --entrypoint sh postgres -c "$1"; }

target="$(in_volume 'echo "$PG_MAJOR"')"
# Postgres rewrites this file at every start, so the newest one marks the version that holds the current data.
newest="$(in_volume "cd $data && ls -t */docker/postmaster.opts 2>/dev/null | head -1" | cut -d/ -f1)"
if [ -z "$newest" ]; then
  echo "This volume holds no data yet, so there is nothing to upgrade."
  exit 0
fi
if [ "$newest" = "$target" ]; then
  # Also finishes a run that stopped after the data moved and before the app started.
  docker compose up -d --wait
  echo "The data is already on Postgres $target."
  exit 0
fi
if in_volume "test -s $data/$target/docker/PG_VERSION"; then
  echo "Postgres $newest ran after this volume's Postgres $target data was written, so that data is out of date." >&2
  echo "If Postgres $newest holds your current data, remove the older copy, and run this again:" >&2
  echo "  docker compose run --rm --no-deps --entrypoint rm postgres -rf $data/$target" >&2
  exit 1
fi
old="$newest"

with_old() { DINGHY_POSTGRES_IMAGE="postgres:$old-alpine" DINGHY_POSTGRES_DATA="$data/$old/docker" docker compose "$@"; }
with_new() { DINGHY_POSTGRES_DATA="$loading" docker compose "$@"; }

finished=0
on_exit() {
  local code=$?
  if [ "$finished" = 0 ]; then
    docker compose stop postgres >/dev/null 2>&1 || true
    in_volume "rm -rf $loading" >/dev/null 2>&1 || true
    echo >&2
    echo "The upgrade failed. Your Postgres $old data is unchanged." >&2
    echo "Fix the error above and run this again, or go back to your previous compose.yaml." >&2
  fi
  exit "$code"
}
trap on_exit EXIT

echo "Upgrading from Postgres $old to Postgres $target. The app stops until this ends."
docker compose stop app postgres
in_volume "rm -rf $loading"

echo "Taking a backup on Postgres $old."
with_old up -d --wait postgres
output="$(with_old run --rm -T migrate chat backup)"
echo "$output"
backup="$(sed -n 's#^Wrote \(.*\)\.$#\1#p' <<<"$output")"
[ -n "$backup" ]
with_old stop postgres

echo "Loading it on Postgres $target."
with_new up -d --wait postgres
with_new run --rm -T migrate chat restore "$backup"
with_new stop postgres

# A start that Postgres refused leaves an empty directory at the real name. rmdir stops on anything else.
in_volume "mkdir -p $data/$target && chown postgres:postgres $data/$target && { [ ! -e $data/$target/docker ] || rmdir $data/$target/docker; } && mv $loading $data/$target/docker"
finished=1

docker compose up -d --wait
echo
echo "The data is on Postgres $target, and the app is running."
echo "Check it. Then free the disk space of the old version, which also removes the way back:"
echo "  docker compose run --rm --no-deps --entrypoint rm postgres -rf $data/$old"
