/**
 * NVIDIA NIM client — the only AI provider.
 *
 *   chat:   POST {base}/chat/completions   (OpenAI-compatible, SSE streaming)
 *   speech: POST {nvcf}/v1/audio/*          (NVCF HTTP invocation, multipart)
 *   images: POST {genai}/{model}            (FLUX etc.)
 *
 * Streaming yields content, reasoning and (at the end) assembled tool calls.
 * Retries happen only before the first byte was received — a partially
 * streamed answer is never silently duplicated.
 */
import { logger } from '../log.js';
import type { Priority, RateLimiter } from './limiter.js';
import { readSse } from './sse.js';

const log = logger('nvidia');

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'audio_url'; audio_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ThinkingMode = false | 'low' | true;

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  thinking?: ThinkingMode;
  reasoningBudget?: number;
  jsonMode?: boolean;
  extra?: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  /** Everything emitted as content so far was actually reasoning (stray </think>). */
  | { type: 'reclassify' }
  | { type: 'done'; finishReason: string | null; toolCalls: ToolCall[]; usage?: Usage };

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface Completion {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: Usage;
}

export type AIErrorKind = 'disabled' | 'auth' | 'rate' | 'model' | 'bad_request' | 'server' | 'timeout' | 'network' | 'aborted' | 'bad_response';

export class AIError extends Error {
  constructor(
    readonly kind: AIErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AIError';
  }

  get mentionsTools(): boolean {
    return /tool|function/i.test(this.message);
  }
}

export interface NvidiaOptions {
  apiKey: string;
  baseUrl: string;
  genaiUrl: string;
  nvcfTemplate: string;
  limiter: RateLimiter;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Abort a stream when no bytes arrive for this long. */
  streamIdleMs?: number;
  /** Absolute cap for one streamed answer. */
  streamHardMs?: number;
}

interface Posted {
  res: Response;
  cleanup: () => void;
  abort: (reason: string) => void;
  watchdog: (idleMs: number, hardMs: number) => { kick: () => void; stop: () => void };
  timedOut: () => boolean;
}

export interface BinaryResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export interface CallOptions {
  signal?: AbortSignal;
  priority?: Priority;
  timeoutMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AIError('aborted', 'aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AIError('aborted', 'aborted'));
      },
      { once: true },
    );
  });

/**
 * Splits `<think>…</think>` reasoning out of a content stream (for servers that
 * don't populate `reasoning_content`).
 */
export class ThinkSplitter {
  private state: 'start' | 'think' | 'content' = 'start';
  private buf = '';
  private sawReasoning = false;
  private emittedContent = false;

  constructor(private thinkingEnabled: boolean) {}

  markReasoningSeen(): void {
    this.sawReasoning = true;
  }

  push(text: string): StreamEvent[] {
    const out: StreamEvent[] = [];
    this.buf += text;
    for (;;) {
      if (this.state === 'start') {
        const trimmed = this.buf.trimStart();
        if (trimmed.startsWith('<think>')) {
          this.buf = trimmed.slice('<think>'.length);
          this.state = 'think';
          continue;
        }
        if ('<think>'.startsWith(trimmed) && trimmed.length < '<think>'.length) {
          return out; // wait for more bytes
        }
        this.state = 'content';
        continue;
      }
      if (this.state === 'think') {
        const end = this.buf.indexOf('</think>');
        if (end >= 0) {
          const r = this.buf.slice(0, end);
          if (r) out.push({ type: 'reasoning', text: r });
          this.sawReasoning = true;
          this.buf = this.buf.slice(end + '</think>'.length).replace(/^\s+/, '');
          this.state = 'content';
          continue;
        }
        const keep = partialSuffix(this.buf, '</think>');
        const r = this.buf.slice(0, this.buf.length - keep);
        if (r) {
          out.push({ type: 'reasoning', text: r });
          this.sawReasoning = true;
        }
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      // content
      const stray = this.buf.indexOf('</think>');
      if (stray >= 0 && this.thinkingEnabled && !this.sawReasoning) {
        const before = this.buf.slice(0, stray);
        if (this.emittedContent) out.push({ type: 'reclassify' });
        if (before) out.push({ type: 'reasoning', text: before });
        this.sawReasoning = true;
        this.emittedContent = false;
        this.buf = this.buf.slice(stray + '</think>'.length).replace(/^\s+/, '');
        continue;
      }
      const keep = this.thinkingEnabled && !this.sawReasoning ? partialSuffix(this.buf, '</think>') : 0;
      const c = this.buf.slice(0, this.buf.length - keep);
      if (c) {
        out.push({ type: 'content', text: c });
        this.emittedContent = true;
      }
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  flush(): StreamEvent[] {
    if (!this.buf) return [];
    const rest = this.buf;
    this.buf = '';
    if (this.state === 'think') return [{ type: 'reasoning', text: rest }];
    return [{ type: 'content', text: rest }];
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `token`. */
function partialSuffix(s: string, token: string): number {
  const max = Math.min(s.length, token.length - 1);
  for (let n = max; n > 0; n--) {
    if (token.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

export class NvidiaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly opts: NvidiaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  get enabled(): boolean {
    return Boolean(this.opts.apiKey);
  }

  get limiter(): RateLimiter {
    return this.opts.limiter;
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 1.0,
      top_p: req.top_p ?? 0.95,
      max_tokens: req.max_tokens ?? 2048,
      stream,
    };
    if (req.top_k !== undefined) body.top_k = req.top_k;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    if (req.thinking !== undefined) {
      const kwargs: Record<string, unknown> = { enable_thinking: req.thinking !== false };
      if (req.thinking === 'low') kwargs.low_effort = true;
      body.chat_template_kwargs = kwargs;
      if (req.thinking !== false && req.reasoningBudget) body.reasoning_budget = req.reasoningBudget;
    }
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (stream) body.stream_options = { include_usage: true };
    return { ...body, ...(req.extra ?? {}) };
  }

  /** POST with limiter, timeout, retry-before-first-byte and error classification. */
  private async post(url: string, init: { body: string | FormData; headers: Record<string, string> }, call: CallOptions, label: string): Promise<Posted> {
    if (!this.enabled) throw new AIError('disabled', 'NVIDIA_API_KEY is not set — get a free key at build.nvidia.com');
    let attempt = 0;
    for (;;) {
      await this.opts.limiter.acquire(call.priority ?? 'normal', call.signal).catch(() => {
        throw new AIError('aborted', 'aborted');
      });
      const ctrl = new AbortController();
      const timeoutMs = call.timeoutMs ?? this.opts.timeoutMs;
      const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
      timer.unref?.();
      const onAbort = () => ctrl.abort(new Error('aborted'));
      call.signal?.addEventListener('abort', onAbort, { once: true });
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.opts.apiKey}`, ...init.headers },
          body: init.body,
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        call.signal?.removeEventListener('abort', onAbort);
        if (call.signal?.aborted) throw new AIError('aborted', 'aborted');
        const isTimeout = ctrl.signal.aborted;
        const e = new AIError(isTimeout ? 'timeout' : 'network', `${label}: ${isTimeout ? 'timed out' : `network error (${(err as Error)?.message ?? err})`}`);
        if (attempt < this.maxRetries && !isTimeout) {
          attempt += 1;
          await sleep(800 * attempt, call.signal);
          continue;
        }
        throw e;
      }
      const cleanup = () => {
        clearTimeout(timer);
        call.signal?.removeEventListener('abort', onAbort);
      };
      if (res.ok) {
        return {
          res,
          cleanup,
          abort: (reason: string) => ctrl.abort(new Error(reason)),
          /** Replace the whole-request timer with an idle watchdog (streams). */
          watchdog: (idleMs: number, hardMs: number) => {
            clearTimeout(timer);
            let idle: NodeJS.Timeout | null = null;
            const hard = setTimeout(() => ctrl.abort(new Error('timeout')), hardMs);
            hard.unref?.();
            const kick = () => {
              if (idle) clearTimeout(idle);
              idle = setTimeout(() => ctrl.abort(new Error('timeout')), idleMs);
              idle.unref?.();
            };
            kick();
            return {
              kick,
              stop: () => {
                if (idle) clearTimeout(idle);
                clearTimeout(hard);
              },
            };
          },
          timedOut: () => ctrl.signal.aborted && !call.signal?.aborted,
        };
      }
      cleanup();
      const raw = await res.text().catch(() => '');
      let detail = raw.slice(0, 400);
      try {
        const j = JSON.parse(raw) as Record<string, unknown>;
        const errObj = (j.error ?? {}) as Record<string, unknown>;
        detail = String(errObj.message ?? j.detail ?? j.message ?? j.title ?? detail);
      } catch {
        /* keep raw */
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        attempt += 1;
        const wait = retryAfterMs ?? (res.status === 429 ? 2500 * attempt : 1200 * attempt);
        log.warn(`${label}: HTTP ${res.status}, retry ${attempt}/${this.maxRetries} in ${wait}ms`);
        await sleep(Math.min(wait, 20_000), call.signal);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new AIError('auth', `${label}: NVIDIA key rejected (${res.status})`, res.status);
      if (res.status === 429) throw new AIError('rate', `${label}: NVIDIA rate limit`, 429, retryAfterMs);
      if (res.status === 404) throw new AIError('model', `${label}: not found — ${detail}`, 404);
      if (res.status >= 500) throw new AIError('server', `${label}: NVIDIA error ${res.status} — ${detail}`, res.status);
      throw new AIError('bad_request', `${label}: ${res.status} — ${detail}`, res.status);
    }
  }

  /** Stream a chat completion. */
  async *stream(req: ChatRequest, call: CallOptions = {}): AsyncGenerator<StreamEvent> {
    const posted = await this.post(
      `${this.opts.baseUrl}/chat/completions`,
      { body: JSON.stringify(this.buildBody(req, true)), headers: { 'content-type': 'application/json', accept: 'text/event-stream' } },
      call,
      'chat',
    );
    const res = posted.res;
    const dog = posted.watchdog(this.opts.streamIdleMs ?? 90_000, this.opts.streamHardMs ?? 600_000);
    const splitter = new ThinkSplitter(req.thinking !== undefined && req.thinking !== false);
    const tools = new Map<number, ToolAcc>();
    let finishReason: string | null = null;
    let usage: Usage | undefined;
    try {
      if (!res.body) throw new AIError('bad_response', 'chat: empty response body');
      const ctype = res.headers.get('content-type') ?? '';
      if (ctype.includes('application/json')) {
        // Server ignored stream=true — treat as a single completion.
        const data = (await res.json()) as Record<string, unknown>;
        const c = parseCompletion(data, req.thinking !== undefined && req.thinking !== false);
        if (c.reasoning) yield { type: 'reasoning', text: c.reasoning };
        if (c.content) yield { type: 'content', text: c.content };
        yield { type: 'done', finishReason: c.finishReason, toolCalls: c.toolCalls, usage: c.usage };
        return;
      }
      for await (const data of readSse(res.body, call.signal)) {
        dog.kick();
        if (data === '[DONE]') break;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.error) {
          const e = obj.error as Record<string, unknown>;
          throw new AIError('server', `chat stream error: ${String(e.message ?? JSON.stringify(e)).slice(0, 300)}`);
        }
        if (obj.usage) usage = obj.usage as Usage;
        const choices = obj.choices as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        if (!choice) continue;
        const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
        const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
        if (typeof reasoning === 'string' && reasoning) {
          splitter.markReasoningSeen();
          yield { type: 'reasoning', text: reasoning };
        }
        const content = delta.content;
        if (typeof content === 'string' && content) {
          for (const ev of splitter.push(content)) yield ev;
        }
        const tc = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(tc)) {
          for (const item of tc) {
            const idx = typeof item.index === 'number' ? item.index : tools.size;
            const acc = tools.get(idx) ?? { id: '', name: '', args: '' };
            if (typeof item.id === 'string' && item.id) acc.id = item.id;
            const fn = (item.function ?? {}) as Record<string, unknown>;
            if (typeof fn.name === 'string' && fn.name) acc.name = acc.name && acc.name !== fn.name ? acc.name + fn.name : fn.name;
            if (typeof fn.arguments === 'string') acc.args += fn.arguments;
            else if (fn.arguments && typeof fn.arguments === 'object') acc.args = JSON.stringify(fn.arguments);
            tools.set(idx, acc);
          }
        }
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      }
      for (const ev of splitter.flush()) yield ev;
    } catch (err) {
      if (call.signal?.aborted) throw new AIError('aborted', 'aborted');
      if (err instanceof AIError) throw err;
      if (posted.timedOut()) throw new AIError('timeout', 'chat stream stalled (no data)');
      throw new AIError('network', `chat stream interrupted: ${(err as Error)?.message ?? err}`);
    } finally {
      dog.stop();
      posted.cleanup();
    }
    const toolCalls: ToolCall[] = [...tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, t]) => t.name)
      .map(([i, t]) => ({ id: t.id || `call_${i}`, type: 'function' as const, function: { name: t.name, arguments: t.args || '{}' } }));
    yield { type: 'done', finishReason, toolCalls, usage };
  }

  /** Non-streaming completion. */
  async complete(req: ChatRequest, call: CallOptions = {}): Promise<Completion> {
    const posted = await this.post(
      `${this.opts.baseUrl}/chat/completions`,
      { body: JSON.stringify(this.buildBody(req, false)), headers: { 'content-type': 'application/json', accept: 'application/json' } },
      call,
      'chat',
    );
    try {
      const data = (await posted.res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!data) throw new AIError(posted.timedOut() ? 'timeout' : 'bad_response', 'chat: invalid JSON');
      return parseCompletion(data, req.thinking !== undefined && req.thinking !== false);
    } finally {
      posted.cleanup();
    }
  }

  /** Ask for JSON and parse it robustly (first {...} or [...] block). */
  async completeJson<T>(req: ChatRequest, call: CallOptions = {}): Promise<T | null> {
    const c = await this.complete({ ...req, thinking: req.thinking ?? false }, call);
    return extractJson<T>(c.content);
  }

  /** NVCF HTTP invocation (speech NIMs): multipart form → raw Response. */
  async nvcf(functionId: string, path: string, form: FormData, call: CallOptions = {}): Promise<BinaryResponse> {
    const base = this.opts.nvcfTemplate.replace('{id}', encodeURIComponent(functionId));
    const posted = await this.post(`${base}${path}`, { body: form, headers: {} }, call, `nvcf${path}`);
    try {
      const buf = Buffer.from(await posted.res.arrayBuffer());
      return { status: posted.res.status, contentType: posted.res.headers.get('content-type') ?? '', body: buf };
    } catch (err) {
      throw new AIError(posted.timedOut() ? 'timeout' : 'network', `nvcf${path}: ${(err as Error)?.message ?? err}`);
    } finally {
      posted.cleanup();
    }
  }

  /** NVIDIA GenAI endpoints (image generation). */
  async genai(model: string, body: Record<string, unknown>, call: CallOptions = {}): Promise<Record<string, unknown>> {
    const posted = await this.post(
      `${this.opts.genaiUrl}/${model}`,
      { body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json' } },
      call,
      `genai/${model}`,
    );
    try {
      const data = (await posted.res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!data) throw new AIError(posted.timedOut() ? 'timeout' : 'bad_response', 'genai: invalid JSON');
      return data;
    } finally {
      posted.cleanup();
    }
  }
}

export function parseCompletion(data: Record<string, unknown>, thinking: boolean): Completion {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  if (!choice) throw new AIError('bad_response', `chat: no choices (${JSON.stringify(data).slice(0, 200)})`);
  const msg = (choice.message ?? {}) as Record<string, unknown>;
  let reasoning = String(msg.reasoning_content ?? msg.reasoning ?? '');
  let content = typeof msg.content === 'string' ? msg.content : '';
  const splitter = new ThinkSplitter(thinking);
  if (reasoning) splitter.markReasoningSeen();
  let c = '';
  for (const ev of [...splitter.push(content), ...splitter.flush()]) {
    if (ev.type === 'content') c += ev.text;
    else if (ev.type === 'reasoning') reasoning += ev.text;
    else if (ev.type === 'reclassify') {
      reasoning += c;
      c = '';
    }
  }
  content = c;
  const rawCalls = (msg.tool_calls ?? []) as Array<Record<string, unknown>>;
  const toolCalls: ToolCall[] = rawCalls
    .map((t, i) => {
      const fn = (t.function ?? {}) as Record<string, unknown>;
      const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      return { id: String(t.id ?? `call_${i}`), type: 'function' as const, function: { name: String(fn.name ?? ''), arguments: args } };
    })
    .filter((t) => t.function.name);
  return {
    content: content.trim(),
    reasoning: reasoning.trim(),
    toolCalls,
    finishReason: (choice.finish_reason as string | null) ?? null,
    usage: data.usage as Usage | undefined,
  };
}

/** Extract the first JSON object/array from model output (handles ```json fences). */
export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const cand of candidates) {
    if (!cand) continue;
    const s = cand.trim();
    try {
      return JSON.parse(s) as T;
    } catch {
      /* try slicing */
    }
    const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0);
    for (const start of starts.sort((a, b) => a - b)) {
      const open = s[start];
      const close = open === '{' ? '}' : ']';
      const end = s.lastIndexOf(close);
      if (end > start) {
        try {
          return JSON.parse(s.slice(start, end + 1)) as T;
        } catch {
          /* next */
        }
      }
    }
  }
  return null;
}

/** Parse tool calls leaked into content as <tool_call>{json}</tool_call>. Returns cleaned text + calls. */
export function extractLeakedToolCalls(content: string): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  let i = 0;
  const text = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, body: string) => {
    const obj = extractJson<Record<string, unknown>>(body);
    if (obj && typeof obj.name === 'string') {
      const args = obj.arguments ?? obj.parameters ?? {};
      calls.push({
        id: `leaked_${i++}`,
        type: 'function',
        function: { name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      });
    }
    return '';
  });
  return { text: text.trim(), calls };
}
