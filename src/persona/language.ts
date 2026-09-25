/** Per-person reply language. Ambiguous messages keep the previous choice. */
export type ReplyLanguage = 'hinglish' | 'english';

// Romanized Hindi shares the Latin alphabet with English: ASCII alone is not
// evidence of English. Avoid ambiguous Hindi words such as "is", "to" and "me".
const HINDI = new Set('hai hain ho hoon hun hu tha thi theek thik nahi nahin nhi nai haan han haa kya kyun kyu kaise kaisa kaisi ka kaafi ki ke ko mujhe mujhko mera meri mere tum tumhe tumhara tumhari tumhare aap aapko apna apni apne hum ham hume hamara yaar yar bhai behen acha accha achha bahut bohot thoda zyada kar karo karna karte karta karti karke kr krna krdo bata batao bta btao bol bolo samjha samjhao samajh namaste shukriya dhanyavad aur lekin par phir abhi aaj kal kab kahan kaha chalo chal rahi raha rahe wali wala wale bas mat mein mai'.split(' '));
const ENGLISH = new Set('i you your yours we our they their he she it its am is are was were be been being have has had do does did can could would should will shall what why when where which who how please explain tell help want need think know feel like love this that these those the a an and but with for from about of in on my me not dont thanks thank good morning evening night'.split(' '));

export function resolveReplyLanguage(text: string, previous: ReplyLanguage = 'hinglish'): ReplyLanguage {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/https?:\/\/\S+|@\w+|\/\w+/g, ' ')
    .replace(/[’']/g, '')
    .toLowerCase();

  // Explicit requests win over the language used to make the request.
  const request = prose.trim().replace(/[.!?]+$/g, '').trim();
  const explicit = request.match(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:reply|respond|speak|talk|answer|switch|use)(?:\s+to\s+me)?\s+(?:(?:in|to)\s+)?(?:only\s+)?(english|hinglish|hindi)(?:\s+(?:only|please|from now on))?$/)
    ?? request.match(/^(english|hinglish|hindi)(?:\s+(?:mein|me))?(?:\s+(?:please|bolo|bol|baat karo|only))?$/);
  if (explicit) return explicit[1] === 'english' ? 'english' : 'hinglish';
  if (/^(?:hi|hey|hello|ok|okay|yes|no|thanks|thank you|thank you so much|sure|lol|hmm)[\s!.?😊👍]*$/.test(request)) return previous;

  if (/[\u0900-\u097f]/u.test(prose)) return 'hinglish';
  const words = prose.match(/[a-z]+/g) ?? [];
  if (words.some((word) => HINDI.has(word))) return 'hinglish';
  // Greetings, acknowledgements, names, emoji, numbers and code on their own
  // do not establish a new preference. Require a little English prose.
  if (words.length >= 2 && words.some((word) => ENGLISH.has(word))) return 'english';
  return previous;
}
