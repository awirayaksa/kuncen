import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UpstreamHealth } from '../src/health';

/** A fetch stand-in driven by a path -> status map. Records what was asked. */
function fakeFetch(routes: Record<string, number | 'throw' | 'timeout'>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const outcome = routes[url.pathname] ?? 404;
    if (outcome === 'throw') throw new TypeError('fetch failed');
    if (outcome === 'timeout') {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    }
    return new Response(outcome === 200 ? '{}' : '', {
      status: outcome,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls, headersOf: () => undefined as unknown, init: undefined as RequestInit | undefined };
}

const base = 'https://backend.test/zen/go';

describe('upstream health', () => {
  it('reports up when vLLM answers /health', async () => {
    const f = fakeFetch({ '/zen/go/health': 200 });
    const result = await new UpstreamHealth({ upstream: base, fetchImpl: f.impl }).check();
    assert.equal(result.state, 'up');
    assert.equal(result.path, '/health');
    assert.deepEqual(f.calls, ['/zen/go/health']);
  });

  it('falls back to /v1/models when /health is not served', async () => {
    // The exact shape of a hosted OpenAI-compatible gateway: no /health, but
    // inference works fine. Reporting "down" here was the bug.
    const f = fakeFetch({ '/zen/go/health': 404, '/zen/go/v1/models': 200 });
    const result = await new UpstreamHealth({ upstream: base, fetchImpl: f.impl }).check();
    assert.equal(result.state, 'up');
    assert.equal(result.path, '/v1/models');
  });

  it('sticks to the path that answered instead of probing both every poll', async () => {
    const f = fakeFetch({ '/zen/go/health': 404, '/zen/go/v1/models': 200 });
    const health = new UpstreamHealth({ upstream: base, fetchImpl: f.impl });
    await health.check();
    f.calls.length = 0;
    await health.check();
    assert.deepEqual(f.calls, ['/zen/go/v1/models'], 'one request per poll once settled');
  });

  it('says unknown — not down — when the host answers but serves no probe', async () => {
    const f = fakeFetch({ '/zen/go/health': 404, '/zen/go/v1/models': 404 });
    const result = await new UpstreamHealth({ upstream: base, fetchImpl: f.impl }).check();
    assert.equal(result.state, 'unknown', 'a missing probe endpoint is not a dead backend');
    assert.match(result.detail, /KUNCEN_HEALTH_PATH/);
  });

  it('reports down when nothing is listening', async () => {
    const f = fakeFetch({ '/zen/go/health': 'throw', '/zen/go/v1/models': 'throw' });
    const result = await new UpstreamHealth({ upstream: base, fetchImpl: f.impl }).check();
    assert.equal(result.state, 'down');
    assert.match(result.detail, /unreachable/);
  });

  it('reports down on a timeout, naming the budget', async () => {
    const f = fakeFetch({ '/zen/go/health': 'timeout', '/zen/go/v1/models': 'timeout' });
    const result = await new UpstreamHealth({ upstream: base, fetchImpl: f.impl, timeoutMs: 1500 }).check();
    assert.equal(result.state, 'down');
    assert.match(result.detail, /1500ms/);
  });

  it('reports down on 5xx', async () => {
    const f = fakeFetch({ '/zen/go/health': 503 });
    const result = await new UpstreamHealth({ upstream: base, fetchImpl: f.impl }).check();
    assert.equal(result.state, 'down');
    assert.match(result.detail, /503/);
  });

  it('calls out a refused credential rather than blaming the backend', async () => {
    const f = fakeFetch({ '/zen/go/health': 401 });
    const result = await new UpstreamHealth({ upstream: base, fetchImpl: f.impl }).check();
    assert.equal(result.state, 'down');
    assert.match(result.detail, /KUNCEN_UPSTREAM_API_KEY/);
    assert.deepEqual(f.calls, ['/zen/go/health'], 'a 401 is an answer — do not keep hunting');
  });

  it('honours an explicit path and does not fall back past it', async () => {
    const f = fakeFetch({ '/zen/go/ping': 200, '/zen/go/v1/models': 200 });
    const result = await new UpstreamHealth({ upstream: base, path: 'ping', fetchImpl: f.impl }).check();
    assert.equal(result.state, 'up');
    assert.deepEqual(f.calls, ['/zen/go/ping'], 'an explicit typo must surface, not be papered over');
  });

  it('can be switched off entirely', async () => {
    const f = fakeFetch({});
    const result = await new UpstreamHealth({ upstream: base, path: 'off', fetchImpl: f.impl }).check();
    assert.equal(result.state, 'unknown');
    assert.equal(f.calls.length, 0, 'no requests at all');
  });

  it('re-probes from scratch after a failure, so recovery is noticed', async () => {
    const routes: Record<string, number> = { '/zen/go/health': 404, '/zen/go/v1/models': 200 };
    const f = fakeFetch(routes);
    const health = new UpstreamHealth({ upstream: base, fetchImpl: f.impl });
    assert.equal((await health.check()).state, 'up');

    routes['/zen/go/v1/models'] = 503;
    assert.equal((await health.check()).state, 'down');

    routes['/zen/go/v1/models'] = 200;
    f.calls.length = 0;
    assert.equal((await health.check()).state, 'up');
    assert.ok(f.calls.includes('/zen/go/v1/models'));
  });

  it('sends the upstream credential when one is configured', async () => {
    let seen: string | null = null;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('authorization');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await new UpstreamHealth({ upstream: base, apiKey: 'sk-test', fetchImpl: impl }).check();
    assert.equal(seen, 'Bearer sk-test');
  });

  it('tolerates a trailing slash on the upstream URL', async () => {
    const f = fakeFetch({ '/zen/go/health': 200 });
    const result = await new UpstreamHealth({ upstream: `${base}/`, fetchImpl: f.impl }).check();
    assert.equal(result.state, 'up');
    assert.deepEqual(f.calls, ['/zen/go/health'], 'no double slash');
  });
});
