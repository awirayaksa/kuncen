import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteTraces,
  expiredTraces,
  finishTrace,
  listTraces,
  mayReadTrace,
  readTraceBody,
  startTrace,
  traceById,
  traceFilePath,
  traceRelativePath,
  type Db,
  type TraceConfig,
} from '../src/index';
import { fakeClock, makeDb, makeUser, type FakeClock, type TestDb } from './helpers';

describe('trace rows', () => {
  let h: TestDb;
  let clock: FakeClock;
  let db: Db;
  let alice: { id: number };
  let bob: { id: number };

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
  });

  it('records a request and closes it with what came back', () => {
    const id = startTrace(db, {
      userId: alice.id,
      sessionId: null,
      method: 'POST',
      path: '/v1/chat/completions',
    });
    finishTrace(db, id, {
      model: 'llama-3',
      streamed: true,
      status: 200,
      outcome: 'ok',
      promptTokens: 120,
      completionTokens: 40,
      requestBytes: 900,
      responseBytes: 3200,
      requestFile: 'x.req',
      responseFile: 'x.res',
    });

    const row = traceById(db, id);
    assert.equal(row?.model, 'llama-3');
    assert.equal(row?.streamed, true);
    assert.equal(row?.outcome, 'ok');
    assert.equal(row?.completionTokens, 40);
    assert.equal(row?.userName, 'Alice');
    assert.equal(row?.durationMs, 0, 'started and ended on the same fake tick');
  });

  it('lists only the requested user, newest first', () => {
    for (const u of [alice, bob, alice]) {
      startTrace(db, { userId: u.id, sessionId: null, method: 'POST', path: '/v1/chat/completions' });
    }
    const hers = listTraces(db, { userId: alice.id });
    assert.equal(hers.length, 2);
    assert.ok(hers.every((t) => t.userId === alice.id));
    assert.ok(hers[0]!.id > hers[1]!.id, 'newest first');
    assert.equal(listTraces(db, {}).length, 3, 'no filter lists everyone');
  });

  it('lets an author read their own and an admin read anyone', () => {
    const trace = { userId: alice.id };
    assert.equal(mayReadTrace(trace, { id: alice.id, role: 'user' }), true);
    assert.equal(mayReadTrace(trace, { id: bob.id, role: 'user' }), false, 'a colleague may not');
    assert.equal(mayReadTrace(trace, { id: bob.id, role: 'admin' }), true);
  });

  it('hands back expired rows before deleting, so files can be unlinked', () => {
    const id = startTrace(db, { userId: alice.id, sessionId: null, method: 'POST', path: '/v1/x' });
    finishTrace(db, id, { outcome: 'ok', requestFile: 'a.req' });

    assert.equal(expiredTraces(db, clock.now()).length, 0, 'nothing is stale yet');
    const stale = expiredTraces(db, clock.now() + 1);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.requestFile, 'a.req', 'the pointer survives long enough to unlink');

    deleteTraces(db, [id]);
    assert.equal(traceById(db, id), undefined);
  });
});

describe('trace files', () => {
  let dir: string;
  let cfg: TraceConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kuncen-trace-'));
    cfg = { mode: 'full', dir, maxBytes: 1024, retentionMs: 3600_000 };
  });

  it('refuses a stored path that climbs out of the trace directory', () => {
    // The value comes from our own database, but it still reaches the
    // filesystem, so it is treated as untrusted.
    assert.equal(traceFilePath(cfg, '../../etc/passwd'), null);
    assert.equal(traceFilePath(cfg, '/etc/passwd'), null);
    assert.equal(traceFilePath(cfg, 'a\0b'), null);
    assert.ok(traceFilePath(cfg, '2026-01-01/7.req'));
  });

  it('reads a recorded body back', () => {
    const rel = traceRelativePath(7, 'req', Date.parse('2026-01-02T10:00:00Z'));
    const full = traceFilePath(cfg, rel)!;
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'hello');

    const body = readTraceBody(cfg, rel);
    assert.equal(body?.text, 'hello');
    assert.equal(body?.clipped, false);
  });

  it('clips a body that is too big to hand to a browser', () => {
    const rel = traceRelativePath(8, 'res', Date.now());
    const full = traceFilePath(cfg, rel)!;
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'x'.repeat(5000));

    const body = readTraceBody(cfg, rel, 100);
    assert.equal(body?.text.length, 100);
    assert.equal(body?.bytes, 5000, 'the real size is still reported');
    assert.equal(body?.clipped, true);
  });

  it('returns null for a body that was pruned rather than throwing', () => {
    assert.equal(readTraceBody(cfg, 'gone/1.req'), null);
    assert.equal(readTraceBody(cfg, null), null);
  });

  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
});
