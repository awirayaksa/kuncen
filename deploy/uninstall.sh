#!/usr/bin/env bash
#
# uninstall.sh — remove kuncen from the machine.
#
# Data is kept by default. The database is the record of who held what and for
# how long; deleting it needs to be something you asked for out loud.
#
set -euo pipefail

PREFIX=/opt/kuncen
SERVICE_USER=kuncen
PURGE=0
REMOVE_USER=0

usage() {
  cat <<'USAGE'
uninstall.sh — remove kuncen

  --prefix DIR     install root (default /opt/kuncen)
  --user NAME      service user (default kuncen)
  --purge          also delete data/ (the database, sessions, traces) and .env
  --remove-user    also delete the system user
  -h, --help       this
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    --remove-user) REMOVE_USER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

echo "==> Stopping services"
systemctl disable --now kuncen-proxy kuncen-web 2>/dev/null || true
rm -f /etc/systemd/system/kuncen-proxy.service /etc/systemd/system/kuncen-web.service
systemctl daemon-reload 2>/dev/null || true

# The container mode, if that is how it was installed. Both are handled here
# because the two are alternatives on one box and whoever is removing kuncen
# should not have to remember which one they chose.
COMPOSE_FILE="$PREFIX/docker/compose.yml"
if [[ -f "$COMPOSE_FILE" ]] && command -v docker >/dev/null; then
  echo "==> Stopping containers"
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" down --remove-orphans || true
  else
    docker-compose -f "$COMPOSE_FILE" down --remove-orphans || true
  fi
  # Images are left alone unless purging: rebuilding one on an air-gapped box
  # means finding the bundle again.
  if [[ $PURGE -eq 1 ]]; then
    docker image rm -f kuncen:latest >/dev/null 2>&1 || true
    for img in $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^kuncen:' || true); do
      docker image rm -f "$img" >/dev/null 2>&1 || true
    done
    echo "    removed kuncen images"
  else
    echo "    kept kuncen images (--purge removes them)"
  fi
fi
rm -f /usr/local/bin/kuncen-admin

if [[ $PURGE -eq 1 ]]; then
  echo "==> Removing $PREFIX including data/"
  rm -rf "${PREFIX:?}"
else
  echo "==> Removing $PREFIX except data/ and .env"
  # Windows will not let you delete a SQLite file a service holds open; Linux
  # will, silently, which is worse. Services are already stopped above.
  find "${PREFIX:?}" -mindepth 1 -maxdepth 1 \
    ! -name data ! -name .env -exec rm -rf {} +
  echo "    kept $PREFIX/data and $PREFIX/.env"
fi

if [[ $REMOVE_USER -eq 1 ]] && id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> Removing user $SERVICE_USER"
  userdel "$SERVICE_USER" || true
fi

echo "Done."
