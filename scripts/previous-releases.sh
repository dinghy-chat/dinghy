#!/usr/bin/env bash
# Prints the images that the upgrade check starts from: the first release, and the latest published
# release before this commit when it differs. A tag whose release failed has no image, so it is
# skipped. Needs the tags (check out with fetch-depth: 0) and a docker login to ghcr.io.
set -euo pipefail

first="0.1.0"
echo "ghcr.io/dinghy-chat/dinghy:$first"
for tag in $(git tag --list 'v*' --merged HEAD --no-contains HEAD --sort=-v:refname | grep -v -- '-'); do
  version="${tag#v}"
  [ "$version" != "$first" ] || break
  if docker manifest inspect "ghcr.io/dinghy-chat/dinghy:$version" >/dev/null 2>&1; then
    echo "ghcr.io/dinghy-chat/dinghy:$version"
    break
  fi
done
