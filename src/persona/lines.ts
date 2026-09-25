/** Canned lines in Alya's voice (for non-AI moments: errors, placeholders, limits). */
import { pick } from '../util/text.js';

export const lines = {
  thinking: () => pick(['hmm… lemme think ✨', 'one sec 💭', 'thinking… ☕', 'wait wait — typing 🐾', 'let me see… 📚']),
  deepThinking: () => pick(['Okay, top-student mode ON 🤓', 'Let me think about this properly… 🧠', 'Hmm, this needs real thinking ✍️']),
  looking: () => pick(['Let me look… 👀', 'Ooh, a picture? Let me see ✨', 'Looking closely… 🔍']),
  listening: () => pick(['Listening… 🎧', 'Let me hear that 🙉', 'Putting my headphones on… 🎧']),
  drawing: () => pick(['Drawing… 🎨', 'Let me sketch that… ✏️', 'Painting something for you 🖌️']),
  stopped: () => pick(['⏹ Okay, okay, I stopped!', '⏹ Stopped. Hmph.', '⏹ Fine, I\'ll be quiet 🙊']),
  rateLimited: () =>
    pick([
      'ahh… too many people are talking to me right now 😵‍💫 try again in a few seconds?',
      'my head is spinning — give me a moment and ask again 🌀',
    ]),
  aiDown: () =>
    pick([
      'sorry… my brain (NVIDIA) isn\'t answering right now 😣 try again in a minute?',
      'something went wrong on my side… not my fault! probably. try again? 🙈',
    ]),
  noKey: () => 'I can\'t think yet — my owner hasn\'t given me an NVIDIA key (NVIDIA_API_KEY) 😤',
  timeout: () => 'That took way too long, I gave up 😮‍💨 Can you ask me again?',
  dailyLimit: () => 'we talked so much today that i hit my daily limit 🥺 let\'s continue tomorrow, okay?',
  slowDown: () => 'hey, slow down! you\'re sending messages faster than i can read 😤',
  imageLimit: () => 'I already drew a lot today — my hand hurts 🥲 Tomorrow, okay?',
  voiceLimit: () => 'My voice is tired for today 🥲 I\'ll answer in text!',
  maintenance: () => 'I\'m getting a little update right now 🛠️ Come back in a few minutes!',
  unknownMedia: () => pick(['hmm, i can\'t open that kind of file yet 🙈', 'i don\'t know what to do with that… show me text or a picture? 👀']),
  pdfUnsupported: () => 'I can\'t read PDFs directly yet 🙈 Send me a screenshot of the page or paste the text, and I\'ll help!',
  empty: () => pick(['…', 'hmm? 🙈', 'oops, i lost my train of thought. say that again?']),
  guestPlaceholder: () => '💭 Alya is typing…',
};
