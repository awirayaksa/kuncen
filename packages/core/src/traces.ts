import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from './db';
import { requestTraces, users, type RequestTrace, type TraceOutcome } from './schema';
import { now } from './time';

/**
 * Request tracing. Off unless the deployment switches it on — the proxy sees
 * every prompt these people write, and recording that is a decision an operator
 * makes deliberately, not a default.
 *
 * This module owns the index rows only. The bodies are files on disk, written by
 * `services/proxy/src/trace.ts`; everything here just carries the pointers.
 */

export interface TraceStartInput {
  userId: number;
  sessionId: number | null;
  method: string;
  path: string;
  startedAt?: number;
}

export function startTrace(db: Db, input: TraceStartInput): number {
  const row = db
    .insert(requestTraces)
    .values({
      userId: input.userId,
      sessionId: input.sessionId,
      startedAt: input.startedAt ?? now(),
      method: input.method,
      path: input.path,
    })
    .returning({ id: requestTraces.id })
    .get();
  return row.id;
}

export interface TraceFinishInput {
  model?: string | null;
  streamed?: boolean;
  status?: number | null;
  outcome?: TraceOutcome;
  promptTokens?: number;
  completionTokens?: number;
  requestBytes?: number;
  responseBytes?: number;
  requestFile?: string | null;
  responseFile?: string | null;
  truncated?: boolean;
  endedAt?: number;
}

/**
 * Tracing must never be able to break a request. Every write here is wrapped by
 * the caller in a swallow-and-log, and this function is safe to call once with
 * whatever fields are known.
 */
export function finishTrace(db: Db, id: number, input: TraceFinishInput): void {
  db.update(requestTraces)
    .set({
      endedAt: input.endedAt ?? now(),
      model: input.model ?? null,
      streamed: input.streamed ?? false,
      status: input.status ?? null,
      outcome: input.outcome ?? null,
      promptTokens: Math.max(0, input.promptTokens ?? 0),
      completionTokens: Math.max(0, input.completionTokens ?? 0),
      requestBytes: Math.max(0, input.requestBytes ?? 0),
      responseBytes: Math.max(0, input.responseBytes ?? 0),
      requestFile: input.requestFile ?? null,
      responseFile: input.responseFile ?? null,
      truncated: input.truncated ?? false,
    })
    .where(eq(requestTraces.id, id))
    .run();
}

export interface TraceView extends RequestTrace {
  userName: string;
  durationMs: number | null;
}

const withUser = {
  id: requestTraces.id,
  userId: requestTraces.userId,
  sessionId: requestTraces.sessionId,
  startedAt: requestTraces.startedAt,
  endedAt: requestTraces.endedAt,
  method: requestTraces.method,
  path: requestTraces.path,
  model: requestTraces.model,
  streamed: requestTraces.streamed,
  status: requestTraces.status,
  outcome: requestTraces.outcome,
  promptTokens: requestTraces.promptTokens,
  completionTokens: requestTraces.completionTokens,
  requestBytes: requestTraces.requestBytes,
  responseBytes: requestTraces.responseBytes,
  requestFile: requestTraces.requestFile,
  responseFile: requestTraces.responseFile,
  truncated: requestTraces.truncated,
  userName: users.name,
};

const decorate = (r: RequestTrace & { userName: string }): TraceView => ({
  ...r,
  durationMs: r.endedAt === null ? null : Math.max(0, r.endedAt - r.startedAt),
});

/** `userId` null lists everyone — only ever reached from an admin route. */
export function listTraces(
  db: Db,
  opts: { userId?: number | null; limit?: number; before?: number } = {},
): TraceView[] {
  const conds = [];
  if (opts.userId != null) conds.push(eq(requestTraces.userId, opts.userId));
  if (opts.before != null) conds.push(lt(requestTraces.id, opts.before));

  const q = db.select(withUser).from(requestTraces).innerJoin(users, eq(users.id, requestTraces.userId)).$dynamic();
  if (conds.length) q.where(and(...conds));
  return q
    .orderBy(desc(requestTraces.id))
    .limit(opts.limit ?? 50)
    .all()
    .map((r) => decorate(r as RequestTrace & { userName: string }));
}

export function traceById(db: Db, id: number): TraceView | undefined {
  const row = db
    .select(withUser)
    .from(requestTraces)
    .innerJoin(users, eq(users.id, requestTraces.userId))
    .where(eq(requestTraces.id, id))
    .get();
  return row ? decorate(row as RequestTrace & { userName: string }) : undefined;
}

/**
 * Whether `viewer` may read `trace`. Authors always may; admins may read
 * anyone's. Every route that serves a body must go through this — it is the only
 * thing standing between a debugging aid and a way to read a colleague's prompts.
 */
export function mayReadTrace(
  trace: Pick<TraceView, 'userId'>,
  viewer: { id: number; role: string },
): boolean {
  return trace.userId === viewer.id || viewer.role === 'admin';
}

export function traceCount(db: Db, userId?: number | null): number {
  const q = db.select({ n: sql<number>`count(*)` }).from(requestTraces).$dynamic();
  if (userId != null) q.where(eq(requestTraces.userId, userId));
  return q.get()?.n ?? 0;
}

/**
 * Rows older than the cutoff, returned so the caller can unlink their files
 * before the rows go. Deleting the row first would orphan the bytes on disk,
 * which is the failure mode that turns a retention policy into a disk-full page.
 */
export function expiredTraces(db: Db, cutoff: number, limit = 500): RequestTrace[] {
  return db
    .select()
    .from(requestTraces)
    .where(lt(requestTraces.startedAt, cutoff))
    .orderBy(requestTraces.id)
    .limit(limit)
    .all();
}

export function deleteTraces(db: Db, ids: number[]): void {
  for (const id of ids) db.delete(requestTraces).where(eq(requestTraces.id, id)).run();
}
