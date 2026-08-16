import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from './db';
import { tx } from './db';
import { getConfig, type Config } from './config';
import { logEvent } from './events';
import {
  lockState,
  queueEntries,
  sessions,
  users,
  type LockState,
  type ReleaseReason,
} from './schema';
import { now } from './time';

export const LOCK_ID = 1;

export function readLock(db: Db): LockState {
  const row = db.select().from(lockState).where(eq(lockState.id, LOCK_ID)).get();
  if (!row) throw new Error('lock_state row missing — database not migrated');
  return row;
}

export interface QueueRow {
  id: number;
  userId: number;
  userName: string;
  enqueuedAt: number;
  expiresAt: number;
  position: number;
}

/** FIFO by enqueue time; id breaks ties inside the same millisecond. */
export function queueList(db: Db): QueueRow[] {
  const rows = db
    .select({
      id: queueEntries.id,
      userId: queueEntries.userId,
      userName: users.name,
      enqueuedAt: queueEntries.enqueuedAt,
      expiresAt: queueEntries.expiresAt,
    })
    .from(queueEntries)
    .innerJoin(users, eq(users.id, queueEntries.userId))
    .orderBy(asc(queueEntries.enqueuedAt), asc(queueEntries.id))
    .all();
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}

export function queueLength(db: Db): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(queueEntries).get();
  return row?.n ?? 0;
}

export function queuePosition(db: Db, userId: number): number | null {
  const idx = queueList(db).findIndex((q) => q.userId === userId);
  return idx === -1 ? null : idx + 1;
}

export interface ExpiryEstimate {
  at: number;
  reason: 'idle' | 'cap';
}

/**
 * When the current hold will end, or null if it will not.
 *
 * Both timers are contention-gated: with an empty queue nothing expires, so
 * there is genuinely no answer to give. An in-flight request suspends the idle
 * timer entirely — only the session cap can catch someone mid-stream.
 */
export function expiryEstimate(
  ls: LockState,
  cfg: Config,
  queueLen: number,
  ts: number = now(),
): ExpiryEstimate | null {
  if (ls.status !== 'HELD' || queueLen === 0) return null;
  const capAt = (ls.acquiredAt ?? ts) + cfg.max_session_seconds * 1000;
  const idleAt = ls.inFlight > 0 ? null : (ls.lastActivityAt ?? ts) + cfg.idle_timeout_seconds * 1000;
  if (idleAt !== null && idleAt <= capAt) return { at: idleAt, reason: 'idle' };
  return { at: capAt, reason: 'cap' };
}

// ---------------------------------------------------------------- transitions

/**
 * FREE -> HELD. Conditional write, never read-then-write: two people clicking in
 * the same second must not both win.
 *
 * Safe to call from either process — promotion needs no access to in-flight
 * connections. Draining to FREE is the one transition that does, and that one
 * lives in the proxy's sweeper.
 */
export function promoteIfFree(t: Db, ts: number = now()): number | null {
  const head = t
    .select()
    .from(queueEntries)
    .orderBy(asc(queueEntries.enqueuedAt), asc(queueEntries.id))
    .limit(1)
    .get();
  if (!head) return null;

  const upd = t
    .update(lockState)
    .set({
      status: 'HELD',
      holderId: head.userId,
      sessionId: null,
      acquiredAt: ts,
      lastActivityAt: ts,
      inFlight: 0,
      drainStartedAt: null,
      drainReason: null,
    })
    .where(and(eq(lockState.id, LOCK_ID), eq(lockState.status, 'FREE')))
    .run();
  if (upd.changes !== 1) return null;

  t.delete(queueEntries).where(eq(queueEntries.id, head.id)).run();
  const session = t
    .insert(sessions)
    .values({ userId: head.userId, acquiredAt: ts })
    .returning({ id: sessions.id })
    .get();
  t.update(lockState).set({ sessionId: session.id }).where(eq(lockState.id, LOCK_ID)).run();

  logEvent(t, {
    type: 'granted',
    userId: head.userId,
    detail: { waited_ms: Math.max(0, ts - head.enqueuedAt), session_id: session.id },
  });
  return head.userId;
}

/** HELD -> DRAINING. `holderId` pins it to a specific holder when relevant. */
export function beginDrain(
  t: Db,
  reason: ReleaseReason,
  ts: number,
  opts: { holderId?: number; actorId?: number; detail?: Record<string, unknown> } = {},
): boolean {
  const conds = [eq(lockState.id, LOCK_ID), eq(lockState.status, 'HELD')];
  if (opts.holderId !== undefined) conds.push(eq(lockState.holderId, opts.holderId));

  const before = readLock(t);
  const upd = t
    .update(lockState)
    .set({ status: 'DRAINING', drainStartedAt: ts, drainReason: reason })
    .where(and(...conds))
    .run();
  if (upd.changes !== 1) return false;

  logEvent(t, {
    type: reason === 'forced' ? 'force_release' : 'released',
    userId: before.holderId,
    actorId: opts.actorId ?? null,
    detail: {
      reason,
      held_ms: before.acquiredAt ? Math.max(0, ts - before.acquiredAt) : 0,
      ...opts.detail,
    },
  });
  return true;
}

/**
 * DRAINING -> FREE. Proxy-only: by the time this runs, any surviving in-flight
 * request has to be killed upstream, and only the proxy holds those sockets.
 */
export function completeDrain(t: Db, ts: number): { holderId: number | null; sessionId: number | null } {
  const ls = readLock(t);
  if (ls.status !== 'DRAINING') return { holderId: null, sessionId: null };

  if (ls.sessionId !== null) {
    t.update(sessions)
      .set({ releasedAt: ts, releaseReason: ls.drainReason ?? 'manual' })
      .where(and(eq(sessions.id, ls.sessionId), isNull(sessions.releasedAt)))
      .run();
  }

  t.update(lockState)
    .set({
      status: 'FREE',
      holderId: null,
      sessionId: null,
      acquiredAt: null,
      lastActivityAt: null,
      inFlight: 0,
      drainStartedAt: null,
      drainReason: null,
    })
    .where(and(eq(lockState.id, LOCK_ID), eq(lockState.status, 'DRAINING')))
    .run();

  return { holderId: ls.holderId, sessionId: ls.sessionId };
}

// ---------------------------------------------------------------- user actions

export type RequestOutcome = 'acquired' | 'queued' | 'already_queued' | 'already_holding';

export interface RequestResult {
  outcome: RequestOutcome;
  position: number | null;
  queueLength: number;
}

/**
 * The only way into the queue. The proxy never enqueues anyone — a 423 is the
 * end of the story there — so the waiting list is built purely out of deliberate
 * button presses.
 */
export function requestAccess(db: Db, userId: number, cfg?: Config): RequestResult {
  return tx(db, (t) => {
    const conf = cfg ?? getConfig(t);
    const ts = now();
    const ls = readLock(t);

    // Only an active hold blocks queueing. A holder who is draining out (cap,
    // manual release) is allowed to line up again — at the back, which is the
    // whole point of the cap.
    if (ls.status === 'HELD' && ls.holderId === userId) {
      return { outcome: 'already_holding' as const, position: null, queueLength: queueLength(t) };
    }

    const existing = t.select().from(queueEntries).where(eq(queueEntries.userId, userId)).get();
    if (existing) {
      // Idempotent: an impatient double-click must not send you to the back.
      return {
        outcome: 'already_queued' as const,
        position: queuePosition(t, userId),
        queueLength: queueLength(t),
      };
    }

    t.insert(queueEntries)
      .values({
        userId,
        enqueuedAt: ts,
        expiresAt: ts + conf.queue_entry_ttl_seconds * 1000,
      })
      .run();
    logEvent(t, { type: 'queued', userId });

    // Tell the holder somebody wants it. Addressed to *them*, not to the
    // requester: delivery filters on events.user_id, so a notice filed under the
    // requester — which is what `queued` above is — can never reach the one
    // person who can act on it.
    //
    // Only a live hold gets one. A holder already draining out is losing the
    // lock anyway, and "someone is waiting" at that moment is noise about a
    // decision they no longer have.
    if (ls.status === 'HELD' && ls.holderId !== null && ls.holderId !== userId) {
      logEvent(t, {
        type: 'access_requested',
        userId: ls.holderId,
        actorId: userId,
        // Counted after the insert, so it includes the person who just queued.
        // Two requests in a row collapse into one OS notification; the count is
        // what keeps that one honest.
        detail: { queue_length: queueLength(t) },
      });
    }

    const granted = promoteIfFree(t, ts);
    if (granted === userId) {
      return { outcome: 'acquired' as const, position: null, queueLength: queueLength(t) };
    }
    return {
      outcome: 'queued' as const,
      position: queuePosition(t, userId),
      queueLength: queueLength(t),
    };
  });
}

export function cancelRequest(db: Db, userId: number): boolean {
  return tx(db, (t) => {
    const res = t.delete(queueEntries).where(eq(queueEntries.userId, userId)).run();
    if (res.changes === 0) return false;
    logEvent(t, { type: 'cancelled', userId });
    return true;
  });
}

/** Holder gives up the lock early. Goes through the normal DRAINING state. */
export function releaseLock(db: Db, userId: number): boolean {
  return tx(db, (t) => beginDrain(t, 'manual', now(), { holderId: userId }));
}

/**
 * Admin override. Enters the same 120s drain as everything else — there is no
 * fast path, and no way to hand the lock to a named person.
 *
 * The reason string is required and shown on the dashboard. Not for audit: for
 * social friction. If overriding a colleague leaves a visible line saying you
 * did it, it stays rare.
 */
export function forceRelease(db: Db, actorId: number, reason: string): boolean {
  const text = reason.trim();
  if (!text) throw new Error('reason: required');
  return tx(db, (t) => beginDrain(t, 'forced', now(), { actorId, detail: { note: text.slice(0, 500) } }));
}

// ---------------------------------------------------------------- in-flight accounting

export interface InFlightHandle {
  sessionId: number | null;
  startedAt: number;
}

/**
 * Claim a slot for one upstream request. Conditional on still holding the lock,
 * so a request that raced a release cannot slip through.
 */
export function beginInFlight(db: Db, userId: number): InFlightHandle | null {
  return tx(db, (t) => {
    const ls = readLock(t);
    const upd = t
      .update(lockState)
      .set({ inFlight: sql`${lockState.inFlight} + 1` })
      .where(
        and(eq(lockState.id, LOCK_ID), eq(lockState.status, 'HELD'), eq(lockState.holderId, userId)),
      )
      .run();
    if (upd.changes !== 1) return null;

    if (ls.sessionId !== null) {
      t.update(sessions)
        .set({ requestCount: sql`${sessions.requestCount} + 1` })
        .where(eq(sessions.id, ls.sessionId))
        .run();
    }
    return { sessionId: ls.sessionId, startedAt: now() };
  });
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Release the slot. `last_activity_at` is set here, when the last token has
 * flushed — not at request start. A six-minute agentic generation must not drop
 * the lock out from under itself.
 *
 * Both writes are pinned to the session that started the request, so a request
 * that outlived its own session cannot reset the *next* holder's idle clock.
 */
export function endInFlight(db: Db, handle: InFlightHandle, usage: Usage = {}): void {
  const ts = now();
  const busyMs = Math.max(0, ts - handle.startedAt);
  tx(db, (t) => {
    const conds = [eq(lockState.id, LOCK_ID)];
    if (handle.sessionId !== null) conds.push(eq(lockState.sessionId, handle.sessionId));
    t.update(lockState)
      .set({ inFlight: sql`MAX(0, ${lockState.inFlight} - 1)`, lastActivityAt: ts })
      .where(and(...conds))
      .run();

    if (handle.sessionId !== null) {
      t.update(sessions)
        .set({
          busyMs: sql`${sessions.busyMs} + ${busyMs}`,
          promptTokens: sql`${sessions.promptTokens} + ${Math.max(0, usage.promptTokens ?? 0)}`,
          completionTokens: sql`${sessions.completionTokens} + ${Math.max(0, usage.completionTokens ?? 0)}`,
        })
        .where(eq(sessions.id, handle.sessionId))
        .run();
    }
  });
}

/**
 * No in-flight request can survive a proxy restart — the sockets died with the
 * process. Called once at proxy startup so a crash mid-generation cannot leave a
 * phantom counter pinning the idle timer open forever.
 */
export function resetInFlight(db: Db): void {
  tx(db, (t) => {
    t.update(lockState).set({ inFlight: 0 }).where(eq(lockState.id, LOCK_ID)).run();
  });
}

// ---------------------------------------------------------------- maintenance

/** Queue entries older than the TTL. Someone who queued at 9am and went home
 * must not still be #1 at 4pm, quietly poisoning everyone's wait estimates. */
export function expireQueueEntries(t: Db, ts: number): number[] {
  const stale = t.select().from(queueEntries).where(lte(queueEntries.expiresAt, ts)).all();
  if (stale.length === 0) return [];
  for (const entry of stale) {
    t.delete(queueEntries).where(eq(queueEntries.id, entry.id)).run();
    logEvent(t, {
      type: 'expired',
      userId: entry.userId,
      detail: { waited_ms: Math.max(0, ts - entry.enqueuedAt) },
    });
  }
  return stale.map((s) => s.userId);
}
