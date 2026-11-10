#!/usr/bin/env bash
# Turns the Unreleased section of CHANGELOG.md into the next release, in the working tree. The Release
# workflow runs it on every push to main and keeps the "Release X.Y.Z" pull request up to date with the
# result. See RELEASING.md.
#
#   scripts/release-prepare.sh          # picks the version from the Unreleased groups
#   scripts/release-prepare.sh 0.9.0    # uses this version
#
# It prints the version on the last line. It exits with 3 and changes nothing when the Unreleased
# section is empty.
set -euo pipefail

old="$(node -p 'require("./package.json").version')"
unreleased="$(awk '/^## \[Unreleased\]$/{on=1; next} /^## /{on=0} on' CHANGELOG.md)"
if ! grep -q '[^[:space:]]' <<<"$unreleased"; then
  echo "The Unreleased section of CHANGELOG.md is empty."
  exit 3
fi

# Semantic Versioning, from the groups that hold entries. Before 1.0, a minor version may break things.
version="${1:-}"
if [ -z "$version" ]; then
  IFS=. read -r major minor patch <<<"$old"
  groups="$(grep -oE '^### [A-Za-z]+' <<<"$unreleased" | cut -c5- | sort -u)"
  if [ "$major" -ge 1 ] && grep -qxE 'Upgrading|Removed' <<<"$groups"; then
    version="$((major + 1)).0.0"
  elif grep -qxE 'Upgrading|Removed|Added|Changed|Deprecated' <<<"$groups"; then
    version="$major.$((minor + 1)).0"
  else
    version="$major.$minor.$((patch + 1))"
  fi
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "$version is not a version such as 0.5.1." >&2
  exit 2
}

# Dates the Unreleased section and leaves a new, empty one above it. The reference links follow:
# Unreleased compares from the new tag, and the new version compares from the tag Unreleased named.
VERSION="$version" TODAY="$(date -u +%F)" perl -0pi -e '
  my ($v, $d) = ($ENV{VERSION}, $ENV{TODAY});
  s/^## \[Unreleased\]\n/## [Unreleased]\n\n## [$v] - $d\n/m or die "No [Unreleased] heading.\n";
  s{^\[Unreleased\]: (\S+)/compare/(\S+)\.\.\.HEAD$}{[Unreleased]: $1/compare/v$v...HEAD\n[$v]: $1/compare/$2...v$v}m
    or die "No [Unreleased] link.\n";
' CHANGELOG.md

# The same files every release changes. perl, not sed -i, which differs between macOS and Linux.
for file in package.json apps/server/package.json apps/operator/package.json packages/widget/package.json \
  ee/package.json apps/server/openapi.json; do
  perl -pi -e "s/\"version\": \"\Q$old\E\"/\"version\": \"$version\"/" "$file"
done
perl -pi -e "s|dinghy-chat/dinghy:\Q$old\E\}|dinghy-chat/dinghy:$version}|" compose.yaml
perl -pi -e "s/^version=\"\Q$old\E\"\$/version=\"$version\"/" install.sh
for file in README.md docs/self-hosting.md docs/deploy-coolify-dokploy.md; do
  perl -pi -e "s/\bv\Q$old\E\b/v$version/g" "$file"
done
bun install --silent

left="$(git grep -n -F "$old" -- ':!CHANGELOG.md' ':!bun.lock' ':!**/node_modules/**' || true)"
if [ -n "$left" ]; then
  printf 'These lines still name %s. Check that each one should:\n%s\n' "$old" "$left"
fi
bun run --silent lint >/dev/null
echo "$version"
