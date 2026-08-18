#!/usr/bin/env bash
#
# install.sh — install kuncen on an air-gapped machine from an offline bundle.
#
# Run from inside the unpacked bundle directory:
#
#     sudo ./install.sh
#
# Nothing here touches the network, and nothing here touches the system Node,
# npm, or apt. The runtime lives inside $PREFIX and the systemd units name it by
# absolute path, so upgrading the box's own node cannot break the lock.
#
# Re-running is the upgrade path: .env and data/ are never overwritten.
#
set -euo pipefail

PREFIX=/opt/kuncen
SERVICE_USER=kuncen
SERVICE_GROUP=kuncen
START_SERVICES=1
VERIFY=1
RUN_TESTS=0

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'USAGE'
install.sh — offline installer for kuncen

  --prefix DIR     install root (default /opt/kuncen)
  --user NAME      system user to run as (default kuncen)
  --no-start       install and enable nothing; do not start services
  --no-verify      skip the MANIFEST.sha256 check
  --run-tests      run the test suite after installing (slow, optional)
  -h, --help       this

Re-run to upgrade. .env and data/ are preserved.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; SERVICE_GROUP="$2"; shift 2 ;;
    --no-start) START_SERVICES=0; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --run-tests) RUN_TESTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

BOLD=$'\e[1m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
[[ -t 1 ]] || { BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""; }

step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    %swarning:%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

NODE_DIR="$PREFIX/runtime/node"
NODE_BIN="$NODE_DIR/bin/node"
NPM_CLI="$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"

# ---------------------------------------------------------------------------
step "Preflight"

[[ $EUID -eq 0 ]] || die "run as root (sudo ./install.sh)"
[[ -f "$BUNDLE_DIR/BUNDLE.json" ]] || die "BUNDLE.json not found — run this from inside the unpacked bundle"

# Read BUNDLE.json without jq: the target is air-gapped and we assume nothing.
read_bundle() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$BUNDLE_DIR/BUNDLE.json" | head -n1; }
BUNDLE_ARCH="$(read_bundle targetArch)"
NODE_TARBALL="$(read_bundle nodeTarball)"
NODE_VERSION="$(read_bundle nodeVersion)"
PREBUILD="$(read_bundle betterSqlite3Prebuild)"
[[ -n "$BUNDLE_ARCH" && -n "$NODE_TARBALL" && -n "$PREBUILD" ]] || die "BUNDLE.json is incomplete"

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  aarch64|arm64) HOST_ARCH=arm64 ;;
  x86_64|amd64)  HOST_ARCH=x64 ;;
esac
[[ "$HOST_ARCH" == "$BUNDLE_ARCH" ]] ||
  die "bundle is for linux-$BUNDLE_ARCH but this machine is $(uname -m). Rebuild with --arch $HOST_ARCH."

# The prebuilt better-sqlite3 binary and the Node runtime are both glibc.
ldd --version >/dev/null 2>&1 || warn "could not identify libc; the bundle assumes glibc"

command -v systemctl >/dev/null || die "systemd not found; this installer manages systemd units"

# The container mode is the alternative to this one, not a companion: both bind
# :8080 and :3000. Finding that out when systemd races the containers for the
# port is a bad way to learn it.
if [[ -f "$PREFIX/docker/compose.yml" ]] && command -v docker >/dev/null; then
  if docker ps --filter 'label=com.docker.compose.project=kuncen' --format '{{.Names}}' 2>/dev/null | grep -q .; then
    die "kuncen containers are running and would fight these units for the port.
       Stop them first:  docker compose -f $PREFIX/docker/compose.yml down"
  fi
fi
command -v tar >/dev/null || die "tar not found"
tar --help 2>&1 | grep -q -- '-J\|xz' || command -v xz >/dev/null ||
  die "xz not available; cannot unpack the Node tarball"

info "target      linux-$BUNDLE_ARCH ($(uname -m))"
info "node        $NODE_VERSION"
info "prefix      $PREFIX"
info "service user $SERVICE_USER"

# Written as `if`, not `[[ … ]] && …`: under `set -e` a trailing && list that
# tests false exits the script.
if [[ -f "$PREFIX/package.json" ]]; then
  info "existing install detected — upgrading in place, .env and data/ preserved"
fi

# ---------------------------------------------------------------------------
step "Verifying bundle integrity"
if [[ $VERIFY -eq 1 ]]; then
  if command -v sha256sum >/dev/null; then
    ( cd "$BUNDLE_DIR" && sha256sum --quiet -c MANIFEST.sha256 ) ||
      die "checksum mismatch — the bundle was damaged in transit, copy it again"
    info "$(wc -l < "$BUNDLE_DIR/MANIFEST.sha256") files verified"
  else
    warn "sha256sum not found; skipping verification"
  fi
else
  info "skipped (--no-verify)"
fi

# ---------------------------------------------------------------------------
step "Creating service account"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "user $SERVICE_USER already exists"
else
  useradd --system --create-home --home-dir "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER"
  info "created system user $SERVICE_USER"
fi
getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$PREFIX"

# ---------------------------------------------------------------------------
step "Installing the Node runtime"
if [[ -x "$NODE_BIN" ]] && [[ "$("$NODE_BIN" -v 2>/dev/null)" == "$NODE_VERSION" ]]; then
  info "node $NODE_VERSION already installed"
else
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$BUNDLE_DIR/runtime/$NODE_TARBALL" -C "$NODE_DIR" --strip-components=1
  info "unpacked $("$NODE_BIN" -v) to $NODE_DIR"
fi
[[ -f "$NPM_CLI" ]] || die "npm not found in the Node tarball at $NPM_CLI"

# Node's own ABI must match the better-sqlite3 prebuild we are about to place.
NODE_ABI="$("$NODE_BIN" -p 'process.versions.modules')"
case "$PREBUILD" in
  *"-node-v$NODE_ABI-"*) ;;
  *) die "ABI mismatch: node reports $NODE_ABI but the prebuild is $PREBUILD" ;;
esac
info "node ABI $NODE_ABI matches the bundled prebuild"

# ---------------------------------------------------------------------------
step "Installing application source"
# data/ and .env live under $PREFIX and are deliberately not in the bundle, so a
# plain copy leaves them alone. Everything the bundle carries is replaced — the
# list comes from the bundle rather than being repeated here, so adding a file to
# the bundler does not silently skip it on upgrade.
shopt -s dotglob nullglob
for src in "$BUNDLE_DIR"/app/*; do
  entry="$(basename "$src")"
  rm -rf "${PREFIX:?}/$entry"
  cp -a "$src" "$PREFIX/$entry"
done
shopt -u dotglob nullglob
chmod +x "$PREFIX"/deploy/*.sh 2>/dev/null || true
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$PREFIX/data"
info "source installed to $PREFIX"

# ---------------------------------------------------------------------------
step "Installing dependencies (offline)"
rm -rf "$PREFIX/npm-cache"
cp -a "$BUNDLE_DIR/npm-cache" "$PREFIX/npm-cache"

# --ignore-scripts is required, not merely tidy: better-sqlite3's install script
# downloads a prebuild and falls back to compiling with node-gyp. Offline, with
# no toolchain, both fail. We place the binary by hand immediately below.
#
# Dev dependencies are included on purpose — both services boot through `tsx`,
# which is a devDependency. --omit=dev yields a tree that cannot start.
( cd "$PREFIX" && HOME="$PREFIX" "$NODE_BIN" "$NPM_CLI" ci \
    --offline \
    --cache "$PREFIX/npm-cache" \
    --include dev \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --loglevel warn ) || die "npm ci failed — the cache does not satisfy package-lock.json"
info "node_modules installed from the bundled cache"

step "Installing the better-sqlite3 native binary"
SQLITE_BUILD="$PREFIX/node_modules/better-sqlite3/build/Release"
mkdir -p "$SQLITE_BUILD"
TMP_PREBUILD="$(mktemp -d)"
trap 'rm -rf "$TMP_PREBUILD"' EXIT
tar -xzf "$BUNDLE_DIR/vendor/$PREBUILD" -C "$TMP_PREBUILD"
BINARY="$(find "$TMP_PREBUILD" -name 'better_sqlite3.node' -print -quit)"
[[ -n "$BINARY" ]] || die "better_sqlite3.node not found inside $PREBUILD"
install -m 0644 "$BINARY" "$SQLITE_BUILD/better_sqlite3.node"
info "placed $SQLITE_BUILD/better_sqlite3.node"

chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PREFIX"

# The one check that actually proves the hard part worked. A native module built
# for the wrong ABI or architecture fails exactly here and nowhere earlier.
SQLITE_VERSION="$( cd "$PREFIX" && "$NODE_BIN" -e \
  "const D=require('better-sqlite3');process.stdout.write(new D(':memory:').prepare('select sqlite_version() v').get().v)" )" ||
  die "better-sqlite3 failed to load — wrong architecture or ABI"
info "better-sqlite3 loads; sqlite $SQLITE_VERSION"

# ---------------------------------------------------------------------------
step "Configuration"
if [[ -f "$PREFIX/.env" ]]; then
  info ".env already present — left untouched"
else
  cp "$PREFIX/.env.example" "$PREFIX/.env"
  set_env() {
    if grep -q "^$1=" "$PREFIX/.env"; then
      sed -i "s|^$1=.*|$1=$2|" "$PREFIX/.env"
    else
      printf '%s=%s\n' "$1" "$2" >> "$PREFIX/.env"
    fi
  }
  HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"
  set_env KUNCEN_DB "$PREFIX/data/kuncen.db"
  set_env KUNCEN_DASHBOARD_URL "http://$HOSTNAME_FQDN:3000"
  set_env KUNCEN_PROXY_URL "http://$HOSTNAME_FQDN:8080"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$PREFIX/.env"
  chmod 0640 "$PREFIX/.env"
  info "wrote $PREFIX/.env from .env.example"
  info "review KUNCEN_UPSTREAM before trusting the lock — it must be a loopback address"
fi

# ---------------------------------------------------------------------------
step "Migrating the database"
# Migrations are append-only and versioned by PRAGMA user_version, so running
# this on an existing database is the upgrade, not a hazard.
( cd "$PREFIX" && sudo -u "$SERVICE_USER" env HOME="$PREFIX" \
    "$NODE_BIN" --env-file-if-exists=.env --import tsx packages/core/bin/migrate.ts ) ||
  die "migration failed"

if [[ $RUN_TESTS -eq 1 ]]; then
  step "Running the test suite"
  ( cd "$PREFIX" && sudo -u "$SERVICE_USER" env HOME="$PREFIX" "$NODE_BIN" --import tsx --test \
      packages/core/test/*.test.ts services/proxy/test/*.test.ts services/web/test/*.test.ts ) ||
    die "tests failed"
fi

# ---------------------------------------------------------------------------
step "Installing systemd units"
# The repo's units call /usr/bin/npx, which assumes a system-wide Node. This
# install is self-contained, so ExecStart is rewritten to the bundled runtime by
# absolute path: replacing the box's node must never take the lock down.
for unit in kuncen-proxy kuncen-web; do
  src="$PREFIX/deploy/$unit.service"
  [[ -f "$src" ]] || die "$src not found"
  sed \
    -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^Group=.*|Group=$SERVICE_GROUP|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PREFIX|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=$PREFIX/.env|" \
    -e "s|^ExecStart=.*npx tsx \(.*\)$|ExecStart=$NODE_BIN --import tsx \1|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$PREFIX/data|" \
    -e "s|^Documentation=.*|Documentation=file://$PREFIX/README.md|" \
    "$src" > "/etc/systemd/system/$unit.service"
  grep -q "^ExecStart=$NODE_BIN" "/etc/systemd/system/$unit.service" ||
    die "failed to rewrite ExecStart in $unit.service"
  info "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload

if [[ $START_SERVICES -eq 1 ]]; then
  step "Starting services"
  systemctl enable kuncen-proxy kuncen-web >/dev/null
  systemctl restart kuncen-proxy kuncen-web

  # Typecheck and tests both stayed green once while the proxy crashed on boot,
  # because module initialisation order is only exercised by actually starting
  # it. So: start it, then hit it.
  PROXY_PORT="$(sed -n 's/^KUNCEN_PROXY_PORT=//p' "$PREFIX/.env" | head -n1)"
  WEB_PORT="$(sed -n 's/^KUNCEN_WEB_PORT=//p' "$PREFIX/.env" | head -n1)"
  : "${PROXY_PORT:=8080}"
  : "${WEB_PORT:=3000}"

  probe() {
    local name="$1" port="$2" i
    for i in $(seq 1 30); do
      if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
        info "$name answering on :$port"
        return 0
      fi
      sleep 1
    done
    printf '\n%serror:%s %s never answered on :%s. Recent log:\n' "$RED" "$RESET" "$name" "$port" >&2
    journalctl -u "$name" -n 40 --no-pager >&2 || true
    return 1
  }

  if command -v curl >/dev/null; then
    failed=0
    probe kuncen-proxy "$PROXY_PORT" || failed=1
    probe kuncen-web "$WEB_PORT" || failed=1
    [[ $failed -eq 0 ]] || die "services installed but not healthy"
  else
    warn "curl not found; skipping the health probe"
    systemctl --no-pager --lines=0 status kuncen-proxy kuncen-web || true
  fi
else
  info "skipped (--no-start); units installed but not enabled"
fi

# ---------------------------------------------------------------------------
ADMIN="sudo -u $SERVICE_USER env HOME=$PREFIX $NODE_BIN --env-file-if-exists=.env --import tsx packages/core/bin/kuncen-admin.ts"

printf '\n%sInstalled.%s  %s\n' "$GREEN" "$RESET" "$PREFIX"
cat <<NEXT

Create the first admin account (registration is admin-provisioned by design):

  cd $PREFIX
  $ADMIN user add you@example.com 'Your Name' --admin

The API key it prints is shown once. Then:

  $ADMIN state
  systemctl status kuncen-proxy kuncen-web
  journalctl -u kuncen-proxy -f

Before this enforces anything, confirm in $PREFIX/.env that KUNCEN_UPSTREAM is a
loopback address and that the upstream itself binds 127.0.0.1. If the upstream is
reachable from the LAN, the lock is decorative.
NEXT
