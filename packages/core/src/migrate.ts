import type Database from 'better-sqlite3';

/**
 * Hand-written, idempotent, versioned by `PRAGMA user_version`. Both services
 * run this at startup. Deliberately not drizzle-kit: that would put a codegen
 * step and a CLI between a fresh checkout and a running box, and this schema is
 * six tables that will barely move.
 */

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    api_key_hash  TEXT UNIQUE,
    api_key_prefix TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE lock_state (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    status           TEXT NOT NULL DEFAULT 'FREE' CHECK (status IN ('FREE','HELD','DRAINING')),
    holder_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    session_id       INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    acquired_at      INTEGER,
    last_activity_at INTEGER,
    in_flight        INTEGER NOT NULL DEFAULT 0,
    drain_started_at INTEGER,
    drain_reason     TEXT CHECK (drain_reason IN ('idle','cap','manual','forced'))
  );

  CREATE TABLE queue_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    enqueued_at INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX queue_entries_enqueued_at ON queue_entries(enqueued_at);

  CREATE TABLE sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acquired_at       INTEGER NOT NULL,
    released_at       INTEGER,
    release_reason    TEXT CHECK (release_reason IN ('idle','cap','manual','forced')),
    request_count     INTEGER NOT NULL DEFAULT 0,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    busy_ms           INTEGER NOT NULL DEFAULT 0,
    warned_at         INTEGER
  );
  CREATE INDEX sessions_user_id ON sessions(user_id);
  CREATE INDEX sessions_acquired_at ON sessions(acquired_at);

  CREATE TABLE events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    type     TEXT NOT NULL,
    user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    detail   TEXT
  );
  CREATE INDEX events_ts ON events(ts);
  CREATE INDEX events_user_id ON events(user_id, id);

  CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE auth_sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX auth_sessions_user_id ON auth_sessions(user_id);

  INSERT INTO lock_state (id, status, in_flight) VALUES (1, 'FREE', 0);
  `,

  // v2 — request tracing. One row per proxied request; the bodies themselves
  // live on disk (see services/proxy/src/trace.ts), because an agentic client
  // resends its whole context every turn and multi-MB blobs in this file would
  // land in the same WAL the 1s sweeper transacts on.
  `
  CREATE TABLE request_traces (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id        INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    method            TEXT NOT NULL,
    path              TEXT NOT NULL,
    model             TEXT,
    streamed          INTEGER NOT NULL DEFAULT 0,
    status            INTEGER,
    outcome           TEXT,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    request_bytes     INTEGER NOT NULL DEFAULT 0,
    response_bytes    INTEGER NOT NULL DEFAULT 0,
    request_file      TEXT,
    response_file     TEXT,
    truncated         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX request_traces_user ON request_traces(user_id, id);
  CREATE INDEX request_traces_started_at ON request_traces(started_at);
  `,

  // v3 — reasoning effort, lifted from the request head like `model`/`streamed`.
  // The field name is not standardised across clients, so it is one free-form
  // column and the proxy is what decides which key it came from.
  `
  ALTER TABLE request_traces ADD COLUMN effort TEXT;
  `,
];

export function migrate(sqlite: Database.Database): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  if (current >= MIGRATIONS.length) return;

  // foreign_keys must be off while running DDL in a transaction, and lock_state
  // references sessions before sessions exists.
  sqlite.pragma('foreign_keys = OFF');
  try {
    const run = sqlite.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) {
        sqlite.exec(MIGRATIONS[v]!);
      }
      sqlite.pragma(`user_version = ${MIGRATIONS.length}`);
    });
    run();
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
}
