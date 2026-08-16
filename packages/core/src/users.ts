import { asc, eq } from 'drizzle-orm';
import type { Db } from './db';
import { users, type User } from './schema';
import { generateApiKey, hashPassword, type GeneratedApiKey } from './auth';
import { now } from './time';

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  role?: 'user' | 'admin';
}

/**
 * Registration is admin-provisioned — there is no self-service path anywhere in
 * the web service. Four accounts, created by hand.
 */
export function createUser(db: Db, input: CreateUserInput): { user: User; apiKey: GeneratedApiKey } {
  const email = normalizeEmail(input.email);
  if (!email.includes('@')) throw new Error('email: not an email address');
  if (!input.name.trim()) throw new Error('name: required');
  if (input.password.length < 8) throw new Error('password: must be at least 8 characters');

  const apiKey = generateApiKey();
  const user = db
    .insert(users)
    .values({
      email,
      name: input.name.trim(),
      passwordHash: hashPassword(input.password),
      role: input.role ?? 'user',
      apiKeyHash: apiKey.hash,
      apiKeyPrefix: apiKey.prefix,
      createdAt: now(),
    })
    .returning()
    .get();
  return { user, apiKey };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function listUsers(db: Db): User[] {
  return db.select().from(users).orderBy(asc(users.id)).all();
}

export function userById(db: Db, id: number): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function userByEmail(db: Db, email: string): User | undefined {
  return db.select().from(users).where(eq(users.email, normalizeEmail(email))).get();
}

export function setPassword(db: Db, userId: number, password: string): void {
  if (password.length < 8) throw new Error('password: must be at least 8 characters');
  db.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, userId)).run();
}

export function setRole(db: Db, userId: number, role: 'user' | 'admin'): void {
  db.update(users).set({ role }).where(eq(users.id, userId)).run();
}

/** Regenerate (or revoke, with `revoke: true`) the caller's proxy credential. */
export function rotateApiKey(db: Db, userId: number): GeneratedApiKey {
  const apiKey = generateApiKey();
  db.update(users)
    .set({ apiKeyHash: apiKey.hash, apiKeyPrefix: apiKey.prefix })
    .where(eq(users.id, userId))
    .run();
  return apiKey;
}

export function revokeApiKey(db: Db, userId: number): void {
  db.update(users).set({ apiKeyHash: null, apiKeyPrefix: null }).where(eq(users.id, userId)).run();
}

export function publicUser(user: User): { id: number; name: string; email: string; role: string } {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}
