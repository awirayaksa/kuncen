import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { config } from './schema';

export const CONFIG_DEFAULTS = {
  idle_timeout_seconds: 300,
  max_session_seconds: 3600,
  drain_ceiling_seconds: 120,
  queue_entry_ttl_seconds: 3600,
  expiry_warning_seconds: 60,
} as const;

export type ConfigKey = keyof typeof CONFIG_DEFAULTS;
export type Config = Record<ConfigKey, number>;

export const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS) as ConfigKey[];

/** Sanity bounds for the admin UI. A 0s idle timeout would be a footgun. */
export const CONFIG_BOUNDS: Record<ConfigKey, { min: number; max: number }> = {
  idle_timeout_seconds: { min: 30, max: 86_400 },
  max_session_seconds: { min: 60, max: 86_400 },
  drain_ceiling_seconds: { min: 5, max: 3_600 },
  queue_entry_ttl_seconds: { min: 60, max: 86_400 },
  expiry_warning_seconds: { min: 5, max: 3_600 },
};

export function getConfig(db: Db): Config {
  const rows = db.select().from(config).all();
  const out = { ...CONFIG_DEFAULTS } as Config;
  for (const row of rows) {
    if (!(row.key in CONFIG_DEFAULTS)) continue;
    const n = Number(row.value);
    if (Number.isFinite(n)) out[row.key as ConfigKey] = n;
  }
  return out;
}

export function setConfig(db: Db, key: ConfigKey, value: number): void {
  const bounds = CONFIG_BOUNDS[key];
  if (!Number.isFinite(value)) throw new Error(`${key}: not a number`);
  const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
  db.insert(config)
    .values({ key, value: String(clamped) })
    .onConflictDoUpdate({ target: config.key, set: { value: String(clamped) } })
    .run();
}

/** Free-form key/value store used for cross-process runtime facts (heartbeats). */
export function getMeta(db: Db, key: string): string | undefined {
  return db.select().from(config).where(eq(config.key, key)).get()?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.insert(config)
    .values({ key, value })
    .onConflictDoUpdate({ target: config.key, set: { value } })
    .run();
}
