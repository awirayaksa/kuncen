import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  CONFIG_KEYS,
  SESSION_COOKIE,
  betSummary,
  cancelRequest,
  createAuthSession,
  createUser,
  csrfToken,
  csrfValid,
  destroyAllAuthSessions,
  destroyAuthSession,
  eventsForUserSince,
  forceRelease,
  getConfig,
  listUsers,
  listTraces,
  mayReadTrace,
  parseRequestTranscript,
  parseResponseTranscript,
  pruneAuthSessions,
  recentSessions,
  releaseLock,
  requestAccess,
  resourceLabel,
  revokeApiKey,
  rotateApiKey,
  serverSecret,
  setConfig,
  setPassword,
  setRole,
  traceById,
  traceConfig,
  readTraceBody,
  userByAuthSession,
  userByEmail,
  userById,
  verifyPassword,
  type ConfigKey,
  type Db,
  type ResourceLabel,
  type TraceConfig,
  type User,
} from '@kuncen/core';
import { APP_JS, STYLESHEET } from './assets';
import { publicFile } from './static';
import { dashboardState } from './state';
import { adminPage, dashboardPage, loginPage, profilePage, tracePage, tracesPage } from './views';

export interface WebOptions {
  db: Db;
  /** What is being guarded. Defaults to the value in the environment. */
  resource?: ResourceLabel;
  /** Shown on the profile page so people can copy a working base URL. */
  proxyUrl: string;
  secureCookies?: boolean;
  /** Where recorded bodies live. Defaults to the environment (off). */
  trace?: TraceConfig;
}

type Env = { Variables: { user: User; csrf: string; sessionToken: string } };

/**
 * Event types a browser tab turns into a notification. Every one of these is
 * addressed to the person who should see it (`events.user_id`), so adding a type
 * here is only half the job — the event has to be filed under its recipient.
 */
const NOTICE_TYPES = [
  'granted',
  'expiry_warning',
  'force_release',
  'access_requested',
  'expired',
] as const;

export function createWebApp(opts: WebOptions): Hono<Env> {
  const { db } = opts;
  const app = new Hono<Env>();
  const secret = serverSecret(db);
  const resource = opts.resource ?? resourceLabel();
  // Read once. kuncen-web only ever *reads* traces — the proxy writes them — but
  // it needs the same directory and the same on/off answer.
  const trace = opts.trace ?? traceConfig();
  const tracing = trace.mode === 'full';

  app.get('/static/style.css', (c) => {
    c.header('content-type', 'text/css; charset=utf-8');
    c.header('cache-control', 'no-cache');
    return c.body(STYLESHEET);
  });

  app.get('/static/app.js', (c) => {
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'no-cache');
    return c.body(APP_JS);
  });

  // Brand assets from services/web/public. Registered after the two generated
  // routes above so `style.css` and `app.js` keep winning.
  app.get('/static/:name', (c) => {
    const file = publicFile(c.req.param('name'));
    if (!file) return c.notFound();
    return new Response(file.body, {
      headers: { 'content-type': file.type, 'cache-control': 'public, max-age=3600' },
    });
  });

  app.get('/healthz', (c) => c.json({ ok: true, service: 'kuncen-web' }));

  // ---------------------------------------------------------------- login

  app.get('/login', (c) => {
    const user = userByAuthSession(db, getCookie(c, SESSION_COOKIE));
    if (user) return c.redirect('/');
    return c.html(loginPage({ resource }));
  });

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');
    const user = userByEmail(db, email);

    // Same message and roughly the same work either way: an unknown address
    // should not be distinguishable from a wrong password.
    const ok = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, DUMMY_HASH);
    if (!user || !ok) {
      return c.html(loginPage({ resource, error: 'Wrong email or password.', email }), 401);
    }

    pruneAuthSessions(db);
    const token = createAuthSession(db, user.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
      secure: opts.secureCookies ?? false,
    });
    return c.redirect('/');
  });

  app.post('/logout', (c) => {
    destroyAuthSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  // ---------------------------------------------------------------- auth + csrf

  app.use('*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = userByAuthSession(db, token);
    if (!user || !token) {
      if (wantsJson(c)) return c.json({ error: 'not signed in' }, 401);
      return c.redirect('/login');
    }
    c.set('user', user);
    c.set('sessionToken', token);
    c.set('csrf', csrfToken(secret, token));

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const given = c.req.header('x-csrf-token') ?? (await formValue(c, 'csrf'));
      if (!csrfValid(secret, token, given)) {
        return wantsJson(c)
          ? c.json({ error: 'stale form — reload the page' }, 403)
          : c.text('Stale form. Reload the page and try again.', 403);
      }
    }
    await next();
    return undefined;
  });

  // ---------------------------------------------------------------- dashboard

  app.get('/', (c) =>
    c.html(
      dashboardPage({
        user: c.get('user'),
        csrf: c.get('csrf'),
        state: dashboardState(db, c.get('user'), tracing),
        resource,
      }),
    ),
  );

  /**
   * Polled every 2s. At four people this is far less code than SSE and the load
   * is a rounding error. `since` lets a tab pick up only the notifications it
   * has not already fired.
   */
  app.get('/api/state', (c) => {
    const user = c.get('user');
    const state = dashboardState(db, user, tracing);
    const sinceRaw = Number(c.req.query('since') ?? state.lastEventId);
    const since = Number.isFinite(sinceRaw) ? sinceRaw : state.lastEventId;
    const notices = eventsForUserSince(db, user.id, since, [...NOTICE_TYPES]);
    return c.json({ state, notices });
  });

  app.post('/request', (c) => {
    const user = c.get('user');
    const result = requestAccess(db, user.id);
    const message =
      result.outcome === 'acquired'
        ? `${resource.The} is yours.`
        : result.outcome === 'already_holding'
          ? 'You already hold the lock.'
          : result.outcome === 'already_queued'
            ? `Already in the queue at #${result.position}.`
            : `Queued at #${result.position}.`;
    return c.json({ ok: true, outcome: result.outcome, message, state: dashboardState(db, user, tracing) });
  });

  app.post('/cancel', (c) => {
    const user = c.get('user');
    const left = cancelRequest(db, user.id);
    return c.json({
      ok: true,
      message: left ? 'Left the queue.' : 'You were not in the queue.',
      state: dashboardState(db, user, tracing),
    });
  });

  app.post('/release', (c) => {
    const user = c.get('user');
    const released = releaseLock(db, user.id);
    return c.json({
      ok: true,
      message: released
        ? 'Releasing — in-flight requests get up to 120s to finish.'
        : 'You are not holding the lock.',
      state: dashboardState(db, user, tracing),
    });
  });

  // ---------------------------------------------------------------- traces

  /**
   * Recorded request and response bodies. Every route here goes through
   * `mayReadTrace` before it serves a byte — authors see their own, admins see
   * everyone's. That check is the only thing between a debugging aid and a way
   * to read a colleague's prompts, so it is never skipped and never inlined.
   */
  const PAGE = 50;

  app.get('/traces', (c) => {
    const user = c.get('user');
    const wanted = Number(c.req.query('user'));
    // Only an admin may look at anyone else. A non-admin passing ?user= is
    // silently shown their own, not an error page telling them the URL works.
    const subjectId = user.role === 'admin' && Number.isInteger(wanted) && wanted > 0 ? wanted : user.id;
    const subject = subjectId === user.id ? null : (userById(db, subjectId) ?? null);
    if (subjectId !== user.id && !subject) return c.redirect('/traces');

    const beforeRaw = Number(c.req.query('before'));
    const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
    const traces = listTraces(db, { userId: subjectId, limit: PAGE + 1, before });
    const page = traces.slice(0, PAGE);

    return c.html(
      tracesPage({
        user,
        csrf: c.get('csrf'),
        traces: page,
        subject: subject ? { id: subject.id, name: subject.name } : null,
        everyone: user.role === 'admin' ? listUsers(db).map((u) => ({ id: u.id, name: u.name })) : [],
        tracing: trace.mode === 'full',
        nextBefore: traces.length > PAGE ? (page[page.length - 1]?.id ?? null) : null,
      }),
    );
  });

  app.get('/traces/:id', (c) => {
    const user = c.get('user');
    const found = traceById(db, Number(c.req.param('id')));
    if (!found || !mayReadTrace(found, user)) return c.notFound();

    const request = readTraceBody(trace, found.requestFile);
    const response = readTraceBody(trace, found.responseFile);
    return c.html(
      tracePage({
        user,
        csrf: c.get('csrf'),
        trace: found,
        request,
        response,
        requestTranscript: parseRequestTranscript(request?.text ?? ''),
        responseTranscript: parseResponseTranscript(response?.text ?? ''),
      }),
    );
  });

  /** The bytes as recorded, for when the transcript view is not enough. */
  app.get('/traces/:id/raw', (c) => {
    const user = c.get('user');
    const found = traceById(db, Number(c.req.param('id')));
    if (!found || !mayReadTrace(found, user)) return c.notFound();

    const side = c.req.query('side') === 'request' ? 'request' : 'response';
    const body = readTraceBody(trace, side === 'request' ? found.requestFile : found.responseFile);
    if (!body) return c.text('Not recorded.', 404);
    // text/plain, never text/html: this is somebody's prompt, and the browser
    // must not be talked into executing any of it.
    return c.text(body.text, 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  // ---------------------------------------------------------------- profile

  app.get('/profile', (c) =>
    c.html(profilePage({ user: c.get('user'), csrf: c.get('csrf'), proxyUrl: opts.proxyUrl })),
  );

  app.post('/profile/key', async (c) => {
    const user = c.get('user');
    const body = await c.req.parseBody();
    if (body.revoke) {
      revokeApiKey(db, user.id);
      return c.html(
        profilePage({
          user: userById(db, user.id)!,
          csrf: c.get('csrf'),
          proxyUrl: opts.proxyUrl,
          message: 'Key revoked. Tools using it will get 401 until you generate a new one.',
        }),
      );
    }
    const key = rotateApiKey(db, user.id);
    return c.html(
      profilePage({
        user: userById(db, user.id)!,
        csrf: c.get('csrf'),
        proxyUrl: opts.proxyUrl,
        newKey: key.key,
        message: 'New key generated. The old one stopped working immediately.',
      }),
    );
  });

  app.post('/profile/password', async (c) => {
    const user = c.get('user');
    const body = await c.req.parseBody();
    const current = String(body.current ?? '');
    const next = String(body.next ?? '');
    if (!verifyPassword(current, user.passwordHash)) {
      return c.html(
        profilePage({ user, csrf: c.get('csrf'), proxyUrl: opts.proxyUrl, error: 'Current password is wrong.' }),
        400,
      );
    }
    try {
      setPassword(db, user.id, next);
    } catch (err) {
      return c.html(
        profilePage({ user, csrf: c.get('csrf'), proxyUrl: opts.proxyUrl, error: (err as Error).message }),
        400,
      );
    }
    // Other sessions die with the old password; this one is re-established.
    destroyAllAuthSessions(db, user.id);
    const token = createAuthSession(db, user.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
      secure: opts.secureCookies ?? false,
    });
    return c.html(
      profilePage({
        user: userById(db, user.id)!,
        csrf: csrfToken(secret, token),
        proxyUrl: opts.proxyUrl,
        message: 'Password changed. Other sessions were signed out.',
      }),
    );
  });

  // ---------------------------------------------------------------- admin

  const admin = new Hono<Env>();

  admin.use('*', async (c, next) => {
    if (c.get('user').role !== 'admin') return c.text('Not an admin.', 403);
    await next();
    return undefined;
  });

  const renderAdmin = (
    c: Context<Env>,
    extra: Partial<Parameters<typeof adminPage>[0]> = {},
  ) => {
    const user = c.get('user');
    return adminPage({
      user,
      csrf: c.get('csrf'),
      users: listUsers(db),
      state: dashboardState(db, user, tracing),
      sessions: recentSessions(db, 25),
      bet: betSummary(db, 14),
      config: getConfig(db) as unknown as Record<string, number>,
      ...extra,
    });
  };

  admin.get('/', (c) => c.html(renderAdmin(c)));

  admin.post('/force-release', async (c) => {
    const body = await c.req.parseBody();
    const reason = String(body.reason ?? '').trim();
    if (!reason) return c.html(renderAdmin(c, { error: 'A reason is required.' }), 400);
    try {
      const done = forceRelease(db, c.get('user').id, reason);
      return c.html(
        renderAdmin(c, {
          message: done ? 'Force-released. Draining now.' : 'Nobody was holding the lock.',
        }),
      );
    } catch (err) {
      return c.html(renderAdmin(c, { error: (err as Error).message }), 400);
    }
  });

  admin.post('/users', async (c) => {
    const body = await c.req.parseBody();
    const password = String(body.password ?? '').trim() || randomBytes(9).toString('base64url');
    try {
      const { user, apiKey } = createUser(db, {
        email: String(body.email ?? ''),
        name: String(body.name ?? ''),
        password,
        role: body.role === 'admin' ? 'admin' : 'user',
      });
      return c.html(
        renderAdmin(c, {
          message: `Created ${user.email}.`,
          newAccount: { email: user.email, password, apiKey: apiKey.key },
        }),
      );
    } catch (err) {
      const msg = (err as Error).message.includes('UNIQUE')
        ? 'That email already has an account.'
        : (err as Error).message;
      return c.html(renderAdmin(c, { error: msg }), 400);
    }
  });

  admin.post('/users/:id/role', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.parseBody();
    const role = body.role === 'admin' ? 'admin' : 'user';
    const target = userById(db, id);
    if (!target) return c.html(renderAdmin(c, { error: 'No such user.' }), 404);
    if (target.id === c.get('user').id && role === 'user') {
      return c.html(renderAdmin(c, { error: 'Demoting yourself would lock you out of this page.' }), 400);
    }
    setRole(db, id, role);
    return c.html(renderAdmin(c, { message: `${target.name} is now ${role}.` }));
  });

  admin.post('/users/:id/password', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.parseBody();
    const password = String(body.password ?? '');
    const target = userById(db, id);
    if (!target) return c.html(renderAdmin(c, { error: 'No such user.' }), 404);
    try {
      setPassword(db, id, password);
    } catch (err) {
      return c.html(renderAdmin(c, { error: (err as Error).message }), 400);
    }
    destroyAllAuthSessions(db, id);
    return c.html(renderAdmin(c, { message: `Password reset for ${target.name}.` }));
  });

  admin.post('/config', async (c) => {
    const body = await c.req.parseBody();
    const changed: string[] = [];
    for (const key of CONFIG_KEYS) {
      const raw = body[key];
      if (raw === undefined) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      setConfig(db, key as ConfigKey, n);
      changed.push(key);
    }
    return c.html(
      renderAdmin(c, {
        message: changed.length ? `Saved: ${changed.join(', ')}. Live on the next sweeper tick.` : 'Nothing changed.',
      }),
    );
  });

  app.route('/admin', admin);

  return app;
}

function wantsJson(c: Context): boolean {
  return (
    c.req.header('accept')?.includes('application/json') === true ||
    c.req.path.startsWith('/api/') ||
    c.req.header('x-csrf-token') !== undefined
  );
}

async function formValue(c: Context, name: string): Promise<string | undefined> {
  const type = c.req.header('content-type') ?? '';
  if (!type.includes('form')) return undefined;
  try {
    const body = await c.req.parseBody();
    const value = body[name];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Constant-ish work for unknown accounts. Never matches anything. */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
