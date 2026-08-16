import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from './db';
import { events, type EventType } from './schema';
import { now } from './time';

export interface LogEventInput {
  type: EventType;
  userId?: number | null;
  actorId?: number | null;
  detail?: Record<string, unknown>;
}

/**
 * Metadata only. The proxy sees every prompt these four people write and none of
 * it is ever written here — `detail` is a small structured object built by
 * kuncen, never anything lifted out of a request body.
 */
export function logEvent(db: Db, input: LogEventInput): number {
  const row = db
    .insert(events)
    .values({
      ts: now(),
      type: input.type,
      userId: input.userId ?? null,
      actorId: input.actorId ?? null,
      detail: input.detail ? JSON.stringify(input.detail) : null,
    })
    .returning({ id: events.id })
    .get();
  return row.id;
}

export interface EventView {
  id: number;
  ts: number;
  type: EventType;
  userId: number | null;
  userName: string | null;
  actorId: number | null;
  actorName: string | null;
  detail: Record<string, unknown> | null;
}

interface EventRowRaw {
  id: number;
  ts: number;
  type: EventType;
  userId: number | null;
  actorId: number | null;
  detail: string | null;
  userName: string | null;
  actorName: string | null;
}

function toView(row: EventRowRaw): EventView {
  let detail: Record<string, unknown> | null = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      detail = null;
    }
  }
  const { detail: _raw, ...rest } = row;
  return { ...rest, detail };
}

const baseSelect = {
  id: events.id,
  ts: events.ts,
  type: events.type,
  userId: events.userId,
  actorId: events.actorId,
  detail: events.detail,
  userName: sql<string | null>`(SELECT name FROM users WHERE users.id = events.user_id)`.as('user_name'),
  actorName: sql<string | null>`(SELECT name FROM users WHERE users.id = events.actor_id)`.as('actor_name'),
};

export function recentEvents(db: Db, limit = 30, types?: EventType[]): EventView[] {
  const q = db.select(baseSelect).from(events).$dynamic();
  if (types?.length) q.where(inArray(events.type, types));
  return q
    .orderBy(desc(events.id))
    .limit(limit)
    .all()
    .map((r) => toView(r as EventRowRaw));
}

/** Events addressed to one user and newer than what their tab has already seen. */
export function eventsForUserSince(
  db: Db,
  userId: number,
  sinceId: number,
  types: EventType[],
): EventView[] {
  return db
    .select(baseSelect)
    .from(events)
    .where(and(eq(events.userId, userId), gt(events.id, sinceId), inArray(events.type, types)))
    .orderBy(events.id)
    .limit(20)
    .all()
    .map((r) => toView(r as EventRowRaw));
}

export function lastEventId(db: Db): number {
  const row = db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1).get();
  return row?.id ?? 0;
}
