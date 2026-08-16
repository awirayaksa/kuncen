import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { defaultDbPath, openDb, pruneAuthSessions, resourceLabel, traceConfig } from '@kuncen/core';
import { createWebApp } from './app';

const PORT = Number(process.env.KUNCEN_WEB_PORT ?? 3000);
const HOST = process.env.KUNCEN_WEB_HOST ?? '0.0.0.0';
const PROXY_URL = process.env.KUNCEN_PROXY_URL ?? `http://${hostGuess()}:8080`;

const dbPath = defaultDbPath();
mkdirSync(dirname(resolve(dbPath)), { recursive: true });
const { db, close } = openDb(dbPath);

const resource = resourceLabel();
const trace = traceConfig();
const app = createWebApp({
  db,
  resource,
  proxyUrl: PROXY_URL,
  secureCookies: process.env.KUNCEN_SECURE_COOKIES === '1',
  trace,
});

const prune = setInterval(() => {
  try {
    pruneAuthSessions(db);
  } catch (err) {
    console.error('[kuncen-web] session prune failed:', err);
  }
}, 60 * 60 * 1000);
prune.unref();

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[kuncen-web] listening on ${HOST}:${info.port}`);
  console.log(`[kuncen-web] db ${resolve(dbPath)}, proxy advertised as ${PROXY_URL}`);
  console.log(`[kuncen-web] guarding ${resource.the}`);
  if (trace.mode === 'full') console.log(`[kuncen-web] TRACING ON — serving recorded bodies from ${trace.dir}`);
});

function hostGuess(): string {
  return process.env.KUNCEN_HOSTNAME ?? 'localhost';
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[kuncen-web] ${signal} — shutting down`);
    clearInterval(prune);
    server.close(() => {
      close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
