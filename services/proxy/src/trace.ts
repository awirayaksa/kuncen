import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { traceFilePath, type TraceConfig } from '@kuncen/core';

/**
 * Streaming body capture.
 *
 * Three rules this file exists to keep:
 *
 * 1. **Never buffer a whole body.** Bytes go to disk as they pass. An agentic
 *    client resends its entire context every turn; holding that in memory per
 *    in-flight request is how a proxy falls over.
 * 2. **Never stall or break the stream.** Every failure here is swallowed. A
 *    disk that is full or read-only must cost you your trace, never your
 *    generation.
 * 3. **Never let a cap turn into a leak.** Once a body passes `maxBytes` we stop
 *    writing but keep *reading*, because a `tee()` branch nobody drains buffers
 *    in memory without limit — the exact failure the cap was meant to prevent.
 */
export class BodySink {
  private stream: WriteStream | null = null;
  private failed = false;
  bytes = 0;
  truncated = false;
  /** First bytes, kept for `model` extraction. Bounded and tiny. */
  head = '';

  constructor(
    private readonly cfg: TraceConfig,
    readonly relative: string,
    private readonly headLimit = 64 * 1024,
  ) {}

  private open(): WriteStream | null {
    if (this.failed) return null;
    if (this.stream) return this.stream;
    try {
      const full = traceFilePath(this.cfg, this.relative);
      if (!full) throw new Error('trace path escapes the trace directory');
      mkdirSync(dirname(full), { recursive: true });
      this.stream = createWriteStream(full, { flags: 'w' });
      // An error event with no listener is an uncaught exception that would take
      // the proxy down with it.
      this.stream.on('error', () => {
        this.failed = true;
      });
      return this.stream;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /** Resolves when the chunk is accepted, so the caller inherits backpressure. */
  async write(chunk: Uint8Array): Promise<void> {
    this.bytes += chunk.byteLength;
    if (this.head.length < this.headLimit) {
      this.head += Buffer.from(
        chunk.buffer,
        chunk.byteOffset,
        Math.min(chunk.byteLength, this.headLimit - this.head.length),
      ).toString('utf8');
    }
    if (this.bytes > this.cfg.maxBytes) {
      // Past the cap: keep counting, stop recording. The caller keeps draining.
      this.truncated = true;
      return;
    }
    const stream = this.open();
    if (!stream) return;
    await new Promise<void>((done) => {
      try {
        if (!stream.write(Buffer.from(chunk))) stream.once('drain', () => done());
        else done();
      } catch {
        this.failed = true;
        done();
      }
    });
  }

  async close(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    this.stream = null;
    await new Promise<void>((done) => {
      try {
        stream.end(() => done());
      } catch {
        done();
      }
    });
  }

  /** Null when nothing was ever written, so the row keeps a null pointer. */
  get storedPath(): string | null {
    return this.bytes > 0 && !this.failed ? this.relative : null;
  }
}

/**
 * Drain a `tee()` branch into a sink. Runs detached from the request: the client
 * must never wait on our bookkeeping.
 */
export function drainToSink(branch: ReadableStream<Uint8Array>, sink: BodySink): Promise<void> {
  return (async () => {
    const reader = branch.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await sink.write(value);
      }
    } catch {
      // Client hung up mid-upload, or the stream errored. Keep what we have.
    } finally {
      reader.releaseLock();
      await sink.close();
    }
  })();
}

/**
 * Pass bytes through untouched, copying them to a sink on the way. Composed
 * outside `meteredStream` so token metering stays a separate concern.
 */
export function tappedStream(
  source: ReadableStream<Uint8Array>,
  sink: BodySink,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await sink.close();
    onDone();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await finish();
          return;
        }
        if (value) {
          controller.enqueue(value);
          // After enqueue: the client's bytes are never held up by our disk.
          await sink.write(value);
        }
      } catch (err) {
        await finish();
        controller.error(err);
      }
    },
    async cancel(reason) {
      await finish();
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** The `model` field out of a request body head, for a scannable list. */
export function extractModel(head: string): string | null {
  const m = /"model"\s*:\s*"([^"\\]{1,120})"/.exec(head);
  return m?.[1] ?? null;
}

/** Whether the caller asked for a streamed response. */
export function extractStreamFlag(head: string): boolean {
  return /"stream"\s*:\s*true/.test(head);
}

/**
 * The reasoning effort the client asked for. The key is not standardised, so
 * the three spellings seen in the wild are accepted: `reasoning_effort`,
 * top-level `effort`, and `reasoning: { effort: … }`. The last two are both
 * matched by the same pattern, since `"effort"` appears quoted in either spot.
 */
export function extractEffort(head: string): string | null {
  const m = /"reasoning_effort"\s*:\s*"([^"\\]{1,120})"/.exec(head);
  if (m) return m[1] ?? null;
  const e = /"effort"\s*:\s*"([^"\\]{1,120})"/.exec(head);
  return e?.[1] ?? null;
}
