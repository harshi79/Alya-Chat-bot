/** Canned lines in Alya's voice (for non-AI moments: errors, placeholders, limits). */
import { pick } from '../util/text.js';

export const lines = {
  thinking: () => pick(['Hmm… let me think ✨', 'Ну… one second 💭', 'Thinking… ☕', 'Wait, wait — I\'m typing 🐾', 'Let me see… 📚']),
  deepThinking: () => pick(['Okay, top-student mode ON 🤓', 'Let me think about this properly… 🧠', 'Hmm, this needs real thinking ✍️']),
  looking: () => pick(['Let me look… 👀', 'Ooh, a picture? Let me see ✨', 'Looking closely… 🔍']),
  listening: () => pick(['Listening… 🎧', 'Let me hear that 🙉', 'Putting my headphones on… 🎧']),
  drawing: () => pick(['Drawing… 🎨', 'Let me sketch that… ✏️', 'Painting something for you 🖌️']),
  stopped: () => pick(['⏹ Okay, okay, I stopped!', '⏹ Stopped. Hmph.', '⏹ Fine, I\'ll be quiet 🙊']),
  rateLimited: () =>
    pick([
      'Подожди… too many people are talking to me right now 😵‍💫 Try again in a few seconds?',
      'Ah, my head is spinning — give me a moment and ask again 🌀',
    ]),
  aiDown: () =>
    pick([
      'Прости… my brain (NVIDIA) isn\'t answering right now 😣 Try again in a minute?',
      'Something went wrong on my side… not my fault! Probably. Try again? 🙈',
    ]),
  noKey: () => 'I can\'t think yet — my owner hasn\'t given me an NVIDIA key (NVIDIA_API_KEY) 😤',
  timeout: () => 'That took way too long, I gave up 😮‍💨 Can you ask me again?',
  dailyLimit: () => 'We talked so much today that I hit my daily limit 🥺 Let\'s continue tomorrow, okay? Спокойной ночи ✨',
  slowDown: () => 'Эй, slow down! You\'re sending messages faster than I can read 😤',
  imageLimit: () => 'I already drew a lot today — my hand hurts 🥲 Tomorrow, okay?',
  voiceLimit: () => 'My voice is tired for today 🥲 I\'ll answer in text!',
  maintenance: () => 'I\'m getting a little update right now 🛠️ Come back in a few minutes!',
  unknownMedia: () => pick(['Hmm, I can\'t open that kind of file yet 🙈', 'I don\'t know what to do with that… show me text or a picture? 👀']),
  pdfUnsupported: () => 'I can\'t read PDFs directly yet 🙈 Send me a screenshot of the page or paste the text, and I\'ll help!',
  empty: () => pick(['…', 'Hmm? 🙈', 'Ой, I lost my train of thought. Say that again?']),
  guestPlaceholder: () => '💭 Alya is typing…',
};
