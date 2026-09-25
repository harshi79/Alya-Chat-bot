/**
 * Environment configuration. Every knob has a safe default so the bot boots
 * with nothing but BOT_TOKEN + NVIDIA_API_KEY. See .env.example for docs.
 */
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function envStr(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function envInt(name: string, fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(raw.trim().toLowerCase());
}

function envIds(name: string): number[] {
  return envStr(name)
    .split(/[\s,;]+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

export interface Config {
  botToken: string;
  apiRoot: string;
  ownerId: number;
  adminIds: number[];
  webhookUrl: string;
  webhookSecret: string;
  port: number;
  dbFile: string;
  developerUrl: string;
  syncCommands: boolean;
  syncProfile: boolean;
  defaultTimezone: string;
  logLevel: string;

  nvidiaKey: string;
  nvidiaBaseUrl: string;
  genaiBaseUrl: string;
  nvcfUrlTemplate: string;
  chatModel: string;
  lightModel: string;
  visionModel: string;
  imageModel: string;
  asrFunctionId: string;
  asrLanguage: string;
  ttsFunctionId: string;
  ttsVoice: string;
  ttsLanguage: string;
  ttsSampleRate: number;
  ttsEmotions: boolean;
  nvidiaRpm: number;
  maxTokens: number;
  aiTimeoutMs: number;
  toolsEnabled: boolean;

  userMsgsPerMin: number;
  dailyMessageLimit: number;
  dailyImageLimit: number;
  dailyVoiceLimit: number;
  historyMessages: number;
  maxMemories: number;
  streamIntervalMs: number;
  editIntervalMs: number;
}

export function loadConfig(): Config {
  const ownerId = envInt('OWNER_ID', 7728424218);
  return {
    botToken: envStr('BOT_TOKEN'),
    apiRoot: envStr('TELEGRAM_API_ROOT', 'https://api.telegram.org').replace(/\/+$/, ''),
    ownerId,
    adminIds: Array.from(new Set([ownerId, ...envIds('ADMIN_IDS')])),
    webhookUrl: envStr('WEBHOOK_URL').replace(/\/+$/, ''),
    webhookSecret: envStr('WEBHOOK_SECRET'),
    port: envInt('PORT', envInt('HEALTH_PORT', 8080), 0, 65535),
    dbFile: envStr('DB_FILE', 'data/alya.db'),
    developerUrl: envStr('DEVELOPER_URL', 'https://t.me/WhoEvenYori'),
    syncCommands: envBool('SYNC_COMMANDS', true),
    syncProfile: envBool('SYNC_PROFILE', false),
    defaultTimezone: envStr('DEFAULT_TIMEZONE', 'UTC'),
    logLevel: envStr('LOG_LEVEL', 'info'),

    nvidiaKey: envStr('NVIDIA_API_KEY', envStr('NVIDIA_KEY')),
    nvidiaBaseUrl: envStr('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
    genaiBaseUrl: envStr('NVIDIA_GENAI_URL', 'https://ai.api.nvidia.com/v1/genai').replace(/\/+$/, ''),
    nvcfUrlTemplate: envStr('NVCF_URL_TEMPLATE', 'https://{id}.invocation.api.nvcf.nvidia.com').replace(/\/+$/, ''),
    chatModel: envStr('CHAT_MODEL', 'nvidia/nemotron-3-super-120b-a12b'),
    lightModel: envStr('LIGHT_MODEL', 'nvidia/nemotron-3-nano-30b-a3b'),
    visionModel: envStr('VISION_MODEL', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'),
    imageModel: envStr('IMAGE_MODEL', 'black-forest-labs/flux.1-schnell'),
    asrFunctionId: envStr('ASR_FUNCTION_ID', '1598d209-5e27-4d3c-8079-4751568b1081'),
    asrLanguage: envStr('ASR_LANGUAGE', 'en-US'),
    ttsFunctionId: envStr('TTS_FUNCTION_ID', '877104f7-e885-42b9-8de8-f6e4c6303969'),
    ttsVoice: envStr('TTS_VOICE', 'Magpie-Multilingual.EN-US.Aria'),
    ttsLanguage: envStr('TTS_LANGUAGE', 'en-US'),
    ttsSampleRate: envInt('TTS_SAMPLE_RATE', 22050, 8000, 48000),
    ttsEmotions: envBool('TTS_EMOTIONS', true),
    nvidiaRpm: envInt('NVIDIA_RPM', 36, 1, 1000),
    maxTokens: envInt('MAX_TOKENS', 4096, 256, 65536),
    aiTimeoutMs: envInt('AI_TIMEOUT_MS', 120_000, 5_000, 900_000),
    toolsEnabled: envBool('TOOLS_ENABLED', true),

    userMsgsPerMin: envInt('USER_MSGS_PER_MIN', 12, 1, 1000),
    dailyMessageLimit: envInt('DAILY_MESSAGE_LIMIT', 300, 0),
    dailyImageLimit: envInt('DAILY_IMAGE_LIMIT', 15, 0),
    dailyVoiceLimit: envInt('DAILY_VOICE_LIMIT', 40, 0),
    historyMessages: envInt('HISTORY_MESSAGES', 24, 4, 200),
    maxMemories: envInt('MAX_MEMORIES', 60, 5, 500),
    streamIntervalMs: envInt('STREAM_INTERVAL_MS', 900, 250, 10_000),
    editIntervalMs: envInt('EDIT_INTERVAL_MS', 1600, 500, 20_000),
  };
}

export const config: Config = loadConfig();

export function isAdmin(userId: number | undefined, cfg: Config = config): boolean {
  return userId !== undefined && cfg.adminIds.includes(userId);
}
