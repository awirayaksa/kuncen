import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import {
  createUser,
  openDb,
  readLock,
  recentEvents,
  recentSessions,
  releaseLock,
  requestAccess,
  makeResourceLabel,
  setConfig,
  tick,
  type Db,
  type ResourceLabel,
} from '@kuncen/core';
import { startFakeVllm, type FakeVllm } from '../../../tools/fake-vllm';
import { createProxyApp } from '../src/app';
import { InFlightRegistry } from '../src/inflight';

interface Proxy {
  url: string;
  registry: InFlightRegistry;
  close(): Promise<void>;
}

async function startProxy(db: Db, upstream: string, resource?: ResourceLabel): Promise<Proxy> {
  const registry = new InFlightRegistry();
  const app = createProxyApp({
    db,
    upstream,
    registry,
    dashboardUrl: 'http://kuncen.test:3000',
    resource,
  });
  const server = await new Promise<ReturnType<typeof serve>>((done) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => done(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    registry,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('condition not met in time');
}

const CHAT = '/v1/chat/completions';

describe('kuncen-proxy', () => {
  let vllm: FakeVllm;
  let proxy: Proxy;
  let handle: { db: Db; close(): void };
  let db: Db;
  let alice: { id: number; key: string };
  let bob: { id: number; key: string };

  before(async () => {
    vllm = await startFakeVllm({ chunkDelayMs: 15, chunks: 6 });
  });

  after(async () => {
    await proxy?.close();
    handle?.close();
    await vllm.close();
  });

  beforeEach(async () => {
    await proxy?.close();
    handle?.close();
    handle = openDb(':memory:');
    db = handle.db;
    const a = createUser(db, { email: 'alice@example.test', name: 'Alice', password: 'password123' });
    const b = createUser(db, { email: 'bob@example.test', name: 'Bob', password: 'password123' });
    alice = { id: a.user.id, key: a.apiKey.key };
    bob = { id: b.user.id, key: b.apiKey.key };
    proxy = await startProxy(db, vllm.url);
  });

  const post = (path: string, key: string | null, body: unknown = { model: 'qwen', messages: [] }) =>
    fetch(proxy.url + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });

  describe('authentication', () => {
    it('rejects a request with no key', async () => {
      const res = await post(CHAT, null);
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'kuncen_unauthorized');
      assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);
    });

    it('rejects an unknown key', async () => {
      const res = await post(CHAT, 'kuncen_madeitup');
      assert.equal(res.status, 401);
    });

    it('lets an authenticated user list models without holding the lock', async () => {
      const res = await fetch(`${proxy.url}/v1/models`, {
        headers: { authorization: `Bearer ${bob.key}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { data: unknown[] };
      assert.equal(body.data.length, 1);
      assert.equal(readLock(db).status, 'FREE', 'reading the model list acquires nothing');
    });
  });

  describe('enforcement', () => {
    it('answers a non-holder with 423, never 429', async () => {
      requestAccess(db, alice.id);
      const res = await post(CHAT, bob.key);

      assert.equal(res.status, 423, '429 would make openai-python retry and hang');
      assert.ok(res.headers.get('retry-after'), 'Retry-After is required for a legible client experience');

      const body = (await res.json()) as {
        error: { message: string; code: string };
        kuncen: { holder: string; queue_position: number | null; queue_length: number; dashboard: string };
      };
      assert.equal(body.error.code, 'kuncen_locked');
      assert.match(body.error.message, /Alice/);
      assert.equal(body.kuncen.holder, 'Alice');
      assert.equal(body.kuncen.queue_position, null);
      assert.equal(body.kuncen.dashboard, 'http://kuncen.test:3000');
    });

    it('names the guarded resource from configuration in the 423 body', async () => {
      const custom = await startProxy(db, vllm.url, makeResourceLabel('Build Server 3', ''));
      try {
        requestAccess(db, alice.id);
        const res = await fetch(custom.url + CHAT, {
          method: 'POST',
          headers: { authorization: `Bearer ${bob.key}`, 'content-type': 'application/json' },
          body: '{}',
        });
        const body = (await res.json()) as { error: { message: string } };
        assert.equal(res.status, 423);
        assert.match(body.error.message, /Build Server 3 is held by Alice\./);
        assert.doesNotMatch(body.error.message, /Spark/);
      } finally {
        await custom.close();
      }
    });

    it('does not enqueue the caller — the proxy is only an enforcer', async () => {
      requestAccess(db, alice.id);
      await post(CHAT, bob.key);
      await post(CHAT, bob.key);
      const state = recentEvents(db, 20, ['queued']);
      assert.equal(state.length, 1, 'only Alice deliberately joined');
    });

    it('reports the caller position when they did queue', async () => {
      requestAccess(db, alice.id);
      requestAccess(db, bob.id);
      const res = await post(CHAT, bob.key);
      const body = (await res.json()) as { kuncen: { queue_position: number; queue_length: number } };
      assert.equal(body.kuncen.queue_position, 1);
      assert.equal(body.kuncen.queue_length, 1);
    });

    it('logs every rejection with how long the caller had been waiting', async () => {
      requestAccess(db, alice.id);
      requestAccess(db, bob.id);
      await post(CHAT, bob.key);

      const [event] = recentEvents(db, 1, ['rejected']);
      assert.equal(event?.userId, bob.id);
      assert.equal(event?.detail?.queue_position, 1);
      assert.equal(typeof event?.detail?.waited_ms, 'number');
      assert.equal(event?.detail?.path, CHAT);
    });

    it('rejects everyone while draining, including the outgoing holder', async () => {
      requestAccess(db, alice.id);
      releaseLock(db, alice.id);
      assert.equal(readLock(db).status, 'DRAINING');

      const res = await post(CHAT, alice.key);
      assert.equal(res.status, 423);
      const body = (await res.json()) as { kuncen: { status: string } };
      assert.equal(body.kuncen.status, 'DRAINING');
    });
  });

  describe('passthrough', () => {
    it('forwards the holder to vLLM and counts the request', async () => {
      requestAccess(db, alice.id);
      const before = readLock(db).lastActivityAt!;

      const res = await post(CHAT, alice.key);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      assert.equal(body.choices[0]?.message.content, 'hello');

      await waitFor(() => readLock(db).inFlight === 0);
      const session = recentSessions(db)[0]!;
      assert.equal(session.requestCount, 1);
      assert.equal(session.promptTokens, 11);
      assert.equal(session.completionTokens, 7);
      assert.ok(readLock(db).lastActivityAt! >= before, 'activity is stamped when the last token flushes');
    });

    it('does not forward the caller credential upstream', async () => {
      requestAccess(db, alice.id);
      vllm.requests.length = 0;
      await (await post(CHAT, alice.key)).json();
      const seen = vllm.requests.find((r) => r.path === CHAT);
      assert.ok(seen);
      assert.equal(seen.authorization, undefined, "vLLM must never see a user's kuncen key");
    });

    it('streams SSE through and picks up the trailing usage frame', async () => {
      requestAccess(db, alice.id);
      const res = await post(CHAT, alice.key, { model: 'qwen', messages: [], stream: true });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /event-stream/);

      const text = await res.text();
      assert.match(text, /tok0/);
      assert.match(text, /\[DONE\]/);

      await waitFor(() => readLock(db).inFlight === 0);
      const session = recentSessions(db)[0]!;
      assert.equal(session.promptTokens, 21);
      assert.equal(session.completionTokens, 13);
      assert.ok(session.busyMs >= 0);
    });

    it('releases the in-flight slot even when the backend errors', async () => {
      const broken = await startFakeVllm({ failWith: 500 });
      const brokenProxy = await startProxy(db, broken.url);
      try {
        requestAccess(db, alice.id);
        const res = await fetch(brokenProxy.url + CHAT, {
          method: 'POST',
          headers: { authorization: `Bearer ${alice.key}`, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(res.status, 500, 'the backend error passes through unchanged');
        await res.text();

        await waitFor(() => readLock(db).inFlight === 0);
        assert.equal(readLock(db).status, 'HELD');
        assert.equal(readLock(db).holderId, alice.id, 'losing your slot to a backend hiccup would be perverse');
      } finally {
        await brokenProxy.close();
        await broken.close();
      }
    });

    it('answers 502 and keeps the lock when vLLM is unreachable', async () => {
      const deadProxy = await startProxy(db, 'http://127.0.0.1:1');
      try {
        requestAccess(db, alice.id);
        const res = await fetch(deadProxy.url + CHAT, {
          method: 'POST',
          headers: { authorization: `Bearer ${alice.key}`, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(res.status, 502);
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'kuncen_upstream_error');
        assert.equal(readLock(db).holderId, alice.id);
      } finally {
        await deadProxy.close();
      }
    });
  });

  describe('killing a request', () => {
    it('aborts the upstream generation when the client walks away', async () => {
      requestAccess(db, alice.id);
      const before = vllm.aborted;

      const controller = new AbortController();
      const res = await fetch(proxy.url + CHAT, {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen', messages: [], stream: true }),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read(); // one chunk, then leave
      controller.abort();

      await waitFor(() => vllm.aborted > before);
      assert.equal(vllm.aborted, before + 1, 'the GPU must stop generating tokens nobody will read');
      await waitFor(() => readLock(db).inFlight === 0);
    });

    it('closes the upstream connection when the drain ceiling expires', async () => {
      setConfig(db, 'drain_ceiling_seconds', 5);
      requestAccess(db, alice.id);
      const before = vllm.aborted;

      const res = await fetch(proxy.url + CHAT, {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen', messages: [], stream: true }),
      });
      const reader = res.body!.getReader();
      await reader.read();
      await waitFor(() => readLock(db).inFlight === 1);

      releaseLock(db, alice.id);
      assert.equal(readLock(db).status, 'DRAINING');

      // The ceiling is reached. Timestamps are absolute, so the tick can be told
      // what time it is rather than made to wait for it.
      const result = tick(db, Date.now() + 10_000);
      assert.equal(result.kill, true);
      proxy.registry.killAll('Kuncen: drain ceiling reached');

      await waitFor(() => vllm.aborted > before);
      assert.equal(readLock(db).status, 'FREE');
      await reader.cancel().catch(() => {});
    });

    it('leaves nothing in flight after a kill, so the next holder starts clean', async () => {
      requestAccess(db, alice.id);
      const res = await fetch(proxy.url + CHAT, {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen', messages: [], stream: true }),
      });
      const reader = res.body!.getReader();
      await reader.read();
      await waitFor(() => readLock(db).inFlight === 1);

      releaseLock(db, alice.id);
      tick(db, Date.now() + 300_000);
      proxy.registry.killAll('Kuncen: drain ceiling reached');
      await reader.cancel().catch(() => {});

      requestAccess(db, bob.id);
      tick(db, Date.now());
      assert.equal(readLock(db).holderId, bob.id);

      // The aborted request's bookkeeping lands on Alice's session, not Bob's.
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(readLock(db).inFlight, 0);
      const bobSession = recentSessions(db).find((s) => s.userId === bob.id);
      assert.equal(bobSession?.requestCount, 0);
    });
  });
});
