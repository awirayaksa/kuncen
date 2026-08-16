import { desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { Db } from './db';
import { getConfig, getMeta, type Config } from './config';
import { lastEventId, recentEvents, type EventView } from './events';
import { expiryEstimate, queueList, readLock, type QueueRow } from './lock';
import { sessions, users } from './schema';
import { now } from './time';

export interface BackendHealth {
  /**
   * true = a probe answered; false = it failed; null = unknown, meaning either
   * the proxy has not reported yet or it found no endpoint it knows how to
   * probe. Unknown is not "down" — see `upstreamDetail` for which it is.
   */
  upstreamOk: boolean | null;
  /** Why the probe says what it says. Shown on the dashboard badge. */
  upstreamDetail: string | null;
  upstreamCheckedAt: number | null;
  /** The sweeper heartbeats every tick. Stale means nothing is expiring. */
  proxyAlive: boolean;
  proxyHeartbeatAt: number | null;
}

export interface StateSnapshot {
  ts: number;
  status: 'FREE' | 'HELD' | 'DRAINING';
  holder: { id: number; name: string } | null;
  acquiredAt: number | null;
  lastActivityAt: number | null;
  inFlight: number;
  drainReason: string | null;
  drainEndsAt: number | null;
  expiresAt: number | null;
  expiryReason: 'idle' | 'cap' | null;
  queue: Array<{ userId: number; userName: string; position: number; enqueuedAt: number }>;
  queueLength: number;
  config: Config;
  health: BackendHealth;
  /** Force-releases, shown on the dashboard so an override is never invisible. */
  overrides: EventView[];
  lastEventId: number;
}

export const PROXY_HEARTBEAT_STALE_MS = 10_000;

export function backendHealth(db: Db, ts: number = now()): BackendHealth {
  const heartbeat = numMeta(db, 'proxy_heartbeat_at');
  const checkedAt = numMeta(db, 'upstream_checked_at');
  const okRaw = getMeta(db, 'upstream_ok');
  return {
    upstreamOk: okRaw === '1' ? true : okRaw === '0' ? false : null,
    upstreamDetail: getMeta(db, 'upstream_detail') ?? null,
    upstreamCheckedAt: checkedAt,
    proxyAlive: heartbeat !== null && ts - heartbeat < PROXY_HEARTBEAT_STALE_MS,
    proxyHeartbeatAt: heartbeat,
  };
}

function numMeta(db: Db, key: string): number | null {
  const raw = getMeta(db, key);
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Everything the dashboard needs in one read. Backend health is reported
 * separately from lock state on purpose: "the resource is broken" and "it is
 * taken" must never look alike.
 */
export function stateSnapshot(db: Db, ts: number = now()): StateSnapshot {
  const cfg = getConfig(db);
  const ls = readLock(db);
  const queue: QueueRow[] = queueList(db);
  const holder =
    ls.holderId === null
      ? null
      : (db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, ls.holderId)).get() ?? null);
  const est = expiryEstimate(ls, cfg, queue.length, ts);
  const overrides = recentEvents(db, 5, ['force_release']);

  return {
    ts,
    status: ls.status,
    holder,
    acquiredAt: ls.acquiredAt,
    lastActivityAt: ls.lastActivityAt,
    inFlight: ls.inFlight,
    drainReason: ls.drainReason,
    drainEndsAt:
      ls.status === 'DRAINING' && ls.drainStartedAt !== null
        ? ls.drainStartedAt + cfg.drain_ceiling_seconds * 1000
        : null,
    expiresAt: est?.at ?? null,
    expiryReason: est?.reason ?? null,
    queue: queue.map((q) => ({
      userId: q.userId,
      userName: q.userName,
      position: q.position,
      enqueuedAt: q.enqueuedAt,
    })),
    queueLength: queue.length,
    config: cfg,
    health: backendHealth(db, ts),
    overrides,
    lastEventId: lastEventId(db),
  };
}

// ---------------------------------------------------------------- telemetry

export interface SessionSummary {
  id: number;
  userId: number;
  userName: string;
  acquiredAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  busyMs: number;
  heldMs: number;
  /** Share of the hold with at least one request upstream. This is the number
   *  that decides whether the bet was worth taking. */
  utilization: number | null;
}

export function recentSessions(db: Db, limit = 25, ts: number = now()): SessionSummary[] {
  const rows = db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      userName: users.name,
      acquiredAt: sessions.acquiredAt,
      releasedAt: sessions.releasedAt,
      releaseReason: sessions.releaseReason,
      requestCount: sessions.requestCount,
      promptTokens: sessions.promptTokens,
      completionTokens: sessions.completionTokens,
      busyMs: sessions.busyMs,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .orderBy(desc(sessions.id))
    .limit(limit)
    .all();

  return rows.map((r) => {
    const heldMs = Math.max(0, (r.releasedAt ?? ts) - r.acquiredAt);
    return {
      ...r,
      heldMs,
      utilization: heldMs > 0 ? Math.min(1, r.busyMs / heldMs) : null,
    };
  });
}

export interface BetSummary {
  windowDays: number;
  sessionCount: number;
  totalHeldMs: number;
  totalBusyMs: number;
  utilization: number | null;
  rejections: number;
  queueEvents: number;
  medianWaitMs: number | null;
  releaseReasons: Record<string, number>;
}

/**
 * The numbers from **The bet**, in one query set: do people actually queue, how
 * long do they wait, and does the box sit idle while locked?
 */
export function betSummary(db: Db, windowDays = 14, ts: number = now()): BetSummary {
  const since = ts - windowDays * 24 * 60 * 60 * 1000;

  const totals = db
    .select({
      count: sql<number>`count(*)`,
      held: sql<number>`COALESCE(SUM(COALESCE(released_at, ${ts}) - acquired_at), 0)`,
      busy: sql<number>`COALESCE(SUM(busy_ms), 0)`,
    })
    .from(sessions)
    .where(gte(sessions.acquiredAt, since))
    .get();

  const reasons = db
    .select({ reason: sessions.releaseReason, n: sql<number>`count(*)` })
    .from(sessions)
    .where(isNotNull(sessions.releaseReason))
    .groupBy(sessions.releaseReason)
    .all();

  const counts = db.all<{ type: string; n: number }>(sql`
    SELECT type, COUNT(*) AS n FROM events WHERE ts >= ${since} GROUP BY type
  `);
  const byType = new Map(counts.map((c) => [c.type, Number(c.n)]));

  const waits = db.all<{ w: number }>(sql`
    SELECT CAST(json_extract(detail, '$.waited_ms') AS INTEGER) AS w
    FROM events
    WHERE type = 'granted' AND ts >= ${since} AND json_extract(detail, '$.waited_ms') IS NOT NULL
    ORDER BY w
  `);

  const held = Number(totals?.held ?? 0);
  const busy = Number(totals?.busy ?? 0);

  return {
    windowDays,
    sessionCount: Number(totals?.count ?? 0),
    totalHeldMs: held,
    totalBusyMs: busy,
    utilization: held > 0 ? Math.min(1, busy / held) : null,
    rejections: byType.get('rejected') ?? 0,
    queueEvents: byType.get('queued') ?? 0,
    medianWaitMs: waits.length ? Number(waits[Math.floor(waits.length / 2)]!.w) : null,
    releaseReasons: Object.fromEntries(reasons.map((r) => [r.reason ?? 'unknown', Number(r.n)])),
  };
}
