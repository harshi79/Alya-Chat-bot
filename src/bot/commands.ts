/** Bot command menus per scope (group personal commands are ephemeral — Bot API 10.2). */
import type { Api } from 'grammy';
import type { BotCommand } from 'grammy/types';
import { logger } from '../log.js';

const log = logger('commands');

export const PRIVATE_COMMANDS: BotCommand[] = [
  { command: 'start', description: 'Say hi to Alya' },
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'settings', description: 'Voice, brain, formatting & more' },
  { command: 'memory', description: 'What Alya remembers about you' },
  { command: 'profile', description: 'Your bond & streak with Alya' },
  { command: 'imagine', description: 'Ask Alya to draw something' },
  { command: 'quiz', description: 'Get a quiz on any topic' },
  { command: 'reminders', description: 'Your reminders' },
  { command: 'voice', description: 'Hear Alya say her last message' },
  { command: 'stop', description: 'Stop the current reply' },
  { command: 'about', description: 'About Alya' },
  { command: 'help', description: 'How to talk to Alya' },
  { command: 'forget', description: 'Delete all your data' },
];

export const GROUP_COMMANDS: BotCommand[] = [
  { command: 'settings', description: 'Your personal settings (only you see it)', is_ephemeral: true },
  { command: 'memory', description: 'What Alya remembers about you (private)', is_ephemeral: true },
  { command: 'profile', description: 'Your bond with Alya (private)', is_ephemeral: true },
  { command: 'reminders', description: 'Your reminders (private)', is_ephemeral: true },
  { command: 'help', description: 'How to talk to Alya (private)', is_ephemeral: true },
  { command: 'imagine', description: 'Ask Alya to draw something' },
  { command: 'quiz', description: 'Quiz the group on a topic' },
  { command: 'about', description: 'About Alya' },
  { command: 'stop', description: 'Stop Alya\'s current reply' },
  { command: 'new', description: 'Reset Alya\'s memory of this chat (admins)' },
  { command: 'groupsettings', description: 'Group settings (admins)' },
];

export async function syncCommands(api: Api, opts: { profile: boolean }): Promise<void> {
  try {
    await api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: 'all_private_chats' } });
    try {
      await api.setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } });
    } catch (err) {
      // Older Bot API servers reject is_ephemeral — fall back to plain commands.
      log.warn(`group commands with is_ephemeral rejected (${(err as Error).message}) — retrying without`);
      await api.setMyCommands(
        GROUP_COMMANDS.map(({ command, description }) => ({ command, description })),
        { scope: { type: 'all_group_chats' } },
      );
    }
    if (opts.profile) {
      await api.setMyShortDescription('Alya ❄️ 19, a shy girl from Saint Petersburg. Chat, voice, photos, drawings, reminders — powered by NVIDIA.');
      await api.setMyDescription(
        "Hi! I'm Alya — a shy 19-year-old girl from Saint Petersburg who studies math & CS and drinks too much tea ☕\n\nTalk to me about anything: I stream my replies live, understand voice messages and photos, draw pictures, set reminders and remember what matters to you.\n\nWorks in groups, inline and even in chats I'm not in (guest mode). Tap Start!",
      );
    }
    log.info('bot commands synced');
  } catch (err) {
    log.warn(`could not sync commands: ${(err as Error).message}`);
  }
}
