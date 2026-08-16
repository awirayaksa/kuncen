/**
 * Is the backend answering?
 *
 * This is deliberately a separate signal from lock state — "the resource is
 * broken" and "the resource is taken" must never look alike on the dashboard.
 * That only holds if the signal is honest, so there are three outcomes here, not
 * two:
 *
 *   up       — a probe endpoint answered 2xx
 *   down     — nothing answered, or it answered 5xx, or the credential is refused
 *   unknown  — the host answered, but serves no endpoint we know how to probe
 *
 * The third one matters. `/health` is a vLLM convention; an OpenAI-compatible
 * gateway typically 404s it while serving inference perfectly well. Reporting
 * that as "down" is a false alarm that trains people to ignore the badge.
 */
export type HealthState = 'up' | 'down' | 'unknown';

export interface HealthResult {
  state: HealthState;
  /** The path that answered, once one has. */
  path: string | null;
  /** Short human-readable reason, shown on the dashboard badge. */
  detail: string;
}

export interface UpstreamHealthOptions {
  upstream: string;
  apiKey?: string | undefined;
  /** From `KUNCEN_HEALTH_PATH`. `off` disables probing entirely. */
  path?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** vLLM serves the first; OpenAI-compatible gateways serve the second. */
export const DEFAULT_HEALTH_PATHS = ['/health', '/v1/models'];

export class UpstreamHealth {
  private readonly base: string;
  private readonly candidates: string[];
  private readonly explicit: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly disabled: boolean;
  /** Once a path answers, keep using it: one request per poll, not two. */
  private sticky: string | null = null;

  constructor(opts: UpstreamHealthOptions) {
    this.base = opts.upstream.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;

    const configured = opts.path?.trim();
    this.disabled = configured?.toLowerCase() === 'off';
    this.explicit = Boolean(configured) && !this.disabled;
    this.candidates = this.explicit ? [normalize(configured!)] : DEFAULT_HEALTH_PATHS;
  }

  async check(): Promise<HealthResult> {
    if (this.disabled) {
      return { state: 'unknown', path: null, detail: 'health probing disabled' };
    }

    const order = this.sticky ? [this.sticky, ...this.candidates.filter((p) => p !== this.sticky)] : this.candidates;
    let sawHost = false;
    let lastDetail = 'no response';

    for (const path of order) {
      const outcome = await this.probe(path);
      if (outcome.state === 'up') {
        this.sticky = path;
        return outcome;
      }
      if (outcome.state === 'down' && outcome.detail !== NOT_A_PROBE) {
        // A real failure — 5xx or a refused credential. Stop and report it.
        this.sticky = null;
        return outcome;
      }
      if (outcome.detail === NOT_A_PROBE) sawHost = true;
      lastDetail = outcome.detail;
    }

    this.sticky = null;
    if (sawHost) {
      // The host is up; we just have nowhere to ask. Saying "down" here would be
      // a lie, and the kind that gets a monitoring signal ignored.
      return {
        state: 'unknown',
        path: null,
        detail: `no health endpoint (tried ${order.join(', ')}) — set KUNCEN_HEALTH_PATH`,
      };
    }
    return { state: 'down', path: null, detail: lastDetail };
  }

  private async probe(path: string): Promise<HealthResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      return {
        state: 'down',
        path,
        detail: name === 'TimeoutError' ? `no answer within ${this.timeoutMs}ms` : `unreachable (${(err as Error).message})`,
      };
    }

    // Never read the body: it is not ours and we do not need it.
    await res.body?.cancel().catch(() => {});

    if (res.ok) return { state: 'up', path, detail: `${path} answered ${res.status}` };
    if (res.status === 401 || res.status === 403) {
      return {
        state: 'down',
        path,
        detail: `backend refused our credential (${res.status}) — check KUNCEN_UPSTREAM_API_KEY`,
      };
    }
    if (res.status === 404 || res.status === 405) return { state: 'down', path, detail: NOT_A_PROBE };
    return { state: 'down', path, detail: `${path} answered ${res.status}` };
  }
}

/** Internal marker: this path is not a health endpoint, try another. */
const NOT_A_PROBE = 'not a health endpoint';

function normalize(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}
