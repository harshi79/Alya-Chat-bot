/**
 * UI screens built from typed rich blocks (Bot API 10.2+) with coloured,
 * disabled and copy buttons (9.4 / 10.3). Every screen also renders on the
 * classic HTML path via blocksToHtml().
 *
 * Colour rules: at most one `primary` CTA per screen, `success` only for a
 * committed positive action, `danger` only for destroying saved data.
 */
import type { InlineKeyboardButton, InlineKeyboardMarkup, UserFromGetMe } from 'grammy/types';
import type { ChatSettings, MemoryRow, ReminderRow, UserRow } from '../db/store.js';
import { ALYA } from '../persona/alya.js';
import { bondLevel, nextBondLevel, progressBar } from '../persona/bond.js';
import { dailyMood } from '../persona/mood.js';
import {
  b,
  buttons,
  code,
  details,
  divider,
  expandable,
  footer,
  h,
  i,
  link,
  list,
  map,
  p,
  pullquote,
  rbtn,
  rcopy,
  spoiler,
  table,
  time,
  type Screen,
} from '../rich/blocks.js';
import { truncate } from '../util/text.js';
import { unix } from '../util/time.js';

type Btn = InlineKeyboardButton;
type Style = 'primary' | 'success' | 'danger';

export const btn = (text: string, data: string, style?: Style): Btn => (style ? { text, callback_data: data, style } : { text, callback_data: data });
export const disabledBtn = (text: string): Btn => ({ text, disabled: {} });
export const urlBtn = (text: string, url: string, style?: Style): Btn => (style ? { text, url, style } : { text, url });
const kb = (rows: Btn[][], forceReply = false): InlineKeyboardMarkup => (forceReply ? { inline_keyboard: rows, force_reply: true } : { inline_keyboard: rows });

export function inviteLink(me: UserFromGetMe, userId?: number): string {
  return `https://t.me/${me.username}${userId ? `?start=ref_${userId}` : ''}`;
}

// ------------------------------------------------------------ welcome & help

export function welcomeScreen(me: UserFromGetMe, name: string, isNew: boolean): Screen {
  return {
    blocks: [
      h(2, `Привет, ${name}! I'm Alya ✨`),
      p(
        'A 19-year-old girl from ',
        b('Saint Petersburg'),
        ' who studies math & CS, drinks far too much tea and loves winter. Talk to me about anything — or ask for help. I ',
        i('am'),
        ' a top student, after all 😤',
      ),
      table(
        ['', 'What I can do'],
        [
          ['💬', 'Chat with live streaming replies — tables, code, math'],
          ['🎙', 'Listen to your voice messages (and answer with my voice)'],
          ['👀', 'Look at photos, screenshots, homework and videos'],
          ['🎨', 'Draw pictures for you'],
          ['⏰', 'Remind you of things, in your own timezone'],
          ['🧠', 'Remember what matters to you'],
          ['👥', 'Join your groups — or just @mention me anywhere'],
        ],
        { compact: true, align: ['center', 'left'] },
      ),
      details('🪄 Use me outside this chat', [
        list([
          [p(b('Inline: '), 'type ', code(`@${me.username} your question`), ' in any chat.')],
          [p(b('Guest mode: '), 'mention ', code(`@${me.username}`), " in a chat I'm not in — I'll still answer."),],
          [p(b('Groups: '), 'add me, then mention me or reply to my messages.')],
        ]),
      ]),
      footer(isNew ? 'Say hi — I don\'t bite. Usually. 🐾' : 'Welcome back! I missed… I mean, hi. 🙈'),
    ],
    keyboard: kb([
      [btn("💬 Let's talk!", 'talk', 'primary')],
      [btn('⚙️ Settings', 'scr:settings'), btn('❓ Help', 'scr:help'), btn('🌸 About me', 'scr:about')],
      [
        urlBtn('👥 Add me to a group', `https://t.me/${me.username}?startgroup=alya`),
        { text: '💌 Share', switch_inline_query_chosen_chat: { query: '', allow_user_chats: true, allow_group_chats: true } },
      ],
    ]),
  };
}

export function helpScreen(me: UserFromGetMe): Screen {
  return {
    blocks: [
      h(2, '❓ How to talk to me'),
      details('💬 Chatting', [
        p('Just write to me like to a friend. For real questions I switch to ', b('top-student mode'), ' with tables, code blocks and LaTeX math.'),
        p('While I type you can press ', b('⏹'), ' to stop me. Under my replies: ', code('🔄'), ' retry · ', code('🔊'), ' hear it · ', code('🧠'), ' think deeper.'),
      ], true),
      details('🎙 Voice, 👀 photos & videos', [
        p('Send voice messages, round videos, photos, screenshots or text files. I listen and look, then answer. Turn on voice replies in ', b('/settings'), '.'),
      ]),
      details('🎨 Drawing & 🎲 games', [p('"Draw a cat in a winter scarf", ', code('/imagine …'), ', "roll a dice", "quiz me about space" or ', code('/quiz planets'), '.')]),
      details('⏰ Reminders & 🧠 memory', [
        p('"Remind me in 2 hours to drink water" or "remind me tomorrow at 9 to call mom". I show times in ', i('your'), ' timezone.'),
        p('I remember important things you tell me. See or delete them with ', code('/memory'), '.'),
      ]),
      details('👥 Groups, guest mode & inline', [
        p('In groups I answer when mentioned, when you reply to me, or when you say my name. ', code('/settings'), ', ', code('/memory'), ' and ', code('/profile'), ' are ', b('ephemeral'), ' there — only you see them.'),
        p('Guest mode: mention ', code(`@${me.username}`), ' in any chat, even if I\'m not a member. Inline: type ', code(`@${me.username} question`), '.'),
      ]),
      details('🧵 Separate conversations', [p(code('/new'), ' starts a fresh conversation. If topics are enabled for me, each topic is its own chat and I give it a title.')]),
      table(
        ['Command', 'What it does'],
        [
          ['/new', 'Fresh conversation'],
          ['/settings', 'Voice, brain, formatting…'],
          ['/memory', 'What I remember'],
          ['/profile', 'Our bond & streak'],
          ['/imagine', 'Draw something'],
          ['/quiz', 'Quiz time'],
          ['/reminders', 'Your reminders'],
          ['/stop', 'Stop my reply'],
          ['/about', 'About me'],
          ['/forget', 'Delete all your data'],
        ],
        { compact: true, striped: true, align: ['left', 'left'] },
      ),
    ],
    keyboard: kb([[btn('⬅️ Back', 'scr:home')]]),
  };
}

export function aboutScreen(now: Date, developerUrl: string): Screen {
  const mood = dailyMood(now);
  return {
    blocks: [
      h(2, 'Alya · Аля ❄️'),
      table(
        null,
        [
          [b('Full name'), ALYA.fullName],
          [b('Age'), `${ALYA.age}`],
          [b('From'), `${ALYA.city} 🇷🇺`],
          [b('Studies'), 'Applied Math & CS, SPbU (2nd year)'],
          [b('Birthday'), `${ALYA.birthday} (Orthodox Christmas!)`],
          [b('Cat'), 'Pelmeni — grey, fluffy, a menace 🐈'],
          [b('Favourite book'), ALYA.favorites.book],
          [b('Loves'), 'winter, tea with raspberry jam, piano, anime (shh)'],
          [b('Mood today'), `${mood.emoji} ${mood.description.split(' — ')[0] ?? mood.description}`],
          [b('Time in Piter'), time(unix(now), 't', 'now')],
        ],
        { compact: true, align: ['left', 'left'] },
      ),
      map(ALYA.cityCoords.lat, ALYA.cityCoords.long, 13, 'Palace Square — my favourite place for night walks'),
      pullquote(['Не то чтобы мне нравилось с тобой болтать… ', spoiler('(It\'s not like I enjoy talking to you or anything…)')], 'Alya'),
      footer('AI companion · made by ', link('YorichiiPrime', developerUrl), ' · powered by NVIDIA NIM'),
    ],
    keyboard: kb([[btn('⬅️ Back', 'scr:home')]]),
  };
}

// ------------------------------------------------------------ settings

function choiceRow<T extends string>(current: T, options: Array<[T, string]>, key: string): Btn[] {
  return options.map(([value, label]) => (value === current ? disabledBtn(`✓ ${label}`) : btn(label, `set:${key}:${value}`)));
}

export function settingsScreen(user: UserRow): Screen {
  const s = user.settings;
  const onOff = (v: boolean) => (v ? 'On' : 'Off');
  return {
    blocks: [
      h(2, '⚙️ Settings'),
      table(
        ['Setting', 'Now'],
        [
          ['🔊 Voice replies', s.voice === 'off' ? 'Off' : s.voice === 'auto' ? 'When you send voice' : 'Always'],
          ['🧠 Brain', s.brain === 'fast' ? '⚡ Fast' : s.brain === 'deep' ? '🧠 Deep thinking' : '✨ Auto'],
          ['💭 Show my thoughts', onOff(s.showThoughts)],
          ['🎉 Message effects', onOff(s.effects)],
          ['😊 Reactions', onOff(s.reactions)],
          ['📝 Formatting', s.classic ? 'Classic' : 'Rich'],
          ['✏️ Nickname', s.nickname ?? '—'],
          ['🌍 Timezone', user.timezone ?? 'unknown'],
        ],
        { compact: true, align: ['left', 'left'] },
      ),
      footer('Brain: Fast answers instantly, Deep thinks longer (you can watch me think), Auto decides per question.'),
    ],
    keyboard: kb([
      choiceRow(s.voice, [['off', '🔇 Off'], ['auto', '🎙 Auto'], ['always', '🔊 Always']], 'voice'),
      choiceRow(s.brain, [['fast', '⚡ Fast'], ['auto', '✨ Auto'], ['deep', '🧠 Deep']], 'brain'),
      [btn(`💭 Thoughts: ${onOff(s.showThoughts)}`, 'set:thoughts:toggle'), btn(`🎉 Effects: ${onOff(s.effects)}`, 'set:effects:toggle')],
      [btn(`😊 Reactions: ${onOff(s.reactions)}`, 'set:reactions:toggle'), btn(`📝 ${s.classic ? 'Classic' : 'Rich'}`, 'set:classic:toggle')],
      [btn('✏️ Nickname', 'ask:nickname'), btn('🌍 Timezone', 'ask:timezone')],
      [btn('⬅️ Back', 'scr:home')],
    ]),
  };
}

/** A prompt that opens the reply field (10.3 force_reply on inline keyboards). */
export function askScreen(kind: 'nickname' | 'timezone' | 'imagine' | 'quiz'): Screen {
  const text: Record<typeof kind, [string, string]> = {
    nickname: ['✏️ What should I call you?', 'Reply to this message with a nickname (or "reset").'],
    timezone: ['🌍 Where do you live?', 'Reply with your city or an IANA timezone like Asia/Kolkata — then my reminders use your time.'],
    imagine: ['🎨 What should I draw?', 'Reply with a description — the more details, the better!'],
    quiz: ['🧩 Quiz about what?', 'Reply with a topic — space, anime, history, anything.'],
  };
  const [title, body] = text[kind];
  return { blocks: [h(3, title), p(body)], keyboard: kb([[btn('✖ Cancel', 'ask:cancel')]], true) };
}

// ------------------------------------------------------------ profile, memory, reminders

export function profileScreen(user: UserRow, memCount: number, remCount: number, me: UserFromGetMe): Screen {
  const lvl = bondLevel(user.bond);
  const next = nextBondLevel(user.bond);
  return {
    blocks: [
      h(2, `💞 You & Alya`),
      table(
        null,
        [
          [b('Bond'), `${lvl.emoji} ${lvl.label} · ${user.bond}/100`],
          ['', progressBar(user.bond)],
          [b('Streak'), `🔥 ${user.streak} day${user.streak === 1 ? '' : 's'} (best ${user.best_streak})`],
          [b('Days talked'), `${user.days_talked}`],
          [b('Messages'), `${user.messages}`],
          [b('Memories'), `${memCount}`],
          [b('Reminders'), `${remCount} pending`],
          [b('Friends since'), time(Math.floor(user.created_at / 1000), 'D', new Date(user.created_at).toISOString().slice(0, 10))],
        ],
        { compact: true, align: ['left', 'left'] },
      ),
      expandable(
        next
          ? `Next level: ${next.emoji} ${next.label} at ${next.min}. Talk to me on different days, keep your streak and react ❤ to messages you like.`
          : 'You reached the top. Не говори никому… (Don\'t tell anyone…) 👑',
      ),
      buttons([rcopy('📋 Copy invite link', inviteLink(me, user.id))]),
    ],
    keyboard: kb([[btn('🧠 Memories', 'scr:memory'), btn('⏰ Reminders', 'scr:reminders')], [btn('⬅️ Back', 'scr:home')]]),
  };
}

const MEM_PAGE = 8;

export function memoryScreen(memories: MemoryRow[], page = 0): Screen {
  const pages = Math.max(1, Math.ceil(memories.length / MEM_PAGE));
  const pg = Math.min(Math.max(0, page), pages - 1);
  const slice = memories.slice(pg * MEM_PAGE, pg * MEM_PAGE + MEM_PAGE);
  const blocks = [h(2, '🧠 What I remember about you')];
  if (memories.length === 0) {
    blocks.push(p(i('Nothing yet… tell me about yourself! 🌸')));
  } else {
    blocks.push(list(slice.map((m, idx) => `${pg * MEM_PAGE + idx + 1}. ${truncate(m.fact, 200)}`)));
    blocks.push(footer(`I learn these while we talk. Tap 🗑 to make me forget one.${pages > 1 ? ` Page ${pg + 1}/${pages}.` : ''}`));
  }
  const rows: Btn[][] = [];
  const del = slice.map((m, idx) => btn(`🗑 ${pg * MEM_PAGE + idx + 1}`, `mem:del:${m.id}:${pg}`));
  for (let k = 0; k < del.length; k += 4) rows.push(del.slice(k, k + 4));
  if (pages > 1) rows.push([pg > 0 ? btn('◀️', `mem:page:${pg - 1}`) : disabledBtn('·'), disabledBtn(`${pg + 1}/${pages}`), pg < pages - 1 ? btn('▶️', `mem:page:${pg + 1}`) : disabledBtn('·')]);
  if (memories.length) rows.push([btn('🧹 Forget everything', 'mem:wipe', 'danger')]);
  rows.push([btn('⬅️ Back', 'scr:profile')]);
  return { blocks, keyboard: kb(rows) };
}

export function confirmWipeScreen(what: 'memories' | 'everything'): Screen {
  return {
    blocks: [
      h(3, what === 'memories' ? '🧹 Forget all memories?' : '⚠️ Delete all your data?'),
      p(
        what === 'memories'
          ? 'I\'ll forget everything I learned about you. Our chat history stays.'
          : 'This deletes your profile, chat history, memories, reminders and settings. It can\'t be undone.',
      ),
    ],
    keyboard: kb([[btn(what === 'memories' ? '🧹 Yes, forget' : '🗑 Yes, delete everything', what === 'memories' ? 'mem:wipe:yes' : 'forget:yes', 'danger'), btn('Cancel', what === 'memories' ? 'scr:memory' : 'scr:home')]]),
  };
}

export function remindersScreen(reminders: ReminderRow[]): Screen {
  const blocks = [h(2, '⏰ Your reminders')];
  if (!reminders.length) {
    blocks.push(p(i('No reminders. Try: "remind me in 30 minutes to stretch" ✨')));
  } else {
    blocks.push(
      list(
        reminders.slice(0, 20).map((r) => [p(time(Math.floor(r.due_at / 1000), 'wDT', new Date(r.due_at).toISOString().slice(0, 16).replace('T', ' ')), ' — ', truncate(r.text, 150))]),
      ),
    );
    blocks.push(footer('Times are shown in your own timezone.'));
  }
  const rows: Btn[][] = [];
  const cancel = reminders.slice(0, 12).map((r, idx) => btn(`❌ ${idx + 1}`, `rem:cancel:${r.id}`));
  for (let k = 0; k < cancel.length; k += 4) rows.push(cancel.slice(k, k + 4));
  rows.push([btn('⬅️ Back', 'scr:profile')]);
  return { blocks, keyboard: kb(rows) };
}

export function reminderFireScreen(text: string, reminderId: number): Screen {
  return {
    blocks: [h(3, '⏰ Reminder!'), p(b(text)), footer('You asked me to remind you — so here I am. Don\'t ignore me 😤')],
    keyboard: kb([[btn('💤 +10 min', `rem:snooze:${reminderId}:10`), btn('💤 +1 hour', `rem:snooze:${reminderId}:60`), btn('✅ Done', `rem:done:${reminderId}`, 'success')]]),
  };
}

// ------------------------------------------------------------ groups

export function groupWelcomeScreen(me: UserFromGetMe): Screen {
  return {
    blocks: [
      h(3, 'Привет, everyone! I\'m Alya ✨'),
      p('Mention me (', code(`@${me.username}`), '), say my name, or reply to my messages to talk. I can see photos, hear voice messages and draw.'),
      p(code('/settings'), ', ', code('/memory'), ' and ', code('/profile'), ' are private here — only you see them.'),
      footer('Admins: /groupsettings'),
    ],
  };
}

export function groupSettingsScreen(settings: ChatSettings): Screen {
  return {
    blocks: [
      h(3, '👥 Group settings'),
      table(
        null,
        [
          ['When I reply', settings.replyMode === 'mention' ? 'Only @mentions & replies' : 'Mentions, replies or my name'],
          ['Reactions', settings.reactions ? 'On' : 'Off'],
        ],
        { compact: true, align: ['left', 'left'] },
      ),
    ],
    keyboard: kb([
      choiceRow(settings.replyMode, [['mention', '@ Mentions only'], ['name', '🌸 Name too']], 'g:reply'),
      [btn(`😊 Reactions: ${settings.reactions ? 'On' : 'Off'}`, 'set:g:reactions:toggle')],
    ]),
  };
}

export function privateOnlyScreen(me: UserFromGetMe, what: string): Screen {
  return {
    blocks: [p(`🤫 Let's talk about ${what} in private.`)],
    keyboard: kb([[urlBtn('💬 Open private chat', `https://t.me/${me.username}?start=${what.replace(/\W+/g, '')}`)]]),
  };
}

// ------------------------------------------------------------ admin

export interface AdminStats {
  users: { total: number; active24h: number; active7d: number; banned: number; blocked: number };
  groups: number;
  stats: Record<string, number>;
  today: Record<string, number>;
  uptime: string;
  model: string;
  queue: { active: number; pending: number; streaming: number; limiterFree: number };
  maintenance: boolean;
  rich: string;
}

export function adminScreen(a: AdminStats): Screen {
  const n = (k: string) => String(a.stats[k] ?? 0);
  return {
    blocks: [
      h(2, '🛠 Alya — admin'),
      table(
        ['Metric', 'Value'],
        [
          ['Users (total)', String(a.users.total)],
          ['Active 24h / 7d', `${a.users.active24h} / ${a.users.active7d}`],
          ['Banned / blocked', `${a.users.banned} / ${a.users.blocked}`],
          ['Groups', String(a.groups)],
          ['Replies (all time)', n('replies')],
          ['Replies today', String(a.today.reply ?? 0)],
          ['Tokens', n('tokens')],
          ['Tool calls', n('tool_calls')],
          ['Images / voice replies', `${n('images')} / ${n('voice_replies')}`],
          ['Voice notes heard', n('voice_in')],
          ['Errors', n('errors')],
        ],
        { compact: true, striped: true },
      ),
      table(
        null,
        [
          ['Model', a.model],
          ['Uptime', a.uptime],
          ['Generating now', String(a.queue.streaming)],
          ['Queue (active / pending)', `${a.queue.active} / ${a.queue.pending}`],
          ['NVIDIA RPM left', String(a.queue.limiterFree)],
          ['Rendering', a.rich],
          ['Maintenance', a.maintenance ? 'ON' : 'off'],
        ],
        { compact: true },
      ),
      divider(),
      details('Commands', [
        list([
          '/broadcast — reply to a message to copy it to all users',
          '/ban <id> · /unban <id>',
          '/model <name> — switch chat model (or "reset")',
          '/avatar — reply to a photo to set my profile photo',
          '/maintenance on|off',
        ]),
      ]),
    ],
    keyboard: kb([[btn('🔄 Refresh', 'adm:refresh'), btn(a.maintenance ? '✅ End maintenance' : '🛠 Maintenance', 'adm:maint', a.maintenance ? 'success' : undefined)]]),
  };
}
