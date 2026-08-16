import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from './db';
import { authSessions, users, type User } from './schema';
import { now } from './time';
import { getMeta, setMeta } from './config';

/**
 * scrypt from node:crypto rather than argon2. One fewer native module to build
 * on the host, and at four hand-provisioned accounts the difference is not the
 * weak link.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(keyB64, 'base64url');
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const API_KEY_PREFIX = 'kuncen_';

export interface GeneratedApiKey {
  key: string;
  hash: string;
  prefix: string;
}

/**
 * Permanent per-user credential. Shown once at generation; only the hash is
 * stored. The prefix exists so the profile page can say *which* key you are
 * looking at without being able to reconstruct it.
 */
export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBytes(24).toString('base64url');
  return { key, hash: hashToken(key), prefix: key.slice(0, 14) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Keys issued before the rename still work. The whole value of a permanent
 * credential is that it gets pasted into a tool once and never touched again —
 * renaming the product is not a good enough reason to break that. New keys are
 * `kuncen_`; drop the legacy prefix once nobody is carrying one.
 */
const LEGACY_KEY_PREFIXES = ['kunci_'];

export function userByApiKey(db: Db, key: string): User | undefined {
  const known = [API_KEY_PREFIX, ...LEGACY_KEY_PREFIXES].some((p) => key.startsWith(p));
  if (!known) return undefined;
  return db.select().from(users).where(eq(users.apiKeyHash, hashToken(key))).get();
}

// ---------------------------------------------------------------- browser sessions

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'kuncen_session';

export function createAuthSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const ts = now();
  db.insert(authSessions)
    .values({ id: hashToken(token), userId, createdAt: ts, expiresAt: ts + SESSION_TTL_MS })
    .run();
  return token;
}

export function userByAuthSession(db: Db, token: string | undefined): User | undefined {
  if (!token) return undefined;
  const row = db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.id, hashToken(token)), gt(authSessions.expiresAt, now())))
    .get();
  if (!row) return undefined;
  return db.select().from(users).where(eq(users.id, row.userId)).get();
}

export function destroyAuthSession(db: Db, token: string | undefined): void {
  if (!token) return;
  db.delete(authSessions).where(eq(authSessions.id, hashToken(token))).run();
}

export function destroyAllAuthSessions(db: Db, userId: number): void {
  db.delete(authSessions).where(eq(authSessions.userId, userId)).run();
}

export function pruneAuthSessions(db: Db): void {
  db.delete(authSessions).where(lt(authSessions.expiresAt, now())).run();
}

// ---------------------------------------------------------------- csrf

/** Generated on first run, shared between the two processes through `config`. */
export function serverSecret(db: Db): string {
  const existing = getMeta(db, 'server_secret');
  if (existing) return existing;
  const secret = randomBytes(32).toString('base64url');
  setMeta(db, 'server_secret', secret);
  return secret;
}

export function csrfToken(secret: string, sessionToken: string): string {
  return createHmac('sha256', secret).update(sessionToken).digest('base64url');
}

export function csrfValid(secret: string, sessionToken: string | undefined, given: string | undefined): boolean {
  if (!sessionToken || !given) return false;
  const expected = Buffer.from(csrfToken(secret, sessionToken));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
