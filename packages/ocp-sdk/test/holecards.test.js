import assert from "node:assert/strict";
import test from "node:test";

import { HoleCardRecovery } from "../dist/appchain/holecards.js";

test("HoleCardRecovery recovers two hole cards from shares", async () => {
  const rpc = {
    async getHoleCardPositions() {
      return { pos0: 9, pos1: 10 };
    },
    async getDealerCiphertext({ pos }) {
      // Encode the card id in the ciphertext for the toy crypto below.
      const cardId = pos === 9 ? 17 : 42;
      return { ciphertext: `0x${cardId.toString(16).padStart(2, "0")}` };
    },
    async getDealerEncShares() {
      return {
        shares: [
          { validatorId: "v1", pkPlayer: "0x01", encShare: "0xaa", proofEncShare: "0x00" },
          { validatorId: "v2", pkPlayer: "0x01", encShare: "0xbb", proofEncShare: "0x00" }
        ]
      };
    }
  };

  const crypto = {
    async decryptEncShare({ encShare }) {
      // toy: "decrypt" is identity
      return encShare;
    },
    async recoverCardId({ ciphertext }) {
      // toy: ciphertext is 0x<cardId>
      return parseInt(ciphertext.slice(2), 16);
    }
  };

  const r = new HoleCardRecovery({ rpc, crypto, thresholdT: 2 });
  const hole = await r.recoverHoleCards({ tableId: "1", handId: "12", seat: 3, skPlayer: "0xdeadbeef" });
  assert.deepEqual(hole, [17, 42]);
});

test("HoleCardRecovery throws if insufficient shares", async () => {
  const rpc = {
    async getHoleCardPositions() {
      return { pos0: 9, pos1: 10 };
    },
    async getDealerCiphertext() {
      return { ciphertext: "0x11" };
    },
    async getDealerEncShares() {
      return { shares: [{ validatorId: "v1", pkPlayer: "0x01", encShare: "0xaa", proofEncShare: "0x00" }] };
    }
  };

  const crypto = {
    async decryptEncShare({ encShare }) {
      return encShare;
    },
    async recoverCardId() {
      return 1;
    }
  };

  const r = new HoleCardRecovery({ rpc, crypto, thresholdT: 2 });
  await assert.rejects(
    () => r.recoverHoleCards({ tableId: "1", handId: "12", seat: 3, skPlayer: "0xdeadbeef" }),
    /not enough shares/
  );
});

