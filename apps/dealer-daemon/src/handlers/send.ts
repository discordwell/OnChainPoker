import { txFailureOf, type OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import { log } from "../log.js";
import type { InFlight } from "../turns.js";

/**
 * Gas limits for hand messages sent without a simulation: each is sent behind another of this
 * daemon's transactions that is not in a block yet, so the node's simulation would refuse it.
 * Each is about three times the most the message used on a local three-validator chain with six
 * players (scripts/liveness/block-txs.mjs prints every transaction's gas). Gas costs nothing here
 * (the ante handler deducts no fee) and the block has no gas limit; a limit that is too low only
 * fails that transaction, and the next block sends the step again with a simulation.
 */
export const BLIND_GAS = {
  initHand: 600_000,
  finalizeDeck: 600_000,
  finalizeReveal: 1_500_000,
} as const;

export type Send = {
  /** Who sends: "t<table>:h<hand>:<step>". A step held by an earlier send is not sent again. */
  key: string;
  msgs: Parameters<OcpCosmosClient["send"]>[0];
  /** Blocks after this one that the step waits for this transaction before sending again; Infinity: until it settles. */
  holdBlocks: number;
  gasLimit?: number;
  gasMultiplier?: number;
  what: string;
};

/** What a hand handler needs to send at one block. */
export type HandSender = {
  /** The committed height the poll read. */
  readonly height: number;
  readonly inflight: InFlight;
  /** Broadcasts in call order. Resolves true once the node took it, false when the chain refused it. Never waits for the block. */
  send(s: Send): Promise<boolean>;
};

export function handSender(client: OcpCosmosClient, inflight: InFlight, height: number): HandSender {
  return {
    height,
    inflight,
    async send(s) {
      try {
        const sent = await client.send(s.msgs, { gasLimit: s.gasLimit, gasMultiplier: s.gasMultiplier });
        inflight.track(s.key, height, s.holdBlocks, sent.landed, (err) => {
          const f = txFailureOf(err);
          log(`Hand: ${s.what} ${f.kind}${f.kind === "failed" ? ` in block ${f.height}: ${f.log}` : ""}`);
        });
        return true;
      } catch (err) {
        if (txFailureOf(err).kind === "not-a-tx") throw err;
        inflight.fail(s.key);
        log(`Hand: ${s.what} refused: ${String((err as Error)?.message ?? err)}`);
        return false;
      }
    },
  };
}
