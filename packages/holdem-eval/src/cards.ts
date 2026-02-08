export type CardId = number; // 0..51

export type Suit = 0 | 1 | 2 | 3;

export type Rank =
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14; // 14 = Ace

const RANK_CHARS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
const SUIT_CHARS = ["c", "d", "h", "s"] as const;

export function assertValidCardId(card: CardId): void {
  if (!Number.isInteger(card) || card < 0 || card > 51) {
    throw new RangeError(`Invalid card id ${card}; expected integer in [0, 51].`);
  }
}

export function cardSuit(card: CardId): Suit {
  assertValidCardId(card);
  return Math.floor(card / 13) as Suit;
}

export function cardRank(card: CardId): Rank {
  assertValidCardId(card);
  return ((card % 13) + 2) as Rank;
}

export function cardIdFromRankSuit(rank: Rank, suit: Suit): CardId {
  if (!Number.isInteger(rank) || rank < 2 || rank > 14) {
    throw new RangeError(`Invalid rank ${rank}; expected integer in [2, 14].`);
  }
  if (!Number.isInteger(suit) || suit < 0 || suit > 3) {
    throw new RangeError(`Invalid suit ${suit}; expected integer in [0, 3].`);
  }
  const rankIndex = rank - 2; // 0..12
  return suit * 13 + rankIndex;
}

export function cardToString(card: CardId): string {
  const suit = cardSuit(card);
  const rankIndex = (card % 13) as number;
  return `${RANK_CHARS[rankIndex]}${SUIT_CHARS[suit]}`;
}

export function cardFromString(s: string): CardId {
  if (typeof s !== "string" || s.length !== 2) {
    throw new TypeError(`Invalid card string ${JSON.stringify(s)}; expected like "As" or "2c".`);
  }

  const rankChar = s[0]!;
  const suitChar = s[1]!.toLowerCase();

  const rankIndex = RANK_CHARS.indexOf(rankChar as (typeof RANK_CHARS)[number]);
  if (rankIndex === -1) {
    throw new RangeError(`Invalid rank character ${JSON.stringify(rankChar)} in ${JSON.stringify(s)}.`);
  }

  const suitIndex = SUIT_CHARS.indexOf(suitChar as (typeof SUIT_CHARS)[number]);
  if (suitIndex === -1) {
    throw new RangeError(`Invalid suit character ${JSON.stringify(suitChar)} in ${JSON.stringify(s)}.`);
  }

  return suitIndex * 13 + rankIndex;
}

