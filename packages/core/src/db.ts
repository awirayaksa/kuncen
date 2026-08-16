import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { migrate } from './migrate';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface KuncenDb {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

export function defaultDbPath(): string {
  return process.env.KUNCEN_DB ?? './data/kuncen.db';
}

/**
 * Two processes share this file, so WAL plus a real busy timeout is not
 * optional. Every write path uses IMMEDIATE transactions (see `tx`) so a
 * writer never has to upgrade a read lock mid-transaction, which is the one
 * case SQLite's busy handler will not retry for you.
 */
export function openDb(path: string = defaultDbPath(), opts: { migrate?: boolean } = {}): KuncenDb {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema }) as Db;
  if (opts.migrate !== false) migrate(sqlite);
  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

/** An IMMEDIATE transaction with a bounded retry on SQLITE_BUSY. */
export function tx<T>(db: Db, fn: (t: Db) => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return db.transaction((t) => fn(t as unknown as Db), { behavior: 'immediate' }) as T;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (!code.startsWith('SQLITE_BUSY')) throw err;
      lastErr = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
  throw lastErr;
}
