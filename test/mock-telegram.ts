/**
 * A local HTTP server that mimics the Telegram Bot API for tests.
 * Records every call; returns realistic results; supports injected failures.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TgCall {
  method: string;
  payload: Record<string, unknown>;
  at: number;
}

type Failure = { error_code: number; description: string; parameters?: Record<string, unknown> };
type Responder = (payload: Record<string, unknown>, call: TgCall) => unknown | Failure | undefined;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Small multipart parser (grammY style: no spaces, unquoted filename, attach:// references). */
function parseMultipart(body: Buffer, boundary: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const files = new Map<string, string>();
  const text = body.toString('latin1');
  for (const part of text.split(`--${boundary}`)) {
    const m = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="?([^"\r\n;]*)"?)?/i.exec(part);
    if (!m) continue;
    const idx = part.indexOf('\r\n\r\n');
    const value = part.slice(idx + 4).replace(/\r\n$/, '');
    const name = m[1] as string;
    if (m[2] !== undefined) {
      files.set(name, `<file:${m[2]}:${value.length}>`);
      out[name] = files.get(name);
      continue;
    }
    const utf8 = Buffer.from(value, 'latin1').toString('utf8');
    try {
      out[name] = JSON.parse(utf8);
    } catch {
      out[name] = utf8;
    }
  }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.startsWith('attach://')) out[k] = files.get(v.slice('attach://'.length)) ?? v;
  }
  return out;
}

export class MockTelegram {
  readonly calls: TgCall[] = [];
  private server: Server;
  private nextMessageId = 100;
  private responders = new Map<string, Responder[]>();
  readonly files = new Map<string, Buffer>();
  private updates: Array<Record<string, unknown>> = [];
  private nextUpdateId = 1;
  port = 0;

  constructor() {
    this.server = createServer(async (req, res) => {
      const url = req.url ?? '/';
      const fileMatch = /^\/file\/bot[^/]+\/(.+)$/.exec(url);
      if (req.method === 'GET' && fileMatch) {
        const buf = this.files.get(decodeURIComponent(fileMatch[1] as string));
        if (!buf) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(buf);
        return;
      }
      const m = /^\/bot[^/]+\/(\w+)/.exec(url);
      if (!m) {
        res.writeHead(404);
        res.end();
        return;
      }
      const method = m[1] as string;
      const raw = await readBody(req);
      const ctype = req.headers['content-type'] ?? '';
      let payload: Record<string, unknown> = {};
      if (ctype.includes('application/json')) payload = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
      else if (ctype.includes('multipart/form-data')) payload = parseMultipart(raw, /boundary=(.+)$/.exec(ctype)?.[1] ?? '');
      const call: TgCall = { method, payload, at: Date.now() };
      if (method === 'getUpdates') {
        // Long-poll semantics: return queued updates, or [] after a short wait.
        const offset = Number(payload.offset ?? 0);
        this.updates = this.updates.filter((u) => Number(u.update_id) >= offset);
        if (!this.updates.length) await new Promise((r) => setTimeout(r, 200));
        const batch = this.updates.filter((u) => Number(u.update_id) >= offset);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: batch }));
        return;
      }
      this.calls.push(call);
      let result: unknown;
      const queue = this.responders.get(method);
      const responder = queue?.[0];
      if (responder) {
        const r = responder(payload, call);
        if (r !== undefined) {
          if (queue && queue.length > 1) queue.shift();
          if (r && typeof r === 'object' && 'error_code' in (r as object)) {
            const f = r as Failure;
            res.writeHead(f.error_code === 429 ? 429 : 400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error_code: f.error_code, description: f.description, parameters: f.parameters }));
            return;
          }
          result = r;
        }
      }
      if (result === undefined) result = this.defaultResult(method, payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get apiRoot(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Queue an update for getUpdates (long polling smoke tests). */
  pushUpdate(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
  }

  /** Customize responses for a method (sticky: the last responder stays active). */
  on(method: string, responder: Responder): void {
    const list = this.responders.get(method) ?? [];
    list.push(responder);
    this.responders.set(method, list);
  }

  /** Fail the next call to `method` once. */
  failOnce(method: string, failure: Failure): void {
    let used = false;
    this.on(method, () => {
      if (used) return undefined;
      used = true;
      return failure;
    });
  }

  reset(): void {
    this.calls.length = 0;
    this.responders.clear();
  }

  callsOf(method: string): TgCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  async waitFor(pred: (calls: TgCall[]) => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!pred(this.calls)) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting; calls so far: ${this.methods().join(', ')}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  private message(payload: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const chatId = Number(payload.chat_id ?? 0);
    return {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: chatId < 0 ? { id: chatId, type: 'supergroup', title: 'Test Group' } : { id: chatId, type: 'private', first_name: 'Tester' },
      from: { id: 999, is_bot: true, first_name: 'Alya', username: 'alya_test_bot' },
      ...extra,
    };
  }

  private defaultResult(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'getMe':
        return { id: 999, is_bot: true, first_name: 'Alya', username: 'alya_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true };
      case 'sendMessage':
        return this.message(p, { text: String(p.text ?? '') });
      case 'sendRichMessage':
        return this.message(p, { rich_message: { blocks: [] } });
      case 'sendPhoto':
      case 'sendVoice':
      case 'sendDice':
      case 'sendPoll':
      case 'sendDocument':
        return this.message(p);
      case 'copyMessage':
        return { message_id: this.nextMessageId++ };
      case 'editMessageText':
        return p.inline_message_id ? true : this.message(p, { message_id: Number(p.message_id) });
      case 'answerGuestQuery':
        return { inline_message_id: 'guest-inline-1' };
      case 'getFile':
        return { file_id: String(p.file_id), file_unique_id: 'u1', file_size: 1234, file_path: `files/${String(p.file_id)}` };
      case 'createForumTopic':
        return { message_thread_id: 77, name: String(p.name ?? 'topic'), icon_color: 7322096 };
      case 'getChatMember':
        return { status: 'administrator', user: { id: Number(p.user_id), is_bot: false, first_name: 'Admin' }, can_be_edited: false };
      default:
        return true;
    }
  }
}
