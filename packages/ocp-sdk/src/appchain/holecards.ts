import type { EncShareArtifact, Hex, SeatIndex, TableId, U64 } from "./types.js";
import type { OcpRpcClient } from "./client.js";

export interface HoleCardCrypto {
  decryptEncShare(args: { encShare: Hex; skPlayer: Hex }): Promise<Hex>;
  recoverCardId(args: { ciphertext: Hex; shares: Array<{ validatorId: string; share: Hex }> }): Promise<number>;
}

export type HoleCards = readonly [number, number];

export class HoleCardRecovery {
  readonly rpc: Pick<OcpRpcClient, "getHoleCardPositions" | "getDealerCiphertext" | "getDealerEncShares">;
  readonly crypto: HoleCardCrypto;
  readonly thresholdT: number;

  constructor(args: {
    rpc: Pick<OcpRpcClient, "getHoleCardPositions" | "getDealerCiphertext" | "getDealerEncShares">;
    crypto: HoleCardCrypto;
    thresholdT: number;
  }) {
    if (args.thresholdT <= 0) throw new Error("thresholdT must be > 0");
    this.rpc = args.rpc;
    this.crypto = args.crypto;
    this.thresholdT = args.thresholdT;
  }

  async recoverHoleCards(args: { tableId: TableId; handId: U64; seat: SeatIndex; skPlayer: Hex; pkPlayer?: Hex }): Promise<HoleCards> {
    const { tableId, handId, seat, skPlayer, pkPlayer } = args;
    const { pos0, pos1 } = await this.rpc.getHoleCardPositions({ tableId, handId, seat });

    const c0 = await this.recoverOne({ tableId, handId, pos: pos0, skPlayer, pkPlayer });
    const c1 = await this.recoverOne({ tableId, handId, pos: pos1, skPlayer, pkPlayer });

    return [c0, c1] as const;
  }

  private async recoverOne(args: { tableId: TableId; handId: U64; pos: number; skPlayer: Hex; pkPlayer?: Hex }): Promise<number> {
    const { tableId, handId, pos, skPlayer, pkPlayer } = args;

    const [{ ciphertext }, { shares }] = await Promise.all([
      this.rpc.getDealerCiphertext({ tableId, handId, pos }),
      this.rpc.getDealerEncShares({ tableId, handId, pos, pkPlayer })
    ]);

    if (!Array.isArray(shares) || shares.length < this.thresholdT) {
      throw new Error(`not enough shares for pos=${pos}: have ${shares?.length ?? 0}, need ${this.thresholdT}`);
    }

    const chosen = shares.slice(0, this.thresholdT);
    const decrypted = await Promise.all(chosen.map((s) => this.decryptShare(s, skPlayer)));

    const cardId = await this.crypto.recoverCardId({
      ciphertext,
      shares: decrypted
    });

    if (!Number.isInteger(cardId) || cardId < 0 || cardId > 51) {
      throw new Error(`invalid recovered card id: ${cardId}`);
    }

    return cardId;
  }

  private async decryptShare(s: EncShareArtifact, skPlayer: Hex): Promise<{ validatorId: string; share: Hex }> {
    const share = await this.crypto.decryptEncShare({ encShare: s.encShare, skPlayer });
    return { validatorId: s.validatorId, share };
  }
}

