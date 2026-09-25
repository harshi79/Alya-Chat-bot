/**
 * Smoke test of the real entry point: boots dist/index.js (or src via tsx) against
 * the mock servers with long polling, sends one message, checks the reply, then SIGTERM.
 * Run: npx tsx test/smoke/run.ts [dist|src]
 */
import { spawn } from 'node:child_process';
import { MockNvidia } from '../mock-nvidia.js';
import { MockTelegram } from '../mock-telegram.js';

const mode = process.argv[2] ?? 'dist';
const webhook = process.argv.includes('--webhook');
const tg = new MockTelegram();
const nv = new MockNvidia();
await tg.start();
await nv.start();
nv.chatHandler = () => ({ chunks: [{ content: 'Привет! ' }, { content: 'Smoke test passed ✨' }], delayMs: 50 });
const port = 18000 + Math.floor(Math.random() * 1000);
const env = {
  ...process.env,
  BOT_TOKEN: '123:SMOKE',
  TELEGRAM_API_ROOT: tg.apiRoot,
  NVIDIA_API_KEY: 'nvapi-smoke',
  NVIDIA_BASE_URL: `${nv.base}/v1`,
  NVIDIA_GENAI_URL: `${nv.base}/genai`,
  NVCF_URL_TEMPLATE: `${nv.base}/nvcf/{id}`,
  DB_FILE: `/tmp/alya-smoke-${Date.now()}.db`,
  PORT: String(port),
  LOG_LEVEL: 'info',
  WEBHOOK_URL: webhook ? `http://127.0.0.1:${port}` : '',
};
const cmd = mode === 'dist' ? ['node', ['dist/index.js']] : ['npx', ['tsx', 'src/index.ts']];
const child = spawn(cmd[0] as string, cmd[1] as string[], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
const fail = (msg: string) => {
  console.error(`SMOKE FAIL: ${msg}\n--- log ---\n${log}\n--- calls ---\n${tg.methods().join(', ')}`);
  child.kill('SIGKILL');
  process.exit(1);
};
try {
  await tg.waitFor((c) => c.some((x) => x.method === (webhook ? 'setWebhook' : 'deleteWebhook')), 15000);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as Record<string, unknown>;
  if (health.ok !== true || health.status !== 'running') fail(`bad health ${JSON.stringify(health)}`);
  console.log('health:', JSON.stringify(health));
  const update = { message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: 'private', first_name: 'Smoke' }, from: { id: 42, is_bot: false, first_name: 'Smoke' }, text: 'hello from smoke test' } };
  if (webhook) {
    const set = tg.callsOf('setWebhook')[0]!;
    const url = String(set.payload.url);
    const secret = String(set.payload.secret_token);
    const allowed = set.payload.allowed_updates as string[];
    if (!allowed.includes('guest_message') || !allowed.includes('stopped_message_generation')) fail('allowed_updates incomplete');
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' }, body: JSON.stringify({ update_id: 1, ...update }) });
    if (bad.status === 200) fail('webhook accepted a wrong secret');
    const t0 = Date.now();
    const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ update_id: 2, ...update }) });
    if (ok.status !== 200) fail(`webhook status ${ok.status}`);
    console.log(`webhook answered in ${Date.now() - t0}ms (AI work continues in the background)`);
  } else {
    tg.pushUpdate(update);
  }
  await tg.waitFor((c) => c.some((x) => x.method === 'sendRichMessage'), 15000);
  const final = tg.callsOf('sendRichMessage')[0]!;
  const md = (final.payload.rich_message as { markdown: string }).markdown;
  if (!md.includes('Smoke test passed')) fail(`unexpected reply ${md}`);
  await tg.waitFor((c) => c.some((x) => x.method === 'setMyCommands'), 5000);
  const cmds = tg.callsOf('setMyCommands');
  const group = cmds.find((c) => (c.payload.scope as { type: string }).type === 'all_group_chats')!;
  if (!(group.payload.commands as Array<{ is_ephemeral?: boolean }>).some((c) => c.is_ephemeral)) fail('group commands lack is_ephemeral');
  if (!webhook && !log.includes('long polling started')) fail('polling did not start');
  console.log('reply:', md);
  console.log('calls:', [...new Set(tg.methods())].join(', '));
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((r) => child.on('exit', r));
  if (code !== 0) fail(`exit code ${code}`);
  console.log(`SMOKE OK (${mode}${webhook ? ', webhook' : ', polling'}) — clean shutdown`);
} catch (err) {
  fail(String(err));
} finally {
  await tg.stop();
  await nv.stop();
}
