import { Hono, type Context } from 'hono';
import {
  beginInFlight,
  endInFlight,
  expiryEstimate,
  getConfig,
  logEvent,
  queueList,
  readLock,
  resourceLabel,
  finishTrace,
  startTrace,
  traceConfig,
  traceRelativePath,
  userByApiKey,
  userById,
  type Db,
  type InFlightHandle,
  type LockState,
  type ResourceLabel,
  type TraceConfig,
  type TraceOutcome,
  type Usage,
  type User,
} from '@kuncen/core';
import { InFlightRegistry, KuncenAbort } from './inflight';
import { meteredStream } from './usage';
import { BodySink, drainToSink, extractEffort, extractModel, extractStreamFlag, tappedStream } from './trace';

export interface ProxyOptions {
  db: Db;
  upstream: string;
  /** Optional key for a vLLM started with `--api-key`. Never the caller's. */
  upstreamApiKey?: string;
  dashboardUrl?: string;
  registry: InFlightRegistry;
  /** What is being guarded. Defaults to the value in the environment. */
  resource?: ResourceLabel;
  /** Body capture. Defaults to the environment, which defaults to off. */
  trace?: TraceConfig;
}

type Env = { Variables: { user: User } };

/** Authenticated, but the lock does not apply. Reading the model list or
 *  pinging health must not require holding the GPU. */
const NO_LOCK_PATHS = new Set(['/v1/models', '/health']);

/** Hop-by-hop and encoding headers we must not blindly relay. */
const STRIP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
  'authorization',
  'content-length',
  'accept-encoding',
]);
const STRIP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

export function createProxyApp(opts: ProxyOptions): Hono<Env> {
  const { db, registry } = opts;
  const app = new Hono<Env>();

  // Liveness for whoever is watching the box. No auth: it exposes nothing.
  app.get('/healthz', (c) =>
    c.json({ ok: true, service: 'kuncen-proxy', inFlight: registry.size, status: readLock(db).status }),
  );

  const auth = async (c: Context<Env>, next: () => Promise<void>) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = token ? userByApiKey(db, token) : undefined;
    if (!user) {
      c.header('WWW-Authenticate', 'Bearer realm="kuncen"');
      return c.json(
        {
          error: {
            message:
              'Kuncen: missing or unknown API key. Use the key from your profile page as `Authorization: Bearer kuncen_...`.',
            type: 'invalid_request_error',
            code: 'kuncen_unauthorized',
          },
        },
        401,
      );
    }
    c.set('user', user);
    await next();
    return undefined;
  };

  app.use('/v1/*', auth);
  app.use('/health', auth);

  /**
   * The proxy is purely an enforcer. A request from a non-holder gets 423 and
   * that is the end of it — it does not enqueue anyone and does not acquire
   * anything. The waiting list is built only from deliberate button presses on
   * the dashboard.
   */
  const lockGate = async (c: Context<Env>, next: () => Promise<void>) => {
    if (NO_LOCK_PATHS.has(new URL(c.req.url).pathname)) {
      await next();
      return undefined;
    }
    const user = c.get('user');
    const ls = readLock(db);
    if (ls.status === 'HELD' && ls.holderId === user.id) {
      await next();
      return undefined;
    }
    return reject(c, opts, ls, user);
  };

  app.use('/v1/*', lockGate);

  app.all('/v1/*', (c) => forward(c, opts));
  app.all('/health', (c) => forward(c, opts));

  return app;
}

/**
 * 423 Locked, deliberately not 429. `openai-python` auto-retries 429s, which
 * would turn a clean "you're queued" into a confusing hang-then-fail. 423 fails
 * fast and legibly, and the body says exactly where you stand.
 */
function reject(c: Context<Env>, opts: ProxyOptions, ls: LockState, user: User) {
  const { db } = opts;
  const cfg = getConfig(db);
  const queue = queueList(db);
  const mine = queue.find((q) => q.userId === user.id);
  const holderName = ls.holderId ? (userById(db, ls.holderId)?.name ?? null) : null;
  const est = expiryEstimate(ls, cfg, queue.length);
  const nowTs = Date.now();

  logEvent(db, {
    type: 'rejected',
    userId: user.id,
    detail: {
      status: ls.status,
      holder_id: ls.holderId,
      queue_position: mine?.position ?? null,
      waited_ms: mine ? Math.max(0, nowTs - mine.enqueuedAt) : 0,
      path: new URL(c.req.url).pathname,
    },
  });

  const retryAfter = Math.max(
    5,
    Math.min(300, est ? Math.ceil((est.at - nowTs) / 1000) : 60),
  );
  c.header('Retry-After', String(retryAfter));

  const dashboard = opts.dashboardUrl ?? '';
  const where = mine
    ? `You are #${mine.position} of ${queue.length} in the queue.`
    : queue.length > 0
      ? `You are not in the queue (${queue.length} waiting).`
      : 'You are not in the queue.';
  const resource = opts.resource ?? resourceLabel();
  const held =
    ls.status === 'DRAINING'
      ? 'The lock is draining and will be handed to the queue head shortly.'
      : ls.status === 'FREE'
        ? `${resource.The} is free, but the lock is not yours.`
        : `${resource.The} is held by ${holderName ?? 'another user'}.`;
  const act = mine ? '' : ` Request access at ${dashboard || 'the kuncen dashboard'}.`;

  return c.json(
    {
      error: {
        message: `Kuncen: ${held} ${where}${act}`,
        type: 'kuncen_locked',
        code: 'kuncen_locked',
      },
      kuncen: {
        status: ls.status,
        holder: holderName,
        holder_id: ls.holderId,
        acquired_at: ls.acquiredAt,
        expires_at: est?.at ?? null,
        expires_in_seconds: est ? Math.max(0, Math.ceil((est.at - nowTs) / 1000)) : null,
        expiry_reason: est?.reason ?? null,
        queue_position: mine?.position ?? null,
        queue_length: queue.length,
        retry_after_seconds: retryAfter,
        dashboard: dashboard || null,
      },
    },
    423,
  );
}

async function forward(c: Context<Env>, opts: ProxyOptions): Promise<Response> {
  const { db, registry } = opts;
  const user = c.get('user');
  const path = new URL(c.req.url).pathname;
  const counted = !NO_LOCK_PATHS.has(path);

  const handle: InFlightHandle | null = counted ? beginInFlight(db, user.id) : null;
  if (counted && !handle) {
    // Raced a release between the gate and here. The conditional write caught it.
    return reject(c, opts, readLock(db), user);
  }

  // --- tracing. Entirely optional and entirely fenced off: every call into it
  // is wrapped, because a failure to record must never cost someone their
  // generation. `trace` stays null when capture is switched off, which is the
  // default and the only state in which no prompt touches the disk.
  const cfg = opts.trace ?? traceConfig();
  const tracing = cfg.mode === 'full' && counted;
  const startedAt = Date.now();
  let traceId: number | null = null;
  let reqSink: BodySink | null = null;
  let resSink: BodySink | null = null;
  if (tracing) {
    try {
      traceId = startTrace(db, {
        userId: user.id,
        sessionId: handle?.sessionId ?? null,
        method: c.req.method,
        path,
        startedAt,
      });
      reqSink = new BodySink(cfg, traceRelativePath(traceId, 'req', startedAt));
      resSink = new BodySink(cfg, traceRelativePath(traceId, 'res', startedAt));
    } catch (err) {
      console.error('[kuncen-proxy] trace start failed:', err);
      traceId = null;
      reqSink = null;
      resSink = null;
    }
  }

  let traceClosed = false;
  const closeTrace = (fields: { status?: number | null; outcome: TraceOutcome; usage?: Usage }) => {
    if (traceClosed || traceId === null) return;
    traceClosed = true;
    try {
      finishTrace(db, traceId, {
        model: extractModel(reqSink?.head ?? ''),
        effort: extractEffort(reqSink?.head ?? ''),
        streamed: extractStreamFlag(reqSink?.head ?? ''),
        status: fields.status ?? null,
        outcome: fields.outcome,
        promptTokens: fields.usage?.promptTokens ?? 0,
        completionTokens: fields.usage?.completionTokens ?? 0,
        requestBytes: reqSink?.bytes ?? 0,
        responseBytes: resSink?.bytes ?? 0,
        requestFile: reqSink?.storedPath ?? null,
        responseFile: resSink?.storedPath ?? null,
        truncated: Boolean(reqSink?.truncated || resSink?.truncated),
      });
    } catch (err) {
      console.error('[kuncen-proxy] trace finish failed:', err);
    }
  };

  let settled = false;
  const settle = (usage: Parameters<typeof endInFlight>[2] = {}) => {
    if (settled || !handle) return;
    settled = true;
    endInFlight(db, handle, usage);
  };

  const controller = new AbortController();
  const unregister = counted ? registry.add(controller) : () => {};

  // A client that walks away must not leave vLLM generating.
  const outgoing = (c.env as { outgoing?: NodeResponseLike } | undefined)?.outgoing;
  if (outgoing?.once) {
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) controller.abort(new KuncenAbort('client disconnected'));
    });
  }
  c.req.raw.signal?.addEventListener('abort', () => {
    controller.abort(new KuncenAbort('client disconnected'));
  });

  const url = new URL(c.req.url);
  const target = opts.upstream.replace(/\/$/, '') + url.pathname + url.search;

  const headers = new Headers();
  for (const [k, v] of c.req.raw.headers) {
    if (!STRIP_REQUEST.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set('accept-encoding', 'identity');
  if (opts.upstreamApiKey) headers.set('authorization', `Bearer ${opts.upstreamApiKey}`);

  const method = c.req.method;
  let body = method === 'GET' || method === 'HEAD' ? undefined : c.req.raw.body;

  // Split the upload: one branch goes upstream, the other to disk. The disk
  // branch is drained detached — the client waits on the model, never on us.
  if (body && reqSink) {
    try {
      const [toUpstream, toDisk] = body.tee();
      body = toUpstream;
      void drainToSink(toDisk, reqSink);
    } catch (err) {
      console.error('[kuncen-proxy] request tee failed:', err);
    }
  }

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
      // @ts-expect-error -- undici streaming-request-body option, not in lib.dom
      duplex: 'half',
    });

    const outHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders.set(k, v);
    }

    if (!upstream.body) {
      settle();
      unregister();
      closeTrace({ status: upstream.status, outcome: 'ok' });
      return new Response(null, { status: upstream.status, headers: outHeaders });
    }

    let seen: Usage = {};
    let stream = meteredStream(upstream.body, (usage) => {
      seen = usage;
      settle(usage);
      unregister();
      // With no tap there is nothing left to flush, so close here.
      if (!resSink) closeTrace({ status: upstream.status, outcome: 'ok', usage });
    });

    // Metering first, then the tap: the recorder sees exactly the bytes the
    // client sees, and token counts stay a separate concern from capture. The
    // trace row is written by the *tap*, once the file is closed — closing it
    // from the meter would record a byte count for a file still being flushed.
    if (resSink) {
      const sink = resSink;
      try {
        stream = tappedStream(stream, sink, () => {
          closeTrace({ status: upstream.status, outcome: 'ok', usage: seen });
        });
      } catch (err) {
        console.error('[kuncen-proxy] response tap failed:', err);
        closeTrace({ status: upstream.status, outcome: 'ok', usage: seen });
      }
    }
    return new Response(stream, { status: upstream.status, headers: outHeaders });
  } catch (err) {
    settle();
    unregister();

    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'KuncenAbort');
    closeTrace({ status: null, outcome: aborted ? 'aborted' : 'upstream_error' });
    if (aborted) {
      return c.json(
        {
          error: {
            message:
              'Kuncen: this request was cut short because the lock was released while it was in flight.',
            type: 'kuncen_aborted',
            code: 'kuncen_aborted',
          },
        },
        503,
      );
    }

    /**
     * vLLM is down or hiccuped. The error passes through and the holder keeps
     * the lock — losing your slot because the backend stumbled would be
     * perverse.
     */
    return c.json(
      {
        error: {
          message: `Kuncen: the model backend did not answer (${(err as Error).message}). Your lock is unaffected.`,
          type: 'kuncen_upstream_error',
          code: 'kuncen_upstream_error',
        },
      },
      502,
    );
  }
}

interface NodeResponseLike {
  once?: (event: string, cb: () => void) => void;
  writableFinished?: boolean;
}
