import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Brand assets, served straight off disk from `services/web/public`.
 *
 * Resolved relative to this module rather than the working directory, so it
 * behaves the same whether started by npm, by systemd, or from a subdirectory.
 */
export const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
};

/** No slashes, no dots leading, no traversal — the name is the whole path. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PublicFile {
  /** ArrayBuffer rather than Buffer: that is what a Response body accepts. */
  body: ArrayBuffer;
  type: string;
}

const cache = new Map<string, PublicFile | null>();

export function publicFile(name: string): PublicFile | null {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const found = load(name);
  cache.set(name, found);
  return found;
}

function load(name: string): PublicFile | null {
  if (!SAFE_NAME.test(name) || name.includes('..')) return null;
  const type = MIME[extname(name).toLowerCase()];
  if (!type) return null; // images only; no serving stray markdown or configs

  const path = join(PUBLIC_DIR, name);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const buf = readFileSync(path);
  // readFileSync can hand back a view into a pooled buffer; slice to own bytes.
  return { body: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), type };
}
