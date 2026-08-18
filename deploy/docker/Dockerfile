# kuncen — one image, three commands: migrate, proxy, web.
#
# Built ON THE TARGET from the offline bundle. The build context carries the npm
# cache and the prebuilt native binary, and the base image arrives as a
# `docker load`ed tarball, so no stage of this build reaches the network.
#
# Building on the Spark rather than shipping a finished image is deliberate: the
# build is then native arm64 (fast, no QEMU) and the only thing the networked
# Windows machine has to produce is a `docker pull --platform linux/arm64` of the
# base — which never executes a single arm64 instruction.
#
# There is no build step in this project — both services run TypeScript through
# tsx — so the image is source plus node_modules and nothing else.

ARG BASE=node:22-bookworm-slim

# --- dependencies -----------------------------------------------------------
# A separate stage so the 14 MB npm cache does not survive into a layer of the
# final image.
FROM ${BASE} AS deps
WORKDIR /app

# Manifests only: npm needs every workspace package.json to build the tree, and
# copying nothing else keeps this layer valid across source edits.
COPY app/package.json app/package-lock.json ./
COPY app/packages/core/package.json packages/core/
COPY app/services/proxy/package.json services/proxy/
COPY app/services/web/package.json services/web/
COPY npm-cache /tmp/npm-cache

# --ignore-scripts is mandatory, not tidy: better-sqlite3's install script
# downloads a prebuild and otherwise compiles with node-gyp. Offline, in a slim
# image with no toolchain, both fail. The binary is placed by hand below.
#
# Dev dependencies stay. Both services boot through tsx, which is a
# devDependency; --omit=dev builds an image that cannot start.
RUN npm ci --offline --cache /tmp/npm-cache \
      --include dev --ignore-scripts --no-audit --no-fund

# The prebuild is keyed by Node's ABI, so it only matches because the base image
# and the bundle were pinned to the same Node major.
ARG PREBUILD
COPY vendor/${PREBUILD} /tmp/prebuild.tar.gz
RUN mkdir -p node_modules/better-sqlite3/build/Release \
 && tar -xzf /tmp/prebuild.tar.gz -C /tmp \
 && cp /tmp/build/Release/better_sqlite3.node node_modules/better-sqlite3/build/Release/ \
 && rm -rf /tmp/prebuild.tar.gz /tmp/build /tmp/npm-cache

# --- runtime ----------------------------------------------------------------
FROM ${BASE}
WORKDIR /app

ENV NODE_ENV=production

# node_modules first: it holds symlinks into packages/ and services/ (npm
# workspaces), which COPY preserves. They dangle until the source lands below.
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./

# Two smoke tests, run natively at build time, that catch the two things most
# likely to be wrong: a native binary for the wrong ABI or architecture, and a
# tsx that cannot load because --ignore-scripts skipped esbuild's postinstall.
RUN node -e "const D=require('better-sqlite3'); \
      console.log('better-sqlite3 ok, sqlite ' + new D(':memory:').prepare('select sqlite_version() v').get().v)" \
 && node --import tsx -e "console.log('tsx ok')"

# Overridden per service by compose. The proxy is the one that must never be
# down, so it is the default for anyone running the image bare.
CMD ["node", "--import", "tsx", "services/proxy/src/index.ts"]
