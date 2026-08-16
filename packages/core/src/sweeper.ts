import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { tx } from './db';
import { getConfig } from './config';
import { logEvent } from './events';
import {
  beginDrain,
  completeDrain,
  expireQueueEntries,
  expiryEstimate,
  promoteIfFree,
  queueLength,
  readLock,
} from './lock';
import { sessions } from './schema';
import { now } from './time';

export interface TickResult {
  /** True when the drain ceiling ran out with requests still upstream. The
   *  caller must abort them — upstream first. */
  kill: boolean;
  granted: number | null;
  drained: { holderId: number | null; sessionId: number | null } | null;
  drainStarted: 'idle' | 'cap' | null;
  expiredFromQueue: number[];
  warned: number | null;
}

/**
 * One sweeper tick. Idempotent and transactional: it reads state, computes what
 * should have happened by now, and applies it in a single transaction of
 * conditional writes. A late tick or a double tick produces the same outcome as
 * a punctual one, which is what lets this be a plain 1s interval with no
 * catch-up logic.
 *
 * Lives in the proxy. If the sweeper is dead the proxy is dead, so nothing can
 * reach the GPU anyway — there is no state where locks have stopped expiring but
 * people are still burning GPU time.
 */
export function tick(db: Db, ts: number = now()): TickResult {
  return tx(db, (t) => {
    const cfg = getConfig(t);
    const result: TickResult = {
      kill: false,
      granted: null,
      drained: null,
      drainStarted: null,
      expiredFromQueue: [],
      warned: null,
    };

    result.expiredFromQueue = expireQueueEntries(t, ts);
    const n = queueLength(t);
    let ls = readLock(t);

    // --- timers. Contention-gated: with nobody waiting, expiring the lock
    // accomplishes nothing except forcing the holder back to the web page to
    // resume exactly what they were doing.
    if (ls.status === 'HELD' && n > 0) {
      const idleFor = ts - (ls.lastActivityAt ?? ts);
      const heldFor = ts - (ls.acquiredAt ?? ts);
      if (ls.inFlight === 0 && idleFor >= cfg.idle_timeout_seconds * 1000) {
        // Idle is measured retroactively — an already-absent holder is over the
        // line the instant someone queues, not five minutes later.
        if (beginDrain(t, 'idle', ts, { detail: { idle_ms: idleFor } })) result.drainStarted = 'idle';
        ls = readLock(t);
      } else if (heldFor >= cfg.max_session_seconds * 1000) {
        if (beginDrain(t, 'cap', ts, { detail: { held_ms: heldFor } })) result.drainStarted = 'cap';
        ls = readLock(t);
      }
    }

    // --- drain. Completes the moment the last in-flight request finishes, or at
    // the ceiling, whichever comes first. Without the ceiling a max_tokens:
    // 100000 generation could extend a session arbitrarily past the cap, which
    // would defeat the cap.
    if (ls.status === 'DRAINING') {
      const ceilingAt = (ls.drainStartedAt ?? ts) + cfg.drain_ceiling_seconds * 1000;
      if (ls.inFlight === 0 || ts >= ceilingAt) {
        result.kill = ls.inFlight > 0;
        result.drained = completeDrain(t, ts);
        ls = readLock(t);
      }
    }

    // --- promotion. No accept step and no claim window: if the new holder is
    // away, the ordinary idle timeout hands it on. One timer, one rule.
    if (ls.status === 'FREE' && n > 0) {
      result.granted = promoteIfFree(t, ts);
      ls = readLock(t);
    }

    // --- expiry warning, once per session. Only ever fires under contention,
    // since otherwise the lock is not expiring at all.
    if (ls.status === 'HELD' && ls.sessionId !== null) {
      const queueLen = queueLength(t);
      const est = expiryEstimate(ls, cfg, queueLen, ts);
      if (est && est.at - ts <= cfg.expiry_warning_seconds * 1000) {
        const session = t.select().from(sessions).where(eq(sessions.id, ls.sessionId)).get();
        if (session && session.warnedAt === null) {
          t.update(sessions).set({ warnedAt: ts }).where(eq(sessions.id, ls.sessionId)).run();
          logEvent(t, {
            type: 'expiry_warning',
            userId: ls.holderId,
            detail: { expires_at: est.at, reason: est.reason },
          });
          result.warned = ls.holderId;
        }
      }
    }

    return result;
  });
}
