import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { Hono } from 'hono';
import {
  createUser,
  openDb,
  readLock,
  recentEvents,
  requestAccess,
  getConfig,
  makeResourceLabel,
  tick,
  type Db,
} from '@kuncen/core';
import { createWebApp } from '../src/app';

const BASE = 'http://kuncen.test';

interface Session {
  cookie: string;
  csrf: string;
}

/** Signs in the way a browser does and keeps the cookie + CSRF token. */
async function signIn(app: Hono, email: string, password: string): Promise<Session> {
  const res = await app.request(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(res.status, 302, 'sign-in should redirect to the dashboard');
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0]!;

  const page = await app.request(`${BASE}/`, { headers: { cookie } });
  const html = await page.text();
  const csrf = /<meta name="csrf" content="([^"]+)">/.exec(html)?.[1];
  assert.ok(csrf, 'the dashboard must ship a CSRF token');
  return { cookie, csrf };
}

const action = (app: Hono, path: string, s: Session) =>
  app.request(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, accept: 'application/json' },
  });

interface Notice {
  id: number;
  type: string;
  actorName: string | null;
  detail: { queue_length?: number } | null;
}

/** One turn of what a dashboard tab does every 2s. */
async function poll(
  app: Hono,
  s: Session,
  since: number,
): Promise<{ notices: Notice[]; state: { lastEventId: number; me: { position: number | null } } }> {
  const res = await app.request(`${BASE}/api/state?since=${since}`, {
    headers: { cookie: s.cookie, accept: 'application/json' },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { notices: Notice[]; state: { lastEventId: number; me: { position: number | null } } };
}

describe('kuncen-web', () => {
  let db: Db;
  let app: Hono;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    const handle = openDb(':memory:');
    db = handle.db;
    alice = createUser(db, { email: 'alice@example.test', name: 'Alice', password: 'password123' }).user.id;
    bob = createUser(db, { email: 'bob@example.test', name: 'Bob', password: 'password123' }).user.id;
    createUser(db, { email: 'root@example.test', name: 'Root', password: 'password123', role: 'admin' });
    app = createWebApp({ db, proxyUrl: 'http://spark:8080' }) as unknown as Hono;
  });

  describe('access control', () => {
    it('sends anonymous visitors to the login page', async () => {
      const res = await app.request(`${BASE}/`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login');
    });

    it('answers 401 to an unauthenticated API poll rather than redirecting it', async () => {
      const res = await app.request(`${BASE}/api/state`, { headers: { accept: 'application/json' } });
      assert.equal(res.status, 401);
    });

    it('rejects a wrong password without saying which half was wrong', async () => {
      const res = await app.request(`${BASE}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'alice@example.test', password: 'nope' }),
      });
      assert.equal(res.status, 401);
      const html = await res.text();
      assert.match(html, /Wrong email or password/);

      const unknown = await app.request(`${BASE}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'nobody@example.test', password: 'nope' }),
      });
      assert.equal(unknown.status, 401);
      assert.match(await unknown.text(), /Wrong email or password/);
    });

    it('refuses a state-changing POST without the CSRF token', async () => {
      const s = await signIn(app, 'alice@example.test', 'password123');
      const res = await app.request(`${BASE}/request`, {
        method: 'POST',
        headers: { cookie: s.cookie, accept: 'application/json' },
      });
      assert.equal(res.status, 403);
      assert.equal(readLock(db).status, 'FREE');
    });

    it('keeps non-admins out of the admin page', async () => {
      const s = await signIn(app, 'alice@example.test', 'password123');
      const res = await app.request(`${BASE}/admin`, { headers: { cookie: s.cookie } });
      assert.equal(res.status, 403);
    });

    it('has no self-service registration route at all', async () => {
      for (const path of ['/register', '/signup']) {
        const res = await app.request(`${BASE}${path}`);
        assert.notEqual(res.status, 200);
      }
    });
  });

  describe('brand assets', () => {
    it('serves the logo and favicon without a login', async () => {
      for (const name of ['kuncen_logo_white.png', 'kuncen_favicon.png']) {
        const res = await app.request(`${BASE}/static/${name}`);
        assert.equal(res.status, 200, name);
        assert.equal(res.headers.get('content-type'), 'image/png');
        const bytes = new Uint8Array(await res.arrayBuffer());
        assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a real PNG');
      }
    });

    it('still serves the generated stylesheet and script from their own routes', async () => {
      const css = await app.request(`${BASE}/static/style.css`);
      assert.match(css.headers.get('content-type') ?? '', /text\/css/);
      assert.match(await css.text(), /--accent: #d4af8a/, 'brand gold is in the palette');

      const js = await app.request(`${BASE}/static/app.js`);
      assert.match(js.headers.get('content-type') ?? '', /javascript/);
    });

    it('serves nothing but images from that directory', async () => {
      // The route parameter cannot contain a slash and the name is whitelisted,
      // so traversal never reaches the filesystem. `..` normalises away to `/`
      // and lands on the auth redirect, which is equally harmless.
      for (const name of ['..%2F..%2F.env', '..', 'kuncen_philosophy.md', '.env', 'nope.png']) {
        const res = await app.request(`${BASE}/static/${name}`);
        assert.notEqual(res.status, 200, `${name} must not be served`);
      }
    });
  });

  describe('requesting and releasing', () => {
    it('names the guarded resource from configuration, not a hardcoded string', async () => {
      const custom = createWebApp({
        db,
        proxyUrl: 'http://host:8080',
        resource: makeResourceLabel('Build Server 3', ''),
      }) as unknown as Hono;

      const login = await custom.request(`${BASE}/login`);
      assert.match(await login.text(), /Exclusive access to Build Server 3\./);
      assert.doesNotMatch(await (await custom.request(`${BASE}/login`)).text(), /Spark/);

      const s = await signIn(custom, 'alice@example.test', 'password123');
      const dash = await (await custom.request(`${BASE}/`, { headers: { cookie: s.cookie } })).text();
      assert.match(dash, /data-resource-the="Build Server 3"/);
      assert.match(dash, /data-resource-the-cap="Build Server 3"/);

      const acquired = (await (await action(custom, '/request', s)).json()) as { message: string };
      assert.equal(acquired.message, 'Build Server 3 is yours.');
    });

    it('acquires a free lock on the first click', async () => {
      const s = await signIn(app, 'alice@example.test', 'password123');
      const res = await action(app, '/request', s);
      const body = (await res.json()) as { outcome: string; state: { me: { holding: boolean } } };

      assert.equal(body.outcome, 'acquired');
      assert.equal(body.state.me.holding, true);
      assert.equal(readLock(db).holderId, alice);
    });

    it('keeps your position when you double-click', async () => {
      requestAccess(db, alice);
      const s = await signIn(app, 'bob@example.test', 'password123');

      const first = (await (await action(app, '/request', s)).json()) as { outcome: string; state: { me: { position: number } } };
      const second = (await (await action(app, '/request', s)).json()) as { outcome: string; state: { me: { position: number } } };

      assert.equal(first.outcome, 'queued');
      assert.equal(second.outcome, 'already_queued');
      assert.equal(second.state.me.position, 1);
    });

    it('leaves the queue on cancel', async () => {
      requestAccess(db, alice);
      const s = await signIn(app, 'bob@example.test', 'password123');
      await action(app, '/request', s);
      const res = await action(app, '/cancel', s);
      const body = (await res.json()) as { state: { me: { position: number | null } } };
      assert.equal(body.state.me.position, null);
    });

    it('drains rather than freeing on release', async () => {
      const s = await signIn(app, 'alice@example.test', 'password123');
      await action(app, '/request', s);
      await action(app, '/release', s);
      assert.equal(readLock(db).status, 'DRAINING');
      assert.equal(readLock(db).drainReason, 'manual');
    });
  });

  describe('state polling', () => {
    it('reports lock state, queue and backend health separately', async () => {
      requestAccess(db, alice);
      const s = await signIn(app, 'bob@example.test', 'password123');
      await action(app, '/request', s);

      const res = await app.request(`${BASE}/api/state?since=0`, {
        headers: { cookie: s.cookie, accept: 'application/json' },
      });
      const body = (await res.json()) as {
        state: {
          status: string;
          holder: { name: string };
          queue: Array<{ userName: string; position: number }>;
          health: { proxyAlive: boolean; upstreamOk: boolean | null };
          me: { position: number };
        };
        notices: Array<{ type: string }>;
      };

      assert.equal(body.state.status, 'HELD');
      assert.equal(body.state.holder.name, 'Alice');
      assert.equal(body.state.queue[0]?.userName, 'Bob');
      assert.equal(body.state.me.position, 1);
      assert.equal(body.state.health.proxyAlive, false, 'no proxy heartbeat in this test');
      assert.equal(body.state.health.upstreamOk, null);
    });

    it('hands a tab only the notices it has not already fired', async () => {
      const s = await signIn(app, 'alice@example.test', 'password123');
      await action(app, '/request', s);

      const fresh = await app.request(`${BASE}/api/state?since=0`, {
        headers: { cookie: s.cookie, accept: 'application/json' },
      });
      const first = (await fresh.json()) as { notices: Array<{ type: string; id: number }>; state: { lastEventId: number } };
      assert.ok(first.notices.some((n) => n.type === 'granted'));

      const again = await app.request(`${BASE}/api/state?since=${first.state.lastEventId}`, {
        headers: { cookie: s.cookie, accept: 'application/json' },
      });
      const second = (await again.json()) as { notices: unknown[] };
      assert.equal(second.notices.length, 0, 'a notification must not fire twice');
    });

    it('tells the holder — and only the holder — that someone wants the lock', async () => {
      const a = await signIn(app, 'alice@example.test', 'password123');
      await action(app, '/request', a);
      const b = await signIn(app, 'bob@example.test', 'password123');
      await action(app, '/request', b);

      const hers = await poll(app, a, 0);
      const notice = hers.notices.find((n) => n.type === 'access_requested');
      assert.ok(notice, 'the holder is told');
      assert.equal(notice.actorName, 'Bob', 'and told who is asking');
      assert.equal(notice.detail?.queue_length, 1);

      // The proof that this is addressed rather than broadcast: the requester
      // does not get his own request read back to him.
      const his = await poll(app, b, 0);
      assert.ok(
        !his.notices.some((n) => n.type === 'access_requested'),
        'a notice addressed to Alice must not reach Bob',
      );
    });

    it('tells someone their queue entry timed out instead of dropping it silently', async () => {
      const a = await signIn(app, 'alice@example.test', 'password123');
      await action(app, '/request', a);
      const b = await signIn(app, 'bob@example.test', 'password123');
      await action(app, '/request', b);

      // Never sleep to reach a deadline — tick() takes the time.
      const ttl = getConfig(db).queue_entry_ttl_seconds * 1000;
      tick(db, Date.now() + ttl + 1000);

      const his = await poll(app, b, 0);
      assert.ok(
        his.notices.some((n) => n.type === 'expired'),
        'losing your place must produce a signal',
      );
      assert.equal(his.state.me.position, null, 'and he really is out of the queue');
    });
  });

  describe('admin', () => {
    it('requires a reason to force-release', async () => {
      requestAccess(db, alice);
      const s = await signIn(app, 'root@example.test', 'password123');

      const res = await app.request(`${BASE}/admin/force-release`, {
        method: 'POST',
        headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: s.csrf, reason: '   ' }),
      });
      assert.equal(res.status, 400);
      assert.equal(readLock(db).status, 'HELD');
    });

    it('records the actor and reason, and shows it on the dashboard', async () => {
      requestAccess(db, alice);
      const s = await signIn(app, 'root@example.test', 'password123');

      const res = await app.request(`${BASE}/admin/force-release`, {
        method: 'POST',
        headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: s.csrf, reason: 'urgent demo' }),
      });
      assert.equal(res.status, 200);
      assert.equal(readLock(db).status, 'DRAINING');

      const [event] = recentEvents(db, 1, ['force_release']);
      assert.equal(event?.detail?.note, 'urgent demo');
      assert.equal(event?.userName, 'Alice');
      assert.equal(event?.actorName, 'Root');

      const state = await app.request(`${BASE}/api/state?since=0`, {
        headers: { cookie: s.cookie, accept: 'application/json' },
      });
      const body = (await state.json()) as { state: { overrides: Array<{ actorName: string }> } };
      assert.equal(body.state.overrides[0]?.actorName, 'Root', 'overrides are visible to everyone');
    });

    it('offers no way to reorder the queue or hand the lock to a named person', async () => {
      requestAccess(db, alice);
      requestAccess(db, bob);
      const s = await signIn(app, 'root@example.test', 'password123');
      const html = await (await app.request(`${BASE}/admin`, { headers: { cookie: s.cookie } })).text();

      // "Admin gives the lock to whoever asks loudest" turns a mechanical system
      // into a political one, so the controls simply do not exist.
      const actions = new Set([...html.matchAll(/action="([^"]+)"/g)].map((m) => m[1]));
      assert.deepEqual(
        [...actions].sort(),
        ['/admin/config', '/admin/force-release', '/admin/users', `/admin/users/${alice}/password`, `/admin/users/${alice}/role`, `/admin/users/${bob}/password`, `/admin/users/${bob}/role`, '/admin/users/3/password', '/admin/users/3/role', '/logout'].sort(),
      );
    });

    it('edits the timers at runtime', async () => {
      const s = await signIn(app, 'root@example.test', 'password123');
      const res = await app.request(`${BASE}/admin/config`, {
        method: 'POST',
        headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: s.csrf, idle_timeout_seconds: '600' }),
      });
      assert.equal(res.status, 200);
      assert.equal(getConfig(db).idle_timeout_seconds, 600);
    });

    it('clamps a nonsensical timer instead of accepting it', async () => {
      const s = await signIn(app, 'root@example.test', 'password123');
      await app.request(`${BASE}/admin/config`, {
        method: 'POST',
        headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: s.csrf, idle_timeout_seconds: '0' }),
      });
      assert.equal(getConfig(db).idle_timeout_seconds, 30, 'a zero idle timeout would be a footgun');
    });

    it('creates accounts and shows the credentials exactly once', async () => {
      const s = await signIn(app, 'root@example.test', 'password123');
      const res = await app.request(`${BASE}/admin/users`, {
        method: 'POST',
        headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: s.csrf, email: 'dan@example.test', name: 'Dan' }),
      });
      const html = await res.text();
      assert.match(html, /api key: kuncen_/);
      assert.match(html, /password: /);

      const listing = await (await app.request(`${BASE}/admin`, { headers: { cookie: s.cookie } })).text();
      assert.doesNotMatch(listing, /api key: kuncen_/, 'the key is never shown again');
    });
  });

  describe('profile', () => {
    it('rotates the API key and shows it once', async () => {
      const s = await signIn(app, 'bob@example.test', 'password123');
      const res = await app.request(`${BASE}/profile/key`, {
        method: 'POST',
        headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: s.csrf }),
      });
      const html = await res.text();
      // Length-bounded: the page also references /static/kuncen_favicon.png.
      const key = /kuncen_[A-Za-z0-9_-]{30,}/.exec(html)?.[0];
      assert.ok(key);

      const again = await (await app.request(`${BASE}/profile`, { headers: { cookie: s.cookie } })).text();
      assert.doesNotMatch(again, new RegExp(key.replace(/[-]/g, '\\-')), 'only the hash is stored');
      assert.equal(bob, bob);
    });

    it('refuses a password change without the current password', async () => {
      const s = await signIn(app, 'bob@example.test', 'password123');
      const res = await app.request(`${BASE}/profile/password`, {
        method: 'POST',
        headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: s.csrf, current: 'wrong', next: 'newpassword123' }),
      });
      assert.equal(res.status, 400);
    });
  });
});
