import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  beginInFlight,
  cancelRequest,
  endInFlight,
  expiryEstimate,
  forceRelease,
  getConfig,
  queueList,
  readLock,
  recentEvents,
  releaseLock,
  requestAccess,
  tick,
  type Db,
  type User,
} from '../src/index';
import { MINUTE, fakeClock, makeDb, makeUser, type FakeClock, type TestDb } from './helpers';

describe('acquisition', () => {
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

  it('grants the lock immediately when it is free and nobody is waiting', () => {
    const result = requestAccess(db, alice.id);
    assert.equal(result.outcome, 'acquired');
    const ls = readLock(db);
    assert.equal(ls.status, 'HELD');
    assert.equal(ls.holderId, alice.id);
    assert.equal(ls.acquiredAt, clock.now());
    assert.equal(ls.lastActivityAt, clock.now());
  });

  it('queues the second requester behind the holder', () => {
    requestAccess(db, alice.id);
    const result = requestAccess(db, bob.id);
    assert.equal(result.outcome, 'queued');
    assert.equal(result.position, 1);
    assert.equal(readLock(db).holderId, alice.id);
  });

  it('is idempotent — an impatient double-click keeps your position', () => {
    requestAccess(db, alice.id);
    requestAccess(db, bob.id);
    requestAccess(db, carol.id);

    const again = requestAccess(db, bob.id);
    assert.equal(again.outcome, 'already_queued');
    assert.equal(again.position, 1, 'Bob must not be sent to the back');
    assert.deepEqual(
      queueList(db).map((q) => q.userId),
      [bob.id, carol.id],
    );
  });

  it('is a no-op when the holder asks again', () => {
    requestAccess(db, alice.id);
    const again = requestAccess(db, alice.id);
    assert.equal(again.outcome, 'already_holding');
    assert.equal(queueList(db).length, 0, 'the holder must not be able to queue behind themselves');
  });

  it('never lets two people win the same free lock', () => {
    // Both arrive with the lock free. The conditional write decides.
    const first = requestAccess(db, bob.id);
    const second = requestAccess(db, carol.id);
    assert.equal(first.outcome, 'acquired');
    assert.equal(second.outcome, 'queued');
    assert.equal(readLock(db).holderId, bob.id);
  });

  it('lets you cancel out of the queue', () => {
    requestAccess(db, alice.id);
    requestAccess(db, bob.id);
    assert.equal(cancelRequest(db, bob.id), true);
    assert.equal(queueList(db).length, 0);
    assert.equal(cancelRequest(db, bob.id), false, 'cancelling twice is harmless');
  });

  it('hands the lock to the queue head in FIFO order, with no accept step', () => {
    requestAccess(db, alice.id);
    clock.advance(1000);
    requestAccess(db, bob.id);
    clock.advance(1000);
    requestAccess(db, carol.id);

    releaseLock(db, alice.id);
    tick(db, clock.now());
    assert.equal(readLock(db).holderId, bob.id, 'Bob queued first');

    releaseLock(db, bob.id);
    tick(db, clock.now());
    assert.equal(readLock(db).holderId, carol.id);
    assert.equal(readLock(db).status, 'HELD');
  });

  it('puts a released holder at the back when they come again', () => {
    requestAccess(db, alice.id);
    requestAccess(db, bob.id);
    clock.advance(1000);
    requestAccess(db, carol.id);

    // Alice is draining out, so she is allowed to line up again — behind everyone.
    releaseLock(db, alice.id);
    const again = requestAccess(db, alice.id);
    assert.equal(again.outcome, 'queued');
    assert.equal(again.position, 3);
  });
});

describe('release', () => {
  let h: TestDb;
  let clock: FakeClock;
  let db: Db;
  let alice: User;
  let bob: User;
  let root: User;

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
    root = makeUser(db, 'Root', 'admin');
  });

  it('goes through DRAINING rather than straight to FREE', () => {
    requestAccess(db, alice.id);
    const handle = beginInFlight(db, alice.id);
    assert.ok(handle);

    releaseLock(db, alice.id);
    assert.equal(readLock(db).status, 'DRAINING');
    assert.equal(readLock(db).drainReason, 'manual');

    // In-flight requests are allowed to finish.
    tick(db, clock.now());
    assert.equal(readLock(db).status, 'DRAINING');

    endInFlight(db, handle);
    tick(db, clock.now());
    assert.equal(readLock(db).status, 'FREE');
  });

  it('ignores a release from someone who is not the holder', () => {
    requestAccess(db, alice.id);
    assert.equal(releaseLock(db, bob.id), false);
    assert.equal(readLock(db).status, 'HELD');
  });

  it('records force-release with actor, target and reason', () => {
    requestAccess(db, alice.id);
    assert.equal(forceRelease(db, root.id, 'urgent demo for the board'), true);

    const ls = readLock(db);
    assert.equal(ls.status, 'DRAINING');
    assert.equal(ls.drainReason, 'forced');

    const [event] = recentEvents(db, 1, ['force_release']);
    assert.ok(event);
    assert.equal(event.actorId, root.id);
    assert.equal(event.userId, alice.id);
    assert.equal(event.detail?.note, 'urgent demo for the board');
  });

  it('refuses a force-release with no reason', () => {
    requestAccess(db, alice.id);
    assert.throws(() => forceRelease(db, root.id, '   '), /reason/);
    assert.equal(readLock(db).status, 'HELD');
  });
});

describe('expiry estimate', () => {
  let h: TestDb;
  let clock: FakeClock;
  let db: Db;

  before(() => {
    clock = fakeClock();
  });
  after(() => clock.restore());

  beforeEach(() => {
    h?.close();
    h = makeDb();
    db = h.db;
  });

  it('is null with an empty queue — nothing is expiring', () => {
    const alice = makeUser(db, 'Alice');
    requestAccess(db, alice.id);
    clock.advance(60 * MINUTE);
    const est = expiryEstimate(readLock(db), getConfig(db), 0, clock.now());
    assert.equal(est, null);
  });

  it('reports the idle deadline when idle comes first', () => {
    const alice = makeUser(db, 'Alice');
    const bob = makeUser(db, 'Bob');
    requestAccess(db, alice.id);
    requestAccess(db, bob.id);
    const ls = readLock(db);
    const est = expiryEstimate(ls, getConfig(db), 1, clock.now());
    assert.equal(est?.reason, 'idle');
    assert.equal(est?.at, ls.lastActivityAt! + 300 * 1000);
  });

  it('falls back to the session cap while a request is streaming', () => {
    const alice = makeUser(db, 'Alice');
    const bob = makeUser(db, 'Bob');
    requestAccess(db, alice.id);
    requestAccess(db, bob.id);
    beginInFlight(db, alice.id);
    const ls = readLock(db);
    const est = expiryEstimate(ls, getConfig(db), 1, clock.now());
    assert.equal(est?.reason, 'cap', 'the idle timer cannot fire mid-stream');
    assert.equal(est?.at, ls.acquiredAt! + 3600 * 1000);
  });
});

/**
 * The holder is the one person who can act on "somebody is waiting", and the
 * only one who is never told by the ordinary `queued` event — that one is filed
 * under the requester, and delivery filters on the recipient.
 */
describe('access_requested notices', () => {
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

  const notices = () => recentEvents(db, 10, ['access_requested']);

  it('addresses the holder and names the requester', () => {
    requestAccess(db, alice.id);
    requestAccess(db, bob.id);

    const [event] = notices();
    assert.ok(event, 'the holder gets a notice');
    // This pair is the whole point: filed under Alice so it reaches her, with
    // Bob as the actor so it can say who wants it.
    assert.equal(event.userId, alice.id, 'addressed to the holder, not the requester');
    assert.equal(event.actorId, bob.id);
    assert.equal(event.userName, 'Alice');
    assert.equal(event.actorName, 'Bob');
  });

  it('counts the requester in queue_length', () => {
    requestAccess(db, alice.id);
    requestAccess(db, bob.id);
    assert.equal(notices()[0]?.detail?.queue_length, 1);

    requestAccess(db, carol.id);
    assert.equal(notices()[0]?.detail?.queue_length, 2, 'Carol counts herself');
  });

  it('says nothing when the lock was free — the requester just took it', () => {
    const result = requestAccess(db, alice.id);
    assert.equal(result.outcome, 'acquired');
    assert.equal(notices().length, 0, 'there is no holder to tell');
  });

  it('does not notify again for an impatient double-click', () => {
    requestAccess(db, alice.id);
    requestAccess(db, bob.id);
    const second = requestAccess(db, bob.id);
    assert.equal(second.outcome, 'already_queued');
    assert.equal(notices().length, 1);
  });

  it('stays quiet while the holder is draining out', () => {
    requestAccess(db, alice.id);
    releaseLock(db, alice.id);
    assert.equal(readLock(db).status, 'DRAINING');

    requestAccess(db, bob.id);
    assert.equal(notices().length, 0, 'she is already losing it — this is noise');
  });

  it('does not notify a holder about their own re-request', () => {
    requestAccess(db, alice.id);
    // Draining, so she is allowed to line up again. She should not be told that
    // she is waiting for herself.
    releaseLock(db, alice.id);
    requestAccess(db, alice.id);
    assert.equal(notices().length, 0);
  });

  it('notifies the new holder once the lock changes hands', () => {
    requestAccess(db, alice.id);
    releaseLock(db, alice.id);
    tick(db, clock.now());
    assert.equal(readLock(db).status, 'FREE');

    requestAccess(db, bob.id);
    assert.equal(readLock(db).holderId, bob.id);
    requestAccess(db, carol.id);

    const [event] = notices();
    assert.equal(event?.userId, bob.id, 'the current holder, not the previous one');
    assert.equal(event?.actorId, carol.id);
  });
});
