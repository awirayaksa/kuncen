import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * Every timestamp in this schema is absolute epoch milliseconds. Never a
 * countdown, never a duration-remaining: a restart, a paused VM or a slow tick
 * then costs nothing.
 */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['user', 'admin'] })
    .notNull()
    .default('user'),
  apiKeyHash: text('api_key_hash'),
  apiKeyPrefix: text('api_key_prefix'),
  createdAt: integer('created_at').notNull(),
});

/**
 * Singleton row, id = 1. `sessionId` points at the open `sessions` row so that
 * telemetry written by a request that outlives its own session lands on the
 * right session instead of the next holder's.
 */
export const lockState = sqliteTable('lock_state', {
  id: integer('id').primaryKey(),
  status: text('status', { enum: ['FREE', 'HELD', 'DRAINING'] })
    .notNull()
    .default('FREE'),
  holderId: integer('holder_id'),
  sessionId: integer('session_id'),
  acquiredAt: integer('acquired_at'),
  lastActivityAt: integer('last_activity_at'),
  inFlight: integer('in_flight').notNull().default(0),
  drainStartedAt: integer('drain_started_at'),
  drainReason: text('drain_reason', { enum: ['idle', 'cap', 'manual', 'forced'] }),
});

export const queueEntries = sqliteTable(
  'queue_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().unique(),
    enqueuedAt: integer('enqueued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => ({
    byEnqueued: index('queue_entries_enqueued_at').on(t.enqueuedAt),
  }),
);

/** One row per lock session. This is the telemetry that checks the bet. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    acquiredAt: integer('acquired_at').notNull(),
    releasedAt: integer('released_at'),
    releaseReason: text('release_reason', { enum: ['idle', 'cap', 'manual', 'forced'] }),
    requestCount: integer('request_count').notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    /** Summed wall time with at least one request in flight — GPU-busy-under-lock. */
    busyMs: integer('busy_ms').notNull().default(0),
    /** Set once, when the 60s expiry warning has been emitted for this session. */
    warnedAt: integer('warned_at'),
  },
  (t) => ({
    byUser: index('sessions_user_id').on(t.userId),
    byAcquired: index('sessions_acquired_at').on(t.acquiredAt),
  }),
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    type: text('type', {
      enum: [
        'queued',
        'cancelled',
        'granted',
        'released',
        'expired',
        'rejected',
        'expiry_warning',
        'force_release',
        'access_requested',
      ],
    }).notNull(),
    /**
     * The **recipient**, not the subject. Delivery (`eventsForUserSince`) filters
     * on this column, so an event has to be filed under whoever should see it.
     * `queued` files under the requester because they are both; `access_requested`
     * files under the holder, with `actorId` naming who wants the lock.
     */
    userId: integer('user_id'),
    actorId: integer('actor_id'),
    /** JSON. Never contains request bodies. */
    detail: text('detail'),
  },
  (t) => ({
    byTs: index('events_ts').on(t.ts),
    byUser: index('events_user_id').on(t.userId, t.id),
  }),
);

export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Browser login sessions. Distinct from `sessions`, which is lock telemetry —
 * the plan's name for that table won, so this one is prefixed.
 */
export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => ({
    byUser: index('auth_sessions_user_id').on(t.userId),
  }),
);

/**
 * One row per proxied request, written only when tracing is switched on.
 *
 * The bodies are **not** here: `requestFile` / `responseFile` point at files
 * under the trace directory. Prompts from an agentic client are megabytes and
 * arrive on every turn; putting them in this database would push multi-MB
 * writes through the same WAL the sweeper transacts on once a second.
 */
export const requestTraces = sqliteTable(
  'request_traces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    /** The lock session this request belonged to, for grouping by hold. */
    sessionId: integer('session_id'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    /** Lifted from the request JSON, purely so the list is scannable. */
    model: text('model'),
    /** Reasoning effort the client asked for. Free-form: `reasoning_effort`,
     *  `effort` and `reasoning.effort` all land here. */
    effort: text('effort'),
    streamed: integer('streamed', { mode: 'boolean' }).notNull().default(false),
    status: integer('status'),
    outcome: text('outcome', {
      enum: ['ok', 'aborted', 'upstream_error', 'client_gone'],
    }),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    requestBytes: integer('request_bytes').notNull().default(0),
    responseBytes: integer('response_bytes').notNull().default(0),
    requestFile: text('request_file'),
    responseFile: text('response_file'),
    /** Set when a body hit the per-request cap and stopped being recorded. */
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    byUser: index('request_traces_user').on(t.userId, t.id),
    byStarted: index('request_traces_started_at').on(t.startedAt),
  }),
);

export type User = typeof users.$inferSelect;
export type RequestTrace = typeof requestTraces.$inferSelect;
export type TraceOutcome = NonNullable<RequestTrace['outcome']>;
export type LockState = typeof lockState.$inferSelect;
export type QueueEntry = typeof queueEntries.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EventType = EventRow['type'];
export type ReleaseReason = NonNullable<Session['releaseReason']>;
export type LockStatus = LockState['status'];
