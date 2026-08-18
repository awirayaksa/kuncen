# Kuncen

Exclusive-access manager for one shared resource — originally a DGX Spark, now
whatever you point it at. One person holds the lock; everyone else waits in an
ordered queue. See [PLAN.md](PLAN.md) for the design and the reasoning behind
it — this file covers running the thing.

```
  clients (Cline, scripts, curl)         browsers
            │ Bearer kuncen_...              │ session cookie
            ▼                                ▼
   ┌───────────────────┐          ┌───────────────────┐
   │   kuncen-proxy    │          │    kuncen-web     │
   │   :8080  /v1/*    │          │      :3000        │
   │  enforces + sweeps│          │  dashboard + admin│
   └─────────┬─────────┘          └─────────┬─────────┘
             ▼                ┌─────────────┘
   127.0.0.1:8000             ▼
   the upstream       kuncen.db (SQLite, WAL)
```

## Layout

| Path | What |
|---|---|
| `packages/core` | Schema, migrations, lock state machine, sweeper, auth, telemetry |
| `services/proxy` | `:8080` — enforcement, passthrough, health probe, **the sweeper** |
| `services/web` | `:3000` — dashboard, request/cancel/release, profile, admin |
| `services/web/public` | Brand assets, served at `/static/<name>` |
| `tools/fake-vllm.ts` | Stand-in backend for development and tests |
| `deploy/` | systemd units |

No build step and no linter. Both services run TypeScript directly through `tsx`.
`CLAUDE.md` carries the invariants worth knowing before editing any of it.

## First run

```sh
npm install
cp .env.example .env          # then edit KUNCEN_DB, KUNCEN_UPSTREAM and the URLs

npm run migrate
npm run admin -- user add alice@example.com Alice --admin
npm run admin -- user add bob@example.com Bob
```

Every `npm run` script loads `.env` automatically (`node --env-file-if-exists`).
Nothing reads it on its own, so invoking a service directly with `npx tsx …` gets
no configuration and falls back to the defaults.

Each `user add` prints a password and an API key **once**. Hand them over and
move on; only hashes are stored.

Then, in three terminals:

```sh
npm run dev:fake-vllm         # or point KUNCEN_UPSTREAM at the real vLLM
npm run start:proxy
npm run start:web
```

Open `http://localhost:3000`, sign in, click **Request access**.

## Configuring a client

The API key answers *who you are*; the lock answers *whether you may go right
now*. Paste it once and never touch it again:

```sh
export OPENAI_BASE_URL=http://spark.local:8080/v1
export OPENAI_API_KEY=kuncen_...
```

While someone else holds the lock you get **`423 Locked`**, plus a `Retry-After`
header:

```json
{
  "error": {
    "message": "Kuncen: the DGX Spark is held by Alice. You are #2 of 3 in the queue.",
    "type": "kuncen_locked",
    "code": "kuncen_locked"
  },
  "kuncen": {
    "status": "HELD", "holder": "Alice",
    "expires_at": 1786800000000, "expires_in_seconds": 240, "expiry_reason": "idle",
    "queue_position": 2, "queue_length": 3,
    "dashboard": "http://spark.local:3000"
  }
}
```

Deliberately not `429` — `openai-python` auto-retries those, turning a clean
"you're queued" into a hang-then-fail. `KUNCEN_DASHBOARD_URL` is what puts a
clickable destination in that message.

The proxy will not enqueue you. Joining the queue is a button press on the
dashboard, always. `/v1/models` and `/health` need a key but not the lock;
everything else under `/v1/*` needs both.

## Deploying

On a box that can reach a registry:

```sh
sudo useradd --system --home /opt/kuncen kuncen
sudo rsync -a --exclude node_modules ./ /opt/kuncen/
cd /opt/kuncen && sudo -u kuncen npm ci
sudo -u kuncen KUNCEN_DB=/opt/kuncen/data/kuncen.db npm run migrate

sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl enable --now kuncen-proxy kuncen-web
```

Not `npm ci --omit=dev`: there is no build step, both services boot through
`tsx`, and `tsx` is a devDependency. Omitting dev dependencies produces a tree
that installs cleanly and cannot start.

### Air-gapped install

The Spark usually cannot reach npmjs.org, so the install is done in two halves:
build a bundle on a machine that has internet, carry it over, run one script.

```sh
npm run bundle                    # on the networked machine; writes dist/
npm run bundle -- --docker        # …and the container deployment too
                                  # --arch x64 / --node-version to override
```

That produces `dist/kuncen-offline-<version>-linux-arm64.tar.gz` (~44 MB)
containing a Node runtime for the target, an npm cache holding every tarball in
`package-lock.json` resolved *for linux/arm64*, the prebuilt `better-sqlite3`
binary, the source, and the installer. Copy it across, then:

```sh
tar -xzf kuncen-offline-1.0.0-linux-arm64.tar.gz
cd kuncen-offline-1.0.0-linux-arm64
sudo ./install.sh                 # --prefix, --user, --no-start, --run-tests
```

`install.sh` verifies the bundle against `MANIFEST.sha256`, creates the service
user, unpacks Node into `/opt/kuncen/runtime/node`, installs dependencies with
`npm ci --offline --ignore-scripts`, drops the native SQLite binary in, writes
`.env` from `.env.example` if there is none, migrates, installs the systemd
units with `ExecStart` pointed at the bundled Node, and then actually hits
`/healthz` on both services before claiming success. Re-run it to upgrade;
`.env` and `data/` are never touched. `deploy/uninstall.sh` reverses it and
keeps the database unless given `--purge`.

Three things in the bundle exist because of specific failure modes:

- **Optional dependencies are resolved for the target, not the build host.** A
  plain `npm ci` on Windows caches `@esbuild/win32-x64`, and the offline install
  on the Spark then fails with nothing to fall back on. The bundler passes
  `--os linux --cpu arm64 --libc glibc`.
- **`better-sqlite3` is installed with `--ignore-scripts` and its binary placed
  by hand.** Its install script downloads a prebuild and otherwise compiles with
  node-gyp; offline and without a toolchain, both fail. The prebuild is keyed by
  Node's ABI (`process.versions.modules`), so the Node version in the bundle and
  the binary are chosen together — 22.x is ABI 127. `install.sh` checks the two
  agree before it trusts them.
- **The runtime lives inside the prefix.** Nothing here touches the system Node,
  npm, or apt, and the units name the interpreter by absolute path, so upgrading
  the box's own Node cannot take the lock down.

### Docker instead of systemd

Same bundle, different installer. Build it with `--docker` and run:

```sh
sudo ./install-docker.sh          # --prefix, --user, --no-start, --no-cache
sudo kuncen-admin user add you@example.com 'Your Name' --admin
```

Pick one mode or the other — both bind `:8080` and `:3000`, and each installer
refuses to run while the other one is up. Layout is otherwise identical:
`/opt/kuncen/.env` and `/opt/kuncen/data` on the host, mounted into the
containers **at the same paths**, so one `.env` is correct in both modes and
`KUNCEN_DB` needs no override. `uninstall.sh` removes whichever is installed.

The image is built *on the Spark* from the bundle, not shipped as a finished
image. The base image arrives as a `docker load`able tarball, and the build
context carries the npm cache and the native binary, so the build reaches no
registry. That also means the networked Windows machine only has to
`docker pull --platform linux/arm64` the base — it never executes an arm64
instruction, so no QEMU and no emulated `npm ci`. The build on the Spark is
native, and it ends with two smoke tests that fail the build rather than the
first request: `better-sqlite3` loading, and `tsx` loading.

**`network_mode: host` is the requirement, not a shortcut.** vLLM binds
`127.0.0.1` so that the lock is a property of the network rather than something
our code has to get right. A bridged container reaches the host only at the
`docker0` gateway (`172.17.0.1`), which a loopback-bound vLLM never answers on —
bridge networking cannot work here at all. Rebinding vLLM to `172.17.0.1` to
make it work would expose it to every container on the default bridge, which is
exactly the bypass the design exists to prevent. Sharing the host's network
namespace is what lets `KUNCEN_UPSTREAM` stay `http://127.0.0.1:8000` while
`:8080` and `:3000` are still reachable from the LAN, and it is why there are no
port mappings in the compose file: the services bind host interfaces directly,
per `KUNCEN_PROXY_HOST` / `KUNCEN_WEB_HOST`.

Two smaller things that follow from the same reasoning:

- **The containers run as the host's `kuncen` uid**, not as root and not as the
  image's `node` user, so `kuncen.db` on the bind mount is owned by something
  that still means something on the host. The installer reads the uid after
  creating the account and renders it into the compose file.
- **`migrate` is a one-shot service** the other two `depend_on` with
  `service_completed_successfully`. It does not re-run when the daemon restarts
  containers after a reboot, which is correct — the schema is already at version
  by then — but it does re-run on every `compose up`, which is the upgrade.

The bind mount must be a local filesystem. SQLite in WAL mode with two processes
on one file over NFS is a corrupted database waiting for a quiet afternoon.

**Enforcement integrity — non-negotiable, or the lock is decorative:**

- The upstream binds `127.0.0.1`. Never `0.0.0.0`. This is what makes the rule a
  property of the network rather than something our code has to get right. Point
  `KUNCEN_UPSTREAM` at a remote HTTPS endpoint and the lock becomes advisory —
  fine for development, not a deployment.
- Only `:8080` and `:3000` are exposed on the LAN.
- SSH to the box remains the real break-glass: an admin can always hit
  `127.0.0.1:8000` directly. Nobody is ever locked out of their own hardware by
  this app, which is what lets the in-app override stay minimal.

## Operating

```sh
npm run admin -- state             # lock, queue, health
npm run admin -- sessions 20       # recent holds, with utilization
npm run admin -- stats 14          # the numbers from "The bet"
npm run admin -- config list
npm run admin -- config set idle_timeout_seconds 300
npm run admin -- user key bob@example.com    # rotate a key
npm run admin -- unlock "wedged after a crash"
```

Timer changes take effect on the next sweeper tick — no restart. The admin page
edits the same values.

`unlock` is the CLI break-glass: it forces the lock to `FREE` without a drain and
without killing anything still streaming. Restart `kuncen-proxy` if a generation
is still running. The in-app **force-release** is the normal tool; it drains
properly and requires a reason.

### Notifications

The dashboard raises a browser notification for five things. Each one is
addressed to a single person — nothing here is broadcast:

| You get | When | Because |
|---|---|---|
| *"Bob is requesting access to the DGX Spark."* | you hold the lock and somebody queues | the whole social contract is that you hand it over; you cannot do that if nobody tells you |
| *"The DGX Spark is now available to use."* | you were queued and the lock reached you | |
| *"Your lock expires in about 60s."* | you hold it, someone is waiting, a timer is about to fire | |
| *"An admin released your lock."* | you were force-released | an override should never be silent |
| *"Your request timed out."* | your queue entry hit `queue_entry_ttl_seconds` | losing your place quietly is worse than losing it |

Permission is asked for the first time you press **Request**, or on load if you
already hold the lock or are waiting. Denying it costs you nothing but the live
page, which updates either way.

**This needs a tab open.** Backgrounded is fine — OS notifications still fire —
but a closed tab gets nothing. Real Web Push is not available here: service
workers require a secure context, and Kuncen ships as plain HTTP on the LAN.

If two people queue in quick succession the popups collapse into one, which is
why the text carries a `(2 waiting)` count.

### Request tracing

**Off by default.** Set `KUNCEN_TRACE=full` and restart both services to record
every request and response body the proxy relays. They then show up under
**Traces** in the dashboard, reassembled into a readable conversation — the
message list you sent, and the reply, with a streamed response stitched back
together from its SSE frames.

This deliberately reverses the rule stated further down this file, that bodies
are never logged. It is a real change to what the box does to everyone using it,
so:

- **Authors read their own; admins read anyone's.** Enforced by `mayReadTrace`
  on every route that serves a byte, including the raw-body route. A colleague
  guessing a URL gets a 404.
- **It announces itself** — in the proxy log at startup, and in a banner on the
  dashboard and the traces page for as long as it is on.
- **There is no runtime toggle.** Unlike the timers, this needs a restart. A
  checkbox that silently starts recording colleagues' prompts is not something
  worth having.

Bodies are files under `KUNCEN_TRACE_DIR` (default `traces/` beside the
database), not rows: an agentic client resends its whole context every turn, and
multi-MB writes into `kuncen.db` would land in the same WAL the 1s sweeper
transacts on. Each body is capped at `KUNCEN_TRACE_MAX_BYTES` (8 MB) — past that
the recording stops and the trace is flagged truncated, while the request itself
is untouched. `kuncen-proxy` prunes anything older than
`KUNCEN_TRACE_RETENTION_HOURS` (7 days) every five minutes, unlinking files
before deleting rows.

Capture never buffers a whole body, never delays a byte reaching the client, and
cannot fail the request: a full or read-only disk costs you the trace, not the
generation.

Disk is the thing to watch. A busy day of agentic coding is gigabytes; keep the
retention short, or leave this off except when you are actually debugging.

### Health

Both services expose `/healthz`. The dashboard shows two separate signals, so
"the resource is broken" and "the resource is taken" never look alike:

- **Sweeper alive** — the proxy heartbeats each tick; a stale heartbeat means
  nothing is expiring, and the page says so.
- **Backend up / down / unknown** — polled by the proxy every 5s.

The backend signal has **three** states, not two, because "we found nowhere to
ask" is not "it is dead":

| State | Means |
|---|---|
| up | a probe path answered `2xx` |
| down | nothing answered, or `5xx`, or the credential was refused |
| unknown | the host answered, but serves no endpoint we know how to probe |

`/health` is a vLLM convention. An OpenAI-compatible gateway usually `404`s it
while serving inference perfectly well, so the probe tries `/health` first and
falls back to `/v1/models`, then sticks with whichever answered — one request per
poll thereafter. Hover the badge for the reason.

```sh
# KUNCEN_HEALTH_PATH=/v1/models   # pin one path (no fallback), or `off`
# KUNCEN_HEALTH_TIMEOUT_MS=5000
```

Pinning a path disables the fallback on purpose: an explicit typo should surface
rather than be silently papered over. The probe sends `KUNCEN_UPSTREAM_API_KEY`
when one is set, and a `401`/`403` is reported as a credential problem rather
than as a dead backend.

### Troubleshooting

**A setting in `.env` seems ignored.** Only `npm run` scripts load it. Check the
spelling too — every variable starts `KUNCEN_`, and an unknown name is silently
ignored rather than rejected. The proxy logs its upstream and the resource it is
guarding at startup, which is the fastest way to confirm what it actually read.

**The badge says the backend is down, but requests work.** The probe is looking
in the wrong place: see **Health** above. `npm run admin -- state` prints the
reason on the second line.

**The badge says the backend is down and requests fail with 502.** That is real.
The holder keeps the lock — losing your slot because the backend hiccuped would
be perverse — so nothing needs resetting once it comes back.

**Everyone gets 423 and the queue never advances.** Check the sweeper badge. If
it says *not responding*, `kuncen-proxy` is down or wedged; nothing is expiring,
because nothing can. Restarting it is safe — in-flight counters are reset at
startup, since no request survives the process.

**`KUNCEN_UPSTREAM` ends in `/v1` and everything 404s.** The proxy appends the
caller's whole path, so the base URL must not repeat it: use
`https://host/api`, not `https://host/api/v1`.

**Windows: renaming or deleting `kuncen.db` fails with "resource busy".** A
service still has it open. Stop both first; the `-wal` and `-shm` files go with
it.

## What it guards

Kuncen began as a lock on one DGX Spark, but nothing in the lock, the queue or
the timers knows what is behind the proxy. The resource is named once, in `.env`,
and both services read it:

```sh
KUNCEN_RESOURCE_NAME=DGX Spark
KUNCEN_RESOURCE_ARTICLE=the      # "the DGX Spark is free"
```

The article is separate because names differ. `the Build Server 3 is free` is
wrong, so for names that stand on their own set it empty:

```sh
KUNCEN_RESOURCE_NAME=Build Server 3
KUNCEN_RESOURCE_ARTICLE=
```

That name reaches the login page, the live dashboard headlines, the browser
notifications, and the `423` body a blocked client tool prints — the dashboard
gets it through `data-resource-*` attributes on `<body>`, so the shared client
script stays deployment-agnostic. Restart both services after changing it; unlike
the timers, this is not read per tick.

Whatever `KUNCEN_UPSTREAM` points at still has to speak HTTP and still has to be
unreachable from the LAN for the lock to mean anything — see **Deploying**.

## Branding

Assets live in `services/web/public` and are served from `/static/<name>`, images
only, filename-whitelisted. Palette from the brand guidelines: Deep Indigo
`#1B3A5C` for structure, Brushed Gold `#D4AF8A` for every action and every "this
is you", Accent Dark `#0F1E2E` behind it all. Status colours stay separate from
gold so a held lock never reads as a warning.

The dark UI takes the reversed (white) mark, per the guidelines. Two notes on how
it is used:

- **The mark is cropped in CSS, not resized.** The supplied files carry ~40%
  clear space on every side — right for print, invisible in a 26px header. The
  `.logo` rule frames the measured content box (x 840–1440, y 1060–1390 of the
  2400² canvas) with a single uniform scale, so the artwork is never distorted.
- **`kuncen_favicon.png` is derived,** not supplied: a tight 256² crop of the
  mark on Accent Dark. Downscaling the original to 16px would have produced a
  speck in a field of empty space. Regenerate it from the source if the mark
  changes.

The wordmark in the header is set in text rather than the wordmark PNG, which is
Deep Indigo artwork and would vanish on this background. The guidelines sanction
mark-only in the product interface.

## Tests

```sh
npm test        # 112 tests
npm run typecheck

node --import tsx --test packages/core/test/sweeper.test.ts          # one file
node --import tsx --test --test-name-pattern="drain" services/proxy/test/*.test.ts
```

The suite covers the parts that are easy to get subtly wrong: contention gating,
retroactive idle measurement, in-flight suspending the idle timer, the drain
ceiling actually aborting the **upstream** connection (verified against a fake
backend that counts abandoned generations), conditional-write acquisition,
sweeper idempotency across late and repeated ticks, 423 shape, and the health
probe telling "no probe endpoint" apart from "backend down".

Tests never sleep to reach a deadline — `tick(db, ts)` takes the time, so "the
drain ceiling expired" is one call with a synthetic timestamp.

Green tests are not sufficient before calling something done: both suites passed
while the proxy crashed on boot with a temporal-dead-zone `ReferenceError`,
because unit tests never exercise module initialisation order. Start the services
and hit them.

## Decisions taken while building

These go beyond what PLAN.md pinned down. Each is cheap to reverse.

- **Hono + server-rendered HTML, no bundler.** The dashboard is a 2s poll against
  `/api/state` and some DOM updates. Six runtime dependencies total; the churny
  half stays editable on the box.
- **Hand-written SQL migrations, versioned by `PRAGMA user_version`.** Drizzle
  still defines the schema and types every query. Dropping drizzle-kit keeps a
  codegen step and a CLI out of the path between a fresh checkout and a running
  box, for six tables that will barely move.
- **scrypt from `node:crypto` instead of argon2.** One fewer native module to
  build for arm64. `better-sqlite3` is unavoidable; argon2 is not.
- **`auth_sessions` table.** PLAN's `sessions` is lock telemetry and keeps the
  name; browser logins needed their own table.
- **Three columns beyond the plan.** `lock_state.session_id` (so a request that
  outlives its session writes telemetry to the right row rather than the next
  holder's), `sessions.busy_ms` (GPU-busy-under-lock directly, rather than
  re-derived from request timestamps), `sessions.warned_at` (so the 60s expiry
  warning fires once per session).
- **Extra event types.** PLAN lists `rejected | force_release | granted |
  expired`; `queued`, `cancelled`, `released` and `expiry_warning` were added so
  the dashboard can drive notifications off the same table.
- **Request tracing exists, and inverts a stated principle.** PLAN.md says the
  proxy never records what it relays, and by default it still does not. Tracing
  was added deliberately, so it is opt-in per deployment, announced in the log
  and on the page while it runs, and restart-only rather than a runtime toggle.
  Bodies went to files rather than into `kuncen.db` because the sweeper transacts
  on that WAL every second.
- **`access_requested` is its own event, not a second reading of `queued`.**
  `events.user_id` is the *recipient*: delivery filters on it, so an event only
  reaches the person it is filed under. `queued` is filed under the requester,
  which is right for them and useless for the holder — the one person who can
  act on it. Rather than special-case the query, the holder gets their own event,
  filed under them, with `actor_id` naming who wants the lock. It is written only
  while the lock is `HELD`: a holder already draining out has no decision left to
  make, and telling them someone is waiting would be noise at the worst moment.
- **"Sole writer of lock state" relaxed, narrowly.** kuncen-web performs the two
  transitions that need no access to open sockets — `FREE -> HELD` on a request
  that finds the lock free, and `HELD -> DRAINING` on release or force-release.
  Both are guarded conditional writes inside `IMMEDIATE` transactions.
  `DRAINING -> FREE` stays proxy-only, because completing a drain may require
  aborting live upstream connections and only the proxy holds those. The
  alternative — an internal RPC from web to proxy — adds a failure mode (proxy
  unreachable, so nobody can release) for no correctness gain.
- **Rejections are logged individually.** PLAN says every 423; a retry loop could
  therefore write a lot of rows. At four people this is fine, and coalescing
  would have blurred exactly the number the bet needs.
- **Backend health is three-valued.** PLAN implies up/down. A missing `/health`
  endpoint is neither: the host answered, we just have nowhere to ask. Collapsing
  that into "down" produced a permanent false alarm against an OpenAI-compatible
  gateway, and a badge that lies gets ignored.
- **The guarded resource is a parameter, not a string literal.** `KUNCEN_RESOURCE_NAME`
  and `KUNCEN_RESOURCE_ARTICLE` in `.env`, resolved once per process by
  `packages/core/src/resource.ts`. Two values rather than one because English
  articles do not survive a find-and-replace: "the DGX Spark is free" and "Build
  Server 3 is free" are both correct and differ by more than the noun. Kept in
  the environment rather than the `config` table because it is a property of the
  deployment, not something to tune at runtime like the timers.
- **Old `kunci_` API keys still authenticate.** The rename to Kuncen changed the
  prefix for newly issued keys, but the whole point of a permanent credential is
  that it is pasted into a tool once and never touched again — a rename is not a
  good enough reason to break that. `LEGACY_KEY_PREFIXES` in
  `packages/core/src/auth.ts` is one line to delete once nobody carries an old
  key. The session cookie was renamed outright, which costs one sign-in.
