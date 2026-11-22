import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURVE_ORDER } from "@onchainpoker/ocp-crypto";
import { evalPoly } from "../src/handlers/dkg.js";

// ---------------------------------------------------------------------------
// evalPoly
// ---------------------------------------------------------------------------
describe("evalPoly", () => {
  it("constant polynomial", () => {
    // f(x) = 42
    assert.equal(evalPoly([42n], 100n), 42n);
  });

  it("linear polynomial", () => {
    // f(x) = 3 + 5x → f(2) = 3 + 10 = 13
    assert.equal(evalPoly([3n, 5n], 2n), 13n);
  });

  it("degree-2 polynomial", () => {
    // f(x) = 1 + 2x + 3x² → f(4) = 1 + 8 + 48 = 57
    assert.equal(evalPoly([1n, 2n, 3n], 4n), 57n);
  });

  it("wraps at CURVE_ORDER", () => {
    const result = evalPoly([CURVE_ORDER - 1n, 1n], 2n);
    // (CURVE_ORDER - 1 + 2) mod q = 1
    assert.equal(result, 1n);
  });
});
