import { queuePosition, readLock, stateSnapshot, type Db, type StateSnapshot, type User } from '@kuncen/core';

export interface DashboardState extends StateSnapshot {
  me: {
    id: number;
    name: string;
    role: string;
    holding: boolean;
    position: number | null;
  };
  /** Recording is a thing done *to* everyone here, so the page always says so. */
  tracing: boolean;
}

export function dashboardState(db: Db, user: User, tracing = false): DashboardState {
  const snapshot = stateSnapshot(db);
  const ls = readLock(db);
  return {
    ...snapshot,
    tracing,
    me: {
      id: user.id,
      name: user.name,
      role: user.role,
      holding: ls.status === 'HELD' && ls.holderId === user.id,
      position: queuePosition(db, user.id),
    },
  };
}

/**
 * Safe to drop inside a `<script type="application/json">` block: the only
 * sequence that could break out is `</script>`, so `<` is escaped.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).split('<').join('\\u003c');
}
