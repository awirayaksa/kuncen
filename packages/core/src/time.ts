let clock: () => number = Date.now;

/** Epoch milliseconds. Everything in kuncen reads the clock through here. */
export function now(): number {
  return clock();
}

/** Test seam. Returns a restore function. */
export function setClock(fn: () => number): () => void {
  const prev = clock;
  clock = fn;
  return () => {
    clock = prev;
  };
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
