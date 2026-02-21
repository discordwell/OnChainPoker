import type { CardId } from "@onchainpoker/holdem-eval";
import { cardRank, cardSuit } from "@onchainpoker/holdem-eval";

export type PreflopTier = "premium" | "strong" | "playable" | "marginal" | "trash";

// Rank → display char for building lookup keys
const R = ["", "", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;

function handKey(c1: CardId, c2: CardId): string {
  const r1 = cardRank(c1);
  const r2 = cardRank(c2);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  if (hi === lo) return `${R[hi]}${R[lo]}`;
  const suited = cardSuit(c1) === cardSuit(c2);
  return `${R[hi]}${R[lo]}${suited ? "s" : "o"}`;
}

// 169-combo preflop tier lookup
const TIERS: Record<string, PreflopTier> = {};

function t(tier: PreflopTier, ...hands: string[]): void {
  for (const h of hands) TIERS[h] = tier;
}

// Premium: top ~3% of hands
t("premium", "AA", "KK", "QQ", "AKs");

// Strong: ~6%
t("strong", "JJ", "TT", "AKo", "AQs", "AJs", "KQs");

// Playable: ~15%
t(
  "playable",
  "99", "88", "77", "66",
  "ATs", "A5s", "A4s", "A3s", "A2s",
  "KJs", "KTs", "QJs", "QTs", "JTs",
  "T9s", "98s", "87s", "76s",
  "AQo", "AJo",
);

// Marginal: ~25%
t(
  "marginal",
  "55", "44", "33", "22",
  "A9s", "A8s", "A7s", "A6s",
  "K9s", "Q9s", "J9s", "T8s",
  "97s", "86s", "75s", "65s", "54s",
  "KQo", "KJo", "QJo", "JTo", "ATo",
);

// Everything else → "trash"

export function preflopTier(c1: CardId, c2: CardId): PreflopTier {
  return TIERS[handKey(c1, c2)] ?? "trash";
}
