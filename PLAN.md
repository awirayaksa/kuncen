# Kuncen — exclusive-access manager for the DGX Spark

## Problem

One DGX Spark serves vLLM (Qwen) to ~4 people. Throughput is acceptable for one
user at a time and degrades badly under concurrency. Kuncen serializes access: one
person holds an exclusive lock on the box, everyone else waits in an ordered
queue.

## The bet

Strict exclusive access, not a concurrency limit. A semaphore of N has no
defensible value for N — 2 concurrent *heavy* requests is exactly the pathology
we're eliminating, and a semaphore can't tell a one-line question from a 30k-token
agentic run. We accept that the GPU will sometimes sit near-idle under lock.

This bet is measurable and we log the data to check it (see **Telemetry**). If the
logs show frequent queueing with low utilization, revisit.

---

## Architecture

Two processes, both on the Spark itself, sharing one SQLite database (WAL mode).

```
  clients (Cline, scripts, curl)          browsers
            │                                 │
            │ Bearer kuncen_...                │ session cookie
            ▼                                 ▼
   ┌──────────────────┐              ┌──────────────────┐
   │   kuncen-proxy    │              │    kuncen-web     │
   │   :8080  /v1/*   │              │      :3000       │
   │                  │              │                  │
   │  · enforces lock │              │  · dashboard     │
   │  · sweeper (1s)  │              │  · request/cancel│
   │  · sole writer   │              │  · release       │
   │    of lock state │              │  · admin         │
   └────────┬─────────┘              └────────┬─────────┘
            │                                 │
            │                    ┌────────────┘
            ▼                    ▼
   127.0.0.1:8000        kuncen.db (SQLite, WAL)
       vLLM
```

**Why two processes.** The proxy holds streaming connections open for minutes; the
dashboard will churn for months. Under a single process, every CSS tweak restarts
the thing currently streaming someone's generation. The proxy is small and goes
stable within a week — the churny part must not be able to hurt it.

**Why the sweeper lives in the proxy.** If the sweeper is dead, the proxy is dead,
so nothing can reach the GPU anyway. There is no state where locks have stopped
expiring but people are still burning GPU time. The failure is total and obvious
rather than partial and unfair.

**Why on the Spark.** vLLM binds `127.0.0.1:8000` and becomes physically
unreachable from the LAN. Enforcement is a property of the network, not something
our code has to get right.

---

## Enforcement integrity

Non-negotiable, or the lock is decorative:

- vLLM binds `127.0.0.1:8000`. Never `0.0.0.0`.
- Only `kuncen-proxy:8080` and `kuncen-web:3000` are exposed on the LAN.
- SSH to the box remains the true break-glass — an admin can always hit
  `127.0.0.1:8000` directly. This is deliberate: nobody is ever locked out of
  their own hardware by this app, which is what lets the in-app override stay
  minimal.

---

## Acquisition model

**Explicit and web-only.** Register → log in → click **Request access**.

The proxy is purely an *enforcer*. A request from a non-holder gets `423` and that
is the end of it — it does not enqueue anyone and does not acquire anything. The
waiting list is built only from deliberate button presses.

| Situation on clicking "Request access" | Result |
|---|---|
| Lock FREE, queue empty | Acquire immediately |
| Lock HELD | Appended to queue at position N |
| Already in queue | No-op, keep existing position |
| Already holding | No-op |

When the lock is released, the sweeper **grants it to the queue head
automatically** — no accept step, no claim window. If they're away, the ordinary
5-minute idle timeout releases it to the next person. One timer, one rule.

---

## Lock state machine

```
                  request (queue empty)
        ┌────────────────────────────────────┐
        │                                    ▼
   ┌────────┐                          ┌──────────┐
   │  FREE  │ ◄───── drain complete ── │ DRAINING │
   └────────┘                          └──────────┘
        │                                    ▲
        │  sweeper promotes queue head       │ idle timeout (contended)
        │                                    │ session cap (contended)
        │                                    │ manual release
        ▼                                    │ admin force-release
   ┌────────┐                                │
   │  HELD  │ ───────────────────────────────┘
   └────────┘
```

`FREE` with a non-empty queue is momentary only — the sweeper promotes on the same
tick.

**DRAINING**: new requests get `423`; in-flight requests are allowed to finish;
lock goes `FREE` when the last one completes **or** after `drain_ceiling_seconds`
(120s), whichever comes first. Pure draining without a ceiling would let a
`max_tokens: 100000` generation extend a session arbitrarily past the cap, which
defeats the cap.

---

## Timers

Both timers are **contention-gated: they only run when the waiting list is
non-empty.** These timers exist to stop one person starving the others. With
nobody waiting, expiring the lock accomplishes nothing except forcing the holder
back to the web page to resume exactly what they were doing.

| Timer | Default | Fires when |
|---|---|---|
| Idle | 300s | `queue_len > 0` and `now - last_activity_at >= idle_timeout` |
| Session cap | 3600s | `queue_len > 0` and `now - acquired_at >= max_session` |
| Drain ceiling | 120s | Always, once DRAINING |

**Idle time is measured retroactively.** If the holder has already been idle 20
minutes when someone queues, they are over the line the instant that person
arrives and the lock releases nearly immediately. Otherwise an absent holder would
get a fresh free 5 minutes for showing up to nothing.

This composes with automatic promotion in a way worth noting: if B is granted the
lock and the queue empties, no timers run, so an absent B holds it indefinitely.
The moment C requests, the queue is non-empty, timers activate, retroactive
measurement applies, and the lock releases almost at once. **The stall self-heals
exactly when someone needs it to.**

### What counts as activity

Only inference requests through the proxy reset `last_activity_at`:

- **Counts:** `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`
- **Does not count:** `/v1/models`, `/health`, dashboard polls, an open browser tab

Having the page open is explicitly **not** usage. Under contention, an idle tab
holding a GPU hostage is precisely the failure this project exists to prevent.
There is no "extend me" button either — with one, the queue would never advance
at the only time it matters.

**In-flight requests count as continuous activity.** The idle timer cannot fire
while a generation is streaming; `last_activity_at` is set when the last token
flushes, not at request start. A 6-minute agentic generation must not drop the
lock out from under itself. This also means only the session cap can ever catch a
user mid-stream.

### Killing a request

When the drain ceiling expires, **close the upstream connection to vLLM, not just
the downstream one to the client.** If the proxy drops the client socket but
leaves vLLM generating, the GPU burns tokens nobody will read — time that now
belongs to the *next* holder. They would get "exclusive" access to a box secretly
still working on the last person's prompt. Verify that client disconnect
propagates to an actual upstream abort.

---

## Authentication

Two credentials, two purposes.

**Browser → kuncen-web:** session cookie. Standard login.

**Client → kuncen-proxy:** permanent per-user API key, `Authorization: Bearer
kuncen_...`. Generated at registration, shown once, pasted into your tool's config
and never touched again. Revoke/regenerate available on the profile page; store
only the hash.

The key answers *who you are*. The lock answers *whether you're allowed right
now*. Keeping those separate is what lets tools be configured once instead of
re-pasting a token every session.

**Registration is admin-provisioned.** Four accounts, created by hand. `role` is a
flag on the user record (`user` | `admin`).

### Proxy authorization

| Endpoint | Requires auth | Requires lock |
|---|---|---|
| `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` | yes | yes |
| `/v1/models`, `/health` | yes | no |

Non-holder on a lock-required endpoint → **`423 Locked`**, with a body giving the
current holder, expiry estimate, and the caller's queue position if any, plus a
`Retry-After` header.

Deliberately **not 429**: `openai-python` auto-retries 429s, which would turn a
clean "you're queued" into a confusing hang-then-fail. 423 fails fast and legibly.

---

## Notifications

Dashboard polls `/api/state` every 2s (at n=4, polling is fine and far less code
than SSE) and fires Web Notifications from the client. Permission is requested
when a user first joins the queue.

Notify on:
1. **Your turn started** — the lock is now yours.
2. **Your lock expires in 60s** — only when contended, since otherwise it isn't
   expiring. This is what stops the handoff feeling arbitrary.
3. **You were force-released** by an admin — so you find out from the app rather
   than from your tool erroring mid-generation.

No Slack/Discord/email. No external services, no secrets, no delivery
infrastructure. Fallback if the user denies the permission is the live page.

---

## Admin

**Force-release only.** An admin can revoke the current lock, which enters the
normal 120s DRAINING state.

Deliberately weak. The rules already self-heal most of what an override would be
for: a dead laptop means no requests means idle-release as soon as anyone queues;
a runaway busy process hits the session cap. Override is for bugs and the
occasional urgent demo.

**No queue reordering and no assigning the lock to a named user.** "Admin gives
the lock to whoever asks loudest" turns a mechanical, legible system into a
political one. At four people the queue's fairness *is* the value proposition.

Every force-release is logged with actor, target, timestamp, and a **required
reason string**, displayed on the dashboard. Not for audit — for social friction.
If overriding a colleague leaves a visible line saying you did it, it stays rare.

---

## Rules

| Case | Behavior |
|---|---|
| Click "Request access" twice | Idempotent no-op; keep position. An impatient double-click must not send you to the back. |
| Holder clicks "Request access" | No-op. Cannot queue while holding. |
| Cancel | Explicit "Cancel request" leaves the queue; "Release" gives up the lock early (via DRAINING). |
| Queue entry TTL | Expires after `queue_entry_ttl` (default 3600s). Someone who queued at 9am and went home must not still be #1 at 4pm — the queue would be showing everyone false wait estimates. |
| Holder loses lock to session cap | Re-requesting puts them at the **back** of the queue. That is the entire point of the cap. Composes with contention gating: with an empty queue the cap never fires, so this only bites under contention. |
| vLLM down / 5xx | Error passes through; holder **keeps** the lock. Losing your slot because the backend hiccuped would be perverse. Dashboard shows backend health separately from lock state, so "the spark is broken" and "the spark is taken" never look alike. |
| Request bodies | **Never logged.** The proxy sees every prompt your colleagues write. Metadata only. At four people who all know each other, this is the difference between a tool people trust and one they resent. |

---

## Data model

SQLite + Drizzle. The entire state is one lock row, a short queue, four users, and
a log — this does not need Postgres.

```
users            id, email, name, password_hash, role,
                 api_key_hash, api_key_prefix, created_at

lock_state       id (always 1), status (FREE|HELD|DRAINING),
                 holder_id, acquired_at, last_activity_at,
                 in_flight, drain_started_at, drain_reason

queue_entries    id, user_id UNIQUE, enqueued_at, expires_at

sessions         id, user_id, acquired_at, released_at,
                 release_reason (idle|cap|manual|forced),
                 request_count, prompt_tokens, completion_tokens

events           id, ts, type (rejected|force_release|granted|expired),
                 user_id, actor_id, detail

config           key, value          -- runtime-editable via admin UI
```

**Acquisition must be a conditional write, not read-then-write.** Two people
clicking in the same second must not both win:
`UPDATE lock_state SET holder_id = ? WHERE status = 'FREE'` and check the affected
row count. Never `SELECT` then `UPDATE`. Same for promoting the queue head.

**Store absolute timestamps, never countdowns.** `expires_at`, `last_activity_at`,
`acquired_at`. A restart, a paused VM, or a slow tick then costs nothing.

### Config defaults

| Key | Default |
|---|---|
| `idle_timeout_seconds` | 300 |
| `max_session_seconds` | 3600 |
| `drain_ceiling_seconds` | 120 |
| `queue_entry_ttl_seconds` | 3600 |
| `expiry_warning_seconds` | 60 |

---

## Sweeper

Runs in kuncen-proxy every 1s. **Idempotent and transactional** — each tick reads
state, computes what should have happened, and applies it in one transaction with
conditional writes. A late tick or a double tick produces an identical outcome.

```
tick():
  begin transaction
    expire queue entries past expires_at
    n = queue length

    if status == HELD and n > 0:
      if in_flight == 0 and now - last_activity_at >= idle_timeout:
        -> DRAINING (reason: idle)      # completes immediately, in_flight == 0
      elif now - acquired_at >= max_session:
        -> DRAINING (reason: cap)

    if status == DRAINING:
      if in_flight == 0 or now - drain_started_at >= drain_ceiling:
        kill any remaining in-flight (upstream + downstream)
        close session row
        -> FREE

    if status == FREE and n > 0:
      pop head -> HELD
      acquired_at = last_activity_at = now
      open session row
      queue 'granted' notification

    queue expiry-warning notifications
  commit
```

---

## Telemetry

Enough to check the bet from **The bet**, and nothing more:

- Every session: who, acquired, released, release reason, request count, tokens.
- Every `423`: requester and how long they'd been waiting.
- GPU-idle-under-lock, derivable from session request timestamps.

After two weeks this answers: do people actually queue, how long do they wait, and
does the box sit idle while locked?

---

## Out of scope for v1

Multiple Sparks or multiple models (the lock is a singleton). Concurrency limits.
Holder-controlled sharing. External notification channels. Per-user quotas or
fair-share scheduling. SSO.

## Assumptions taken without explicit sign-off

- Registration is admin-provisioned rather than self-service.
- SQLite rather than Postgres.
- `admin` is a role flag on the user record rather than an SSH-only CLI.
