#!/usr/bin/env bash
# Runs one load step against load/compose.yaml and prints the result with each service's memory.
# Usage: apps/server/load/measure.sh <streams> <messages per second> <seconds>
set -euo pipefail
cd "$(dirname "$0")/../../.."
ORIGIN=https://load.example.com
docker compose -f apps/server/load/compose.yaml down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -f apps/server/load/compose.yaml up -d --wait postgres valkey >/dev/null 2>&1
KEY=$(node apps/server/load/setup.ts postgres://postgres@127.0.0.1:55433/postgres "$ORIGIN")
docker compose -f apps/server/load/compose.yaml up -d --wait web >/dev/null 2>&1
until curl -sf http://127.0.0.1:3100/readyz >/dev/null; do :; done
docker stats --no-stream --format '{{.Name}} idle {{.MemUsage}}' | grep dinghy-load
node apps/server/load/run.ts http://127.0.0.1:3100 "$KEY" "$ORIGIN" "$1" "$2" "$3" &
RUN=$!
# Sample during the send phase, after the streams have opened.
SAMPLE=$(( $3 / 2 + 5 ))
( sleep "$SAMPLE"; docker stats --no-stream --format '{{.Name}} loaded {{.CPUPerc}} {{.MemUsage}}' | grep dinghy-load ) &
wait "$RUN"
wait
