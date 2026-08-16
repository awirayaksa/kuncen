#!/usr/bin/env node
/**
 * kuncen-admin — the provisioning surface. Registration is admin-provisioned by
 * design, so this is where the four accounts come from.
 *
 * SSH to the box is the real break-glass (an admin can always hit
 * 127.0.0.1:8000 directly). That is what lets the in-app override stay minimal,
 * and it is why `unlock` lives out here rather than in the web UI.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { defaultDbPath, openDb, tx, type Db } from '../src/db';
import { CONFIG_KEYS, getConfig, setConfig, type ConfigKey } from '../src/config';
import { createUser, listUsers, rotateApiKey, setPassword, setRole, userByEmail } from '../src/users';
import { completeDrain, readLock } from '../src/lock';
import { lockState } from '../src/schema';
import { betSummary, recentSessions, stateSnapshot } from '../src/state';
import { resourceLabel } from '../src/resource';
import { fmtDuration, now } from '../src/time';
import { logEvent } from '../src/events';

const USAGE = `kuncen-admin — provisioning and break-glass

  user add <email> <name> [--admin] [--password <pw>]
  user list
  user passwd <email> <password>
  user role <email> user|admin
  user key <email>                 rotate the proxy API key (shown once)

  config list
  config set <key> <value>

  state                            current lock, queue and health
  sessions [n]                     recent lock sessions
  stats [days]                     the numbers from "The bet"
  unlock [reason]                  force the lock to FREE, no drain (break-glass)

Database: $KUNCEN_DB (default ./data/kuncen.db)`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function open() {
  const path = defaultDbPath();
  mkdirSync(dirname(resolve(path)), { recursive: true });
  return openDb(path);
}

function requireUser(db: Db, email: string) {
  const user = userByEmail(db, email);
  if (!user) fail(`no user with email ${email}`);
  return user;
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}
const positional = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !(prev === '--password');
});

const [group, ...rest] = positional;

if (!group || flags.has('--help')) {
  console.log(USAGE);
  process.exit(0);
}

const { db, close } = open();
try {
  switch (group) {
    case 'user':
      userCommand(rest);
      break;
    case 'config':
      configCommand(rest);
      break;
    case 'state':
      stateCommand();
      break;
    case 'sessions':
      sessionsCommand(Number(rest[0] ?? 20));
      break;
    case 'stats':
      statsCommand(Number(rest[0] ?? 14));
      break;
    case 'unlock':
      unlockCommand(rest.join(' '));
      break;
    default:
      fail(`unknown command '${group}'\n\n${USAGE}`);
  }
} finally {
  close();
}

function userCommand(args: string[]): void {
  const [action, ...a] = args;
  switch (action) {
    case 'add': {
      const [email, ...nameParts] = a;
      if (!email || nameParts.length === 0) fail('usage: user add <email> <name> [--admin] [--password <pw>]');
      const password = flagValue('--password') ?? randomBytes(9).toString('base64url');
      const generated = flagValue('--password') === undefined;
      const { user, apiKey } = createUser(db, {
        email,
        name: nameParts.join(' '),
        password,
        role: flags.has('--admin') ? 'admin' : 'user',
      });
      console.log(`created user #${user.id} ${user.email} (${user.role})`);
      if (generated) console.log(`  password:  ${password}   <- shown once`);
      console.log(`  api key:   ${apiKey.key}   <- shown once`);
      break;
    }
    case 'list': {
      for (const u of listUsers(db)) {
        const key = u.apiKeyPrefix ? `${u.apiKeyPrefix}…` : '(no key)';
        console.log(`#${u.id}  ${u.email.padEnd(28)} ${u.role.padEnd(6)} ${key.padEnd(16)} ${u.name}`);
      }
      break;
    }
    case 'passwd': {
      const [email, password] = a;
      if (!email || !password) fail('usage: user passwd <email> <password>');
      setPassword(db, requireUser(db, email).id, password);
      console.log('password updated');
      break;
    }
    case 'role': {
      const [email, role] = a;
      if (!email || (role !== 'user' && role !== 'admin')) fail('usage: user role <email> user|admin');
      setRole(db, requireUser(db, email).id, role);
      console.log(`role set to ${role}`);
      break;
    }
    case 'key': {
      const [email] = a;
      if (!email) fail('usage: user key <email>');
      const key = rotateApiKey(db, requireUser(db, email).id);
      console.log(`  api key:   ${key.key}   <- shown once`);
      break;
    }
    default:
      fail(`unknown user command '${action ?? ''}'`);
  }
}

function configCommand(args: string[]): void {
  const [action, key, value] = args;
  if (action === 'list' || action === undefined) {
    const cfg = getConfig(db);
    for (const k of CONFIG_KEYS) console.log(`${k.padEnd(26)} ${cfg[k]}`);
    return;
  }
  if (action === 'set') {
    if (!key || !CONFIG_KEYS.includes(key as ConfigKey)) fail(`unknown key. one of: ${CONFIG_KEYS.join(', ')}`);
    const n = Number(value);
    if (!Number.isFinite(n)) fail('value must be a number of seconds');
    setConfig(db, key as ConfigKey, n);
    console.log(`${key} = ${getConfig(db)[key as ConfigKey]}`);
    return;
  }
  fail(`unknown config command '${action}'`);
}

function stateCommand(): void {
  const s = stateSnapshot(db);
  const resource = resourceLabel();
  console.log(`status:     ${s.status}${s.drainReason ? ` (${s.drainReason})` : ''}`);
  if (s.holder) {
    console.log(`holder:     ${s.holder.name} for ${fmtDuration(s.ts - (s.acquiredAt ?? s.ts))}`);
    console.log(`idle for:   ${fmtDuration(s.ts - (s.lastActivityAt ?? s.ts))}   in flight: ${s.inFlight}`);
  }
  console.log(
    `expires:    ${s.expiresAt ? `${fmtDuration(s.expiresAt - s.ts)} (${s.expiryReason})` : 'not expiring (no contention)'}`,
  );
  console.log(`queue:      ${s.queue.map((q) => `${q.position}. ${q.userName}`).join('  ') || 'empty'}`);
  console.log(
    `health:     sweeper ${s.health.proxyAlive ? 'alive' : 'STALE'}, ${resource.name} ${
      s.health.upstreamOk === null ? 'unknown' : s.health.upstreamOk ? 'ok' : 'DOWN'
    }`,
  );
  if (s.health.upstreamDetail) console.log(`            ${s.health.upstreamDetail}`);
}

function sessionsCommand(limit: number): void {
  for (const s of recentSessions(db, limit)) {
    const util = s.utilization === null ? '   -' : `${Math.round(s.utilization * 100)}%`.padStart(4);
    console.log(
      `#${String(s.id).padEnd(4)} ${s.userName.padEnd(14)} ${fmtDuration(s.heldMs).padStart(8)} ` +
        `busy ${util}  ${String(s.requestCount).padStart(4)} req  ` +
        `${s.promptTokens}+${s.completionTokens} tok  ${s.releaseReason ?? 'open'}`,
    );
  }
}

function statsCommand(days: number): void {
  const b = betSummary(db, days);
  console.log(`window:         last ${b.windowDays} days`);
  console.log(`sessions:       ${b.sessionCount}`);
  console.log(`held total:     ${fmtDuration(b.totalHeldMs)}`);
  console.log(`busy total:     ${fmtDuration(b.totalBusyMs)}`);
  console.log(`utilization:    ${b.utilization === null ? '-' : `${Math.round(b.utilization * 100)}%`}`);
  console.log(`queue joins:    ${b.queueEvents}`);
  console.log(`423 rejections: ${b.rejections}`);
  console.log(`median wait:    ${b.medianWaitMs === null ? '-' : fmtDuration(b.medianWaitMs)}`);
  console.log(`released by:    ${JSON.stringify(b.releaseReasons)}`);
  console.log('');
  console.log('The bet holds if people queue rarely, wait briefly, and utilization is high.');
  console.log('Frequent queueing with low utilization is the signal to revisit it.');
}

function unlockCommand(reason: string): void {
  tx(db, (t) => {
    const ls = readLock(t);
    if (ls.status === 'FREE') {
      console.log('already FREE');
      return;
    }
    if (ls.status === 'HELD') {
      t.update(lockState)
        .set({ status: 'DRAINING', drainStartedAt: now(), drainReason: 'forced' })
        .where(eq(lockState.id, 1))
        .run();
    }
    const drained = completeDrain(t, now());
    logEvent(t, {
      type: 'force_release',
      userId: drained.holderId,
      detail: { note: reason || 'kuncen-admin unlock', via: 'cli' },
    });
    console.log(`forced to FREE (was held by user #${drained.holderId ?? '?'})`);
    console.log('note: any request still streaming upstream is NOT killed by this — restart kuncen-proxy if so.');
  });
}
