# DKG v2: Encrypted-Share DKG with On-Chain Verifiable Encryption

Date: 2026-04-18
Status: Design (chain integration to follow)

## 0. Problem Statement

The current DKG (see `docs/DKG.md` §3.4) allows any dealer to respond to a
complaint via `MsgDkgShareReveal(epochId, dealer=i, to=j, share=s_{i,j})`,
where `share` is the **plaintext scalar** `f_i(j) mod q`. This was marked
as an acceptable compromise at the time ("revealing some evaluations of a
polynomial does not break secrecy unless the adversary can reconstruct the
epoch secret"). It is not.

In practice the chain accepts one `MsgDkgShareReveal` per (dealer, complainer)
pair, and any sufficiently motivated observer can:

1. Provoke complaints for up to `t` recipients against a target dealer `i`.
2. Harvest `t` plaintext evaluations of `f_i`.
3. Lagrange-interpolate `f_i(0) = a_{i,0}` — the dealer's secret contribution
   to `sk_E`.
4. Repeat for every dealer in `QUAL`, recovering the full epoch secret
   `sk_E = Σ a_{i,0}`.

Even without a motivated attacker, the existing on-chain logic leaks share
bytes to the public mempool anytime the complaint-reveal flow is exercised.
The threshold trust model collapses to "trust the most-accusatory set of
`t-1` validators plus the chain's mempool".

DKG v2 closes this hole by making share delivery **verifiable encryption**
on-chain rather than off-chain, and making the complaint/reveal flow
challenge specific ciphertexts rather than plaintext shares.

## 1. Cryptographic Primitives (this PR)

Added in `packages/ocp-crypto/src/proofs/dkgEncShare.ts`:

- `DkgEncShareProof` — a Sigma / Schnorr-style NIZK with Fiat-Shamir
  transcript domain `"ocp/v1/dkg/encshare"`.
- `dkgEncShareProve`, `dkgEncShareVerify`, `encodeDkgEncShareProof`,
  `decodeDkgEncShareProof` (fixed 160-byte wire format).
- `evalCommitments(C[], j)` helper that computes `Σ_k C_k * j^k`.

**Statement.** Public inputs `(C_0, …, C_{t-1}, j, pkR, U, V)` with `j` a
uint32 recipient index (`j >= 1`). The prover knows scalars `(s, r)` such
that:

- (a) `s*G = Σ_{k=0..t-1} C_k * j^k` — the share scalar `s` is consistent
  with the Feldman commitments the dealer already published.
- (b) `U = r*G` — valid ElGamal ephemeral.
- (c) `V = s*G + r*pkR` — ElGamal ciphertext on the **share point** `s*G`
  (encryption "in the exponent") under `pkR`.

**Protocol.** Prover picks fresh nonces `(ws, wr)` and sends
`A1 = ws*G`, `A2 = wr*G`, `A3 = ws*G + wr*pkR`. Challenge
`e = H(C_0, …, C_{t-1}, j, pkR, U, V, A1, A2, A3)` is bound to all public
inputs including the length `t` of the commitment vector, so truncation
attacks are impossible. Responses `ss = ws + e*s`, `sr = wr + e*r`.

Verification: `ss*G == A1 + e * Eval_j`, `sr*G == A2 + e * U`, and
`ss*G + sr*pkR == A3 + e * V` (with `Eval_j := Σ_k C_k * j^k`). All three
checks are required.

**Security.** Standard Schnorr/Sigma argument on a linear statement over a
prime-order group (Ristretto255), Fiat-Shamir transformed with a typed
transcript that includes domain separation, threshold length, and all
public group elements. Knowledge-soundness follows the usual rewinding
argument; zero-knowledge (in the ROM) follows from the uniform distribution
of `(ss, sr)` under fresh `(ws, wr)`. The proof reveals nothing about `s`
or `r` beyond what is already implied by the public statement
(`Eval_j`, `U`, `V`).

Because `V = s*G + r*pkR`, the recipient — and only the recipient —
recovers the **share point** `s*G` via `V - skR*U`. The share **scalar**
`s` never appears on-chain. Aggregating share points across dealers gives
each recipient's threshold public-key share point
`SK_j*G = Σ_{i ∈ QUAL} f_i(j)*G`, which is what the on-chain verifier
already uses to check decryption-share proofs downstream.

**Tests.** `packages/ocp-crypto/test/dkgEncShare.test.ts`: round-trip
prove/verify, canonical encode/decode, recipient decryption sanity,
and negative cases for wrong share scalar, wrong recipient index,
tampered commitments (both perturbed and truncated), tampered
ciphertext (U and V independently), proof-to-wrong-recipient, zero
nonces, and wrong-length encodings.

## 2. New On-Chain Message Shape

Replace the current off-chain signed `DKGShare(...)` + plaintext
`MsgDkgShareReveal` pair with a single on-chain message posted by the
dealer during Round 2.

```proto
message MsgDkgEncryptedShare {
  string dealer         = 1;  // valoper of the dealer (f_i's owner)
  uint64 epoch_id       = 2;  // dkg.EpochId
  uint32 recipient_index = 3; // j >= 1; matches DealerMember.Index
  bytes  u              = 4;  // 32 bytes, Ristretto255 canonical
  bytes  v              = 5;  // 32 bytes, Ristretto255 canonical
  bytes  proof          = 6;  // 160 bytes, DkgEncShareProof encoding
}
```

Acceptance rules (chain-side validation in a new `DkgEncryptedShare`
handler):

1. Signer is `dealer` and `dealer` is in `dkg.Members`.
2. `epoch_id == dkg.EpochId`; `BlockHeight() <= dkg.ShareDeadline`.
3. `recipient_index` matches some `DealerMember.Index` (recipient != dealer).
4. `commit := findDKGCommit(dkg, dealer)` exists (dealer already committed).
5. `pkR := DealerMember(recipient).DkgEphemeralPubkey` — a new field on
   `DealerMember`, the recipient's per-epoch ElGamal public key, posted
   during committee selection or via a prior `MsgDkgSetEphemeral` step.
6. Call `dkgEncShareVerify(commitments=commit.Commitments, j=recipient_index,
   pkR, u, v, proof)`. On failure, reject; on success, persist the
   ciphertext + proof into `dkg.EncryptedShares` (keyed by
   `(dealer, recipient_index)`).

Once `ShareDeadline` passes, any `(dealer, recipient_index)` pair with no
stored ciphertext is grounds for a `DkgComplaintMissing` against the dealer
(same as today, just keyed off the on-chain table instead of p2p gossip).

## 3. Updated Complaint Flow

Because share delivery is now on-chain and ciphertexts are publicly
verifiable against commitments, most old complaint paths collapse into
one-shot chain-side checks. The remaining legitimate complaint is
"you decrypted my share and it didn't match `C_{i,0}`'s contribution
after downstream use" — but we don't need that level because the proof
already binds `s*G` to the commitments. The only residual failure mode
is ciphertext-mangling / bit-flipping after-the-fact, which the proof
prevents at submit time.

The flow reduces to:

- **Missing (unchanged).** `MsgDkgComplaintMissing(epochId, complainer, dealer)`
  opens when `ShareDeadline` passed and the chain has no encrypted share
  from `dealer` to `complainer`. The dealer can cure by posting a
  `MsgDkgEncryptedShare` before `ComplaintDeadline` (closing the
  complaint). Otherwise the dealer is slashed at `RevealDeadline`.
- **Invalid (reshaped).** A recipient that believes a specific ciphertext
  `(u, v)` — one that passed the on-chain proof check — nevertheless
  fails their local sanity check (e.g. decrypts to a point they
  independently can't reconcile with their share agreement) can submit
  `MsgDkgComplaintInvalid(epochId, complainer, dealer, u, v)`. The chain
  re-runs `dkgEncShareVerify` against the stored `(u, v, proof)`. In the
  baseline protocol this will always succeed (the chain only accepts
  valid ciphertexts), so `DkgComplaintInvalid` is expected to be a no-op
  for honest chains and is retained primarily as a liveness tripwire for
  future proof-system bugs. It **never carries plaintext shares**.
- **Reveal (replaced).** The old `MsgDkgShareReveal` carrying a plaintext
  `share` scalar is **removed**. Its replacement for the "missing share"
  cure case is an ordinary `MsgDkgEncryptedShare` submission — same
  message, same proof, just arriving late.

Slashing rules tighten accordingly:

- Dealer posts `MsgDkgEncryptedShare` with a proof that verifies → accepted.
- Dealer posts `MsgDkgEncryptedShare` with a bad proof → reject
  (not slash, because the message is simply ignored; duplicates or
  malformed attempts are rate-limited via the existing signing path).
- Dealer has no stored `(u, v, proof)` for `(dealer, recipient)` at
  `RevealDeadline` → **slash** (same penalty parameters as today's
  missing-share slash).

Key property: **at no point does a share scalar appear on-chain.**

## 4. Recipient Decryption + Aggregation

Each epoch, each committee member `j` holds a fresh per-epoch ElGamal
keypair `(skR_j, pkR_j)`. The `pkR_j` lives in `DealerMember`; `skR_j`
is held in the validator's `dealer-daemon` state and never leaves it.
(Rationale: rotate per epoch so that compromising one epoch's recipient
keys cannot retroactively decrypt older epochs' share deliveries.)

During Round 2 / Round 3:

1. Recipient `j` watches `MsgDkgEncryptedShare` events for
   `recipient_index == j`. For each dealer `i`:
   1. Pull `(u_i, v_i, proof_i)` from chain state.
   2. Re-run `dkgEncShareVerify` locally. (Consensus already did this;
      this is belt-and-suspenders against chain bugs.)
   3. Decrypt the **share point**: `S_{i,j} := v_i - skR_j * u_i`.
      By construction `S_{i,j} = s_{i,j} * G = f_i(j) * G`.
2. After `dkg.QUAL` is determined, recipient `j` stores the **share point**
   `SK_j*G := Σ_{i ∈ QUAL} S_{i,j}` locally and uses it for the downstream
   partial-decrypt proof path (`proofs/encShare.ts`, `chaumPedersen.ts`).

Important consequence: **recipients no longer hold a scalar share.** The
existing downstream protocol uses `sk_j * C1`-style Chaum-Pedersen
decryption-share proofs that require a scalar witness. DKG v2 makes that
scalar unavailable on-chain by design — but the recipient's local dealer
daemon can still hold `s_{i,j}` as a scalar (it decrypts to a point, and
by knowing `s_{i,j}` would be the `discrete log` of `S_{i,j}`, the daemon
cannot obtain the scalar from `S_{i,j}` alone). To preserve the scalar
witness we have two options:

- **Option A (preferred).** Encrypt the share scalar `s` as an additional
  ciphertext alongside the share point, using the same ElGamal keypair but
  with a separate randomness and an extra proof component. The proof
  expands to also bind the hybrid encryption of `s`. This keeps the
  current downstream Chaum-Pedersen interface unchanged.
- **Option B.** Switch downstream to group-element shares and port the
  decryption-share proofs to use discrete-log-witness via Pedersen-style
  commitments. Larger refactor.

For this PR we ship Option A's primitive shape (the proof statement as
specified) and leave the explicit scalar-hybrid extension as a follow-up
decision. The minimum viable chain-side integration can ship with Option
B by having `dealer-daemon` record `s_{i,j}` locally at its source (the
dealer already knows `f_i(j)` when it builds the ciphertext, and in a
real rollout the receiving daemon can derive `s` from `S_{i,j}` using a
small-range search only if `s` is constrained — it is not, so Option A
is the right long-term shape).

## 5. Why This Fixes The Plaintext Leak

- On-chain state after Round 2 contains only `(u, v, proof)` tuples.
  Each `v = s*G + r*pkR` is semantically secure ElGamal under DDH; without
  `skR` it leaks no information about `s*G`, let alone `s`.
- The complaint / reveal path no longer accepts plaintext scalars. There
  is simply no message type that moves `s` bytes through the mempool.
- The proof binds the ciphertext to the Feldman commitments — a dealer
  cannot post a chaff ciphertext whose plaintext doesn't match its
  polynomial. This preserves all the objective slashing properties the
  current chain relies on.
- Observers see `N*(N-1)` ciphertexts per epoch. By DDH, these are
  indistinguishable from random group-element pairs even with access to
  the public key `PK_E = Σ C_{i,0}`. Recovering any `s_{i,j}` requires
  breaking either DDH on Ristretto255 or compromising `>= t` recipient
  keys — which is the same `t-out-of-N` assumption the threshold model
  is designed to protect.

## 6. Migration Plan

Protocol-version bump on `x/dealer`:

1. **v1** (current): plaintext shares in `MsgDkgShareReveal`. Keep in
   the codebase behind `if params.DkgVersion == 1` for chain-upgrade
   compatibility.
2. **v2** (this design): encrypted shares via `MsgDkgEncryptedShare`;
   `MsgDkgShareReveal` removed from accepted message types; recipient
   ephemeral pubkey added to `DealerMember`.
3. Governance switches `params.DkgVersion` at an epoch boundary
   (`SwitchEpoch`). The switch MUST be at `dkg.EpochId`'s round-1 start
   to avoid mixed-round state.

Follow-up PRs (out of scope here):

1. Chain: add `MsgDkgEncryptedShare` / `DealerDKGEncryptedShare` proto
   types, `DkgEphemeralPubkey` field on `DealerMember`, a
   `dkgEncShareVerify` wrapper in `apps/cosmos/x/dealer/keeper/logic.go`
   (Go port of `packages/ocp-crypto`'s primitive — or a thin wrapper
   over an existing Go impl; see `ocpcrypto` Go package), and route the
   new msg through `msg_server.go`.
2. Dealer daemon: per-epoch ElGamal keygen, sign+submit
   `MsgDkgEncryptedShare`, decrypt on ingest, drop the old p2p signed-
   share path.
3. Remove `MsgDkgShareReveal` and its handler in
   `apps/cosmos/x/dealer/keeper/msg_server.go` at v2 activation height.
4. Test-vectors: freeze a `vectors/dkg-encshare/*.json` set from
   `packages/ocp-crypto` for cross-language conformance (Go chain,
   TS daemon).

## 7. Interfaces Added This PR

- `packages/ocp-crypto/src/proofs/dkgEncShare.ts` — proof primitive.
- `packages/ocp-crypto/src/index.ts` — exports the new API.
- `packages/ocp-crypto/test/dkgEncShare.test.ts` — positive, round-trip,
  and six tampering/negative cases.

No Go or dealer-daemon changes in this PR.
