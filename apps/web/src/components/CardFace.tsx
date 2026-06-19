import "./CardFace.css";

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
const SUIT_GLYPHS = ["\u2663", "\u2666", "\u2665", "\u2660"] as const; // ♣ ♦ ♥ ♠
const SUIT_NAMES = ["clubs", "diamonds", "hearts", "spades"] as const;
const SUIT_LETTERS = ["c", "d", "h", "s"] as const; // chain Card.String() suit letters

// rankIdx (0=Two .. 12=Ace) keyed by every label spelling we may receive:
// glyph-format "10" and the chain's letter-format "T" both map to ten.
const RANK_INDEX: Readonly<Record<string, number>> = {
  "2": 0, "3": 1, "4": 2, "5": 3, "6": 4, "7": 5, "8": 6, "9": 7,
  "10": 8, T: 8, J: 9, Q: 10, K: 11, A: 12,
};

export function cardLabel(id: number): string {
  return `${RANKS[id % 13]}${SUIT_GLYPHS[Math.floor(id / 13)]}`;
}

/** Reverse lookup from label string (e.g. "A♠") to numeric card ID (0-51). */
export function cardIdFromLabel(label: string): number | null {
  if (!label || label.length < 2) return null;
  const suitChar = label[label.length - 1]!;
  const rankStr = label.slice(0, -1).toUpperCase();
  let suitIdx = SUIT_GLYPHS.indexOf(suitChar as typeof SUIT_GLYPHS[number]);
  if (suitIdx < 0) {
    // Fall back to the chain's letter-format suits (c/d/h/s).
    suitIdx = SUIT_LETTERS.indexOf(suitChar.toLowerCase() as typeof SUIT_LETTERS[number]);
  }
  const rankIdx = RANK_INDEX[rankStr];
  if (suitIdx < 0 || rankIdx === undefined) return null;
  return suitIdx * 13 + rankIdx;
}

export function CardFace({
  cardId,
  size = "md",
  className = "",
}: {
  cardId: number | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  if (cardId == null || cardId < 0 || cardId > 51) {
    return (
      <div className={`card card--back card--${size} ${className}`} aria-label="face-down card">
        <div className="card__back-pattern" />
      </div>
    );
  }

  const rankIdx = cardId % 13;
  const suitIdx = Math.floor(cardId / 13);
  const rank = RANKS[rankIdx];
  const glyph = SUIT_GLYPHS[suitIdx];
  const suitName = SUIT_NAMES[suitIdx];
  const isRed = suitIdx === 1 || suitIdx === 2;

  return (
    <div
      className={`card card--face card--${size} card--${suitName} ${isRed ? "card--red" : "card--black"} ${className}`}
      aria-label={`${rank} of ${suitName}`}
    >
      <span className="card__rank-top">
        {rank}
        <span className="card__suit-small">{glyph}</span>
      </span>
      <span className="card__pip">{glyph}</span>
      <span className="card__rank-bot">
        {rank}
        <span className="card__suit-small">{glyph}</span>
      </span>
    </div>
  );
}
