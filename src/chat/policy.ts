/** Small decision helpers: reasoning mode, reactions, message effects, action keyboards. */
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { ThinkingMode } from '../ai/nvidia.js';
import type { BrainMode } from '../db/store.js';
import { pick } from '../util/text.js';

/** Message effect ids (free; private chats only). Rejected ids are blacklisted at runtime. */
export const EFFECTS = {
  fire: '5104841245755180586',
  like: '5107584321108051014',
  heart: '5159385139981059251',
  party: '5046509860389126442',
} as const;

const COMPLEX_RE =
  /(\bsolve\b|\bprove\b|\bcalculate\b|\bcompute\b|integral|derivative|equation|theorem|algorithm|complexity|\bdebug\b|stack ?trace|traceback|exception|\berror\b|refactor|optimi[sz]e|step[- ]by[- ]step|\bexplain (how|why)\b|\bcompare\b|\bpros and cons\b|\bplan\b|\bstrategy\b|\bschedule\b|```|\bsql\b|regex|\bproof\b|\bmath\b|физик|реши|докажи)/i;

/** Choose reasoning for Nemotron: off for chit-chat, low effort for real problems, full for "deep". */
export function chooseThinking(text: string, brain: BrainMode, deep: boolean): { thinking: ThinkingMode; budget?: number } {
  if (deep) return { thinking: true, budget: 6144 };
  if (brain === 'fast') return { thinking: false };
  if (brain === 'deep') return { thinking: true, budget: 4096 };
  const long = text.length > 450;
  const mathy = /\d\s*[-+*/^×÷=]\s*\d/.test(text);
  if (COMPLEX_RE.test(text) || mathy || long) return { thinking: 'low', budget: 2048 };
  return { thinking: false };
}

interface ReactionRule {
  re: RegExp;
  emojis: string[];
  chance: number;
}

const REACTION_RULES: ReactionRule[] = [
  { re: /\b(i love you|love you|luv u|ily)\b|❤️|💕|💖|😘|люблю/i, emojis: ['❤', '🥰', '😍'], chance: 0.8 },
  { re: /\b(thanks|thank you|thx|ty|appreciate)\b|спасибо/i, emojis: ['🤗', '🥰', '❤'], chance: 0.55 },
  { re: /(\bha(ha)+\b|\blol\b|\blmao\b|😂|🤣|\bxd\b|хаха)/i, emojis: ['🤣', '😁'], chance: 0.55 },
  { re: /\b(i (passed|won|got the job|got accepted|did it|finished)|congrat|promotion|graduated|birthday)\b|🎉|🥳/i, emojis: ['🎉', '🏆', '🔥'], chance: 0.8 },
  { re: /\b(good ?night|gn|sleep well|going to sleep)\b|спокойной ночи/i, emojis: ['😴', '❤'], chance: 0.6 },
  { re: /\b(good morning|gm|morning)\b|доброе утро/i, emojis: ['🤗', '❤'], chance: 0.45 },
  { re: /\b(i'?m sad|feel(ing)? (down|bad|lonely)|depressed|crying|i miss)\b|😢|😭/i, emojis: ['🤗', '❤'], chance: 0.6 },
  { re: /\b(wow|omg|no way|holy)\b|😱|🤯/i, emojis: ['🤯', '😱'], chance: 0.45 },
  { re: /\b(you'?re|u r|ur) (so )?(cute|pretty|beautiful|smart|amazing|the best)\b/i, emojis: ['🥰', '😇', '❤'], chance: 0.8 },
  { re: /\b(cat|kitty|kitten)\b|🐱|🐈/i, emojis: ['😍', '🥰'], chance: 0.35 },
  { re: /\b(strawberr|tea|blini|pancake)\b/i, emojis: ['🍓', '🤩'], chance: 0.25 },
];

/** Pick a free emoji reaction for a user message (or null). */
export function pickReaction(text: string, rnd: () => number = Math.random): string | null {
  for (const rule of REACTION_RULES) {
    if (rule.re.test(text)) return rnd() < rule.chance ? (rule.emojis[Math.floor(rnd() * rule.emojis.length)] as string) : null;
  }
  return null;
}

/** Special moments deserve a message effect (private chats). */
export function chooseEffect(text: string, bond: number, milestone: boolean): string | undefined {
  if (milestone) return EFFECTS.fire;
  if (/\b(i passed|i won|got the job|got accepted|graduated|it'?s my birthday)\b|🎉|🥳/i.test(text)) return EFFECTS.party;
  if (bond >= 60 && /\b(i love you|love you)\b|❤️|люблю тебя/i.test(text)) return EFFECTS.heart;
  return undefined;
}

/** Buttons under an AI reply. One row, neutral styles (no colour for routine actions). */
export function actionKeyboard(replyId: string, opts: { voice: boolean; deep: boolean }): InlineKeyboardMarkup {
  const row: InlineKeyboardMarkup['inline_keyboard'][number] = [{ text: '🔄', callback_data: `rg:${replyId}` }];
  if (opts.voice) row.push({ text: '🔊', callback_data: `tts:${replyId}` });
  if (opts.deep) row.push({ text: '🧠 Think deeper', callback_data: `deep:${replyId}` });
  return { inline_keyboard: [row] };
}

export function stopNote(): string {
  return pick(['⏹ _stopped_', '⏹ _you stopped me_', '⏹ _okay, okay — stopped_']);
}
