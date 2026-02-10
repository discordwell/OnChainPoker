import { Registry } from "@cosmjs/proto-signing";
import { defaultRegistryTypes } from "@cosmjs/stargate";

import {
  MsgAct,
  MsgCreateTable,
  MsgLeave,
  MsgSit,
  MsgStartHand,
  MsgTick
} from "./gen/onchainpoker/poker/v1/tx.js";
import {
  MsgBeginEpoch,
  MsgDkgCommit,
  MsgDkgComplaintInvalid,
  MsgDkgComplaintMissing,
  MsgDkgShareReveal,
  MsgDkgTimeout,
  MsgFinalizeDeck,
  MsgFinalizeEpoch,
  MsgFinalizeReveal,
  MsgInitHand,
  MsgSubmitEncShare,
  MsgSubmitPubShare,
  MsgSubmitShuffle,
  MsgTimeout
} from "./gen/onchainpoker/dealer/v1/tx.js";

export const OCP_TYPE_URLS = {
  poker: {
    createTable: "/onchainpoker.poker.v1.MsgCreateTable",
    sit: "/onchainpoker.poker.v1.MsgSit",
    startHand: "/onchainpoker.poker.v1.MsgStartHand",
    act: "/onchainpoker.poker.v1.MsgAct",
    tick: "/onchainpoker.poker.v1.MsgTick",
    leave: "/onchainpoker.poker.v1.MsgLeave"
  },
  dealer: {
    beginEpoch: "/onchainpoker.dealer.v1.MsgBeginEpoch",
    dkgCommit: "/onchainpoker.dealer.v1.MsgDkgCommit",
    dkgComplaintMissing: "/onchainpoker.dealer.v1.MsgDkgComplaintMissing",
    dkgComplaintInvalid: "/onchainpoker.dealer.v1.MsgDkgComplaintInvalid",
    dkgShareReveal: "/onchainpoker.dealer.v1.MsgDkgShareReveal",
    finalizeEpoch: "/onchainpoker.dealer.v1.MsgFinalizeEpoch",
    dkgTimeout: "/onchainpoker.dealer.v1.MsgDkgTimeout",
    initHand: "/onchainpoker.dealer.v1.MsgInitHand",
    submitShuffle: "/onchainpoker.dealer.v1.MsgSubmitShuffle",
    finalizeDeck: "/onchainpoker.dealer.v1.MsgFinalizeDeck",
    submitPubShare: "/onchainpoker.dealer.v1.MsgSubmitPubShare",
    submitEncShare: "/onchainpoker.dealer.v1.MsgSubmitEncShare",
    finalizeReveal: "/onchainpoker.dealer.v1.MsgFinalizeReveal",
    timeout: "/onchainpoker.dealer.v1.MsgTimeout"
  }
} as const;

/**
 * Returns a CosmJS registry with:
 * - the standard stargate types, plus
 * - OCP custom message types from `apps/cosmos/proto`.
 */
export function createOcpRegistry(): Registry {
  const registry = new Registry(defaultRegistryTypes);

  registry.register(OCP_TYPE_URLS.poker.createTable, MsgCreateTable);
  registry.register(OCP_TYPE_URLS.poker.sit, MsgSit);
  registry.register(OCP_TYPE_URLS.poker.startHand, MsgStartHand);
  registry.register(OCP_TYPE_URLS.poker.act, MsgAct);
  registry.register(OCP_TYPE_URLS.poker.tick, MsgTick);
  registry.register(OCP_TYPE_URLS.poker.leave, MsgLeave);

  registry.register(OCP_TYPE_URLS.dealer.beginEpoch, MsgBeginEpoch);
  registry.register(OCP_TYPE_URLS.dealer.dkgCommit, MsgDkgCommit);
  registry.register(OCP_TYPE_URLS.dealer.dkgComplaintMissing, MsgDkgComplaintMissing);
  registry.register(OCP_TYPE_URLS.dealer.dkgComplaintInvalid, MsgDkgComplaintInvalid);
  registry.register(OCP_TYPE_URLS.dealer.dkgShareReveal, MsgDkgShareReveal);
  registry.register(OCP_TYPE_URLS.dealer.finalizeEpoch, MsgFinalizeEpoch);
  registry.register(OCP_TYPE_URLS.dealer.dkgTimeout, MsgDkgTimeout);
  registry.register(OCP_TYPE_URLS.dealer.initHand, MsgInitHand);
  registry.register(OCP_TYPE_URLS.dealer.submitShuffle, MsgSubmitShuffle);
  registry.register(OCP_TYPE_URLS.dealer.finalizeDeck, MsgFinalizeDeck);
  registry.register(OCP_TYPE_URLS.dealer.submitPubShare, MsgSubmitPubShare);
  registry.register(OCP_TYPE_URLS.dealer.submitEncShare, MsgSubmitEncShare);
  registry.register(OCP_TYPE_URLS.dealer.finalizeReveal, MsgFinalizeReveal);
  registry.register(OCP_TYPE_URLS.dealer.timeout, MsgTimeout);

  return registry;
}

