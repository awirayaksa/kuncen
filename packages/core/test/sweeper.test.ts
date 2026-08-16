import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  beginInFlight,
  endInFlight,
  readLock,
  recentEvents,
  recentSessions,
  requestAccess,
  setConfig,
  tick,
  type Db,
  type User,
} from '../src/index';
import { MINUTE, SECOND, fakeClock, makeDb, makeUser, type FakeClock, type TestDb } from './helpers';

describe('sweeper', () => {
  let h: TestDb;
  let clock: FakeClock;
  let db: Db;
  let alice: User;
  let bob: User;
  let carol: User;

  before(() => {
    clock = fakeClock();
  });
  after(() => clock.restore());

  beforeEach(() => {
    h?.close();
    h = makeDb();
    db = h.db;
    alice = makeUser(db, 'Alice');
    bob = makeUser(db, 'Bob');
    carol = makeUser(db, 'Carol');
  });

  describe('contention gating', () => {
    it('never expires an idle holder while nobody is waiting', () => {
      requestAccess(db, alice.id);
      clock.advance(6 * 60 * MINUTE); // six hours of nothing

      tick(db, clock.now());

      assert.equal(readLock(db).status, 'HELD');
      assert.equal(readLock(db).holderId, alice.id);
    });

    it('never applies the session cap while nobody is waiting', () => {
      requestAccess(db, alice.id);
      const handle = beginInFlight(db, alice.id);
      clock.advance(5 * 60 * MINUTE);
      endInFlight(db, handle!);

      tick(db, clock.now());

      assert.equal(readLock(db).status, 'HELD', 'the cap is a fairness tool, not a curfew');
    });
  });

  describe('idle timeout', () => {
    it('releases and promotes in a single tick once someone is waiting', () => {
      requestAccess(db, alice.id);
      clock.advance(6 * MINUTE);
      requestAccess(db, bob.id);

      const result = tick(db, clock.now());

      assert.equal(result.drainStarted, 'idle');
      assert.equal(result.granted, bob.id);
      const ls = readLock(db);
      assert.equal(ls.status, 'HELD');
      assert.equal(ls.holderId, bob.id);
    });

    it('measures idle time retroactively', () => {
      requestAccess(db, alice.id);
      clock.advance(20 * MINUTE); // Alice wandered off long ago

      // Bob arrives. Alice is already over the line, so she goes almost at once —
      // she does not get a fresh five minutes for showing up to nothing.
      requestAccess(db, bob.id);
      tick(db, clock.now());

      assert.equal(readLock(db).holderId, bob.id);
    });

    it('does not fire while a request is streaming', () => {
      requestAccess(db, alice.id);
      const handle = beginInFlight(db, alice.id);
      requestAccess(db, bob.id);
      clock.advance(30 * MINUTE); // a long agentic generation

      tick(db, clock.now());

      assert.equal(readLock(db).holderId, alice.id, 'a generation must not drop the lock out from under itself');
      assert.equal(readLock(db).status, 'HELD');

      // last_activity_at is stamped when the last token flushes, not at start.
      endInFlight(db, handle!);
      assert.equal(readLock(db).lastActivityAt, clock.now());
    });

    it('self-heals a stalled hand-off the moment someone needs it to', () => {
      // Bob is granted the lock automatically and the queue empties behind him.
      requestAccess(db, alice.id);
      requestAccess(db, bob.id);
      clock.advance(6 * MINUTE);
      tick(db, clock.now());
      assert.equal(readLock(db).holderId, bob.id);

      // Bob is away. With nobody waiting, no timers run, so he holds it for
      // hours — which costs nobody anything.
      clock.advance(3 * 60 * MINUTE);
      tick(db, clock.now());
      assert.equal(readLock(db).holderId, bob.id);

      // Carol arrives. The queue is non-empty, retroactive measurement applies,
      // and the stall resolves almost at once.
      requestAccess(db, carol.id);
      tick(db, clock.now());
      assert.equal(readLock(db).holderId, carol.id);
    });
  });

  describe('session cap', () => {
    it('fires under contention even mid-stream, and drains', () => {
      requestAccess(db, alice.id);
      const handle = beginInFlight(db, alice.id);
      clock.advance(61 * MINUTE);
      requestAccess(db, bob.id);

      const result = tick(db, clock.now());

      assert.equal(result.drainStarted, 'cap');
      assert.equal(readLock(db).status, 'DRAINING');
      assert.equal(readLock(db).drainReason, 'cap');

      endInFlight(db, handle!);
      tick(db, clock.now());
      assert.equal(readLock(db).holderId, bob.id);
    });
  });

  describe('draining', () => {
    it('completes as soon as the last in-flight request finishes', () => {
      requestAccess(db, alice.id);
      requestAccess(db, bob.id);
      const handle = beginInFlight(db, alice.id);
      clock.advance(6 * MINUTE);
      tick(db, clock.now());
      assert.equal(readLock(db).status, 'HELD', 'in-flight suspends the idle timer');

      endInFlight(db, handle!);
      clock.advance(6 * MINUTE);
      tick(db, clock.now());
      assert.equal(readLock(db).holderId, bob.id);
    });

    it('kills what is left at the drain ceiling', () => {
      requestAccess(db, alice.id);
      beginInFlight(db, alice.id); // a max_tokens: 100000 run, never finishing
      clock.advance(61 * MINUTE);
      requestAccess(db, bob.id);
      tick(db, clock.now()); // -> DRAINING (cap)

      clock.advance(119 * SECOND);
      let result = tick(db, clock.now());
      assert.equal(result.kill, false, 'not yet — the ceiling has not been reached');
      assert.equal(readLock(db).status, 'DRAINING');

      clock.advance(2 * SECOND);
      result = tick(db, clock.now());
      assert.equal(result.kill, true, 'the proxy must now abort upstream, not just downstream');
      assert.equal(readLock(db).holderId, bob.id);
    });

    it('closes the session row with the reason it ended', () => {
      requestAccess(db, alice.id);
      requestAccess(db, bob.id);
      clock.advance(6 * MINUTE);
      tick(db, clock.now());

      const closed = recentSessions(db).find((s) => s.userId === alice.id);
      assert.equal(closed?.releaseReason, 'idle');
      assert.equal(closed?.releasedAt, clock.now());
    });
  });

  describe('queue entry TTL', () => {
    it('drops someone who queued this morning and went home', () => {
      requestAccess(db, alice.id);
      requestAccess(db, bob.id);
      clock.advance(61 * MINUTE);

      const result = tick(db, clock.now());

      assert.deepEqual(result.expiredFromQueue, [bob.id]);
      const [event] = recentEvents(db, 1, ['expired']);
      assert.equal(event?.userId, bob.id);
    });

    it('does not let an expired entry trigger the timers it was gating', () => {
      requestAccess(db, alice.id);
      setConfig(db, 'queue_entry_ttl_seconds', 60);
      requestAccess(db, bob.id);
      clock.advance(61 * MINUTE); // Alice is idle, but Bob's entry has expired

      tick(db, clock.now());

      assert.equal(readLock(db).holderId, alice.id, 'with the queue empty again, nothing is contended');
      assert.equal(readLock(db).status, 'HELD');
    });
  });

  describe('expiry warning', () => {
    it('fires once, only under contention, before the deadline', () => {
      requestAccess(db, alice.id);
      requestAccess(db, bob.id);

      clock.advance(3 * MINUTE);
      tick(db, clock.now());
      assert.equal(recentEvents(db, 5, ['expiry_warning']).length, 0, 'too early');

      clock.advance(90 * SECOND); // now inside the 60s warning window
      const result = tick(db, clock.now());
      assert.equal(result.warned, alice.id);

      tick(db, clock.now());
      tick(db, clock.now());
      assert.equal(recentEvents(db, 5, ['expiry_warning']).length, 1, 'exactly once per session');
    });
  });

  describe('idempotency', () => {
    it('produces the same state whether it ticks once or five times', () => {
      requestAccess(db, alice.id);
      requestAccess(db, bob.id);
      clock.advance(6 * MINUTE);

      tick(db, clock.now());
      const afterOne = readLock(db);

      for (let i = 0; i < 4; i++) tick(db, clock.now());
      const afterFive = readLock(db);

      assert.deepEqual(afterFive, afterOne);
    });

    it('survives a long gap between ticks', () => {
      // A paused VM, a slow tick, a restart. Absolute timestamps make this a
      // non-event: the tick computes what should have happened, not what has
      // elapsed since it last ran.
      requestAccess(db, alice.id);
      clock.advance(9 * 60 * MINUTE);
      requestAccess(db, bob.id);

      tick(db, clock.now());

      assert.equal(readLock(db).holderId, bob.id);
      assert.equal(readLock(db).status, 'HELD');
    });
  });
});
