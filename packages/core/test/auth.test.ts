import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  createAuthSession,
  createUser,
  csrfToken,
  csrfValid,
  destroyAuthSession,
  generateApiKey,
  hashPassword,
  revokeApiKey,
  rotateApiKey,
  serverSecret,
  userByApiKey,
  userByAuthSession,
  verifyPassword,
  type Db,
} from '../src/index';
import { fakeClock, makeDb, makeUser, type FakeClock, type TestDb } from './helpers';

describe('passwords', () => {
  it('round-trips and rejects the wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', stored), true);
    assert.equal(verifyPassword('correct horse battery stapl', stored), false);
    assert.equal(verifyPassword('', stored), false);
  });

  it('salts, so two identical passwords do not share a hash', () => {
    assert.notEqual(hashPassword('same'), hashPassword('same'));
  });

  it('treats a malformed stored hash as a failure rather than a crash', () => {
    assert.equal(verifyPassword('anything', 'not-a-hash'), false);
    assert.equal(verifyPassword('anything', 'scrypt$x$y$z$q$r'), false);
  });
});

describe('api keys', () => {
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

  it('is issued at creation and stored only as a hash', () => {
    const { user, apiKey } = createUser(db, {
      email: 'a@example.test',
      name: 'A',
      password: 'password123',
    });
    assert.match(apiKey.key, /^kuncen_[A-Za-z0-9_-]{20,}$/);
    assert.notEqual(user.apiKeyHash, apiKey.key);
    assert.equal(user.apiKeyPrefix, apiKey.key.slice(0, 14));
    assert.equal(userByApiKey(db, apiKey.key)?.id, user.id);
  });

  it('rejects unknown and malformed keys', () => {
    assert.equal(userByApiKey(db, 'kuncen_nope'), undefined);
    assert.equal(userByApiKey(db, 'sk-not-ours'), undefined);
    assert.equal(userByApiKey(db, ''), undefined);
  });

  it('invalidates the old key on rotation', () => {
    const { user, apiKey } = createUser(db, {
      email: 'b@example.test',
      name: 'B',
      password: 'password123',
    });
    const next = rotateApiKey(db, user.id);
    assert.equal(userByApiKey(db, apiKey.key), undefined);
    assert.equal(userByApiKey(db, next.key)?.id, user.id);

    revokeApiKey(db, user.id);
    assert.equal(userByApiKey(db, next.key), undefined);
  });

  it('does not collide', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    assert.equal(keys.size, 200);
  });
});

describe('browser sessions', () => {
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

  it('resolves a cookie to its user, and stops after sign-out', () => {
    const user = makeUser(db, 'Alice');
    const token = createAuthSession(db, user.id);
    assert.equal(userByAuthSession(db, token)?.id, user.id);

    destroyAuthSession(db, token);
    assert.equal(userByAuthSession(db, token), undefined);
  });

  it('expires', () => {
    const user = makeUser(db, 'Bob');
    const token = createAuthSession(db, user.id);
    clock.advance(31 * 24 * 60 * 60 * 1000);
    assert.equal(userByAuthSession(db, token), undefined);
  });

  it('rejects a missing or forged cookie', () => {
    assert.equal(userByAuthSession(db, undefined), undefined);
    assert.equal(userByAuthSession(db, 'forged'), undefined);
  });
});

describe('csrf', () => {
  let h: TestDb;

  beforeEach(() => {
    h?.close();
    h = makeDb();
  });

  it('binds a token to one session', () => {
    const secret = serverSecret(h.db);
    const good = csrfToken(secret, 'session-a');
    assert.equal(csrfValid(secret, 'session-a', good), true);
    assert.equal(csrfValid(secret, 'session-b', good), false);
    assert.equal(csrfValid(secret, 'session-a', 'wrong'), false);
    assert.equal(csrfValid(secret, undefined, good), false);
    assert.equal(csrfValid(secret, 'session-a', undefined), false);
  });

  it('keeps one secret across calls, so both services agree', () => {
    assert.equal(serverSecret(h.db), serverSecret(h.db));
  });
});
