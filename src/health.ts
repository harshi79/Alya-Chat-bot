/** Health endpoints (Render/Docker) + optional Telegram webhook on the same port. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { logger } from './log.js';

const log = logger('http');

export interface HealthInfo {
  (): Record<string, unknown>;
}

export function startHttpServer(
  port: number,
  info: HealthInfo,
  webhook?: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown },
): Server {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    if (webhook && req.method === 'POST' && url === webhook.path) {
      Promise.resolve(webhook.handler(req, res)).catch((err) => {
        log.error('webhook handler failed', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }
    if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/healthz')) {
      const body = JSON.stringify({ ok: true, ...info() });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
  });
  server.listen(port, '0.0.0.0', () => log.info(`health server on :${port}${webhook ? ' (webhook enabled)' : ''}`));
  server.on('error', (err) => log.error('http server error', err));
  return server;
}
