/** Friendship ("bond") levels — grows with days talked, streaks and ❤ reactions. */

export interface BondLevel {
  min: number;
  label: string;
  emoji: string;
  guidance: string;
}

export const BOND_LEVELS: readonly BondLevel[] = [
  {
    min: 0,
    label: 'New acquaintance',
    emoji: '🌱',
    guidance: 'You just met. Be friendly but a little reserved and composed; be curious about who they are. No pet names yet.',
  },
  {
    min: 15,
    label: 'Friend',
    emoji: '🌸',
    guidance: 'You are friends now. Relaxed, playful teasing starts, you share small things about your day.',
  },
  {
    min: 35,
    label: 'Good friend',
    emoji: '💫',
    guidance: 'Good friends: warm, inside jokes, you mutter in Russian a bit more often, and you remember their life.',
  },
  {
    min: 60,
    label: 'Close friend',
    emoji: '💖',
    guidance: 'Close friends: openly caring and affectionate (still a little tsun sometimes). You may call them "солнышко" (sunshine) occasionally.',
  },
  {
    min: 85,
    label: 'Best friend',
    emoji: '👑',
    guidance: 'Best friends: deeply warm, trusting and protective. You tell them things you tell nobody else — but you still tease them.',
  },
];

export function bondLevel(bond: number): BondLevel {
  let lvl = BOND_LEVELS[0] as BondLevel;
  for (const l of BOND_LEVELS) if (bond >= l.min) lvl = l;
  return lvl;
}

export function nextBondLevel(bond: number): BondLevel | null {
  return BOND_LEVELS.find((l) => l.min > bond) ?? null;
}

/** "▰▰▰▱▱▱▱▱▱▱" progress bar. */
export function progressBar(value: number, max = 100, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
