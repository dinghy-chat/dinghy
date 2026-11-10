#!/usr/bin/env bash
# Installs Dinghy on one server, and is safe to run again. See docs/self-hosting.md.
#
#   sudo ./install.sh
#
# It asks for what it needs. To run it with no questions, pass all of these:
#   --domain chat.example.com   Or --local, to try it on this machine with no domain.
#   --email you@example.com     The owner's login.
#   --name "Your Name"
#   --workspace "Your Company"
#   --origin https://example.com   The website that gets the chat.
# Other options:
#   --no-backup-cron            Do not add the nightly backup.
#   --yes                       Continue when the domain does not point at this server.
set -euo pipefail

# In a function, so that bash has read the whole file before any command runs. From a pipe, a command
# that reads standard input would otherwise take the rest of this script.
main() {
version="0.10.0"
repository="https://github.com/dinghy-chat/dinghy.git"
default_directory="${DINGHY_DIR:-/opt/dinghy}"

domain="" local_only=0 email="" name="" workspace="" origin="" backup_cron=1 assume_yes=0
while [ "$#" -gt 0 ]; do
  case "$1" in
  --domain | --email | --name | --workspace | --origin)
    [ "$#" -ge 2 ] || {
      echo "$1 needs a value." >&2
      exit 2
    }
    case "$1" in
    --domain) domain="$2" ;;
    --email) email="$2" ;;
    --name) name="$2" ;;
    --workspace) workspace="$2" ;;
    --origin) origin="$2" ;;
    esac
    shift 2
    ;;
  --local)
    local_only=1
    shift
    ;;
  --no-backup-cron)
    backup_cron=0
    shift
    ;;
  --yes)
    assume_yes=1
    shift
    ;;
  --help | -h)
    echo "Read the top of this script for the options:"
    echo "https://github.com/dinghy-chat/dinghy/blob/v$version/install.sh"
    [ ! -f "${BASH_SOURCE[0]:-}" ] || sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Unknown option: $1. Read the top of this script for the options." >&2
    exit 2
    ;;
  esac
done

say() { printf '\n==> %s\n' "$1"; }
warn() { printf '\nWarning: %s\n' "$1" >&2; }
stop() {
  printf '\nStopped: %s\n' "$1" >&2
  exit 1
}
has_terminal() { (: </dev/tty) 2>/dev/null; }
# ask <variable> <question>: keeps a value that a flag already set.
ask() {
  [ -z "${!1}" ] || return 0
  has_terminal || stop "This has no terminal to ask at. Pass --${1}."
  local answer=""
  while [ -z "$answer" ]; do
    printf '%s ' "$2" >/dev/tty
    IFS= read -r answer </dev/tty
  done
  printf -v "$1" '%s' "$answer"
}

if [ "$(uname -s)" != "Linux" ]; then
  stop "This installer is for a Linux server. On another system, follow docs/self-hosting.md."
fi

# ---- Docker.
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  [ "$(id -u)" = 0 ] || stop "Docker is missing, and installing it needs root. Run this with sudo."
  say "Installing Docker"
  installed=0
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    if apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1; then installed=1; fi
  fi
  if [ "$installed" = 0 ]; then
    command -v curl >/dev/null 2>&1 || stop "Install curl or Docker, and run this again."
    curl -fsSL https://get.docker.com | sh
  fi
  command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 || stop "Docker is installed, but this user cannot use it. Run this with sudo."
if ! command -v curl >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || stop "Install curl, and run this again."
  apt-get install -y -qq curl >/dev/null
fi

# ---- The files. From a checkout, it stays there. From a pipe, it gets this release.
script_directory=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$script_directory" ] && [ -f "$script_directory/compose.yaml" ]; then
  directory="$script_directory"
else
  directory="$default_directory"
  if [ ! -f "$directory/compose.yaml" ]; then
    [ "$(id -u)" = 0 ] || stop "Getting the files into $directory needs root. Run this with sudo."
    command -v git >/dev/null 2>&1 || {
      command -v apt-get >/dev/null 2>&1 || stop "Install git, and run this again."
      apt-get install -y -qq git >/dev/null
    }
    say "Getting Dinghy $version"
    git clone -q --depth 1 -b "v$version" "$repository" "$directory"
  fi
fi
cd "$directory"

# ---- The questions, and the settings. A second run keeps the settings it finds.
fresh=0
if [ -f .env ] && [ -n "$domain" ] && [ "$domain" != "$(sed -n 's/^CHAT_DOMAIN=//p' .env | tail -1)" ]; then
  stop "This install already has settings, so --domain would do nothing. To change the domain, read docs/troubleshooting.md."
fi
if [ ! -f .env ]; then
  fresh=1
  if [ "$local_only" = 0 ] && [ -z "$domain" ]; then
    has_terminal || stop "This has no terminal to ask at. Pass --domain or --local."
    printf 'Your domain, such as chat.example.com. Leave it empty to try Dinghy on this machine: ' >/dev/tty
    IFS= read -r domain </dev/tty
  fi
fi

if [ "$fresh" = 1 ] && [ -n "$domain" ]; then
  case "$domain" in
  http://* | https://* | */* | *" "*) stop "Give only the domain, such as chat.example.com." ;;
  esac
  addresses="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  [ -n "$addresses" ] || [ "$assume_yes" = 1 ] ||
    stop "$domain has no DNS record yet. Add an A record that points at this server, and run this again."
  ours=0
  for address in $addresses; do
    if hostname -I 2>/dev/null | tr ' ' '\n' | grep -qx "$address"; then ours=1; fi
  done
  if [ "$ours" = 0 ] && [ "$assume_yes" = 0 ]; then
    printf '\n%s points at %s, which is not an address on this server.\n' "$domain" "$addresses"
    echo "That is fine behind NAT. With another address, or a proxy, the certificate can fail."
    has_terminal || stop "Fix the record, or pass --yes."
    printf 'Continue? [y/N] ' >/dev/tty
    IFS= read -r answer </dev/tty
    case "$answer" in
    y | Y | yes) ;;
    *) stop "Fix the record, and run this again." ;;
    esac
  fi
  for port in 80 443; do
    if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
      stop "Another program uses port $port on this server. Stop it, or follow docs/self-hosting.md for another proxy."
    fi
  done
fi

if [ "$fresh" = 1 ]; then
  ask email "The email for your owner login:"
  ask name "Your name:"
  ask workspace "Your company or project:"
  ask origin "The website that gets the chat, such as https://example.com:"
  cp settings.example .env
  chmod 600 .env
  if [ -n "$domain" ]; then
    sed -i "s|^CHAT_DOMAIN=.*|CHAT_DOMAIN=$domain|; s|^# COMPOSE_PROFILES=tls|COMPOSE_PROFILES=tls|" .env
  fi
fi
# With sudo, the person who ran it still needs to read this.
if [ -n "${SUDO_USER:-}" ]; then chown "$SUDO_USER" .env; fi
domain="$(sed -n 's/^CHAT_DOMAIN=//p' .env | tail -1)"
if [ -n "$domain" ]; then
  address="https://$domain"
else
  address="http://localhost:${DINGHY_PORT:-$(sed -n 's/^DINGHY_PORT=//p' .env | tail -1 | tr -d "\"'" | grep . || echo 3000)}"
fi

# ---- Start it.
say "Starting Dinghy. The first start downloads a few hundred MB."
if ! docker compose up -d --wait; then
  docker compose ps -a >&2 || true
  echo >&2
  stop "It did not start. Read the output above, and docker compose logs. Then run this again."
fi

# ---- The owner. A failed setup, such as a bad email, changes nothing, and a second run asks again.
created=0
operators="$(docker compose exec -T postgres psql -U postgres -d dinghy -tAc 'select count(*) from operator')"
if [ "$operators" = 0 ]; then
  ask email "The email for your owner login:"
  ask name "Your name:"
  ask workspace "Your company or project:"
  ask origin "The website that gets the chat, such as https://example.com:"
  say "Creating your account"
  # Printed at once and whatever happens next, because nothing can show the backup key again.
  if output="$(docker compose exec -T app chat setup --email "$email" --name "$name" --workspace "$workspace" --origin "$origin")"; then
    created=1
    grep -v 'Restart to turn on web push' <<<"$output"
    printf '\n==> Save the backup key above now. Nothing shows it again.\n'
  else
    [ -z "$output" ] || printf '%s\n' "$output"
    stop "The setup failed, with the error above. Run this again to answer again."
  fi
  # The restart turns on web push, with the keys that the setup made.
  say "Turning on web push"
  docker compose restart app >/dev/null ||
    stop "The restart failed, so web push stays off. Run: docker compose restart app"
  docker compose up -d --wait >/dev/null ||
    stop "The app did not come back after the restart. Read: docker compose logs app"
fi

# ---- The nightly backup. Its output and any failure go to the system log, tagged dinghy-backup.
backup_skipped=""
if [ "$backup_cron" = 1 ] && [ ! -f /etc/cron.d/dinghy ]; then
  if [ "$(id -u)" != 0 ]; then
    backup_skipped="the installer did not run as root"
  elif [ ! -d /etc/cron.d ] || ! { pgrep -x cron || pgrep -x crond; } >/dev/null 2>&1; then
    backup_skipped="this server runs no cron"
  elif ! command -v logger >/dev/null 2>&1; then
    backup_skipped="this server has no logger command for the backup's output"
  else
    printf '%s\n' \
      '# Added by the Dinghy installer. A backup on this disk does not survive the loss of this disk.' \
      '# Read its output with: journalctl -t dinghy-backup (or grep dinghy-backup /var/log/syslog)' \
      "17 3 * * * root cd $(printf '%q' "$directory") && { docker compose run --rm -T migrate chat backup || logger -p user.err -t dinghy-backup 'The nightly Dinghy backup FAILED. Read the lines above.'; } 2>&1 | logger -t dinghy-backup" \
      >/etc/cron.d/dinghy
  fi
fi
[ -z "$backup_skipped" ] || warn "No nightly backup was added, because $backup_skipped. Read docs/self-hosting.md to add one."

# ---- Check it from outside the containers.
say "Checking $address"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 5 "$address/readyz" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done

echo
if [ "$ready" = 1 ]; then
  echo "Dinghy is running at $address"
else
  echo "Dinghy started, but $address/readyz does not answer yet."
  if [ -n "$domain" ]; then
    echo "Check that $domain points at this server, and that a cloud firewall allows ports 80 and 443."
    echo "To read the certificate logs, run: cd $directory && docker compose logs caddy"
  fi
fi
if [ "$created" = 1 ]; then
  echo "Your backup key is above."
  # A new link, because the one from the setup may expire while this runs. Each works once.
  docker compose exec -T app chat sign-in-link "$email" ||
    echo "To sign in, run: cd $directory && docker compose exec app chat sign-in-link $email"
fi
echo
echo "The files are in $directory. Your next steps are in docs/README.md."
if [ -f /etc/cron.d/dinghy ] && { pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; }; then
  echo "A backup runs every night, on this disk. Read docs/self-hosting.md to keep a copy elsewhere."
else
  echo "Nothing takes backups on a schedule. Read docs/self-hosting.md to add one."
fi
[ "$ready" = 1 ]
}

main "$@"
