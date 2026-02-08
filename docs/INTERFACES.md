# Interfaces (PokerTable <-> Dealer, Tx/Event Schema)

Date: 2026-02-08
Status: Draft

This document defines the "stable seams" that let teams build in parallel. It is intentionally narrow: the goal is to prevent cross-team thrash.

## 1. Dealer API (Conceptual)

All functions below are *on-chain* state transitions or protocol messages validated by the chain.

### 1.1 Epoch/Committee

- `Dealer.BeginEpoch(epochId, committee[], thresholdT, randEpoch)`
- `Dealer.SubmitDKGContribution(epochId, validatorId, contribution, proof)`
- `Dealer.FinalizeEpoch(epochId, PK_epoch, transcriptRoot)`

### 1.2 Per-Hand Deck

- `Dealer.InitHand(tableId, handId, epochId)`
  - Derives `PK_hand` from `PK_epoch` and `k = H_to_scalar(epochId||tableId||handId)`.
  - Initializes canonical encrypted deck `D0`.

- `Dealer.SubmitShuffle(tableId, handId, round, shufflerId, deckRootNew, proofShuffle)`
  - Must prove `D_new` is a re-encrypted permutation of `D_prev`.
  - v1 proof encoding: see `docs/SHUFFLE.md` (reference implementation: `packages/ocp-shuffle`).

- `Dealer.FinalizeDeck(tableId, handId, deckCommit, deckCursor=0)`

### 1.3 Hole Card Delivery (Private)

- `Dealer.AssignHoleCardPos(tableId, handId, seat, h, pos)`
  - Deterministic mapping from `(seat,h)` to `pos` once the deck is finalized.

- `Dealer.SubmitEncShare(tableId, handId, pos, validatorId, pkPlayer, encShare, proofEncShare)`
  - `encShare` encrypts the validator's decryption share to `pkPlayer`.
  - `proofEncShare` proves:
    - the share is correct for ciphertext at `pos`, and
    - the encryption binds exactly to that share under `pkPlayer`.

### 1.4 Community Reveal (Public)

- `Dealer.SubmitPubShare(tableId, handId, pos, validatorId, pubShare, proofPubShare)`
  - `proofPubShare`: Chaum-Pedersen equality of discrete logs.

- `Dealer.FinalizeReveal(tableId, handId, pos, plaintextCard)`

## 2. PokerTable API (Conceptual)

- `PokerTable.CreateTable(params)`
- `PokerTable.Sit(tableId, seat, buyIn, playerBond, pkPlayer)`
- `PokerTable.Leave(tableId)`

Hand driver:

- `PokerTable.StartHand(tableId)`
  - calls into `Dealer.InitHand`.

Actions:

- `PokerTable.Act(tableId, actionType, amount?)`
- `PokerTable.Tick(tableId)` (applies timeouts deterministically)

Phase transitions:

- `PokerTable.RequestFlop(tableId)` -> Dealer reveals 3 cards
- `PokerTable.RequestTurn(tableId)` -> Dealer reveals 1 card
- `PokerTable.RequestRiver(tableId)` -> Dealer reveals 1 card
- `PokerTable.Showdown(tableId)` -> uses WS2 evaluator to settle

## 3. Events (Client Contract)

Minimum event set clients rely on:

- Table lifecycle: `TableCreated`, `PlayerSat`, `PlayerLeft`, `PlayerEjected`
- Hand lifecycle: `HandStarted`, `DeckFinalized`, `HoleCardAssigned`, `StreetRevealed`, `HandCompleted`, `HandAborted`
- Action log: `ActionApplied`, `TimeoutApplied`
- Dealer artifacts: `ShuffleAccepted`, `EncShareAccepted`, `PubShareAccepted`
- Slashing: `PlayerSlashed`, `ValidatorSlashed`

Events MUST include:

- `tableId`, `handId` (when applicable)
- a monotonic `eventIndex` or `(height, txIndex, logIndex)`

## 4. Serialization Rules (v1)

v1 concrete crypto suite (WS3):

- Group: Ristretto255
- Hash: SHA-512

### 4.1 Scalar

- `Scalar` is a 32-byte little-endian encoding of an integer `s` with `0 <= s < q`.
- Decoders MUST reject non-canonical encodings (`s >= q`).

### 4.2 GroupElement

- `GroupElement` is a 32-byte canonical Ristretto255 encoding.
- Decoders MUST reject invalid/non-canonical encodings.

### 4.3 Fiat-Shamir Transcript (v1)

Used for non-interactive proofs (domain separated).

Let `u32le(n)` be 4-byte little-endian unsigned length.

Transcript state is a SHA-512 hash initialized with:

- ASCII `OCPv1|transcript|`
- `u32le(len(domainSep)) || domainSep(utf8)`

Appending a message `(label, msgBytes)` updates the hash with:

- ASCII `msg`
- `u32le(len(label)) || label(utf8)`
- `u32le(len(msgBytes)) || msgBytes`

Challenge scalar `e = ChallengeScalar(label)` is computed by:

- cloning the transcript hash state
- updating the clone with ASCII `challenge`
- `u32le(len(label)) || label(utf8)`
- digesting to 64 bytes `h`
- interpreting `h` as a little-endian integer and reducing mod `q`

### 4.4 Chaum-Pedersen Proof Encoding (v1)

For the proof of equality of discrete logs `log_g(Y) = log_{c1}(d)`:

- `proofCP = A(32) || B(32) || s(32)`
  - `A`, `B` are `GroupElement` encodings
  - `s` is a canonical `Scalar` encoding

Transcript binding (v1):

- `domainSep = ocp/v1/chaum-pedersen-eqdl`
- Append messages in this exact order:
  - `("y", Y)`
  - `("c1", c1)`
  - `("d", d)`
  - `("a", A)`
  - `("b", B)`
- Challenge scalar is `e = ChallengeScalar("e")`.

Reference implementation: `packages/ocp-crypto`.
