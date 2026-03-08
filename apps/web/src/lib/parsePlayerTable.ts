export type PlayerSeatState = {
  seat: number;
  player: string;
  stack: string;
  bond: string;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
};

export type PlayerHandState = {
  handId: string;
  phase: string;
  actionOn: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  actionDeadline: number;
  pot: string;
  board: number[];
  street: string;
};

export type PlayerTableState = {
  tableId: string;
  params: {
    maxPlayers: number;
    smallBlind: string;
    bigBlind: string;
    minBuyIn: string;
    maxBuyIn: string;
    passwordHash?: string;
  };
  seats: PlayerSeatState[];
  hand: PlayerHandState | null;
};

export function parseTableBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return Boolean(raw);
}

export function parsePlayerTable(raw: unknown): PlayerTableState | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  const tableId = String(root.id ?? root.tableId ?? "").trim();
  if (!tableId) return null;

  const params = (root.params as Record<string, unknown>) ?? {};
  const rawSeats = Array.isArray(root.seats) ? root.seats : [];
  const rawHand = (root.hand as Record<string, unknown>) ?? null;
  const inHands = Array.isArray(rawHand?.inHand ?? rawHand?.in_hand) ? (rawHand!.inHand ?? rawHand!.in_hand) as unknown[] : [];
  const folded = Array.isArray(rawHand?.folded) ? rawHand.folded : [];
  const allIn = Array.isArray(rawHand?.allIn ?? rawHand?.all_in) ? (rawHand!.allIn ?? rawHand!.all_in) as unknown[] : [];

  const seats: PlayerSeatState[] = rawSeats
    .slice(0, 9)
    .map((seatRaw, seat) => {
      const value = (seatRaw ?? {}) as Record<string, unknown>;
      return {
        seat,
        player: String(value.player ?? ""),
        stack: String(value.stack ?? "0"),
        bond: String(value.bond ?? "0"),
        inHand: parseTableBool(inHands[seat] ?? value.inHand),
        folded: parseTableBool(folded[seat] ?? value.folded),
        allIn: parseTableBool(allIn[seat] ?? value.allIn)
      } satisfies PlayerSeatState;
    });

  while (seats.length < 9) {
    const seat = seats.length;
    seats.push({
      seat,
      player: "",
      stack: "0",
      bond: "0",
      inHand: false,
      folded: false,
      allIn: false
    });
  }

  const handRaw = rawHand;
  const phase = String(handRaw?.phase ?? "");
  const actionOn = Number.isFinite(Number(handRaw?.actionOn ?? handRaw?.action_on)) ? Number(handRaw?.actionOn ?? handRaw?.action_on) : -1;
  const buttonSeat = Number.isFinite(Number(handRaw?.buttonSeat ?? handRaw?.button_seat ?? handRaw?.button)) ? Number(handRaw?.buttonSeat ?? handRaw?.button_seat ?? handRaw?.button) : -1;
  const smallBlindSeat = Number.isFinite(Number(handRaw?.smallBlindSeat ?? handRaw?.small_blind_seat ?? handRaw?.sbSeat)) ? Number(handRaw?.smallBlindSeat ?? handRaw?.small_blind_seat ?? handRaw?.sbSeat) : -1;
  const bigBlindSeat = Number.isFinite(Number(handRaw?.bigBlindSeat ?? handRaw?.big_blind_seat ?? handRaw?.bbSeat)) ? Number(handRaw?.bigBlindSeat ?? handRaw?.big_blind_seat ?? handRaw?.bbSeat) : -1;
  const actionDeadline = Number.isFinite(Number(handRaw?.actionDeadline ?? handRaw?.action_deadline ?? handRaw?.deadline)) ? Number(handRaw?.actionDeadline ?? handRaw?.action_deadline ?? handRaw?.deadline) : 0;
  const street = String(handRaw?.street ?? "");

  // Compute pot from totalCommit array (chain doesn't have a pot field)
  let pot = 0n;
  const totalCommits = Array.isArray(handRaw?.totalCommit ?? handRaw?.total_commit) ? (handRaw!.totalCommit ?? handRaw!.total_commit) as unknown[] : [];
  for (const tc of totalCommits) {
    const v = typeof tc === "string" ? BigInt(tc || "0") : BigInt(tc ?? 0);
    pot += v;
  }

  // Extract board cards directly from hand.board (chain proto field)
  const rawBoard = Array.isArray(handRaw?.board) ? handRaw.board : [];
  const board: number[] = rawBoard
    .map((c: unknown) => Number(c))
    .filter((c: number) => Number.isFinite(c) && c >= 0 && c <= 51);

  return {
    tableId,
    params: {
      maxPlayers: Number.isFinite(Number(params.maxPlayers ?? params.max_players)) ? Number(params.maxPlayers ?? params.max_players) : 9,
      smallBlind: String(params.smallBlind ?? params.small_blind ?? "0"),
      bigBlind: String(params.bigBlind ?? params.big_blind ?? "0"),
      minBuyIn: String(params.minBuyIn ?? params.min_buy_in ?? "0"),
      maxBuyIn: String(params.maxBuyIn ?? params.max_buy_in ?? "0")
    },
    seats,
    hand: handRaw
      ? {
          handId: String(handRaw.handId ?? handRaw.hand_id ?? ""),
          phase,
          actionOn,
          buttonSeat,
          smallBlindSeat,
          bigBlindSeat,
          actionDeadline,
          pot: pot.toString(),
          board,
          street,
        }
      : null
  };
}
