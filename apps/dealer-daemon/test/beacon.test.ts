import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beaconCommitment, beaconSalt } from "../src/handlers/beacon.js";

const me = { statePassphrase: "a passphrase for tests only", validatorAddress: "ocpvaloper1a" };
const window = { epochId: 44, commitOpenHeight: 1_536_468 };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** x/dealer/committee Commit: sha256 of the domain, then each part behind its length as u32 little-endian. */
function chainCommit(validator: string, epochId: number, salt: Uint8Array): string {
  const h = createHash("sha256").update("ocp/v1/beacon/commit");
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64LE(BigInt(epochId));
  for (const part of [Buffer.from(validator), epoch, Buffer.from(salt)]) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(part.length);
    h.update(length).update(part);
  }
  return h.digest("hex");
}

describe("the beacon salt and its commitment", () => {
  it("the commitment is what the chain recomputes from the revealed salt", () => {
    assert.equal(hex(beaconCommitment(me, window)), chainCommit(me.validatorAddress, 44, beaconSalt(me, window)));
  });

  it("the salt is 32 bytes and is the same every time it is derived for a window", () => {
    assert.equal(beaconSalt(me, window).length, 32);
    assert.equal(hex(beaconSalt(me, window)), hex(beaconSalt({ ...me }, { ...window })));
  });

  it("a window the chain opened in place of another for the same epoch gets another salt", () => {
    const replaced = { epochId: 44, commitOpenHeight: 1_536_569 };
    assert.notEqual(hex(beaconSalt(me, window)), hex(beaconSalt(me, replaced)));
  });

  it("differs by epoch, by validator and by passphrase", () => {
    const salts = [
      beaconSalt(me, window),
      beaconSalt(me, { ...window, epochId: 45 }),
      beaconSalt({ ...me, validatorAddress: "ocpvaloper1b" }, window),
      beaconSalt({ ...me, statePassphrase: "another passphrase" }, window),
    ].map(hex);
    assert.equal(new Set(salts).size, 4);
  });
});
