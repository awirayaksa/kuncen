import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import type { Hono } from 'hono';
import {
  createUser,
  finishTrace,
  openDb,
  startTrace,
  traceFilePath,
  traceRelativePath,
  type Db,
  type TraceConfig,
} from '@kuncen/core';
import { createWebApp } from '../src/app';

const BASE = 'http://kuncen.test';

async function signIn(app: Hono, email: string): Promise<string> {
  const res = await app.request(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password: 'password123' }),
  });
  assert.equal(res.status, 302);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

const get = (app: Hono, path: string, cookie: string) =>
  app.request(`${BASE}${path}`, { headers: { cookie } });

/**
 * Reading a trace means reading somebody's prompts. These tests exist to make
 * the boundary explicit: authors see their own, admins see everyone's, and a
 * colleague sees nothing — not even by guessing the URL.
 */
describe('trace access', () => {
  let db: Db;
  let app: Hono;
  let dir: string;
  let cfg: TraceConfig;
  let alice: number;
  let bob: number;
  let traceId: number;

  beforeEach(() => {
    const handle = openDb(':memory:');
    db = handle.db;
    alice = createUser(db, { email: 'alice@example.test', name: 'Alice', password: 'password123' }).user.id;
    bob = createUser(db, { email: 'bob@example.test', name: 'Bob', password: 'password123' }).user.id;
    createUser(db, { email: 'root@example.test', name: 'Root', password: 'password123', role: 'admin' });

    dir = mkdtempSync(join(tmpdir(), 'kuncen-web-trace-'));
    cfg = { mode: 'full', dir, maxBytes: 1024 * 1024, retentionMs: 3600_000 };
    app = createWebApp({ db, proxyUrl: 'http://spark:8080', trace: cfg }) as unknown as Hono;

    // One recorded request belonging to Alice.
    traceId = startTrace(db, { userId: alice, sessionId: null, method: 'POST', path: '/v1/chat/completions' });
    const reqRel = traceRelativePath(traceId, 'req', Date.now());
    const resRel = traceRelativePath(traceId, 'res', Date.now());
    for (const [rel, text] of [
      [reqRel, JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'ALICE SECRET PROMPT' }] })],
      [resRel, JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ALICE SECRET REPLY' } }] })],
    ] as const) {
      const full = traceFilePath(cfg, rel)!;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    finishTrace(db, traceId, {
      model: 'qwen',
      effort: 'high',
      status: 200,
      outcome: 'ok',
      requestFile: reqRel,
      responseFile: resRel,
      promptTokens: 5,
      completionTokens: 7,
    });
  });

  it('shows the author their own conversation, reassembled', async () => {
    const cookie = await signIn(app, 'alice@example.test');
    const html = await (await get(app, `/traces/${traceId}`, cookie)).text();
    assert.match(html, /ALICE SECRET PROMPT/);
    assert.match(html, /ALICE SECRET REPLY/);
    assert.match(html, /qwen/);
    assert.match(html, /high/, 'the client-chosen effort is shown');
  });

  it('refuses a colleague, by page and by raw body alike', async () => {
    const cookie = await signIn(app, 'bob@example.test');

    const page = await get(app, `/traces/${traceId}`, cookie);
    assert.equal(page.status, 404, 'guessing the id must not work');
    assert.doesNotMatch(await page.text(), /ALICE SECRET/);

    // The raw route is a separate handler and a separate chance to get it wrong.
    for (const side of ['request', 'response']) {
      const raw = await get(app, `/traces/${traceId}/raw?side=${side}`, cookie);
      assert.equal(raw.status, 404, `raw ${side} must be refused too`);
      assert.doesNotMatch(await raw.text(), /ALICE SECRET/);
    }
  });

  it('lets an admin read anyone', async () => {
    const cookie = await signIn(app, 'root@example.test');
    const html = await (await get(app, `/traces/${traceId}`, cookie)).text();
    assert.match(html, /ALICE SECRET PROMPT/);
  });

  it('ignores ?user= from a non-admin instead of honouring it', async () => {
    const cookie = await signIn(app, 'bob@example.test');
    const html = await (await get(app, `/traces?user=${alice}`, cookie)).text();
    assert.doesNotMatch(html, /ALICE SECRET/);
    assert.match(html, /Your requests/, 'quietly shown his own list');
  });

  it('serves the raw body as text, never as html', async () => {
    const cookie = await signIn(app, 'alice@example.test');
    const raw = await get(app, `/traces/${traceId}/raw?side=request`, cookie);
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-type') ?? '', /^text\/plain/);
  });

  it('sends an anonymous visitor to the login page', async () => {
    const res = await app.request(`${BASE}/traces/${traceId}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  });

  it('says recording is on, so nobody is recorded without being told', async () => {
    const cookie = await signIn(app, 'alice@example.test');
    assert.match(await (await get(app, '/traces', cookie)).text(), /Recording is <strong>on<\/strong>/);
    assert.match(await (await get(app, '/', cookie)).text(), /tracing is <strong>on<\/strong>/i);
  });

  it('says recording is off when it is', async () => {
    const off = createWebApp({
      db,
      proxyUrl: 'http://spark:8080',
      trace: { ...cfg, mode: 'off' },
    }) as unknown as Hono;
    const cookie = await signIn(off, 'alice@example.test');
    assert.match(await (await get(off, '/traces', cookie)).text(), /Recording is <strong>off<\/strong>/);
  });

  it('survives a body that was pruned out from under the row', async () => {
    rmSync(dir, { recursive: true, force: true });
    const cookie = await signIn(app, 'alice@example.test');
    const res = await get(app, `/traces/${traceId}`, cookie);
    assert.equal(res.status, 200, 'a missing file is not a 500');
    assert.match(await res.text(), /not recorded/i);
  });
});
