#!/usr/bin/env bash
# Runs the real install with limits that total 4 GB, with streams, messages, image uploads and the worker, and
# prints one JSON line. It fails if a send fails, a message or an alert is lost, or a service runs out
# of memory.
#
# Usage: scripts/capacity-check.sh <image> <streams> <messages per second> <seconds> [uploads per second]
#
# To measure a real server, run this on another machine with both of these set:
#   DOCKER_HOST=ssh://root@<server>  CAPACITY_HOST=<server>
# The Compose commands then act on the server, and only the load generator runs here.
set -euo pipefail

image="${1:?Usage: capacity-check.sh <image> <streams> <messages per second> <seconds> [uploads per second]}"
streams="${2:?}"
rate="${3:?}"
seconds="${4:?}"
image_rate="${5:-0}"

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
origin="https://load.example.com"
port=$((37000 + $$ % 900))
host="${CAPACITY_HOST:-127.0.0.1}"
base="http://$host:$port"
export COMPOSE_PROJECT_NAME="dinghy-capacity-$$" DINGHY_IMAGE="$image" DINGHY_PORT="$port"
if [ -n "${CAPACITY_HOST:-}" ]; then export LOAD_BIND=0.0.0.0; fi
compose=(docker compose -f "$root/compose.yaml" -f "$root/apps/server/load/compose.capacity.yaml")
sampler=""

cleanup() {
  [ -z "$sampler" ] || kill "$sampler" 2>/dev/null || true
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

sql() { "${compose[@]}" exec -T postgres psql -U postgres -d dinghy -tAc "$1"; }
# The sum of the services' memory right now, in MiB.
memory_now() {
  # shellcheck disable=SC2046
  docker stats --no-stream --format '{{.MemUsage}}' $("${compose[@]}" ps -q) | awk '
    { split($1, used, /[A-Za-z]+/); value = used[1]; unit = $1; gsub(/[0-9.]/, "", unit)
      if (unit == "GiB") value *= 1024; else if (unit == "KiB") value /= 1024; else if (unit == "B") value /= 1048576
      total += value }
    END { printf "%d\n", total }'
}

"${compose[@]}" up -d --wait >"$work/up.log" 2>&1 || {
  tail -30 "$work/up.log" >&2
  exit 1
}
setup="$("${compose[@]}" exec -T app chat setup --email owner@example.com --name Owner --workspace Load --origin "$origin")"
key="$(sed -n 's/.*data-key="\([^"]*\)".*/\1/p' <<<"$setup")"
# The restart turns on web push, with the keys that chat setup made. Then each alert goes to the stand-in.
"${compose[@]}" restart app >/dev/null 2>&1
"${compose[@]}" up -d --wait app >/dev/null 2>&1
sql "insert into push_subscription (operator_id, endpoint, p256dh, auth) select id, 'http://fakepush:8080/device', 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', 'tBHItJI5svbpez7KI4CCXg' from operator" >/dev/null

# A 12-megapixel JPEG, as from a phone. Noise stops it from compressing to almost nothing.
"${compose[@]}" exec -T --workdir /app/apps/server app node --input-type=module -e "
  import sharp from 'sharp';
  const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#7a8b9c',
    noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).jpeg({ quality: 75 }).toBuffer();
  process.stdout.write(photo);" >"$work/photo.jpg"
photo_bytes="$(stat -c %s "$work/photo.jpg")"

idle_mb="$(memory_now)"
(while :; do memory_now >>"$work/memory"; done) &
sampler=$!

# DOCKER_HOST may point at the server, and the load generator stays on this machine.
result="$(DOCKER_HOST='' docker run --rm --network host -v "$root/apps/server/load:/load:ro" -v "$work:/work:ro" node:24-slim \
  node /load/run.ts "$base" "$key" "$origin" "$streams" "$rate" "$seconds" --image /work/photo.jpg --image-rate "$image_rate")"
kill "$sampler" 2>/dev/null || true
sampler=""
peak_mb="$(sort -n "$work/memory" | tail -1)"

# The worker's backlog when the load ends, and how long it takes to finish.
backlog_query="select count(*) from alert_delivery where finished_at is null"
alerts_waiting="$(sql "$backlog_query")"
drain_started=$SECONDS
drained=1
until [ "$(sql "$backlog_query")" = 0 ]; do
  if [ $((SECONDS - drain_started)) -gt 300 ]; then
    drained=0
    break
  fi
  sleep 2
done
drain_seconds=$((SECONDS - drain_started))
alert_outcomes="$(sql "select coalesce(json_object_agg(coalesce(outcome::text, 'waiting'), n), '{}') from (select outcome, count(*) n from alert_delivery group by outcome) t")"
pushes="$("${compose[@]}" exec -T fakepush node -e "fetch('http://127.0.0.1:8080/').then((r)=>r.text()).then((t)=>console.log(Number(t)-1))")"

# Anything that ran out of memory or restarted.
problems=0
for container in $("${compose[@]}" ps -q); do
  state="$(docker inspect -f '{{.Name}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' "$container")"
  case "$state" in
  *"oom=false restarts=0") ;;
  *)
    echo "FAILED - $state" >&2
    problems=$((problems + 1))
    ;;
  esac
done

echo "{\"idleMb\":$idle_mb,\"peakMb\":$peak_mb,\"photoBytes\":$photo_bytes,\"alertsWaitingAtEnd\":$alerts_waiting,\"drainSeconds\":$drain_seconds,\"alertOutcomes\":$alert_outcomes,\"pushes\":$pushes,\"load\":$result}"

node_check() { # node_check <description> <JavaScript expression over load>
  if DOCKER_HOST='' docker run --rm -e "RESULT=$result" node:24-slim node -e "
    const load = JSON.parse(process.env.RESULT);
    process.exit(($2) ? 0 : 1)"; then
    echo "ok - $1" >&2
  else
    echo "FAILED - $1" >&2
    problems=$((problems + 1))
  fi
}
node_check "every stream opened" "load.streamsOpen === load.streamsRequested"
node_check "no send failed" "load.failed === 0"
node_check "no send was left waiting" "load.unfinished === 0"
node_check "every sent message was delivered" "load.delivered === load.sent"
# At least, because alert delivery is at-least-once.
node_check "every message and image made a push" "$pushes >= load.sent + (load.imageStatuses['201'] ?? 0)"
node_check "no upload failed" "Object.keys(load.imageStatuses).every((status) => status === '201')"
[ "$drained" = 1 ] && echo "ok - the worker finished its backlog" >&2 || {
  echo "FAILED - the worker still had a backlog after 300 seconds" >&2
  problems=$((problems + 1))
}
[ "$problems" = 0 ]
