# Verifiable Shuffle Proofs (WS5, v1)

Date: 2026-02-08
Status: Draft (prototype implementation included)

This document locks a concrete shuffle proof system for v1 and defines:

- The statement being proved by `Dealer.SubmitShuffle(...)`.
- The transcript format (bytes) and Fiat-Shamir tags.
- Expected proof sizes and verification complexity for a 52-card deck.

## 1. Cryptographic Setting

### 1.1 Group

Use a prime-order group `G` (recommended: Ristretto255) with:

- Generator `g`
- Order `q`

All group operations are written multiplicatively in this doc (`g^x`), but the implementation may use additive notation.

### 1.2 ElGamal Ciphertexts

Public key: `Y = g^x`.

Encrypt message `M ∈ G` with randomness `r`:

- `Enc_Y(M; r) = (c1, c2) = (g^r, M · Y^r)`

Re-encryption of ciphertext `C` by `ρ`:

- `ReEnc_Y((c1, c2); ρ) = (c1 · g^ρ, c2 · Y^ρ)`

## 2. Shuffle Statement

Let:

- Input deck `D_in = [C_0, ..., C_51]`, each `C_i` an ElGamal ciphertext under `Y`
- Output deck `D_out = [C'_0, ..., C'_51]`, ciphertexts under the same `Y`

The shuffle proof MUST prove:

> There exists a permutation `π` of `{0..51}` and scalars `ρ_0..ρ_51` such that for all `j`:
>
> `C'_j = ReEnc_Y(C_{π(j)}; ρ_j)`

Additionally, v1 ENFORCES **non-zero re-randomization** per shuffle step:

- For every output ciphertext, `c1'` MUST differ from *any* candidate input `c1` it could have come from in that local switch.
- This prevents "pure permutation" shuffles with `ρ=0` that are linkable.

## 3. Chosen Proof System (v1)

### 3.1 High-Level Idea

We implement a **verifiable adjacent-swap shuffle network** using standard Sigma-protocol building blocks:

1. Route a chosen permutation using an **odd-even transposition** network on 52 items (52 rounds).
2. Each round consists of disjoint adjacent 2x2 "switches" that either:
   - pass through (no swap), or
   - swap the two ciphertexts,
   and in both cases **re-encrypt** both outputs.
3. For each 2x2 switch we attach a **2-branch OR-proof** that the outputs are a correct re-encrypted mapping of the inputs:
   - branch 0: `(out0,out1)` is re-encryption of `(in0,in1)`
   - branch 1: `(out0,out1)` is re-encryption of `(in1,in0)`
   while hiding which branch is true (so the permutation is not revealed).
4. For the few unpaired positions in "odd" rounds, we attach a plain re-encryption proof.

This is not as compact as Groth/Bayer-Groth shuffles, but it is:

- pairing-free,
- simple to implement correctly,
- built from well-known primitives (Chaum-Pedersen + OR composition),
- easy to benchmark and to replace later.

### 3.2 Per-Ciphertext Re-Encryption Proof (Chaum-Pedersen)

To prove `C' = ReEnc_Y(C; ρ)` without revealing `ρ`:

Let:

- `Δ1 = c1' / c1 = g^ρ`
- `Δ2 = c2' / c2 = Y^ρ`

Prove equality of discrete logs:

- `log_g(Δ1) = log_Y(Δ2) = ρ`

We use a Fiat-Shamir NIZK of the Chaum-Pedersen Sigma protocol.

### 3.3 2x2 Switch Proof (OR of Two Conjunctions)

For inputs `(A,B)` and outputs `(A',B')`, prove:

- Either:
  - `A' = ReEnc_Y(A; ρ0)` and `B' = ReEnc_Y(B; ρ1)`
- Or:
  - `A' = ReEnc_Y(B; ρ0)` and `B' = ReEnc_Y(A; ρ1)`

This is a standard 2-branch OR-proof constructed by simulating one branch and proving the other, with a single Fiat-Shamir challenge split as `e = e0 + e1 (mod q)`.

## 4. Transcript / Byte Format (v1)

This section defines the byte encoding used at the `PokerTable <-> Dealer` interface boundary.

### 4.1 Primitive Encodings

- `Scalar`: 32-byte little-endian integer mod `q`
- `Point`: 32-byte canonical compressed encoding (Ristretto255: 32 bytes)
- `Ciphertext`: `c1 || c2` (64 bytes)

### 4.2 Chaum-Pedersen Re-Encryption Proof Encoding

`ReEncProof` (96 bytes):

- `t1` (Point, 32)
- `t2` (Point, 32)
- `z`  (Scalar, 32)

### 4.3 Switch OR-Proof Encoding

`SwitchProof` (416 bytes):

- `e0` (Scalar, 32)  (branch 0 challenge; branch 1 is derived)
- 4 Chaum-Pedersen transcripts, in order:
  - branch 0, relation 0 (out0 vs in0)
  - branch 0, relation 1 (out1 vs in1)
  - branch 1, relation 0 (out0 vs in1)
  - branch 1, relation 1 (out1 vs in0)
Each transcript is `(t1,t2,z)` = 96 bytes.

### 4.4 Full Shuffle Proof Encoding

Header:

- `version` (u8) = `1`
- `n` (u16 LE) = `52`
- `rounds` (u16 LE) = `52`

Then for each round `r = 0..51`:

1. `deck_r` (the post-round ciphertext deck):
   - `n` ciphertexts (each 64 bytes) => `n*64` bytes
2. Switch proofs for that round:
   - if `r` even: pairs `(0,1),(2,3),...,(50,51)` => 26 switch proofs
   - if `r` odd:  pairs `(1,2),(3,4),...,(49,50)` => 25 switch proofs
3. Single re-encryption proofs for unpaired indices:
   - if `r` odd: indices `0` and `51` => 2 proofs
   - if `r` even: none

This encoding is deterministic; no per-round counts are stored.

## 5. Expected Sizes And Complexity (N=52)

Let `N=52`, `R=52` internal rounds per shuffle step.

Counts:

- Switches per shuffle: `N*(N-1)/2 = 1326`
- Unpaired single proofs: `N = 52` (2 in each odd round)

Sizes (bytes):

- SwitchProof: 416 bytes
- ReEncProof: 96 bytes
- One deck snapshot: `N * 64 = 3328` bytes

Total proof size:

- Switch proofs: `1326 * 416 = 551,616`
- Singles: `52 * 96 = 4,992`
- Intermediate decks: `52 * 3328 = 173,056`
- Header: 5

Total: **729,669 bytes (~712.6 KiB)** per `SubmitShuffle`.

Verification work per shuffle proof (rough group-op count):

- Each SwitchProof verifies 4 Chaum-Pedersen relations.
- Each Chaum-Pedersen relation checks 2 equations, each equation costs ~2 scalar mults.
- Approx scalar mults per switch ≈ `4 relations * 4 muls = 16 muls`.

Total scalar mults:

- Switches: `1326 * 16 = 21,216`
- Singles: `52 * 4 = 208`
- Total ≈ **21,424 scalar mults** per shuffle step.

These are large but benchmarkable; see `packages/ocp-shuffle`.

## 6. Cost Model For Committee Sizes 16..64

If the chain follows SPEC 6.5 v1 recommendation `R_chain = |committee|` shuffle submissions per hand:

- Total proof bytes per hand ≈ `R_chain * 713 KiB`
- Total verification scalar mults per hand ≈ `R_chain * 21.4k`

This is likely too expensive without:

- fewer shuffle submitters (e.g., sample `k` shufflers per hand),
- fewer internal rounds per shuffle step, or
- a more compact shuffle proof (Groth/Bayer-Groth), and/or
- runtime precompiles for batch scalar multiplication (MSM) on the chosen curve.

The included benchmark script reports end-to-end verify times for 16..64 sequential shuffle proofs.

## 7. Plan B (If Too Expensive)

If benchmarks show the v1 switch-network proof is too heavy:

1. Replace the switch-network proof with a standard **Groth / Bayer-Groth** shuffle proof (pairing-free, much smaller).
2. Add a runtime precompile for:
   - multi-scalar multiplication (MSM),
   - batch Chaum-Pedersen verification,
   and keep this proof as an interim.

## 8. References

- Chaum, D. and Pedersen, T.P. "Wallet Databases with Observers." (Chaum-Pedersen equality-of-discrete-logs technique).
- Standard "OR-proofs" for Sigma protocols via challenge splitting (classic Cramer-Damgård-Schoenmakers style technique).
- Odd-even transposition routing / sorting network (parallel adjacent-swap network).
- Mixnet verifiable shuffles (background): https://eprint.iacr.org/2005/246

