/**
 * Stylesheet and client script as string constants, served from routes. No
 * bundler, no static-path resolution, no build step — the churny half of kuncen
 * should be editable on the box with a text editor.
 */

export const STYLESHEET = `
/* Kuncen brand palette: Deep Indigo #1B3A5C, Brushed Gold #D4AF8A,
   Accent Dark #0F1E2E. Gold carries every action and every "this is you";
   indigo carries structure. Status colours stay semantic and distinct from it. */
:root {
  --bg: #0f1e2e;
  --panel: #16293c;
  --panel-2: #1b3a5c;
  --line: #24425f;
  --text: #e9eef4;
  --muted: #93a7bc;
  --accent: #d4af8a;
  --accent-strong: #e4c8ae;
  --on-accent: #0f1e2e;
  --ok: #5fd79b;
  --held: #7fa0c0;
  --warn: #e8b96a;
  --bad: #f08a8a;
  --radius: 10px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 Inter, "DejaVu Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

/* The supplied mark sits in ~40% clear space on every side — correct for print,
   far too small in a 26px header. This crops to the measured content box with a
   uniform scale: the artwork is never stretched, only framed. */
.logo {
  --logo-h: 26px;
  --k: calc(var(--logo-h) / 331);
  position: relative;
  flex: none;
  overflow: hidden;
  height: var(--logo-h);
  width: calc(601 * var(--k));
}
.logo img {
  position: absolute;
  max-width: none;
  width: calc(2400 * var(--k));
  height: calc(2400 * var(--k));
  left: calc(-840 * var(--k));
  top: calc(-1060 * var(--k));
}
.logo.lg { --logo-h: 44px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header {
  display: flex; align-items: center; gap: 18px;
  padding: 12px 22px; border-bottom: 1px solid var(--line); background: var(--panel);
}
header .brand { display: flex; align-items: center; gap: 11px; }
.brand-text { display: flex; flex-direction: column; justify-content: center; }
.wordmark {
  font-weight: 700;
  letter-spacing: .14em;
  font-size: 16px;
  line-height: 1;
  color: var(--text);
}
.tagline {
  color: var(--accent);
  font-weight: 400;
  font-size: 11px;
  letter-spacing: .1em;
  text-transform: uppercase;
  line-height: 1;
  margin-top: 4px;
}
header .tagline { display: none; }
@media (min-width: 720px) { header .tagline { display: block; } }
header nav { margin-left: auto; display: flex; gap: 16px; align-items: baseline; }
header nav .who { color: var(--muted); font-size: 13px; }
main { max-width: 940px; margin: 0 auto; padding: 24px 22px 60px; }
h1 { font-size: 20px; margin: 0 0 18px; }
h2 { font-size: 15px; margin: 28px 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; }
.panel + .panel { margin-top: 14px; }
.row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.grow { flex: 1; }
.status { display: flex; align-items: center; gap: 12px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.free { background: var(--ok); }
.dot.held { background: var(--held); }
.dot.mine { background: var(--accent); }
.dot.draining { background: var(--bad); }
.headline { font-size: 20px; font-weight: 600; }
.sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
.meta { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.meta div { min-width: 110px; }
.meta .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
.meta .v { font-variant-numeric: tabular-nums; margin-top: 2px; }
button, .btn {
  font: inherit; padding: 9px 16px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--panel-2); color: var(--text); cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
button.danger { border-color: #5a2a2a; color: var(--bad); }
input, select, textarea {
  font: inherit; padding: 9px 11px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--bg); color: var(--text);
}
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 5px; }
.field { margin-bottom: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); }
tr:last-child td { border-bottom: 0; }
td.num { font-variant-numeric: tabular-nums; text-align: right; }
.queue { list-style: none; margin: 0; padding: 0; }
.queue li { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); }
.queue li:last-child { border-bottom: 0; }
.queue .pos {
  width: 24px; height: 24px; border-radius: 50%; background: var(--panel-2);
  display: grid; place-items: center; font-size: 12px; color: var(--muted); flex: none;
}
.queue li.me { color: var(--accent); }
.queue li.me .pos { background: var(--accent); color: var(--on-accent); font-weight: 700; }
.empty { color: var(--muted); font-style: italic; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.badge.ok { color: var(--ok); border-color: #234; }
.badge.bad { color: var(--bad); border-color: #422; }
.banner { border-radius: 8px; padding: 11px 14px; margin-bottom: 14px; font-size: 14px; }
.banner.bad { background: #2a1618; border: 1px solid #5a2a2a; color: #fca5a5; }
.banner.ok { background: #14251b; border: 1px solid #2b4d38; color: #86efac; }
.banner.warn { background: #2a2314; border: 1px solid #574a1f; color: #fcd34d; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.key { display: block; padding: 12px; background: var(--bg); border: 1px dashed var(--accent); border-radius: 8px; word-break: break-all; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.spread { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
.login { max-width: 340px; margin: 10vh auto; }
.login-brand { display: flex; align-items: center; gap: 13px; margin-bottom: 18px; }
.notice { color: var(--muted); font-size: 13px; margin-top: 10px; }

/* --- traces. Recorded prompts are long, so every body scrolls inside its own
   box rather than stretching the page sideways. */
.turn { border-top: 1px solid var(--line); padding: 12px 0; }
.turn:first-child { border-top: 0; padding-top: 0; }
.turn-role {
  font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--accent); margin-bottom: 6px;
}
.turn-body, .trace-raw {
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; line-height: 1.5; max-height: 460px; overflow-y: auto;
}
.trace-raw { color: var(--muted); }
`;

export const APP_JS = String.raw`
(() => {
  const el = (id) => document.getElementById(id);
  const state = { since: Number(document.body.dataset.lastEvent || 0), me: Number(document.body.dataset.me), snap: null };
  // What this Kuncen guards, e.g. 'the DGX Spark'. Set in .env, rendered onto
  // the page by the server so this script stays deployment-agnostic.
  const RES = document.body.dataset.resourceThe || 'the resource';
  const RES_CAP = document.body.dataset.resourceTheCap || 'The resource';
  const BACKEND = document.body.dataset.resource || 'backend';
  const csrf = document.querySelector('meta[name="csrf"]').content;

  const fmt = (ms) => {
    if (ms == null || !isFinite(ms)) return '–';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  };

  async function post(path) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    });
    const body = await res.json().catch(() => ({}));
    if (body.state) apply(body.state);
    if (body.message) flash(body.message, res.ok ? 'ok' : 'bad');
    return body;
  }

  let flashTimer;
  function flash(msg, kind) {
    const box = el('flash');
    box.className = 'banner ' + (kind || 'ok');
    box.textContent = msg;
    box.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }

  // Permission is asked for at the moment it becomes useful: when you join the
  // queue, or when a page load finds you already holding or waiting. Denying it
  // costs you nothing but the live page.
  //
  // Once per page, not once per 2s poll. Safari ignores requestPermission()
  // without a user gesture — that is fine, the Request button still covers it.
  let asked = false;
  function askNotify() {
    if (asked || !('Notification' in window)) return;
    asked = true;
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }

  // One tag per kind, not one tag for all of Kuncen: a shared tag makes every
  // new notification replace the last, so "someone is waiting" would silently
  // wipe out an unread "your lock is expiring". Same-kind ones still collapse,
  // which is what we want — one popup saying "(3 waiting)" beats three popups.
  function notify(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag: tag || 'kuncen', renotify: true }); } catch (e) {}
  }

  function apply(snap) {
    state.snap = snap;
    render();
  }

  function render() {
    const s = state.snap;
    if (!s) return;
    const mine = s.me.holding;
    const drift = Date.now() - s.ts;
    const nowish = s.ts + drift;

    const dot = el('dot');
    dot.className = 'dot ' + (s.status === 'DRAINING' ? 'draining' : s.status === 'FREE' ? 'free' : mine ? 'mine' : 'held');

    if (s.status === 'FREE') {
      el('headline').textContent = RES_CAP + ' is free';
      el('subline').textContent = s.queueLength ? 'Handing it to the queue head…' : 'Nobody is holding the lock.';
    } else if (s.status === 'DRAINING') {
      el('headline').textContent = 'Draining' + (mine ? ' — your session is ending' : '');
      el('subline').textContent =
        'Finishing in-flight requests (' + s.inFlight + '), then the queue head takes over. ' +
        'Ceiling in ' + fmt(s.drainEndsAt - nowish) + '.';
    } else if (mine) {
      el('headline').textContent = 'You hold ' + RES;
      el('subline').textContent = s.expiresAt
        ? 'Expires in ' + fmt(s.expiresAt - nowish) + ' (' + s.expiryReason + ') — ' + s.queueLength + ' waiting.'
        : 'No one is waiting, so nothing is expiring. Take your time.';
    } else {
      el('headline').textContent = (s.holder ? s.holder.name : 'Someone') + ' holds ' + RES;
      el('subline').textContent = s.expiresAt
        ? 'Expires in ' + fmt(s.expiresAt - nowish) + ' (' + s.expiryReason + ').'
        : 'Not expiring — you are not in the queue, so no timers are running.';
    }

    el('m-held').textContent = s.acquiredAt ? fmt(nowish - s.acquiredAt) : '–';
    el('m-idle').textContent = s.inFlight > 0 ? 'streaming' : s.lastActivityAt ? fmt(nowish - s.lastActivityAt) : '–';
    el('m-inflight').textContent = String(s.inFlight);
    el('m-queue').textContent = String(s.queueLength);
    el('m-expires').textContent = s.expiresAt ? fmt(s.expiresAt - nowish) : 'not expiring';

    const q = el('queue');
    q.innerHTML = '';
    if (!s.queue.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nobody waiting.';
      q.appendChild(li);
    }
    for (const entry of s.queue) {
      const li = document.createElement('li');
      if (entry.userId === state.me) li.className = 'me';
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = entry.position;
      const name = document.createElement('span');
      name.className = 'grow';
      name.textContent = entry.userName + (entry.userId === state.me ? ' (you)' : '');
      const wait = document.createElement('span');
      wait.className = 'muted small';
      wait.textContent = 'waiting ' + fmt(nowish - entry.enqueuedAt);
      li.append(pos, name, wait);
      q.appendChild(li);
    }

    const queued = s.me.position !== null;
    // A holder whose grant landed in a tab they have since closed never pressed
    // Request in *this* one, and is exactly who the new notifications are for.
    if (mine || queued) askNotify();
    el('btn-request').hidden = mine || queued;
    el('btn-cancel').hidden = !queued;
    el('btn-release').hidden = !mine || s.status !== 'HELD';
    el('you').textContent = mine
      ? 'You hold the lock.'
      : queued
        ? 'You are #' + s.me.position + ' in the queue.'
        : 'You are not in the queue.';

    const health = el('health');
    const bits = [];
    const why = s.health.upstreamDetail ? ' title="' + escapeHtml(s.health.upstreamDetail) + '"' : '';
    if (!s.health.proxyAlive) bits.push('<span class="badge bad">sweeper not responding</span>');
    // Three states, not two: unknown means the probe found nowhere to ask, which
    // is not the same as the backend being dead.
    if (s.health.upstreamOk === false) bits.push('<span class="badge bad"' + why + '>' + BACKEND + ' down</span>');
    if (s.health.upstreamOk === true) bits.push('<span class="badge ok"' + why + '>' + BACKEND + ' ok</span>');
    if (s.health.upstreamOk === null) bits.push('<span class="badge"' + why + '>' + BACKEND + ' unknown</span>');
    health.innerHTML = bits.join(' ');

    const ov = el('overrides');
    if (ov) {
      ov.innerHTML = '';
      for (const e of s.overrides) {
        const li = document.createElement('li');
        const when = new Date(e.ts).toLocaleString();
        const note = (e.detail && e.detail.note) || '(no reason given)';
        li.innerHTML = '<span class="grow">' +
          '<strong>' + (e.actorName || 'an admin') + '</strong> force-released <strong>' +
          (e.userName || 'someone') + '</strong> — ' + escapeHtml(String(note)) +
          '</span><span class="muted small">' + when + '</span>';
        ov.appendChild(li);
      }
      el('overrides-wrap').hidden = s.overrides.length === 0;
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function handleNotices(notices) {
    for (const n of notices) {
      state.since = Math.max(state.since, n.id);
      if (n.type === 'granted') notify('Kuncen: your turn', RES_CAP + ' is now available to use.', 'kuncen-turn');
      else if (n.type === 'access_requested') {
        const who = n.actorName || 'Someone';
        const waiting = (n.detail && n.detail.queue_length) || 1;
        const tail = waiting > 1 ? ' (' + waiting + ' waiting)' : '';
        notify('Kuncen: someone is waiting', who + ' is requesting access to ' + RES + '.' + tail, 'kuncen-request');
        flash(who + ' is requesting access to ' + RES + '.' + tail, 'warn');
      } else if (n.type === 'expiry_warning') {
        const secs = n.detail && n.detail.expires_at ? Math.max(0, Math.round((n.detail.expires_at - Date.now()) / 1000)) : 60;
        notify('Kuncen: lock expiring', 'Your lock expires in about ' + secs + 's — someone is waiting.', 'kuncen-warning');
      } else if (n.type === 'expired') {
        notify('Kuncen: you left the queue', 'Your request timed out — you are no longer in the queue.', 'kuncen-queue');
        flash('Your queue request timed out. Press Request again if you still want ' + RES + '.', 'warn');
      } else if (n.type === 'force_release') {
        const note = (n.detail && n.detail.note) || '';
        notify('Kuncen: force-released', (n.actorName || 'An admin') + ' released your lock. ' + note, 'kuncen-force');
        flash((n.actorName || 'An admin') + ' force-released your lock: ' + note, 'warn');
      }
    }
  }

  let failures = 0;
  async function poll() {
    try {
      const res = await fetch('/api/state?since=' + state.since, { headers: { accept: 'application/json' } });
      if (res.status === 401) { location.href = '/login'; return; }
      const body = await res.json();
      failures = 0;
      el('stale').hidden = true;
      handleNotices(body.notices || []);
      state.since = Math.max(state.since, body.state.lastEventId);
      apply(body.state);
    } catch (e) {
      if (++failures > 2) el('stale').hidden = false;
    }
  }

  el('btn-request').addEventListener('click', async () => {
    askNotify();
    await post('/request');
  });
  el('btn-cancel').addEventListener('click', () => post('/cancel'));
  el('btn-release').addEventListener('click', () => post('/release'));

  apply(JSON.parse(document.getElementById('bootstrap').textContent));
  setInterval(poll, 2000);
  // Countdowns tick locally between polls so the page never looks frozen.
  setInterval(render, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
`;
