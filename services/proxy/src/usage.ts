import type { Usage } from '@kuncen/core';

/**
 * Pulls token counts out of a response as it streams past, without ever
 * buffering the whole thing and without inspecting anything else.
 *
 * Works for both shapes vLLM produces: `usage` at the tail of a JSON completion,
 * and the final `data:` frame of an SSE stream when the client asked for
 * `stream_options: {include_usage: true}`. If neither is present we record zero
 * tokens and still count the request — the request count is what the bet
 * actually needs.
 */
const MAX_BUFFER = 128 * 1024;

export class UsageScanner {
  private buf = '';
  private decoder = new TextDecoder();
  usage: Usage = {};

  push(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    this.scan();
    // Only ever drop text we know contains no pending match. The 16-char tail
    // covers a `"usage"` split across two chunks.
    if (this.buf.length > MAX_BUFFER && !this.buf.includes('"usage"')) {
      this.buf = this.buf.slice(-16);
    }
  }

  private scan(): void {
    for (;;) {
      const key = this.buf.indexOf('"usage"');
      if (key === -1) return;

      let i = key + '"usage"'.length;
      while (i < this.buf.length && (this.buf[i] === ' ' || this.buf[i] === ':')) i++;
      if (i >= this.buf.length) return; // incomplete, wait for more bytes

      if (this.buf[i] !== '{') {
        // `"usage": null` on every intermediate SSE frame. Skip and keep going.
        this.buf = this.buf.slice(i);
        continue;
      }

      const obj = extractBalanced(this.buf, i);
      if (obj === null) return; // object straddles a chunk boundary
      this.take(obj);
      this.buf = this.buf.slice(i + obj.length);
    }
  }

  private take(json: string): void {
    try {
      const parsed = JSON.parse(json) as { prompt_tokens?: unknown; completion_tokens?: unknown };
      const prompt = Number(parsed.prompt_tokens);
      const completion = Number(parsed.completion_tokens);
      if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return;
      // Later matches win: the real usage block is the last one in the body.
      this.usage = {
        promptTokens: Number.isFinite(prompt) ? prompt : 0,
        completionTokens: Number.isFinite(completion) ? completion : 0,
      };
    } catch {
      // Not JSON we understand. Token counts are telemetry, not correctness.
    }
  }
}

/** The balanced `{...}` starting at `start`, or null if it is not all here yet. */
function extractBalanced(s: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Passes bytes through untouched while metering them, and calls `onDone`
 * exactly once — on clean end, on client cancel, or on upstream error.
 */
export function meteredStream(
  source: ReadableStream<Uint8Array>,
  onDone: (usage: Usage) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const scanner = new UsageScanner();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone(scanner.usage);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          controller.close();
          finish();
          return;
        }
        if (value) {
          scanner.push(value);
          controller.enqueue(value);
        }
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason).catch(() => {});
    },
  });
}
