import type { Chips, Pot } from "./types.js";

export function computeSidePots(totalCommit: readonly Chips[], eligibleForWin: readonly boolean[]): Pot[] {
  const remaining: Array<{ seat: number; amount: Chips; eligible: boolean }> = [];
  for (let i = 0; i < totalCommit.length; i++) {
    const amount = totalCommit[i] ?? 0n;
    if (amount > 0n) remaining.push({ seat: i, amount, eligible: eligibleForWin[i] === true });
  }

  const potsByTier: Pot[] = [];
  while (remaining.length > 0) {
    let min = remaining[0]!.amount;
    for (let i = 1; i < remaining.length; i++) {
      if (remaining[i]!.amount < min) min = remaining[i]!.amount;
    }

    const potAmount = min * BigInt(remaining.length);
    const eligibleSeats = remaining.filter((r) => r.eligible).map((r) => r.seat);
    potsByTier.push({ amount: potAmount, eligibleSeats });

    for (const r of remaining) r.amount -= min;
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i]!.amount === 0n) remaining.splice(i, 1);
    }
  }

  // Merge consecutive tiers that have identical eligibility sets. This prevents folded
  // "dead money" from artificially creating multiple pots with the same winners.
  const merged: Pot[] = [];
  for (const p of potsByTier) {
    const last = merged[merged.length - 1];
    if (last && sameSeats(last.eligibleSeats, p.eligibleSeats)) {
      last.amount += p.amount;
      continue;
    }
    merged.push({ amount: p.amount, eligibleSeats: p.eligibleSeats.slice() });
  }
  return merged;
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
