import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRequestTranscript, parseResponseTranscript } from '../src/transcript';

/**
 * Every input here is something a real trace can contain. A recorded body may be
 * cut off at the size cap or halfway through a stream when a drain killed it, so
 * "malformed" is the normal case, not the exception.
 */
describe('request transcripts', () => {
  it('reads a chat completion back as turns', () => {
    const t = parseRequestTranscript(
      JSON.stringify({
        model: 'llama-3',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Why is the sky blue?' },
        ],
      }),
    );
    assert.equal(t.unparsed, false);
    assert.deepEqual(
      t.turns.map((x) => [x.role, x.text]),
      [
        ['system', 'Be brief.'],
        ['user', 'Why is the sky blue?'],
      ],
    );
  });

  it('flattens the multi-part content shape and notes what it dropped', () => {
    const t = parseRequestTranscript(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this?' },
              { type: 'image_url', image_url: { url: 'data:...' } },
            ],
          },
        ],
      }),
    );
    assert.equal(t.turns[0]?.text, 'What is in this?');
    assert.match(t.turns[0]?.note ?? '', /image_url/);
  });

  it('counts tool calls rather than dumping their arguments', () => {
    const t = parseRequestTranscript(
      JSON.stringify({
        messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] }],
      }),
    );
    assert.equal(t.turns[0]?.note, '2 tool calls');
  });

  it('handles a bare /v1/completions prompt', () => {
    const t = parseRequestTranscript(JSON.stringify({ prompt: 'once upon a time' }));
    assert.deepEqual(t.turns, [{ role: 'prompt', text: 'once upon a time' }]);
  });

  it('reports truncated JSON as unparsed instead of throwing', () => {
    const t = parseRequestTranscript('{"messages":[{"role":"user","content":"hal');
    assert.equal(t.unparsed, true);
    assert.equal(t.turns.length, 0);
  });

  it('survives an empty body', () => {
    assert.equal(parseRequestTranscript('').unparsed, true);
  });
});

describe('response transcripts', () => {
  it('reads a non-streamed completion', () => {
    const t = parseResponseTranscript(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Rayleigh scattering.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
    );
    assert.equal(t.turns[0]?.text, 'Rayleigh scattering.');
  });

  it('reassembles an SSE stream into one turn', () => {
    const body = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"Ray"}}]}',
      'data: {"choices":[{"delta":{"content":"leigh"}}]}',
      'data: {"choices":[{"delta":{"content":" scattering."},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');

    const t = parseResponseTranscript(body);
    assert.equal(t.turns.length, 1, 'one reply, not one turn per frame');
    assert.equal(t.turns[0]?.text, 'Rayleigh scattering.');
    assert.match(t.turns[0]?.note ?? '', /finish: stop/);
  });

  it('keeps what it has when a drain cut the stream mid-frame', () => {
    // Exactly what the drain ceiling produces: no [DONE], no finish_reason, and
    // a final frame that stops in the middle of its JSON.
    const body = [
      'data: {"choices":[{"delta":{"content":"half a "}}]}',
      'data: {"choices":[{"delta":{"content":"tho',
    ].join('\n\n');

    const t = parseResponseTranscript(body);
    assert.equal(t.turns[0]?.text, 'half a ', 'the complete frames still count');
    assert.match(t.turns[0]?.note ?? '', /cut short/);
  });

  it('surfaces an upstream error body as an error turn', () => {
    const t = parseResponseTranscript(JSON.stringify({ error: { message: 'context length exceeded' } }));
    assert.equal(t.turns[0]?.role, 'error');
    assert.equal(t.turns[0]?.text, 'context length exceeded');
  });

  it('reports an unrecognised body as unparsed so the caller shows it raw', () => {
    const t = parseResponseTranscript('<html>gateway timeout</html>');
    assert.equal(t.unparsed, true);
  });
});
