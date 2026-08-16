import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
  fmtDuration,
  type BetSummary,
  type ResourceLabel,
  type SessionSummary,
  type TraceBody,
  type Transcript,
  type TraceView,
  type User,
} from '@kuncen/core';
import { embedJson, type DashboardState } from './state';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/**
 * The reversed (white) mark, per the brand guidelines for dark backgrounds.
 * Decorative here — the wordmark beside it already carries the name — so the
 * alt text is empty rather than a redundant announcement.
 */
function logoMark(size?: 'lg') {
  return html`<span class="logo${size ? ' lg' : ''}"
    ><img src="/static/kuncen_logo_white.png" alt="" width="601" height="331"
  /></span>`;
}

export interface LayoutOptions {
  title: string;
  user?: User;
  csrf?: string;
  bodyAttrs?: Record<string, string>;
  head?: Html;
}

export function layout(opts: LayoutOptions, body: Html) {
  const attrs = Object.entries(opts.bodyAttrs ?? {})
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(' ');
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Kuncen</title>
${opts.csrf ? raw(`<meta name="csrf" content="${escapeAttr(opts.csrf)}">`) : ''}
<link rel="icon" type="image/png" href="/static/kuncen_favicon.png">
<link rel="stylesheet" href="/static/style.css">
${opts.head ?? ''}
</head>
<body ${raw(attrs)}>
${opts.user
    ? html`<header>
  <a class="brand" href="/">
    ${logoMark()}
    <span class="brand-text">
      <span class="wordmark">KUNCEN</span>
      <span class="tagline">Exclusive Access Control</span>
    </span>
  </a>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/traces">Traces</a>
    <a href="/profile">Profile</a>
    ${opts.user.role === 'admin' ? html`<a href="/admin">Admin</a>` : ''}
    <span class="who">${opts.user.name}</span>
    <form method="post" action="/logout" style="display:inline">
      <input type="hidden" name="csrf" value="${opts.csrf ?? ''}">
      <button class="small" style="padding:4px 10px">Sign out</button>
    </form>
  </nav>
</header>`
    : ''}
<main>${body}</main>
</body>
</html>`;
}

export function loginPage(opts: { resource: ResourceLabel; error?: string; email?: string }) {
  return layout(
    { title: 'Sign in' },
    html`<div class="login">
  <div class="login-brand">
    ${logoMark('lg')}
    <span class="brand-text">
      <span class="wordmark" style="font-size:24px">KUNCEN</span>
      <span class="tagline">Exclusive Access Control</span>
    </span>
  </div>
  <p class="muted small" style="margin-top:0">Exclusive access to ${opts.resource.the}.</p>
  ${opts.error ? html`<div class="banner bad">${opts.error}</div>` : ''}
  <form method="post" action="/login" class="panel">
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required style="width:100%" value="${opts.email ?? ''}">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required style="width:100%">
    </div>
    <button class="primary" style="width:100%">Sign in</button>
  </form>
  <p class="notice">Accounts are created by an admin. Ask one of them if you need access.</p>
</div>`,
  );
}

export function dashboardPage(opts: {
  user: User;
  csrf: string;
  state: DashboardState;
  resource: ResourceLabel;
}) {
  const s = opts.state;
  return layout(
    {
      title: 'Dashboard',
      user: opts.user,
      csrf: opts.csrf,
      // The live headlines are built in the browser, so the label has to travel
      // with the page rather than being baked into the shared script.
      bodyAttrs: {
        'data-me': String(opts.user.id),
        'data-last-event': String(s.lastEventId),
        'data-resource': opts.resource.name,
        'data-resource-the': opts.resource.the,
        'data-resource-the-cap': opts.resource.The,
      },
      head: html`<script defer src="/static/app.js"></script>`,
    },
    html`
<div id="flash" class="banner" hidden></div>
<div id="stale" class="banner warn" hidden>Lost contact with kuncen-web — this page may be out of date.</div>
${s.tracing
      ? html`<div class="banner warn">Request tracing is <strong>on</strong>: every prompt and reply through the proxy
  is being recorded. <a href="/traces">See yours</a>.</div>`
      : ''}

<div class="panel">
  <div class="status">
    <span id="dot" class="dot"></span>
    <div class="grow">
      <div id="headline" class="headline">Loading…</div>
      <div id="subline" class="sub"></div>
    </div>
    <div id="health"></div>
  </div>
  <div class="meta">
    <div><div class="k">Held for</div><div id="m-held" class="v">–</div></div>
    <div><div class="k">Idle</div><div id="m-idle" class="v">–</div></div>
    <div><div class="k">In flight</div><div id="m-inflight" class="v">–</div></div>
    <div><div class="k">Waiting</div><div id="m-queue" class="v">–</div></div>
    <div><div class="k">Expires</div><div id="m-expires" class="v">–</div></div>
  </div>
</div>

<div class="panel">
  <div class="spread">
    <div id="you" class="grow"></div>
    <div class="row">
      <button id="btn-request" class="primary" hidden>Request access</button>
      <button id="btn-cancel" hidden>Cancel request</button>
      <button id="btn-release" class="danger" hidden>Release</button>
    </div>
  </div>
  <p class="notice">
    Timers only run while someone is waiting. Having this page open is not usage —
    only requests through the proxy count. There is no way to extend a session.
  </p>
</div>

<h2>Queue</h2>
<div class="panel"><ul id="queue" class="queue"></ul></div>

<div id="overrides-wrap" hidden>
  <h2>Recent force-releases</h2>
  <div class="panel"><ul id="overrides" class="queue"></ul></div>
</div>

<script type="application/json" id="bootstrap">${raw(embedJson(s))}</script>`,
  );
}

export function profilePage(opts: {
  user: User;
  csrf: string;
  newKey?: string;
  message?: string;
  error?: string;
  proxyUrl: string;
}) {
  const u = opts.user;
  return layout(
    { title: 'Profile', user: u, csrf: opts.csrf },
    html`
<h1>Profile</h1>
${opts.message ? html`<div class="banner ok">${opts.message}</div>` : ''}
${opts.error ? html`<div class="banner bad">${opts.error}</div>` : ''}

<div class="panel">
  <div class="spread">
    <div>
      <div><strong>${u.name}</strong></div>
      <div class="muted small">${u.email} · ${u.role}</div>
    </div>
  </div>
</div>

<h2>Proxy API key</h2>
<div class="panel">
  ${opts.newKey
    ? html`<p class="small">Your new key. It is shown <strong>once</strong> — paste it into your tool now.</p>
        <code class="key">${opts.newKey}</code>`
    : html`<p class="small muted">
        Current key: <code>${u.apiKeyPrefix ? `${u.apiKeyPrefix}…` : 'none — generate one'}</code>.
        Only the hash is stored, so it cannot be shown again.
      </p>`}
  <p class="small muted">
    This key says <em>who you are</em>. The lock says <em>whether you may go right now</em>.
    Configure it once and never touch it again.
  </p>
  <pre class="mono" style="background:var(--bg);padding:12px;border-radius:8px;overflow-x:auto">OPENAI_BASE_URL=${opts.proxyUrl}/v1
OPENAI_API_KEY=${opts.newKey ?? 'kuncen_…'}</pre>
  <form method="post" action="/profile/key">
    <input type="hidden" name="csrf" value="${opts.csrf}">
    <button>${u.apiKeyHash ? 'Regenerate key' : 'Generate key'}</button>
    ${u.apiKeyHash
      ? html`<button name="revoke" value="1" class="danger" style="margin-left:8px">Revoke</button>`
      : ''}
  </form>
</div>

<h2>Password</h2>
<div class="panel">
  <form method="post" action="/profile/password">
    <input type="hidden" name="csrf" value="${opts.csrf}">
    <div class="field"><label for="current">Current password</label>
      <input id="current" name="current" type="password" autocomplete="current-password" required></div>
    <div class="field"><label for="next">New password</label>
      <input id="next" name="next" type="password" autocomplete="new-password" minlength="8" required></div>
    <button>Change password</button>
  </form>
</div>`,
  );
}

export function adminPage(opts: {
  user: User;
  csrf: string;
  users: User[];
  state: DashboardState;
  sessions: SessionSummary[];
  bet: BetSummary;
  config: Record<string, number>;
  message?: string;
  error?: string;
  newAccount?: { email: string; password: string; apiKey: string };
}) {
  const s = opts.state;
  return layout(
    { title: 'Admin', user: opts.user, csrf: opts.csrf },
    html`
<h1>Admin</h1>
${opts.message ? html`<div class="banner ok">${opts.message}</div>` : ''}
${opts.error ? html`<div class="banner bad">${opts.error}</div>` : ''}
${opts.newAccount
      ? html`<div class="panel" style="border-color:var(--accent)">
          <strong>Account created — these are shown once.</strong>
          <p class="small muted" style="margin-bottom:6px">${opts.newAccount.email}</p>
          <code class="key">password: ${opts.newAccount.password}</code>
          <code class="key" style="margin-top:8px">api key: ${opts.newAccount.apiKey}</code>
        </div>`
      : ''}

<h2>Override</h2>
<div class="panel">
  <div class="spread" style="margin-bottom:12px">
    <div>
      <div><strong>${s.status}</strong>${s.holder ? html` — held by ${s.holder.name}` : ''}</div>
      <div class="muted small">${s.queueLength} waiting</div>
    </div>
  </div>
  ${s.status === 'HELD'
      ? html`<form method="post" action="/admin/force-release" class="row">
          <input type="hidden" name="csrf" value="${opts.csrf}">
          <input name="reason" placeholder="Reason (required, shown to everyone)" required class="grow" style="min-width:280px">
          <button class="danger">Force-release</button>
        </form>`
      : html`<p class="muted small">Nothing to release.</p>`}
  <p class="notice">
    Force-release enters the normal 120s drain. There is no queue reordering and no
    way to assign the lock to a named person — at four people the queue's fairness
    is the whole value. Every override is logged with your name and this reason and
    shown on the dashboard.
  </p>
</div>

<h2>The bet</h2>
<div class="panel">
  <div class="meta" style="border-top:0;padding-top:0;margin-top:0">
    <div><div class="k">Sessions (${opts.bet.windowDays}d)</div><div class="v">${opts.bet.sessionCount}</div></div>
    <div><div class="k">Queue joins</div><div class="v">${opts.bet.queueEvents}</div></div>
    <div><div class="k">423s</div><div class="v">${opts.bet.rejections}</div></div>
    <div><div class="k">Median wait</div><div class="v">${opts.bet.medianWaitMs === null ? '–' : fmtDuration(opts.bet.medianWaitMs)}</div></div>
    <div><div class="k">Utilization</div><div class="v">${opts.bet.utilization === null ? '–' : `${Math.round(opts.bet.utilization * 100)}%`}</div></div>
  </div>
  <p class="notice">
    Frequent queueing with low utilization is the signal that strict exclusivity is
    costing more than it saves. That is the number this table exists to expose.
  </p>
</div>

<h2>Recent sessions</h2>
<div class="panel" style="overflow-x:auto">
  <table>
    <thead><tr><th>User</th><th>Started</th><th class="num">Held</th><th class="num">Busy</th><th class="num">Reqs</th><th class="num">Tokens</th><th>Ended</th></tr></thead>
    <tbody>
    ${opts.sessions.length === 0
      ? html`<tr><td colspan="7" class="empty">No sessions yet.</td></tr>`
      : opts.sessions.map(
          (row) => html`<tr>
            <td>${row.userName}</td>
            <td class="muted small">${new Date(row.acquiredAt).toLocaleString()}</td>
            <td class="num">${fmtDuration(row.heldMs)}</td>
            <td class="num">${row.utilization === null ? '–' : `${Math.round(row.utilization * 100)}%`}</td>
            <td class="num">${row.requestCount}</td>
            <td class="num">${row.promptTokens + row.completionTokens}</td>
            <td>${row.releaseReason ?? html`<span class="badge">open</span>`}</td>
          </tr>`,
        )}
    </tbody>
  </table>
</div>

<h2>Timers</h2>
<div class="panel">
  <form method="post" action="/admin/config">
    <input type="hidden" name="csrf" value="${opts.csrf}">
    <div class="row">
      ${Object.entries(opts.config).map(
        ([key, value]) => html`<div class="field">
          <label for="cfg-${key}">${key.replace(/_/g, ' ')}</label>
          <input id="cfg-${key}" name="${key}" type="number" min="1" value="${value}" style="width:150px">
        </div>`,
      )}
    </div>
    <button>Save</button>
  </form>
</div>

<h2>Users</h2>
<div class="panel" style="overflow-x:auto">
  <table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Key</th><th></th></tr></thead>
    <tbody>
    ${opts.users.map(
      (u) => html`<tr>
        <td>${u.name}</td>
        <td class="muted">${u.email}</td>
        <td>
          <form method="post" action="/admin/users/${u.id}/role" class="row" style="gap:6px">
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <select name="role">
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>user</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
            </select>
            <button style="padding:6px 10px">Set</button>
          </form>
        </td>
        <td class="mono muted small">${u.apiKeyPrefix ? `${u.apiKeyPrefix}…` : '–'}</td>
        <td>
          <form method="post" action="/admin/users/${u.id}/password" class="row" style="gap:6px">
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <input name="password" type="text" placeholder="new password" minlength="8" style="width:150px">
            <button style="padding:6px 10px">Reset</button>
          </form>
        </td>
      </tr>`,
    )}
    </tbody>
  </table>
</div>

<h2>Create account</h2>
<div class="panel">
  <form method="post" action="/admin/users" class="row" style="align-items:flex-end">
    <input type="hidden" name="csrf" value="${opts.csrf}">
    <div class="field"><label for="new-email">Email</label><input id="new-email" name="email" type="email" required></div>
    <div class="field"><label for="new-name">Name</label><input id="new-name" name="name" required></div>
    <div class="field"><label for="new-password">Password</label><input id="new-password" name="password" placeholder="auto-generate" minlength="8"></div>
    <div class="field"><label for="new-role">Role</label>
      <select id="new-role" name="role"><option value="user">user</option><option value="admin">admin</option></select>
    </div>
    <div class="field"><button class="primary">Create</button></div>
  </form>
  <p class="notice">There is no self-service registration. Four accounts, created by hand.</p>
</div>`,
  );
}

// ---------------------------------------------------------------- traces

const when = (ts: number) => new Date(ts).toLocaleString();

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function outcomeBadge(t: TraceView) {
  if (t.outcome === 'aborted') return html`<span class="badge warn">cut short</span>`;
  if (t.outcome === 'upstream_error') return html`<span class="badge bad">backend error</span>`;
  if (t.status && t.status >= 400) return html`<span class="badge bad">${t.status}</span>`;
  return html`<span class="badge ok">${t.status ?? 'ok'}</span>`;
}

export interface TraceListOptions {
  user: User;
  csrf: string;
  traces: TraceView[];
  /** Set when an admin is looking at somebody else. */
  subject: { id: number; name: string } | null;
  everyone: Array<{ id: number; name: string }>;
  tracing: boolean;
  nextBefore: number | null;
}

export function tracesPage(opts: TraceListOptions) {
  return layout(
    { title: 'Traces', user: opts.user, csrf: opts.csrf },
    html`
<div class="spread">
  <h2 style="margin:0">${opts.subject ? `${opts.subject.name}'s requests` : 'Your requests'}</h2>
  ${opts.user.role === 'admin'
        ? html`<form method="get" action="/traces" class="row" style="gap:6px">
      <select name="user" onchange="this.form.submit()">
        <option value="">Me</option>
        ${opts.everyone.map(
          (u) => html`<option value="${String(u.id)}" ${opts.subject?.id === u.id ? 'selected' : ''}>${u.name}</option>`,
        )}
      </select>
      <noscript><button style="padding:6px 10px">Show</button></noscript>
    </form>`
        : ''}
</div>

${opts.tracing
        ? html`<div class="banner warn">Recording is <strong>on</strong>. Every request and response body through the
    proxy is written to disk, and admins can read anyone's.</div>`
        : html`<div class="banner">Recording is <strong>off</strong>. Only requests made while it was on appear here —
    set <span class="mono">KUNCEN_TRACE=full</span> and restart kuncen-proxy to record.</div>`}

<div class="panel" style="overflow-x:auto">
  <table>
    <thead><tr><th>When</th><th>Endpoint</th><th>Model</th><th>Tokens</th><th>Took</th><th>Size</th><th></th></tr></thead>
    <tbody>
    ${opts.traces.length === 0
        ? html`<tr><td colspan="7" class="muted">Nothing recorded yet.</td></tr>`
        : opts.traces.map(
            (t) => html`<tr>
        <td class="muted small">${when(t.startedAt)}</td>
        <td class="mono small">${t.path}</td>
        <td class="small">${t.model ?? '–'}${t.streamed ? html` <span class="muted">stream</span>` : ''}</td>
        <td class="small">${String(t.promptTokens)} → ${String(t.completionTokens)}</td>
        <td class="small">${t.durationMs === null ? '–' : fmtDuration(t.durationMs)}</td>
        <td class="small muted">${bytes(t.requestBytes + t.responseBytes)}${t.truncated ? ' *' : ''}</td>
        <td>${outcomeBadge(t)} <a href="/traces/${String(t.id)}">Open</a></td>
      </tr>`,
          )}
    </tbody>
  </table>
</div>
${opts.nextBefore !== null
        ? html`<p><a href="/traces?before=${String(opts.nextBefore)}${opts.subject ? `&user=${String(opts.subject.id)}` : ''}">Older →</a></p>`
        : ''}
<p class="notice">A <span class="mono">*</span> marks a body that hit the size cap and stopped being recorded.</p>`,
  );
}

function turnList(t: Transcript, raw: TraceBody | null, emptyNote: string) {
  if (t.unparsed) {
    return raw
      ? html`<pre class="trace-raw">${raw.text}</pre>
        ${raw.clipped ? html`<p class="notice">Showing the first part of ${bytes(raw.bytes)}.</p>` : ''}`
      : html`<p class="muted">${emptyNote}</p>`;
  }
  return html`${t.turns.map(
    (turn) => html`<div class="turn">
    <div class="turn-role">${turn.role}${turn.note ? html` <span class="muted small">${turn.note}</span>` : ''}</div>
    <pre class="turn-body">${turn.text || '(empty)'}</pre>
  </div>`,
  )}`;
}

export interface TraceDetailOptions {
  user: User;
  csrf: string;
  trace: TraceView;
  request: TraceBody | null;
  response: TraceBody | null;
  requestTranscript: Transcript;
  responseTranscript: Transcript;
}

export function tracePage(opts: TraceDetailOptions) {
  const t = opts.trace;
  return layout(
    { title: `Trace #${t.id}`, user: opts.user, csrf: opts.csrf },
    html`
<div class="spread">
  <h2 style="margin:0">Request #${String(t.id)}</h2>
  <a href="/traces${t.userId === opts.user.id ? '' : `?user=${String(t.userId)}`}">← Back</a>
</div>

<div class="panel">
  <div class="meta">
    <div><div class="k">Who</div><div class="v" style="font-size:15px">${t.userName}</div></div>
    <div><div class="k">When</div><div class="v" style="font-size:15px">${when(t.startedAt)}</div></div>
    <div><div class="k">Model</div><div class="v" style="font-size:15px">${t.model ?? '–'}</div></div>
    <div><div class="k">Took</div><div class="v" style="font-size:15px">${t.durationMs === null ? '–' : fmtDuration(t.durationMs)}</div></div>
    <div><div class="k">Tokens</div><div class="v" style="font-size:15px">${String(t.promptTokens)} → ${String(t.completionTokens)}</div></div>
    <div><div class="k">Result</div><div class="v" style="font-size:15px">${outcomeBadge(t)}</div></div>
  </div>
  <p class="notice mono small">${t.method} ${t.path}${t.streamed ? ' · streamed' : ''}
    · ${bytes(t.requestBytes)} up, ${bytes(t.responseBytes)} down${t.truncated ? ' · hit the size cap' : ''}</p>
</div>

<h3>Conversation sent</h3>
<div class="panel">${turnList(opts.requestTranscript, opts.request, 'The request body was not recorded.')}</div>

<h3>Reply</h3>
<div class="panel">${turnList(opts.responseTranscript, opts.response, 'The response body was not recorded — the request may have been cut short.')}</div>

<p class="notice">
  <a href="/traces/${String(t.id)}/raw?side=request">Raw request</a> ·
  <a href="/traces/${String(t.id)}/raw?side=response">Raw response</a>
</p>`,
  );
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
