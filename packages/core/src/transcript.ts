/**
 * Turns a recorded body back into something a person can read.
 *
 * A raw trace is not a conversation: the request is one JSON object with the
 * whole message history in it, and the response is either a single JSON blob or
 * a few hundred SSE frames each carrying one token. This module reassembles
 * both into turns.
 *
 * Everything here is defensive. A body may be truncated at the size cap, cut off
 * mid-stream by a drain, or simply not be chat at all — none of which is allowed
 * to throw, because the alternative is a trace page that 500s on the one request
 * you wanted to look at.
 */

export interface TranscriptTurn {
  role: string;
  text: string;
  /** Set when the turn is not plain prose — a tool call, an image part. */
  note?: string;
}

export interface Transcript {
  turns: TranscriptTurn[];
  /** True when nothing could be parsed and the caller should show raw text. */
  unparsed: boolean;
}

const empty = (): Transcript => ({ turns: [], unparsed: true });

/** Flattens the string-or-parts shape the OpenAI schema allows for `content`. */
function flattenContent(content: unknown): { text: string; note?: string } {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return { text: '' };

  const bits: string[] = [];
  const other: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      bits.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: unknown; text?: unknown };
    if (typeof p.text === 'string') bits.push(p.text);
    else if (typeof p.type === 'string') other.push(p.type);
  }
  return {
    text: bits.join('\n'),
    note: other.length ? `+ ${other.join(', ')}` : undefined,
  };
}

export function parseRequestTranscript(body: string): Transcript {
  const obj = tryJson(body);
  if (!obj) return empty();

  const messages = (obj as { messages?: unknown }).messages;
  if (Array.isArray(messages)) {
    const turns: TranscriptTurn[] = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const msg = m as { role?: unknown; content?: unknown; tool_calls?: unknown };
      const { text, note } = flattenContent(msg.content);
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0;
      turns.push({
        role: typeof msg.role === 'string' ? msg.role : 'unknown',
        text,
        note: calls ? `${calls} tool call${calls === 1 ? '' : 's'}` : note,
      });
    }
    return { turns, unparsed: turns.length === 0 };
  }

  // /v1/completions — a bare prompt rather than a message list.
  const prompt = (obj as { prompt?: unknown }).prompt;
  if (typeof prompt === 'string') return { turns: [{ role: 'prompt', text: prompt }], unparsed: false };
  if (Array.isArray(prompt)) {
    return {
      turns: prompt.filter((p) => typeof p === 'string').map((p) => ({ role: 'prompt', text: p as string })),
      unparsed: false,
    };
  }
  return empty();
}

export function parseResponseTranscript(body: string): Transcript {
  const trimmed = body.trimStart();
  if (!trimmed) return empty();

  // Server-sent events: one frame per token, reassembled into one turn.
  if (trimmed.startsWith('data:') || trimmed.includes('\ndata:')) return parseSse(body);

  const obj = tryJson(body);
  if (!obj) return empty();

  // An upstream error passed through by the proxy.
  const err = (obj as { error?: { message?: unknown } }).error;
  if (err && typeof err === 'object') {
    const message = typeof err.message === 'string' ? err.message : JSON.stringify(err);
    return { turns: [{ role: 'error', text: message }], unparsed: false };
  }

  const choices = (obj as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return empty();

  const turns: TranscriptTurn[] = [];
  for (const ch of choices) {
    if (!ch || typeof ch !== 'object') continue;
    const choice = ch as { message?: { role?: unknown; content?: unknown; tool_calls?: unknown }; text?: unknown };
    if (choice.message) {
      const { text, note } = flattenContent(choice.message.content);
      const calls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls.length : 0;
      turns.push({
        role: typeof choice.message.role === 'string' ? choice.message.role : 'assistant',
        text,
        note: calls ? `${calls} tool call${calls === 1 ? '' : 's'}` : note,
      });
    } else if (typeof choice.text === 'string') {
      turns.push({ role: 'assistant', text: choice.text });
    }
  }
  return { turns, unparsed: turns.length === 0 };
}

/**
 * Concatenate `choices[].delta.content` across frames. A stream cut short by a
 * drain has no terminating `[DONE]` and often a half-written final frame; both
 * are normal here and neither is an error.
 */
function parseSse(body: string): Transcript {
  let text = '';
  let role = 'assistant';
  let toolCalls = 0;
  let frames = 0;
  let finish: string | null = null;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    const obj = tryJson(payload);
    if (!obj) continue; // truncated tail frame
    frames++;

    const choices = (obj as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) continue;
    for (const ch of choices) {
      if (!ch || typeof ch !== 'object') continue;
      const choice = ch as {
        delta?: { role?: unknown; content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      };
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.role === 'string') role = delta.role;
      if (typeof delta.content === 'string') text += delta.content;
      if (Array.isArray(delta.tool_calls)) toolCalls += delta.tool_calls.length;
    }
  }

  if (frames === 0) return empty();
  const notes: string[] = [`${frames} frames`];
  if (toolCalls) notes.push(`${toolCalls} tool-call deltas`);
  if (finish) notes.push(`finish: ${finish}`);
  else notes.push('no finish_reason — cut short');
  return { turns: [{ role, text, note: notes.join(' · ') }], unparsed: false };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}
