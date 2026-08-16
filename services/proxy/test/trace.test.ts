import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import {
  createUser,
  listTraces,
  openDb,
  requestAccess,
  traceFilePath,
  type Db,
  type TraceConfig,
} from '@kuncen/core';
import { startFakeVllm, type FakeVllm } from '../../../tools/fake-vllm';
import { createProxyApp } from '../src/app';
import { InFlightRegistry } from '../src/inflight';

/**
 * Body capture, against a real socket and a real backend. The unit tests cover
 * the parsing; what matters here is that recording does not change what the
 * client receives, and that switching it off writes nothing at all.
 */
const CHAT = '/v1/chat/completions';

async function startProxy(db: Db, upstream: string, trace: TraceConfig) {
  const registry = new InFlightRegistry();
  const app = createProxyApp({ db, upstream, registry, trace });
  const server = await new Promise<ReturnType<typeof serve>>((done) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => done(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function settle(): Promise<void> {
  // The response tap closes its file after the last chunk reaches the client.
  await new Promise((r) => setTimeout(r, 120));
}

describe('request tracing', () => {
  let vllm: FakeVllm;
  let proxy: { url: string; close(): Promise<void> };
  let handle: { db: Db; close(): void };
  let db: Db;
  let alice: { id: number; key: string };
  let dir: string;
  let cfg: TraceConfig;

  before(async () => {
    vllm = await startFakeVllm({ chunkDelayMs: 2, chunks: 4 });
  });

  after(async () => {
    await proxy?.close();
    handle?.close();
    await vllm.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  const boot = async (mode: TraceConfig['mode']) => {
    await proxy?.close();
    handle?.close();
    handle = openDb(':memory:');
    db = handle.db;
    const a = createUser(db, { email: 'alice@example.test', name: 'Alice', password: 'password123' });
    alice = { id: a.user.id, key: a.apiKey.key };
    requestAccess(db, alice.id);
    dir = mkdtempSync(join(tmpdir(), 'kuncen-trace-proxy-'));
    cfg = { mode, dir, maxBytes: 1024 * 1024, retentionMs: 3600_000 };
    proxy = await startProxy(db, vllm.url, cfg);
  };

  const post = (body: unknown) =>
    fetch(proxy.url + CHAT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.key}` },
      body: JSON.stringify(body),
    });

  const read = (rel: string | null) => (rel ? readFileSync(traceFilePath(cfg, rel)!, 'utf8') : null);

  beforeEach(() => boot('full'));

  it('records both bodies without altering what the client gets', async () => {
    const sent = { model: 'qwen', messages: [{ role: 'user', content: 'why is the sky blue' }] };
    const res = await post(sent);
    const delivered = await res.text();
    await settle();

    const [row] = listTraces(db, { userId: alice.id });
    assert.ok(row, 'a trace row was written');
    assert.equal(row.path, CHAT);
    assert.equal(row.model, 'qwen', 'model lifted from the request head');
    assert.equal(row.outcome, 'ok');
    assert.equal(row.status, 200);

    assert.deepEqual(JSON.parse(read(row.requestFile)!), sent, 'the request is recorded byte for byte');
    assert.equal(read(row.responseFile), delivered, 'the recorded response is what the client received');
  });

  it('keeps counting tokens while recording', async () => {
    await post({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] });
    await settle();
    const [row] = listTraces(db, { userId: alice.id });
    assert.ok((row?.completionTokens ?? 0) > 0, 'metering still works through the tap');
  });

  it('records a streamed reply frame by frame', async () => {
    const res = await post({ model: 'qwen', stream: true, messages: [{ role: 'user', content: 'go' }] });
    const delivered = await res.text();
    await settle();

    const [row] = listTraces(db, { userId: alice.id });
    assert.equal(row?.streamed, true, 'the stream flag is lifted from the request');
    assert.equal(read(row!.responseFile), delivered);
    assert.match(read(row!.responseFile) ?? '', /^data:/m);
  });

  it('writes nothing whatsoever when tracing is off', async () => {
    await boot('off');
    const res = await post({ model: 'qwen', messages: [{ role: 'user', content: 'secret' }] });
    assert.equal(res.status, 200);
    await res.text();
    await settle();

    assert.equal(listTraces(db, {}).length, 0, 'no rows');
    // And nothing on disk either. "Off" has to mean the prompt never lands,
    // not merely that no row points at it.
    assert.deepEqual(readdirSync(dir), [], 'the trace directory stays empty');
  });

  it('stops recording at the cap but still delivers the whole response', async () => {
    await boot('full');
    cfg.maxBytes = 32; // smaller than one chunk

    const res = await post({ model: 'qwen', messages: [{ role: 'user', content: 'x'.repeat(500) }] });
    const delivered = await res.text();
    await settle();

    assert.ok(delivered.length > 32, 'the client still got the full reply');
    const [row] = listTraces(db, { userId: alice.id });
    assert.equal(row?.truncated, true, 'the row says it was capped');
    assert.ok((row?.requestBytes ?? 0) > 32, 'the real size is still counted');
  });
});
