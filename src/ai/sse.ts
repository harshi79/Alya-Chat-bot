/** Minimal Server-Sent Events reader for fetch() bodies (no dependencies). */

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let dataLines: string[] = [];
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (dataLines.length > 0) {
            yield dataLines.join('\n');
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith(':')) continue; // comment / keep-alive
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // "event:", "id:", "retry:" are ignored — OpenAI-style streams only use data
      }
    }
    buf += decoder.decode();
    const rest = buf.replace(/\r$/, '');
    if (rest.startsWith('data:')) dataLines.push(rest.slice(5).replace(/^ /, ''));
    if (dataLines.length > 0) yield dataLines.join('\n');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
