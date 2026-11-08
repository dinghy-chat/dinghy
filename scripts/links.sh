# shellcheck shell=bash
# Sourced by the check scripts. A sign-in link opens a confirm page, and only that page's button
# uses its token, so these do what the button does.

# The link that `chat setup` and `chat sign-in-link` print.
link_in() { grep -o 'http[^ ]*/link?for=[^ ]*' | tail -1; }

# press_link <url> [cookie jar]: posts the link's token as the confirm page's button does, and
# prints ok once it signed in, or the HTTP status. Like a browser, it keeps the jar's cookies when
# a link is refused.
press_link() {
  local origin token status jar="${2:-/dev/null}"
  origin="$(grep -o '^https\?://[^/]*' <<<"$1")"
  token="$(sed -n 's/.*[?&]token=\([^&]*\).*/\1/p' <<<"$1")"
  status="$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -c "$jar" -X POST \
    -H "Origin: $origin" -H 'content-type: application/json' -d "{\"token\":\"$token\"}" \
    "$origin/v1/auth/magic-link/verify")"
  if [ "$status" = 200 ]; then echo ok; else echo "$status"; fi
}
