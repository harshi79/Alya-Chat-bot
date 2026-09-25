/**
 * Mock NVIDIA endpoints: OpenAI-compatible chat (SSE + JSON), NVCF ASR/TTS and GenAI images.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeWav } from '../src/ai/audio.js';

export interface ChatScript {
  /** Stream chunks (each becomes one SSE event). */
  chunks?: Array<{ content?: string; reasoning?: string; tool_calls?: unknown[] }>;
  finish?: string;
  /** Delay between chunks. */
  delayMs?: number;
  /** Respond with an HTTP error instead. */
  error?: { status: number; body: unknown; retryAfter?: number };
}

export interface NvRequest {
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

type ChatHandler = (body: Record<string, unknown>, index: number) => ChatScript;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export class MockNvidia {
  readonly requests: NvRequest[] = [];
  private server: Server;
  private chatIndex = 0;
  chatHandler: ChatHandler = () => ({ chunks: [{ content: 'Привет! ' }, { content: 'I am Alya.' }] });
  transcript = 'hello alya, how are you';
  asrStatus = 200;
  ttsStatus = 200;
  imageFinish = 'SUCCESS';
  port = 0;

  constructor() {
    this.server = createServer(async (req, res) => {
      const url = req.url ?? '/';
      const raw = await readBody(req);
      const ctype = req.headers['content-type'] ?? '';
      let body: unknown = raw.toString('utf8');
      if (ctype.includes('application/json')) body = JSON.parse(raw.toString('utf8') || '{}');
      this.requests.push({ path: url, body, headers: req.headers });

      if (url.endsWith('/chat/completions')) {
        const b = body as Record<string, unknown>;
        const script = this.chatHandler(b, this.chatIndex++);
        if (script.error) {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (script.error.retryAfter !== undefined) headers['retry-after'] = String(script.error.retryAfter);
          res.writeHead(script.error.status, headers);
          res.end(JSON.stringify(script.error.body));
          return;
        }
        const chunks = script.chunks ?? [];
        if (b.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const c of chunks) {
            const delta: Record<string, unknown> = {};
            if (c.content !== undefined) delta.content = c.content;
            if (c.reasoning !== undefined) delta.reasoning_content = c.reasoning;
            if (c.tool_calls !== undefined) delta.tool_calls = c.tool_calls;
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
            if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
          }
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: script.finish ?? 'stop' }], usage: { total_tokens: 42 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const content = chunks.map((c) => c.content ?? '').join('');
        const reasoning = chunks.map((c) => c.reasoning ?? '').join('');
        const toolCalls = chunks.flatMap((c) => (c.tool_calls as unknown[]) ?? []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: reasoning || undefined, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: script.finish ?? 'stop' }],
            usage: { total_tokens: 21 },
          }),
        );
        return;
      }
      if (url.includes('/v1/audio/transcriptions')) {
        res.writeHead(this.asrStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.asrStatus === 200 ? { text: this.transcript } : { detail: 'nope' }));
        return;
      }
      if (url.includes('/v1/audio/synthesize')) {
        if (this.ttsStatus !== 200) {
          res.writeHead(this.ttsStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: 'bad voice' }));
          return;
        }
        const sr = 22050;
        const pcm = new Int16Array(sr / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 330 * i) / sr) * 9000);
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(makeWav(pcm, sr));
        return;
      }
      if (url.includes('/genai/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ artifacts: [{ base64: TINY_PNG.toString('base64'), finishReason: this.imageFinish, seed: 1 }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  chatRequests(): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.path.endsWith('/chat/completions')).map((r) => r.body as Record<string, unknown>);
  }

  reset(): void {
    this.requests.length = 0;
    this.chatIndex = 0;
  }
}
