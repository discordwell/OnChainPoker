# DKG (WS4): Threshold Keying + Per-Hand Key Derivation

Date: 2026-02-08  
Status: Draft (implementation-oriented)

This document specifies a *slashable* Distributed Key Generation (DKG) protocol for producing an epoch dealer public key `PK_E` and per-validator secret shares `sk_i`, plus the deterministic per-hand derivation described in `docs/SPEC.md` Sections 6.2 and 6.3.

The concrete crypto suite (curve, proofs, serialization) is owned by WS3/WS5. This document focuses on protocol structure, message types, deadlines, and objective slashing evidence.

## 0. Summary

- Committee `C_E` of size `N` runs DKG at epoch `E` to produce:
  - `PK_E` (public key)
  - per-validator secret shares `sk_i` (threshold `t`)
  - `transcriptRoot` (hash commitment to the on-chain DKG transcript)
- Per hand `(tableId, handId)` derives:
  - `k = H_to_scalar(E || tableId || handId)`
  - `PK_hand = PK_E ^ k`
  - `sk_i_hand = (sk_i * k) mod q`

## 1. Assumptions / Threat Model (DKG Scope)

- The chain can verify *public* DKG artifacts deterministically.
- Private messages between validators are allowed (p2p gossip). Any private message used as slashing evidence MUST be signed by the sender.
- Confidentiality breaks if an adversary controls `>= t` committee members (same as `docs/SPEC.md`).

## 2. Parameters

- `N`: committee size
- `t`: threshold (suggested `t = floor(2N/3) + 1`)
- `q`: prime group order
- `G`: prime-order group with generator `g`
- Epoch-level deadlines in blocks or seconds:
  - `commitDeadline`: last time to post coefficient commitments
  - `shareDeadline`: last time to send signed shares off-chain
  - `complaintDeadline`: last time to post a complaint
  - `revealDeadline`: last time for an accused dealer to respond on-chain
  - `finalizeDeadline`: last time to finalize epoch (else abort + slash non-finalizers)

Deadline policy:

- Deadlines MUST be deterministic functions of epoch start height/time and configured durations.
- Missing a required on-chain message by its deadline is objectively slashable.

## 3. DKG Construction (Feldman-Style With Complaint/Reveal)

Each committee member acts as a "dealer" of a random polynomial. The final secret is the sum of all qualified dealers' secrets.

### 3.1 Round 1: Commitments (On-Chain)

For each validator `i ∈ C_E`:

1. Sample random polynomial over `Z_q` of degree `t-1`:
   - `f_i(x) = a_{i,0} + a_{i,1} x + ... + a_{i,t-1} x^{t-1}`
2. Post coefficient commitments on-chain:
   - `C_{i,k} = g^{a_{i,k}}` for `k=0..t-1`

On-chain message:

- `DKGCommit(epochId, dealerId=i, commitments=[C_{i,0}..C_{i,t-1}])`

Rules:

- If `DKGCommit` is not posted by `commitDeadline`, slash `i` and exclude from `QUAL`.
- Commitments are immutable once posted for an epoch.

### 3.2 Round 2: Share Delivery (Off-Chain, Signed)

For each dealer `i` and recipient `j` (where `j` is the validator id used as the interpolation x-coordinate):

- Compute share scalar: `s_{i,j} = f_i(j) mod q`.
- Send the following signed message off-chain to recipient `j`:

`DKGShare(epochId, from=i, to=j, share=s_{i,j}, sig_i)`

Recipient verification:

- Check signature `sig_i`.
- Check share vs commitments:
  - `g^{s_{i,j}} == ∏_{k=0..t-1} C_{i,k}^{j^k}`

### 3.3 Round 3: Complaints (On-Chain)

If recipient `j` detects any issue for dealer `i`:

- missing share by `shareDeadline`, OR
- invalid share vs commitments, OR
- malformed signature

then `j` posts a complaint on-chain by `complaintDeadline`.

On-chain messages:

- Missing share:
  - `DKGComplaintMissing(epochId, complainer=j, dealer=i)`
- Invalid share (includes the dealer-signed share as evidence):
  - `DKGComplaintInvalid(epochId, complainer=j, dealer=i, shareMsg=DKGShare{...})`

Rules:

- Complaints after `complaintDeadline` are ignored.
- Complaints MUST be deterministic to evaluate:
  - signature check,
  - share validity check against the already-posted commitments.

### 3.4 Round 4: Dealer Response / Reveal (On-Chain)

For each complaint against dealer `i`, the chain opens an obligation for `i` to respond by `revealDeadline`:

- `DKGShareReveal(epochId, dealer=i, to=j, share=s_{i,j})`

Deterministic resolution:

1. If dealer `i` fails to reveal by `revealDeadline`: slash `i`, exclude from `QUAL`.
2. Else verify `share` vs commitments:
   - If invalid: slash `i`, exclude from `QUAL`.
3. If complaint was `DKGComplaintInvalid` and included a signed `DKGShare`:
   - If `share` does not equal the signed `shareMsg.share`: slash `i` for equivocation (sent one share, revealed another), exclude from `QUAL`.
   - If it matches and verifies: complaint is false; chain MAY slash `j` (policy choice).

Notes:

- `DKGShareReveal` reveals one share publicly. This is acceptable because:
  - the adversary model already allows `< t` corruptions; and
  - revealing some evaluations of a polynomial does not break secrecy unless the adversary can reconstruct the epoch secret (requires threshold compromise).
- Upgrade path: replace reveal-with-plaintext with PVSS / verifiable encryption to avoid any plaintext reveal. This is not required for the WS4 prototype but is compatible with the interface.

### 3.5 QUAL Set, Output Key, and Transcript Root

Define `QUAL` = committee members not excluded by the deterministic slashing rules above.

Success condition:

- `|QUAL| >= t` (otherwise epoch keying fails deterministically).

Epoch public key:

- `PK_E = ∏_{i ∈ QUAL} C_{i,0}`.

Per-validator secret share for validator `j`:

- `sk_j = ( ∑_{i ∈ QUAL} s_{i,j} ) mod q`

Transcript commitment:

- `transcriptRoot = MerkleRoot( Hash(msg) for all DKG messages accepted on-chain )`
- Canonical message encoding and domain separation MUST be specified by WS3 (placeholder).

Finalize:

- `Dealer.FinalizeEpoch(epochId, PK_E, transcriptRoot)`

## 4. Per-Hand Key Derivation (No Per-Hand DKG)

As in `docs/SPEC.md` Section 6.3:

- `k = H_to_scalar(epochId || tableId || handId)`
- `PK_hand = PK_E ^ k`
- `sk_i_hand = (sk_i * k) mod q`

Domain separation:

- `H_to_scalar` MUST include a stable domain tag, e.g.:
  - `k = H_to_scalar("OCP/handkey/v1" || epochId || tableId || handId)`

## 5. Slashable Evidence (Concrete, Objective)

Objective (chain-verifiable) slashing conditions:

- Missing `DKGCommit` by `commitDeadline`.
- Posting malformed commitments (wrong length/encoding) at `DKGCommit`.
- Missing `DKGShareReveal` by `revealDeadline` for an opened complaint.
- Revealing a share that fails verification against posted commitments.
- Equivocation: a complaint includes a valid dealer-signed `DKGShare` but the dealer reveals a different share.

Non-objective behaviors that require a challenge to become objective:

- Withholding a share off-chain becomes objective only if a complaint is filed and the dealer then fails to reveal a valid share by the reveal deadline.

## 6. Prototype (Repo)

The WS4 prototype implementation lives in:

- `packages/dkg`: off-chain simulation of:
  - all-honest DKG success,
  - 1 byzantine equivocation => complaint + slash + still finalize,
  - withholding beyond tolerance => deterministic abort.

This prototype uses a small toy safe-prime group for fast tests. Production must use the suite chosen in WS3 (recommended: Ristretto255 per `docs/SPEC.md`).

