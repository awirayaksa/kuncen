import { createUser, openDb, setClock, type Db, type User } from '../src/index';

export interface TestDb {
  db: Db;
  close(): void;
}

export function makeDb(): TestDb {
  const { db, close } = openDb(':memory:');
  return { db, close };
}

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  restore(): void;
}

/** Fixed start so failures are reproducible. */
export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let t = start;
  const restore = setClock(() => t);
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    restore,
  };
}

export function makeUser(db: Db, name: string, role: 'user' | 'admin' = 'user'): User {
  return createUser(db, {
    email: `${name.toLowerCase()}@example.test`,
    name,
    password: 'correct horse battery',
    role,
  }).user;
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
