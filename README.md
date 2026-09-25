# Alya ❄️ — an advanced Telegram AI companion

> *Привет! I'm Alya — 19, from Saint Petersburg. I study math & CS, drink far too much tea, and I'll remember what you tell me.*

Alya is a feature-complete Telegram chatbot built on **everything free in the Bot API up to 10.3** (August 2026). It needs no Telegram Premium. Every thought, word, glance and drawing comes from **NVIDIA NIM**: one free `nvapi-` key, no other AI providers.

- **Rich answers**, streamed live: headings, tables, code, LaTeX math, spoilers, footnotes and collapsible sections (Rich Messages, 10.1–10.3).
- **Native streaming with a ⏹ Stop button** in private chats (`sendRichMessageDraft` + `can_stop`, 10.3). You can watch her reasoning in a thinking block while she works on hard questions.
- **Voice**: she hears voice messages and round videos and can answer with her own voice.
- **Eyes**: photos, screenshots, homework, GIFs and short videos.
- **Drawing** with FLUX, **quizzes** as real quiz polls, and **dice** games.
- **Reminders** that show times in *your* timezone (`date_time` entities, 9.5).
- **Memory**: she remembers facts about you, summarizes long chats, and you can view or delete everything.
- **Works anywhere**:
  - in private chats, with optional separate topics that she titles herself (9.3/9.4);
  - in groups, where personal commands are **ephemeral** so only you see them (10.2/10.3);
  - in **guest mode**, when you @mention her in chats she isn't a member of (10.0);
  - in **inline mode**, via `@alya question` in any chat.
- **A real personality**: a mood that follows Saint Petersburg time, a friendship "bond" that grows, daily streaks, reactions and message effects. When she's flustered she mutters in Russian, with the translation hidden in a spoiler.

---

## Meet Alya

| | |
|---|---|
| **Full name** | Alina Sergeyevna Volkova — "Alya" (Аля) |
| **Age** | 19 · born January 7 (Orthodox Christmas) |
| **From** | Saint Petersburg, Russia — Vasilyevsky Island |
| **Studies** | Applied Mathematics & Computer Science, SPbU (2nd year) |
| **Family** | Mom (literature teacher), little brother Misha, dad (ship engineer, often at sea) |
| **Cat** | Pelmeni — grey, fluffy, walks across her keyboard |
| **Loves** | Winter, White Nights, tea with raspberry jam, blini, piano (Tchaikovsky's *December*), Bulgakov, anime (she won't admit how much), chess |
| **Personality** | Cool, proud, teasing top student outside; warm, caring and easily flustered inside |

She knows what time it is in Piter (sleepy at 2 am, grumpy before tea, cozy in the evening) and has a daily mood. She celebrates New Year and March 8, and her own birthday on January 7. She's honest when sincerely asked whether she's an AI, and she keeps things wholesome.

Her whole character lives in [`src/persona/alya.ts`](src/persona/alya.ts). Tweak her there.

---

## Features and the Bot API behind them

| Feature | Bot API | Notes |
|---|---|---|
| Rich AI answers (tables, math, code, `<details>`) | 10.1 `sendRichMessage`, 10.3 compact tables | Model Markdown is sanitized (no injected buttons or media) |
| Live streaming + native ⏹ | 9.3/9.5 drafts, 10.1 `sendRichMessageDraft`, 10.3 `can_stop`, `keep_on_stop`, `stopped_message_generation` | The partial answer is kept as a real message when you stop |
| Watch her think | Nemotron reasoning → `<tg-thinking>` draft block | Auto (per question), Fast, or Deep, set in /settings |
| Groups | Placeholder + rich edits, ⏹ button for the asker | Answers when mentioned, replied to, or called by name |
| Ephemeral personal commands | 10.2 `is_ephemeral` commands, 10.3 `ephemeral_message_parameters` | `/settings`, `/memory`, `/profile`, `/reminders`, `/help` are visible only to you in groups |
| Guest mode | 10.0 `guest_message` → `answerGuestQuery` → edits | @mention her in any chat |
| Inline mode | inline query → chosen result → edit | "✨ Ask Alya" and "Alya's mood today" |
| UI screens | 10.2 `InputRichMessage.blocks`, 9.4 coloured buttons, 10.3 disabled buttons, 10.3 `force_reply`, 10.3 in-message rich buttons, `copy_text` | Welcome, Help, Settings, Profile, Memory, Reminders, About (with a **map** of Saint Petersburg), Admin |
| Localized times | 9.5 `date_time` | Reminders render in each reader's timezone |
| Private-chat topics | 9.3/9.4 `createForumTopic`, `editForumTopic` | `/new` opens a topic; she auto-titles new topics |
| Quizzes | 9.6 `correct_option_ids`, poll descriptions | `/quiz space`, or just "quiz me" |
| Reactions and effects | `setMessageReaction`, `message_effect_id`, `message_reaction` | Rejected effect IDs are blacklisted automatically; ❤ reactions grow your bond |
| Profile photo | 9.4 `setMyProfilePhoto` | Admin: reply `/avatar` to a photo |
| Classic fallback | HTML `parse_mode` | Used automatically if rich payloads are rejected or the server is older |

The full research notes are in [`DESIGN.md`](DESIGN.md), including which features were skipped and why.

### NVIDIA models (all free on build.nvidia.com)

| Role | Default |
|---|---|
| Chat brain (streaming, tool calling, reasoning) | `nvidia/nemotron-3-super-120b-a12b` |
| Background (memory, titles, summaries) | `nvidia/nemotron-3-nano-30b-a3b` |
| Eyes and fallback ears (image, video, audio) | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` |
| Speech → text | Parakeet CTC 1.1B (English), or Whisper large-v3 (`ASR_LANGUAGE=multi`) via NVCF HTTP |
| Text → speech | Magpie TTS Multilingual, voice `EN-US.Aria` (mood-tinted `.Happy`/`.Calm`) |
| Drawing | FLUX.1-schnell |

---

## Quick start

### 1. Create the bot in @BotFather

1. `/newbot` and copy the **token**.
2. `/setinline` to enable inline mode (placeholder: *Ask Alya anything…*).
3. `/setinlinefeedback` → **Enabled**. This is required for inline answers.
4. `/setjoingroups` → **Enable**.
5. Optional: `/setprivacy` → **Disable**. Alya can then follow the whole group conversation, but she still only answers when addressed.
6. Open the **BotFather Mini App** (search `@BotFather` → **Open**) → *My bots* → your bot → *Bot Settings*:
   - **Guest Mode** → on, so @mentions work in chats she isn't in;
   - **Threads Settings → Threaded Mode** → on (optional), so `/new` opens separate topics.

### 2. Get a free NVIDIA key

Go to [build.nvidia.com](https://build.nvidia.com), sign in, open **API Keys** and generate one (`nvapi-…`). No card is needed. The free tier allows about 40 requests per minute.

### 3. Run it

```bash
git clone https://github.com/harshi79/Alya-Chat-bot && cd Alya-Chat-bot
cp .env.example .env        # set BOT_TOKEN and NVIDIA_API_KEY (and OWNER_ID = your Telegram id)
npm install
npm run dev                 # or: npm run build && npm start
```

Node **22.13+** is required. Storage uses the built-in `node:sqlite`, so there are **no native dependencies** to compile.

---

## Deploy

**Docker**

```bash
docker build -t alya .
docker run -d --name alya --restart unless-stopped \
  -e BOT_TOKEN=123:ABC -e NVIDIA_API_KEY=nvapi-... -e OWNER_ID=123456789 \
  -p 8080:8080 -v alya-data:/app/data alya
```

**Render**: New → Blueprint → select this repo ([`render.yaml`](render.yaml)). On the free plan, remove the disk block and set `WEBHOOK_URL=https://<your-service>.onrender.com` so Telegram wakes the service. Health check: `/health`.

**Anything else** (VPS, Railway, Fly, Heroku): `npm ci && npm run build && npm start`. A [`Procfile`](Procfile) is included.

- **Polling vs webhook:** by default Alya long-polls. Set `WEBHOOK_URL` and she registers a secret-protected webhook on the same port as `/health`. Updates are acknowledged in milliseconds and AI work runs in the background.

---

## Commands

| Private | Groups |
|---|---|
| `/start` welcome · `/help` · `/about` | `/settings` `/memory` `/profile` `/reminders` `/help` (**ephemeral**) |
| `/new` fresh conversation / new topic | `/imagine` · `/quiz` · `/about` · `/stop` |
| `/settings` voice, brain, thoughts, effects, reactions, formatting, nickname, timezone | `/new` reset chat memory (admins) |
| `/memory` · `/profile` · `/reminders` | `/groupsettings` reply mode and reactions (admins) |
| `/imagine <prompt>` · `/quiz <topic>` · `/voice` · `/stop` · `/forget` | |

**Admin** (the owner and `ADMIN_IDS`):
- `/admin` opens the dashboard;
- `/broadcast` (reply to a message), `/ban` and `/unban`, `/model <name|reset>`;
- `/avatar` (reply to a photo), `/maintenance on|off`.

You don't need commands for most things. Just talk: "draw a cat in a scarf", "remind me tomorrow at 9 to call mom", "quiz me about space", "roll a dice", or send a voice note.

---

## Configuration

Every option is documented in [`.env.example`](.env.example). The most useful:

| Variable | Default | What it does |
|---|---|---|
| `BOT_TOKEN` / `NVIDIA_API_KEY` | — | Required |
| `OWNER_ID`, `ADMIN_IDS` | — | Who can use admin commands |
| `WEBHOOK_URL` | empty (polling) | Public URL for webhook mode |
| `CHAT_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Alya's brain; admins can switch it live with `/model` |
| `ASR_FUNCTION_ID` / `ASR_LANGUAGE` | Parakeet, `en-US` | For many languages: Whisper `b702f636-f60c-4a3d-a6f4-f3568c13bd7d` + `multi` |
| `TTS_VOICE` | `Magpie-Multilingual.EN-US.Aria` | Also try `…EN-US.Sofia` |
| `NVIDIA_RPM` | `36` | Global request budget (free tier ≈ 40/min) |
| `DAILY_MESSAGE_LIMIT` / `DAILY_IMAGE_LIMIT` / `DAILY_VOICE_LIMIT` | 300 / 15 / 40 | Per-user caps protect the shared key (admins are exempt) |
| `DB_FILE` | `data/alya.db` | SQLite location; mount a volume here |

---

## How it works

```
Telegram update ─▶ grammY handler (enqueue, return instantly)
                        │
          per-conversation queue (batches messages sent while she types)
                        │
         perceive media ─▶ NVIDIA eyes/ears (vision, ASR)   [status shown live]
                        │
   persona + mood + bond + memories + history ─▶ Nemotron (SSE, tools, reasoning)
                        │
      sink: draft (private) · edits (groups) · guest/inline edits
                        │
   final rich message ─▶ save history ─▶ deferred images/dice/quizzes ─▶ voice reply
                        └─▶ background: memory extraction, summaries, topic titles
```

Details, including the rich→HTML fallback, the sanitizer and rate limiting, are in [`DESIGN.md`](DESIGN.md).

---

## Development

```bash
npm run typecheck      # TypeScript 7, strict
npm test               # 80+ tests: units + end-to-end against mock Telegram & mock NVIDIA
npm run smoke          # boots the compiled bot (long polling) against the mocks
npm run smoke:webhook  # same, in webhook mode
```

The test suite needs no network. [`test/mock-telegram.ts`](test/mock-telegram.ts) records every Bot API call, and [`test/mock-nvidia.ts`](test/mock-nvidia.ts) streams SSE with content, reasoning and tool calls and serves ASR, TTS and FLUX. The end-to-end tests cover:
* drafts, ⏹ stop and batching;
* groups, guest mode, inline mode and ephemeral commands;
* fallbacks, tools, voice, vision, drawing and topics;
* reminders and guardrails.

---

## Credits

Made by **YorichiiPrime** ([t.me/WhoEvenYori](https://t.me/WhoEvenYori)). Built with [grammY](https://grammy.dev) and powered by [NVIDIA NIM](https://build.nvidia.com). BSD-2-Clause licensed — see [LICENSE](LICENSE).

*Не то чтобы я хотела, чтобы ты поставил звёздочку…* ||(It's not like I want you to star the repo or anything…)||
