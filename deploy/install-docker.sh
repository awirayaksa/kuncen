#!/usr/bin/env bash
#
# install-docker.sh — install kuncen as containers on an air-gapped machine.
#
# Run from inside the unpacked bundle directory:
#
#     sudo ./install-docker.sh
#
# The alternative to this is install.sh, which runs the same two services under
# systemd with a bundled Node. Pick one: both bind :8080 and :3000.
#
# Nothing here touches the network. The base image is `docker load`ed from the
# bundle and the image is built locally against the bundled npm cache.
#
# Re-running is the upgrade path: .env and data/ are never overwritten.
#
set -euo pipefail

PREFIX=/opt/kuncen
SERVICE_USER=kuncen
SERVICE_GROUP=kuncen
START_SERVICES=1
VERIFY=1
NO_CACHE=0

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'USAGE'
install-docker.sh — offline container installer for kuncen

  --prefix DIR     install root for .env, data/ and compose.yml (default /opt/kuncen)
  --user NAME      host user owning data/ and running the containers (default kuncen)
  --no-start       build and configure, but do not start the stack
  --no-verify      skip the MANIFEST.sha256 check
  --no-cache       docker build --no-cache
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
    --no-cache) NO_CACHE=1; shift ;;
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

DOCKER_DIR="$PREFIX/docker"
COMPOSE_FILE="$DOCKER_DIR/compose.yml"

# ---------------------------------------------------------------------------
step "Preflight"

[[ $EUID -eq 0 ]] || die "run as root (sudo ./install-docker.sh)"
[[ -f "$BUNDLE_DIR/BUNDLE.json" ]] || die "BUNDLE.json not found — run this from inside the unpacked bundle"
[[ -d "$BUNDLE_DIR/docker" ]] || die "this bundle carries no docker assets; rebuild it with: npm run bundle -- --docker"

read_bundle() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$BUNDLE_DIR/BUNDLE.json" | head -n1; }
BUNDLE_ARCH="$(read_bundle targetArch)"
KUNCEN_VERSION="$(read_bundle kuncen)"
PREBUILD="$(read_bundle betterSqlite3Prebuild)"
BASE_IMAGE="$(read_bundle dockerBase)"
BASE_TAR="$(read_bundle dockerBaseTarball)"
[[ -n "$BUNDLE_ARCH" && -n "$PREBUILD" && -n "$BASE_IMAGE" && -n "$BASE_TAR" ]] ||
  die "BUNDLE.json is incomplete"
IMAGE="kuncen:$KUNCEN_VERSION"

# Node's arch names are not Docker's: they coincide for arm64 and differ for
# x64/amd64, so both are tracked rather than assumed equal.
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  aarch64|arm64) HOST_ARCH=arm64; DOCKER_ARCH=arm64 ;;
  x86_64|amd64)  HOST_ARCH=x64;   DOCKER_ARCH=amd64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
[[ "$HOST_ARCH" == "$BUNDLE_ARCH" ]] ||
  die "bundle is for linux-$BUNDLE_ARCH but this machine is $(uname -m)"

command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (is it running, and are you root?)"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null; then
  COMPOSE=(docker-compose)
else
  die "neither 'docker compose' nor 'docker-compose' is available"
fi

# Both deployment modes bind the same two ports. Finding out at `compose up`
# time, with systemd racing the containers to :8080, is a bad way to learn this.
for unit in kuncen-proxy kuncen-web; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    die "$unit is running under systemd and would fight these containers for the port.
       Stop it first:  sudo systemctl disable --now kuncen-proxy kuncen-web
       Or uninstall it: sudo ./uninstall.sh"
  fi
done

info "target      linux-$BUNDLE_ARCH ($(uname -m))"
info "docker      $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
info "compose     $("${COMPOSE[@]}" version --short 2>/dev/null || echo unknown)"
info "base image  $BASE_IMAGE"
info "image       $IMAGE"
info "prefix      $PREFIX"

if [[ -f "$COMPOSE_FILE" ]]; then
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
# The containers run as this uid so that kuncen.db on the bind mount is owned by
# something that still means something on the host.
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "user $SERVICE_USER already exists"
else
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER"
  info "created system user $SERVICE_USER"
fi
getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"
KUNCEN_UID="$(id -u "$SERVICE_USER")"
KUNCEN_GID="$(id -g "$SERVICE_USER")"
info "uid:gid $KUNCEN_UID:$KUNCEN_GID"

DATA_DIR="$PREFIX/data"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$PREFIX"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$DATA_DIR"
install -d -m 0755 "$DOCKER_DIR"

# ---------------------------------------------------------------------------
step "Loading the base image"
if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  info "$BASE_IMAGE already present"
else
  docker load -i "$BUNDLE_DIR/docker/$BASE_TAR" >/dev/null
  docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 ||
    die "loaded $BASE_TAR but $BASE_IMAGE is still not present"
  info "loaded $BASE_IMAGE"
fi

LOADED_ARCH="$(docker image inspect --format '{{.Architecture}}' "$BASE_IMAGE")"
[[ "$LOADED_ARCH" == "$DOCKER_ARCH" ]] ||
  die "base image is $LOADED_ARCH, not $DOCKER_ARCH — it was pulled without --platform linux/$DOCKER_ARCH"
info "architecture $LOADED_ARCH"

# ---------------------------------------------------------------------------
step "Building $IMAGE"
# The context is the bundle root: the Dockerfile reads app/, npm-cache/ and
# vendor/ from it. Nothing in the build reaches the network.
BUILD_ARGS=(--file "$BUNDLE_DIR/docker/Dockerfile"
            --build-arg "BASE=$BASE_IMAGE"
            --build-arg "PREBUILD=$PREBUILD"
            --tag "$IMAGE" --tag "kuncen:latest")
[[ $NO_CACHE -eq 1 ]] && BUILD_ARGS+=(--no-cache)
docker build "${BUILD_ARGS[@]}" "$BUNDLE_DIR" ||
  die "image build failed"
info "built $IMAGE ($(docker image inspect --format '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1048576}'))"

# ---------------------------------------------------------------------------
step "Configuration"
if [[ -f "$PREFIX/.env" ]]; then
  info ".env already present — left untouched"
else
  cp "$BUNDLE_DIR/app/.env.example" "$PREFIX/.env"
  set_env() {
    if grep -q "^$1=" "$PREFIX/.env"; then
      sed -i "s|^$1=.*|$1=$2|" "$PREFIX/.env"
    else
      printf '%s=%s\n' "$1" "$2" >> "$PREFIX/.env"
    fi
  }
  HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"
  # The data directory is mounted at its host path, so this is correct on both
  # sides of the container boundary.
  set_env KUNCEN_DB "$DATA_DIR/kuncen.db"
  set_env KUNCEN_DASHBOARD_URL "http://$HOSTNAME_FQDN:3000"
  set_env KUNCEN_PROXY_URL "http://$HOSTNAME_FQDN:8080"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$PREFIX/.env"
  chmod 0640 "$PREFIX/.env"
  info "wrote $PREFIX/.env from .env.example"
  info "KUNCEN_UPSTREAM must stay a 127.0.0.1 address — host networking is what makes that reachable"
fi

# compose reads env_file as root, but the containers run as $SERVICE_USER.
[[ -r "$PREFIX/.env" ]] || die "$PREFIX/.env is not readable"

step "Rendering $COMPOSE_FILE"
sed -e "s|@@IMAGE@@|$IMAGE|g" \
    -e "s|@@ENV_FILE@@|$PREFIX/.env|g" \
    -e "s|@@UID@@|$KUNCEN_UID|g" \
    -e "s|@@GID@@|$KUNCEN_GID|g" \
    -e "s|@@DATA_DIR@@|$DATA_DIR|g" \
    -e "s|@@COMPOSE_PATH@@|$COMPOSE_FILE|g" \
    "$BUNDLE_DIR/docker/compose.yml.tmpl" > "$COMPOSE_FILE"
grep -q '@@' "$COMPOSE_FILE" &&
  die "unsubstituted placeholder left in $COMPOSE_FILE: $(grep -o '@@[A-Z_]*@@' "$COMPOSE_FILE" | sort -u | tr '\n' ' ')"
"${COMPOSE[@]}" -f "$COMPOSE_FILE" config >/dev/null || die "rendered compose file is invalid"
info "valid"

# A wrapper, because the full incantation is not something anyone should have to
# remember at the moment they need to force-release a lock.
cat > "$DOCKER_DIR/kuncen-admin" <<ADMIN
#!/usr/bin/env bash
# kuncen-admin inside the container. Same CLI as npm run admin.
exec ${COMPOSE[*]} -f "$COMPOSE_FILE" run --rm --no-deps migrate \\
  node --import tsx packages/core/bin/kuncen-admin.ts "\$@"
ADMIN
chmod 0755 "$DOCKER_DIR/kuncen-admin"
ln -sf "$DOCKER_DIR/kuncen-admin" /usr/local/bin/kuncen-admin
info "kuncen-admin installed to /usr/local/bin"

# ---------------------------------------------------------------------------
if [[ $START_SERVICES -eq 1 ]]; then
  step "Starting the stack"
  # migrate runs to completion first; compose enforces that ordering here. It is
  # not re-run on daemon restart, which is correct — the schema is already at
  # version by then.
  "${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d --remove-orphans ||
    die "compose up failed"

  PROXY_PORT="$(sed -n 's/^KUNCEN_PROXY_PORT=//p' "$PREFIX/.env" | head -n1)"
  WEB_PORT="$(sed -n 's/^KUNCEN_WEB_PORT=//p' "$PREFIX/.env" | head -n1)"
  : "${PROXY_PORT:=8080}"
  : "${WEB_PORT:=3000}"

  # Probed from the host, not through docker: what matters is that the port is
  # answering where a colleague's tool will look for it.
  probe() {
    local name="$1" port="$2" i
    for i in $(seq 1 40); do
      if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
        info "$name answering on :$port"
        return 0
      fi
      sleep 1
    done
    printf '\n%serror:%s %s never answered on :%s. Recent log:\n' "$RED" "$RESET" "$name" "$port" >&2
    "${COMPOSE[@]}" -f "$COMPOSE_FILE" logs --tail 40 "$name" >&2 || true
    return 1
  }

  if command -v curl >/dev/null; then
    failed=0
    probe proxy "$PROXY_PORT" || failed=1
    probe web "$WEB_PORT" || failed=1
    [[ $failed -eq 0 ]] || die "containers are up but not healthy"
  else
    warn "curl not found; skipping the health probe"
    "${COMPOSE[@]}" -f "$COMPOSE_FILE" ps
  fi
else
  step "Not starting (--no-start)"
  info "start it with: ${COMPOSE[*]} -f $COMPOSE_FILE up -d"
fi

# ---------------------------------------------------------------------------
printf '\n%sInstalled.%s  %s\n' "$GREEN" "$RESET" "$COMPOSE_FILE"
cat <<NEXT

Create the first admin account (registration is admin-provisioned by design):

  sudo kuncen-admin user add you@example.com 'Your Name' --admin

The API key it prints is shown once. Then:

  sudo kuncen-admin state
  ${COMPOSE[*]} -f $COMPOSE_FILE ps
  ${COMPOSE[*]} -f $COMPOSE_FILE logs -f proxy

Before this enforces anything, confirm in $PREFIX/.env that KUNCEN_UPSTREAM is a
loopback address and that vLLM itself binds 127.0.0.1. The containers share the
host's network namespace, so 127.0.0.1 means the same thing on both sides — and
if vLLM is reachable from the LAN, the lock is decorative no matter how it runs.
NEXT
