# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kuncen serialises access to one shared resource: exactly one person holds a lock,
everyone else waits in an ordered queue. [PLAN.md](PLAN.md) is the design record
and states the *reasons* behind most rules here — read it before changing
behaviour. [README.md](README.md) covers operating the thing, and its "Decisions
taken while building" section records every deviation from PLAN.md.

## Commands

```sh
npm install                      # npm workspaces: packages/*, services/*
npm test                         # 112 tests, node:test
npm run typecheck                # tsc --noEmit, whole workspace

npm run migrate                  # create/upgrade the schema at $KUNCEN_DB
npm run admin -- state           # also: sessions, stats, config, user, unlock
npm run dev:fake-vllm            # stand-in backend on 127.0.0.1:8000
npm run start:proxy              # :8080  (dev:proxy for --watch)
npm run start:web                # :3000  (dev:web for --watch)
```

Run one test file, or one test by name:

```sh
node --import tsx --test packages/core/test/sweeper.test.ts
node --import tsx --test --test-name-pattern="drain ceiling" services/proxy/test/*.test.ts
```

There is **no build step and no linter**. Both services run TypeScript directly
through `tsx`. Every script loads `.env` via `node --env-file-if-exists=.env`;
nothing reads `.env` on its own, so a bare `npx tsx services/...` gets no
configuration.

`npm test` lists its test globs explicitly — a new `*/test/` directory must be
added to that script or it will silently never run.

## Architecture

Two processes over one SQLite file (WAL). `packages/core` holds everything both
of them need; neither service imports the other.

```
clients ──Bearer kuncen_──▶ kuncen-proxy :8080 ──▶ upstream (vLLM, gateway, …)
browsers ──cookie─────────▶ kuncen-web   :3000
                    both ──▶ kuncen.db (SQLite, WAL)
```

**Why two processes.** The proxy holds streaming connections open for minutes;
the dashboard churns. A CSS tweak must never restart the thing currently
streaming someone's generation. Keep the proxy small and its dependencies boring.

**The sweeper lives in the proxy** (`services/proxy/src/index.ts`, 1s interval).
If it is dead the proxy is dead, so nothing can reach the resource anyway — there
is no state where locks stop expiring while people still burn time.

### Who may write what

| Transition | Owner | Why |
|---|---|---|
| `FREE -> HELD` | either | Promotion needs no open sockets |
| `HELD -> DRAINING` | either | Release / force-release / timers |
| `DRAINING -> FREE` | **proxy only** | May require aborting live upstream connections, and only the proxy holds them |
| `in_flight` | **proxy only** | It is the only thing with requests in flight |

PLAN.md says the proxy is "sole writer of lock state"; that is relaxed exactly as
far as the table above and no further. Do not move `completeDrain` out of the
sweeper.

### Rules that are load-bearing

Breaking any of these silently defeats the point of the project:

- **Conditional writes, never read-then-write.** Every transition is an `UPDATE …
  WHERE status = ?` inside `tx()` (IMMEDIATE transaction, `packages/core/src/db.ts`)
  with the affected row count checked. Two people clicking in the same second must
  not both win.
- **Absolute timestamps only** (epoch ms). No countdowns anywhere — a restart, a
  paused VM or a late tick then costs nothing.
- **The sweeper tick is idempotent** and takes `ts` as a parameter. A double tick
  or a nine-hour gap must produce the same state as a punctual one.
- **Timers are contention-gated.** Idle and session-cap only run when the queue is
  non-empty. Idle is measured *retroactively*, so an already-absent holder is over
  the line the instant someone queues.
- **In-flight suspends the idle timer**; `last_activity_at` is stamped when the
  last token flushes, not at request start. Only the session cap can catch someone
  mid-stream.
- **Killing a request closes the upstream connection**, not just the client one.
  Dropping only the client leaves the resource working on a prompt nobody will
  read, on time that now belongs to the next holder. `InFlightRegistry.killAll`
  aborts the `fetch` signal; `services/proxy/test/proxy.test.ts` verifies against a
  fake backend that counts abandoned generations.
- **`beginInFlight`/`endInFlight` are pinned to the session that started the
  request** (`lock_state.session_id`). A request outliving its own session must not
  reset the *next* holder's idle clock.
- **423, never 429.** `openai-python` auto-retries 429s, turning "you're queued"
  into a hang-then-fail.
- **The proxy never enqueues anyone.** A non-holder gets 423 and that is the end
  of it; the queue is built only from deliberate button presses on the dashboard.
- **Request bodies are never logged _by the lock machinery_.** The proxy sees
  every prompt these people write. `events.detail` only ever holds structured
  metadata kuncen built itself, and that stays true. The one deliberate exception
  is request tracing (below), which is off by default, announced when on, and
  never writes through `events`.
- **`events.user_id` is the recipient, not the subject.** Delivery
  (`eventsForUserSince`) filters on it, so an event only ever reaches the person
  it is filed under. `queued` files under the requester; `access_requested` files
  under the *holder* with `actor_id` naming the requester, which is the only
  reason it can reach them. File one under the wrong person and it looks perfectly
  correct in the table while silently arriving nowhere.

### Request tracing

Optional body capture (`KUNCEN_TRACE=full`, default off). The rules it must keep:

- **Bodies are files, never rows.** `request_traces` holds only pointers.
  Multi-MB blobs in `kuncen.db` would push writes through the WAL the sweeper
  transacts on every second. `services/proxy/src/trace.ts` streams to disk.
- **Capture must never break a request.** Every call into tracing is wrapped and
  swallowed. A full disk costs a trace, not a generation.
- **A cap must not become a leak.** Past `maxBytes` the sink stops writing but
  the caller *keeps reading* — an undrained `tee()` branch buffers in memory
  without limit, which is the exact failure the cap exists to prevent.
- **The trace row is closed by the response tap, not the meter.** Closing it from
  `meteredStream` records a byte count for a file still being flushed.
- **Every read goes through `mayReadTrace`** (author, or admin). It is the only
  thing between a debugging aid and reading a colleague's prompts. The raw-body
  route is a second handler and a second chance to get this wrong.
- **Off means nothing on disk**, not merely no row pointing at it —
  `services/proxy/test/trace.test.ts` asserts the directory stays empty.
- **Raw bodies are served `text/plain`**, never `text/html`.
- Pruning lives on its own interval in the proxy, *not* in the sweeper: unlinking
  files is slow and the lock must never wait on it. Files go before rows.

`packages/core/src/transcript.ts` reassembles bodies for display and must never
throw — a recorded body is routinely truncated at the cap or cut mid-frame by a
drain, so "malformed" is the normal case.

### Two kinds of configuration

- **`config` table** — the five timers (`idle_timeout_seconds`,
  `max_session_seconds`, `drain_ceiling_seconds`, `queue_entry_ttl_seconds`,
  `expiry_warning_seconds`). Read every tick, editable at runtime from the admin
  page or `npm run admin -- config set`. Values are clamped by `CONFIG_BOUNDS`.
- **Environment** — deployment facts: ports, `KUNCEN_UPSTREAM`, `KUNCEN_DB`,
  `KUNCEN_RESOURCE_NAME`/`_ARTICLE`, `KUNCEN_HEALTH_PATH`, `KUNCEN_TRACE*`. Read
  once at startup; changing one needs a restart. Tracing is here rather than in
  the `config` table on purpose — a runtime checkbox that starts recording
  everyone's prompts is not something worth having.

The same `config` table doubles as a cross-process key/value store (`getMeta`/
`setMeta`) for the proxy heartbeat and upstream health.

### Things worth knowing before editing

- **Migrations** (`packages/core/src/migrate.ts`) are hand-written SQL in an
  append-only array, versioned by `PRAGMA user_version`. Add an entry; never edit
  an existing one. Both services run them at startup.
- **A new event type needs no migration.** Unlike `users.role`, `lock_state.status`
  and the `*_reason` columns, `events.type` is a bare `TEXT NOT NULL` with no
  `CHECK` — the enum lives only in `schema.ts`. Adding one means: the enum, and
  `NOTICE_TYPES` in `services/web/src/app.ts` if a browser should be told about it.
  Do not append a migration for it.
- **The resource is a parameter**, not a literal. `resourceLabel()` returns
  `{ name, the, The }`; the browser gets it through `data-resource-*` attributes on
  `<body>` so `APP_JS` stays deployment-agnostic. Never hardcode "Spark".
- **Backend health has three states** — `up`, `down`, `unknown`. Unknown means the
  host answered but serves no endpoint we know how to probe; reporting that as
  "down" was a real bug. `/health` is a vLLM convention, so
  `services/proxy/src/health.ts` falls back to `/v1/models` and sticks with
  whichever answered.
- **The web UI has no bundler.** `STYLESHEET` and `APP_JS` are string constants in
  `services/web/src/assets.ts`, served from routes. Brand images live in
  `services/web/public` and are served by `static.ts` — images only, filename
  whitelisted. Register any new `/static/*` route *after* `style.css` and `app.js`,
  which are matched in order.
- **Old `kunci_` API keys still authenticate** (`LEGACY_KEY_PREFIXES` in
  `auth.ts`) — the project was renamed from kunci and a permanent credential
  should survive that. One line to delete when nobody carries one.
- **Passwords use scrypt** from `node:crypto`, not argon2: one fewer native module
  to build for arm64.

## Testing

`node:test` with `tsx`. No mocking framework, no fixtures directory.

- Databases are `openDb(':memory:')`; migrations run automatically.
- Time is controlled by `fakeClock()` (`packages/core/test/helpers.ts`), which
  swaps the clock behind `now()`. Restore it in `after()`.
- **Never `sleep` to reach a deadline.** `tick(db, ts)` accepts the time, so
  "the drain ceiling expired" is `tick(db, Date.now() + 10_000)`.
- Proxy tests run the real app over a real socket against `tools/fake-vllm.ts`,
  which counts generations abandoned mid-stream. It detects that on the *response*
  `close` event — `req`'s fires as soon as the request body is read, which is too
  early and was a live bug in the test double.
- Web tests drive `app.request()` directly, signing in the way a browser does to
  collect the cookie and CSRF token.

**Typecheck and tests are not sufficient before saying something works.** Both
were green while `kuncen-proxy` crashed on boot with a temporal-dead-zone
`ReferenceError`, because unit tests never exercise module initialisation order.
Start the services and hit them before reporting a change as working.

## Environment notes

- Development here is on Windows; deployment is arm64 Linux (systemd units in
  `deploy/`). Windows will refuse to rename or delete a SQLite file while a
  service holds it open — stop the services first.
- `data/` and `.env` are gitignored. `.env.example` documents every variable.
- The enforcement model assumes the upstream is unreachable from the LAN (vLLM on
  `127.0.0.1`). Pointing `KUNCEN_UPSTREAM` at a remote HTTPS endpoint is fine for
  development but makes the lock advisory, since anyone with the upstream key can
  bypass the proxy.
