import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UsageScanner, meteredStream } from '../src/usage';

const enc = new TextEncoder();

function scan(...chunks: string[]): UsageScanner {
  const scanner = new UsageScanner();
  for (const chunk of chunks) scanner.push(enc.encode(chunk));
  return scanner;
}

describe('usage scanner', () => {
  it('reads usage off a plain JSON completion', () => {
    const scanner = scan(
      JSON.stringify({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
      }),
    );
    assert.deepEqual(scanner.usage, { promptTokens: 12, completionTokens: 34 });
  });

  it('skips the `"usage": null` frames vLLM sends mid-stream', () => {
    const scanner = scan(
      'data: {"choices":[{"delta":{"content":"a"}}],"usage":null}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}],"usage":null}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
      'data: [DONE]\n\n',
    );
    assert.deepEqual(scanner.usage, { promptTokens: 5, completionTokens: 9 });
  });

  it('handles a usage object split across chunk boundaries', () => {
    const scanner = scan('{"choices":[],"us', 'age":{"prompt_to', 'kens":7,"completion_tokens":', '3}}');
    assert.deepEqual(scanner.usage, { promptTokens: 7, completionTokens: 3 });
  });

  it('takes the last usage block, so text that merely mentions one cannot win', () => {
    const scanner = scan(
      '{"choices":[{"message":{"content":"here is an example: \\"usage\\": {\\"prompt_tokens\\": 999}"}}],',
      '"usage":{"prompt_tokens":4,"completion_tokens":2}}',
    );
    assert.deepEqual(scanner.usage, { promptTokens: 4, completionTokens: 2 });
  });

  it('reports nothing rather than guessing when there is no usage block', () => {
    const scanner = scan('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    assert.deepEqual(scanner.usage, {});
  });

  it('stays bounded on a long body with usage only at the very end', () => {
    const scanner = new UsageScanner();
    for (let i = 0; i < 40; i++) scanner.push(enc.encode('x'.repeat(8 * 1024)));
    scanner.push(enc.encode('{"usage":{"prompt_tokens":1,"completion_tokens":2}}'));
    assert.deepEqual(scanner.usage, { promptTokens: 1, completionTokens: 2 });
  });
});

describe('metered stream', () => {
  it('passes bytes through unchanged and settles once at the end', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"usage":{"prompt_tokens":2,'));
        controller.enqueue(enc.encode('"completion_tokens":3}}'));
        controller.close();
      },
    });

    let settled = 0;
    let seen: unknown;
    const out = meteredStream(source, (usage) => {
      settled++;
      seen = usage;
    });

    const text = await new Response(out).text();
    assert.equal(text, '{"usage":{"prompt_tokens":2,"completion_tokens":3}}');
    assert.equal(settled, 1);
    assert.deepEqual(seen, { promptTokens: 2, completionTokens: 3 });
  });

  it('settles exactly once when the reader cancels early', async () => {
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode('chunk'));
      },
    });

    let settled = 0;
    const out = meteredStream(source, () => {
      settled++;
    });

    const reader = out.getReader();
    await reader.read();
    await reader.cancel('done with you');
    assert.equal(settled, 1, 'the in-flight slot must be released exactly once');
  });

  it('settles when the upstream errors mid-body', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('partial'));
      },
      pull(controller) {
        controller.error(new Error('upstream died'));
      },
    });

    let settled = 0;
    const out = meteredStream(source, () => {
      settled++;
    });

    const reader = out.getReader();
    await reader.read();
    await assert.rejects(() => reader.read(), /upstream died/);
    assert.equal(settled, 1);
  });
});
