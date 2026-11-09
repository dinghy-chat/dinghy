#!/usr/bin/env bash
# Prints the images that the upgrade check starts from: the oldest release tagged in this repository,
# and the latest published release before this commit when it differs. A tag whose release failed
# has no image, so it is skipped. With no earlier release, it prints nothing and the check skips the
# upgrade. Needs the tags (check out with fetch-depth: 0).
set -euo pipefail

published() { docker manifest inspect "ghcr.io/dinghy-chat/dinghy:$1" >/dev/null 2>&1; }

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
