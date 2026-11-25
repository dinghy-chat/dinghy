#!/usr/bin/env bash
# Prints the images that the upgrade check starts from: the oldest release tagged in this repository,
# and the latest published release before this commit when it differs. A tag whose release failed
# has no image, so it is skipped. With no earlier release, it prints nothing and the check skips the
# upgrade. Any other registry error fails, so an outage cannot skip the upgrade check unnoticed.
# Needs the tags (check out with fetch-depth: 0).
set -euo pipefail

published() {
  local error
  error=$(docker manifest inspect "ghcr.io/dinghy-chat/dinghy:$1" 2>&1 >/dev/null) && return 0
  # GHCR answers "manifest unknown" for a missing tag. Docker also prints "no such manifest" for a
  # 401, so that one counts as an error.
  case "$error" in *"manifest unknown"*) return 1 ;; esac
  echo "previous-releases: cannot read ghcr.io/dinghy-chat/dinghy:$1: $error" >&2
  exit 1
}

tags=$(git tag --list 'v*' --merged HEAD --no-contains HEAD --sort=v:refname | grep -v -- '-' || true)
first=""
for tag in $tags; do
  if published "${tag#v}"; then
    first="${tag#v}"
    break
  fi
done
[ -n "$first" ] || exit 0
echo "ghcr.io/dinghy-chat/dinghy:$first"
for tag in $(printf '%s\n' $tags | sort -rV); do
  version="${tag#v}"
  [ "$version" != "$first" ] || break
  if published "$version"; then
    echo "ghcr.io/dinghy-chat/dinghy:$version"
    break
  fi
done
