import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { defaultDbPath } from './db';

/**
 * Where traced bodies live, and whether they are being written at all.
 *
 * Both services need this: the proxy writes the files, kuncen-web reads them
 * back. It is environment, not the `config` table — turning prompt recording on
 * or off should be a deliberate act with a restart behind it, not a checkbox
 * that quietly changes what the box is doing to everyone using it.
 */
export type TraceMode = 'off' | 'full';

export interface TraceConfig {
  mode: TraceMode;
  /** Absolute. Defaults to `traces/` beside the database. */
  dir: string;
  /** Per direction, per request. Beyond this the body stops being recorded. */
  maxBytes: number;
  retentionMs: number;
}

export const TRACE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const TRACE_DEFAULT_RETENTION_HOURS = 168; // 7 days

export function traceConfig(env: NodeJS.ProcessEnv = process.env): TraceConfig {
  const raw = (env.KUNCEN_TRACE ?? 'off').trim().toLowerCase();
  // Anything unrecognised is off. Failing closed is the only safe default for a
  // switch that decides whether colleagues' prompts hit the disk.
  const mode: TraceMode = raw === 'full' || raw === 'on' || raw === '1' ? 'full' : 'off';

  const configured = env.KUNCEN_TRACE_DIR?.trim();
  const dir = configured
    ? resolve(configured)
    : resolve(dirname(resolve(defaultDbPath())), 'traces');

  return {
    mode,
    dir,
    maxBytes: positive(env.KUNCEN_TRACE_MAX_BYTES, TRACE_DEFAULT_MAX_BYTES),
    retentionMs: positive(env.KUNCEN_TRACE_RETENTION_HOURS, TRACE_DEFAULT_RETENTION_HOURS) * 3600 * 1000,
  };
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve a stored relative path inside the trace directory.
 *
 * The stored value comes out of our own database, but it still ends up in a
 * filesystem call, so it is treated as untrusted: anything that escapes the
 * trace directory is refused rather than read.
 */
export function traceFilePath(cfg: TraceConfig, relative: string): string | null {
  if (!relative || isAbsolute(relative) || relative.includes('\0')) return null;
  const full = resolve(cfg.dir, normalize(relative));
  const root = resolve(cfg.dir);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export interface TraceBody {
  text: string;
  bytes: number;
  /** True when the file is longer than what was read back. */
  clipped: boolean;
}

/**
 * Read a recorded body for display. `limit` caps what is pulled into memory —
 * an 8 MB prompt is not something to hand to a browser in one page.
 */
export function readTraceBody(
  cfg: TraceConfig,
  relative: string | null,
  limit = 1024 * 1024,
): TraceBody | null {
  if (!relative) return null;
  const path = traceFilePath(cfg, relative);
  if (!path) return null;
  try {
    const size = statSync(path).size;
    const buf = readFileSync(path);
    const slice = buf.subarray(0, limit);
    return {
      text: slice.toString('utf8'),
      bytes: size,
      clipped: size > slice.length,
    };
  } catch {
    // Pruned, or never written because the request failed before the body.
    return null;
  }
}

/** `<dir>/<YYYY-MM-DD>/<id>.<kind>` — dated so pruning can drop whole folders. */
export function traceRelativePath(id: number, kind: 'req' | 'res', ts: number): string {
  const day = new Date(ts).toISOString().slice(0, 10);
  return join(day, `${id}.${kind}`);
}
