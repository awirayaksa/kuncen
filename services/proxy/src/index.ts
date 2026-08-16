import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { rm } from 'node:fs/promises';
import {
  defaultDbPath,
  deleteTraces,
  expiredTraces,
  openDb,
  resetInFlight,
  resourceLabel,
  setMeta,
  tick,
  traceConfig,
  traceFilePath,
  userById,
  type Db,
} from '@kuncen/core';
import { createProxyApp } from './app';
import { UpstreamHealth } from './health';
import { InFlightRegistry } from './inflight';

const PORT = Number(process.env.KUNCEN_PROXY_PORT ?? 8080);
const HOST = process.env.KUNCEN_PROXY_HOST ?? '0.0.0.0';
const UPSTREAM = process.env.KUNCEN_UPSTREAM ?? 'http://127.0.0.1:8000';
const UPSTREAM_API_KEY = process.env.KUNCEN_UPSTREAM_API_KEY;
const DASHBOARD = process.env.KUNCEN_DASHBOARD_URL ?? '';
const TICK_MS = Number(process.env.KUNCEN_TICK_MS ?? 1000);
const HEALTH_MS = Number(process.env.KUNCEN_HEALTH_POLL_MS ?? 5000);

const dbPath = defaultDbPath();
mkdirSync(dirname(resolve(dbPath)), { recursive: true });
const { db, close } = openDb(dbPath);

// No in-flight request survives a restart — the sockets died with the process.
// Leaving a phantom counter behind would pin the idle timer open forever.
resetInFlight(db);

const registry = new InFlightRegistry();
const resource = resourceLabel();
const trace = traceConfig();
const app = createProxyApp({
  db,
  upstream: UPSTREAM,
  upstreamApiKey: UPSTREAM_API_KEY,
  dashboardUrl: DASHBOARD,
  registry,
  resource,
  trace,
});

/**
 * Tracing is loud on purpose. It is off by default, and when it is on the box is
 * writing down every prompt four people type — that should be impossible to
 * enable without noticing, in the log and on the dashboard alike.
 */
setMeta(db, 'trace_mode', trace.mode);

/**
 * The sweeper lives here, not in kuncen-web, on purpose: if it is dead the proxy
 * is dead, so nothing can reach the GPU anyway. There is no state where locks
 * have stopped expiring but people are still burning GPU time.
 */
const sweeper = setInterval(() => {
  try {
    const result = tick(db);
    if (result.kill) {
      const killed = registry.killAll('Kuncen: drain ceiling reached');
      if (killed > 0) log(`drain ceiling: killed ${killed} in-flight request(s) upstream`);
    }
    if (result.drainStarted) log(`draining (${result.drainStarted})`);
    if (result.drained?.holderId) log(`released #${result.drained.holderId} -> FREE`);
    if (result.granted) log(`granted to ${describe(db, result.granted)}`);
    for (const uid of result.expiredFromQueue) log(`queue entry expired for #${uid}`);
    setMeta(db, 'proxy_heartbeat_at', String(Date.now()));
  } catch (err) {
    console.error('[kuncen-proxy] sweeper tick failed:', err);
  }
}, TICK_MS);

/**
 * Backend health is recorded separately from lock state so the dashboard can
 * keep "the resource is broken" and "the resource is taken" from ever looking
 * alike.
 */
const health = new UpstreamHealth({
  upstream: UPSTREAM,
  apiKey: UPSTREAM_API_KEY,
  path: process.env.KUNCEN_HEALTH_PATH,
  timeoutMs: Number(process.env.KUNCEN_HEALTH_TIMEOUT_MS ?? 5000),
});

let lastHealthDetail = '';

const healthPoll = setInterval(() => {
  void probeUpstream();
}, HEALTH_MS);
void probeUpstream();

async function probeUpstream(): Promise<void> {
  const result = await health.check();
  // Log only on change: a 5s poll would otherwise bury everything else.
  if (result.detail !== lastHealthDetail) {
    lastHealthDetail = result.detail;
    log(`upstream ${result.state}: ${result.detail}`);
  }
  try {
    setMeta(db, 'upstream_ok', result.state === 'up' ? '1' : result.state === 'down' ? '0' : 'unknown');
    setMeta(db, 'upstream_detail', result.detail);
    setMeta(db, 'upstream_checked_at', String(Date.now()));
  } catch (err) {
    console.error('[kuncen-proxy] health write failed:', err);
  }
}

/**
 * Retention. Deliberately not in the sweeper: that tick is a 1s transaction on
 * the critical path of the lock, and unlinking files is neither fast nor
 * something the lock should ever wait on.
 *
 * Files go before rows. The other order orphans bytes on disk with nothing left
 * pointing at them, which is how a retention policy turns into a disk-full page.
 */
const TRACE_PRUNE_MS = 5 * 60 * 1000;

async function pruneTraces(): Promise<void> {
  if (trace.mode === 'off') return;
  try {
    const cutoff = Date.now() - trace.retentionMs;
    const stale = expiredTraces(db, cutoff);
    if (stale.length === 0) return;
    for (const row of stale) {
      for (const rel of [row.requestFile, row.responseFile]) {
        if (!rel) continue;
        const full = traceFilePath(trace, rel);
        if (full) await rm(full, { force: true });
      }
    }
    deleteTraces(db, stale.map((r) => r.id));
    log(`pruned ${stale.length} trace(s) older than ${trace.retentionMs / 3600000}h`);
  } catch (err) {
    console.error('[kuncen-proxy] trace prune failed:', err);
  }
}

const tracePrune = setInterval(() => void pruneTraces(), TRACE_PRUNE_MS);
void pruneTraces();

function describe(db: Db, userId: number): string {
  return userById(db, userId)?.name ?? `#${userId}`;
}

function log(msg: string): void {
  console.log(`[kuncen-proxy] ${msg}`);
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  log(`listening on ${HOST}:${info.port} -> ${UPSTREAM}`);
  log(`guarding ${resource.the}`);
  log(`db ${resolve(dbPath)}, sweeper every ${TICK_MS}ms`);
  if (trace.mode === 'full') {
    log(
      `TRACING ON — recording every request and response body to ${trace.dir} ` +
        `(cap ${Math.round(trace.maxBytes / 1024 / 1024)}MB/body, kept ${trace.retentionMs / 3600000}h)`,
    );
  }
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} — shutting down`);
    clearInterval(sweeper);
    clearInterval(healthPoll);
    clearInterval(tracePrune);
    registry.killAll('kuncen-proxy shutting down');
    server.close(() => {
      close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
