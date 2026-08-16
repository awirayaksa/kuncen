/**
 * A stand-in for vLLM: streams tokens slowly, reports usage, and — crucially —
 * records whether an aborted client actually caused the upstream generation to
 * stop. That last property is the one kuncen has to get right, so it is worth
 * being able to observe it directly.
 *
 *   npm run dev:fake-vllm            # listens on 127.0.0.1:8000
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeVllm {
  server: Server;
  port: number;
  url: string;
  /** Generations that stopped early because the client went away. */
  aborted: number;
  /** Generations that ran to completion. */
  completed: number;
  requests: Array<{ path: string; method: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

export interface FakeVllmOptions {
  port?: number;
  /** Milliseconds between streamed chunks. */
  chunkDelayMs?: number;
  chunks?: number;
  healthy?: boolean;
  /** Force every completion call to fail, to test the "vLLM hiccuped" rule. */
  failWith?: number;
}

export async function startFakeVllm(options: FakeVllmOptions = {}): Promise<FakeVllm> {
  const chunkDelay = options.chunkDelayMs ?? 20;
  const chunkCount = options.chunks ?? 5;

  const state: FakeVllm = {
    server: undefined as unknown as Server,
    port: 0,
    url: '',
    aborted: 0,
    completed: 0,
    requests: [],
    close: async () => {},
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    state.requests.push({
      path: url.pathname,
      method: req.method ?? 'GET',
      authorization: req.headers.authorization,
    });

    if (url.pathname === '/health') {
      res.writeHead(options.healthy === false ? 503 : 200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }

    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen', object: 'model' }] }));
      return;
    }

    if (options.failWith) {
      res.writeHead(options.failWith, { 'content-type': 'application/json' });
      res.end('{"error":"backend exploded"}');
      return;
    }

    void readBody(req).then((body) => {
      const wantsStream = body.includes('"stream":true') || body.includes('"stream": true');
      if (wantsStream) streamCompletion(res);
      else jsonCompletion(res);
    });
  });

  function jsonCompletion(res: ServerResponse): void {
    setTimeout(() => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-fake',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      );
      state.completed++;
    }, chunkDelay);
  }

  function streamCompletion(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let sent = 0;
    let stopped = false;
    let delivered = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Not `req`'s 'close': that fires as soon as the request body has been
      // read, long before the client goes away mid-stream.
      if (!delivered) state.aborted++;
    };
    res.on('close', () => {
      if (!res.writableFinished) stop();
    });

    const timer = setInterval(() => {
      if (stopped || res.writableEnded) return stop();
      if (sent < chunkCount) {
        res.write(
          `data: ${JSON.stringify({
            id: 'cmpl-fake',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: `tok${sent} ` } }],
            usage: null,
          })}\n\n`,
        );
        sent++;
        return;
      }
      clearInterval(timer);
      stopped = true;
      delivered = true;
      res.write(
        `data: ${JSON.stringify({
          id: 'cmpl-fake',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      state.completed++;
    }, chunkDelay);
  }

  await new Promise<void>((resolveListen) => server.listen(options.port ?? 0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 8000);

  state.server = server;
  state.port = port;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections?.();
      server.close(() => done());
    });
  return state;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
    });
    req.on('end', () => resolveBody(data));
    req.on('error', () => resolveBody(data));
  });
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('tools/fake-vllm.ts');
if (isMain) {
  void startFakeVllm({ port: Number(process.env.PORT ?? 8000), chunkDelayMs: 120, chunks: 40 }).then((v) => {
    console.log(`[fake-vllm] listening on ${v.url}`);
  });
}
