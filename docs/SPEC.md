# OnChainPoker Appchain Specification (Draft)

Status: Draft
Version: 0.1
Date: 2026-02-08

This document specifies a poker-specific blockchain ("OnChainPoker chain") where:

- Funds custody, betting, and settlement are executed on-chain.
- The "dealer" is an on-chain protocol module.
- No player and no single validator can learn unrevealed cards.
- Cheating/violations that are objectively provable are slashable while the hand continues whenever possible.

This spec is written to be implementation-oriented and is intentionally explicit about assumptions. It uses RFC-style keywords (MUST/SHOULD/MAY) as normative requirements.

## 1. Goals And Non-Goals

### 1.1 Goals

- Support 9-max Texas Hold'em cash games (ring games) in v1.
- On-chain escrow and accounting:
  - Every chip used in play exists on-chain.
  - Every bet updates on-chain pot/stack state (no "signatures-per-action" requirement).
- Confidential dealing:
  - Hole cards are delivered privately to the intended player.
  - Community cards are revealed publicly at flop/turn/river.
  - Unrevealed future cards are not knowable to players and are not knowable to any single validator.
- Deterministic dispute handling:
  - The chain enforces turn order, action validity, pot/side-pot correctness, and hand settlement deterministically.
- Slashable misbehavior:
  - The protocol defines objective evidence for violations and slashes accordingly.
  - Where feasible, slashing/removal of an offender MUST NOT prevent the hand from completing.
- A non-trusted coordinator service MAY exist for matchmaking and UX, but MUST NOT control custody or unilateral settlement.

### 1.2 Non-Goals

- Preventing all forms of collusion, screen-sharing, or out-of-band signaling.
- Achieving confidentiality against an adversary controlling a threshold of the dealer committee.
- Full anonymity / private transfers at the chain level (can be added later).
- Tournament formats in v1 (possible later).

## 2. Security Model

### 2.1 Participants

- Players: end users seated at a poker table.
- Validators: nodes participating in consensus and executing the state machine.
- Dealer committee: a subset of validators (possibly all) tasked with threshold cryptographic operations for dealing/revealing.
- Coordinator service: off-chain matching/relay service (untrusted for correctness, trusted only for convenience).

### 2.2 Trust And Assumptions (Explicit)

Because "the contract" is executed by validators, the strongest achievable confidentiality is threshold-based:

- Confidentiality and correct dealing assume that fewer than `t` members of the dealer committee are adversarial at any given time.
  - If an adversary controls `t` or more committee members, they can decrypt hole cards and/or future cards and the game is compromised.
- Consensus safety/liveness follows the underlying BFT assumptions (e.g., < 1/3 Byzantine for Tendermint-style, or the chosen protocol's thresholds).

This is the best possible approximation to "trust nobody but the contract" in a decentralized system:

- No single party (player, coordinator, or validator) can learn unrevealed cards.
- Only an adversary that controls a threshold of the on-chain dealer power can break confidentiality.

### 2.3 Threats Addressed

- Player attempts to take illegal actions (out of turn, invalid amounts, etc.).
- Player attempts to grief by not acting.
- Validator attempts to bias or tamper with dealing.
- Validator attempts to withhold required cryptographic shares (liveness attack).
- Coordinator attempts to lie about game state (irrelevant; chain is source of truth).

### 2.4 Threats Not Fully Addressed

- Player collusion or out-of-band sharing of private information.
- Economic bribery that corrupts >= `t` dealer committee members.

## 3. Chain Architecture Overview

The OnChainPoker chain is an appchain/rollup with native modules:

- `Bank`: balances, transfers, fees.
- `Staking`: validator staking and slashing.
- `Governance`: parameter and upgrade control.
- `PokerTable`: table lifecycle, 9-max betting state machine, settlement, player-level penalties.
- `Dealer`: threshold cryptography for deck creation, private hole-card delivery, and public reveals.

The chain MUST provide:

- A canonical transaction ordering (consensus).
- Deterministic state transitions given transactions and protocol messages.
- A mechanism for validators/committees to submit cryptographic artifacts (proofs/shares) to chain state.

## 4. Token Model (Economics Layer)

### 4.1 Native Token

The chain SHOULD have a native staking token (e.g., `OCP`) used for:

- Validator stake (slashable).
- Transaction fees.
- Optional treasury/rake routing.

### 4.2 In-Game Chips

The simplest v1 model is single-asset chips:

- Chips are the native token (one asset system-wide).

Future variants MAY support multiple assets or bridged tokens, but those add complexity:

- fee accounting,
- oracle-less pricing,
- and increased attack surface.

## 5. PokerTable Module Specification

### 5.1 Table Parameters

Each table has immutable parameters:

- `maxPlayers`: MUST be 9 in v1.
- `smallBlind`, `bigBlind`: chip amounts.
- `minBuyIn`, `maxBuyIn`: chip amounts.
- `playerBond`: additional slashable bond required to sit.
- `actionTimeoutSecs`: maximum time a player has to act on their turn.
- `dealerTimeoutSecs`: maximum time for dealer steps (shuffle/share/reveal).
- `rakeBps`: optional basis points rake (MUST be 0 in v1 unless governance explicitly enables).

Tables have mutable state:

- seating and player status,
- current hand state,
- pots and side pots,
- deadlines for actions and dealer steps.

### 5.2 Player Lifecycle

To join a table a player MUST:

- reserve a seat,
- deposit `buyIn` chips to the table escrow,
- deposit `playerBond` to a slashable bond account,
- register a public key `PK_player` used for private hole-card delivery for the current/next hand.

Player states:

- `Seated` (funded, waiting),
- `InHand` (active in current hand),
- `Folded` (folded this hand),
- `AllIn` (no further actions),
- `SitOut` (temporarily not dealt),
- `Ejected` (removed due to penalties),
- `Left` (withdrew from table when not in a hand).

### 5.3 Hand State Machine (9-max Texas Hold'em)

Hand phases:

1. `HandInit` (assign button, blinds)
2. `Shuffle` (Dealer module builds committed encrypted deck)
3. `DealHole` (Dealer module delivers 2 hole cards to each active player privately)
4. `PreflopBetting`
5. `FlopReveal` (3 community cards public)
6. `FlopBetting`
7. `TurnReveal`
8. `TurnBetting`
9. `RiverReveal`
10. `RiverBetting`
11. `Showdown` (reveal necessary hole cards, evaluate winners, distribute pots)
12. `HandComplete` (update stacks, advance button)

The chain MUST enforce:

- turn order,
- legal actions per round,
- bet sizing constraints (including no-limit rules),
- correct pot and side pot creation,
- all-in handling.

Hand termination:

- If only one player remains not-folded, the hand ends immediately and that player wins remaining pots without further reveals.

### 5.4 Action Submission

Players submit on-chain transactions:

- `Fold`
- `Check`
- `Call`
- `Bet(amount)`
- `Raise(amount)` (or `BetTo(totalBetTo)` depending on chosen representation)

The chain MUST reject invalid actions deterministically.

### 5.5 Timeouts And Player Penalties

If a player fails to act within `actionTimeoutSecs`:

- The chain MUST auto-apply a default action:
  - If `Check` is legal: `Check`.
  - Else: `Fold`.
- The chain SHOULD slash part of the player's `playerBond` (configurable) and MAY also apply an additional table-level penalty (e.g., forced sit-out next hand).
- The hand MUST continue.

Timeout events MUST be fully on-chain and not dependent on an off-chain reporter. Any actor MAY submit a `Tick(tableId)` transaction to advance timeouts.

## 6. Dealer Module Specification (Confidential Dealing)

### 6.1 Cryptographic Primitives (Abstract)

The Dealer module relies on:

- Threshold public-key encryption (TPKE) for encrypting deck cards.
- Distributed Key Generation (DKG) to create threshold keys without a trusted dealer.
- Verifiable shuffle proofs for re-encryption + permutation of ciphertext lists.
- Verifiable (distributed) decryption shares with proofs of correctness.
- A method for delivering decryption shares privately to a single player.

This spec intentionally does not lock the implementation to one curve/proof system, but requires:

- a group of prime order `q`,
- efficient exponentiation,
- and verifiable proofs that are efficient to verify on-chain.

Recommended families:

- Verifiable shuffles: Neff-style or Groth/Bayer-Groth shuffle proofs (mixnet literature).
- Verifiable decryption shares: Chaum-Pedersen equality-of-discrete-log style proofs.
- Verifiable encryption of shares: Camenisch-Shoup style verifiable encryption or an equivalent construction.

#### 6.1.1 Concrete v1 Suite (Recommended)

To make v1 implementable without pairings, the chain SHOULD implement the Dealer module over a prime-order elliptic curve group `G` with:

- A generator `g`
- Order `q`
- Efficient scalar multiplication

Candidate: Ristretto255 (built on Curve25519) with well-maintained Rust libraries.

Encryption:

- Use ElGamal-style encryption in `G`:
  - Public key: `Y = g^x`
  - Encrypt plaintext group element `M` with randomness `r`:
    - `C = (c1, c2) = (g^r, M * Y^r)`

Decryption shares and proofs:

- A validator public share is `Y_i = g^{x_i}` (or derived per hand).
- For a ciphertext `C = (c1, c2)`, a validator share is `d_i = c1^{x_i}`.
- Validator MUST provide a Chaum-Pedersen style proof that:
  - `log_g(Y_i) = log_{c1}(d_i)`

Private share delivery (encrypted to player):

- Each player encryption public key is `PKP = g^{x_p}` in the same group `G`.
- A validator encrypts its decryption share `d_i` to the player using ElGamal:
  - `EncShare = (u, v) = (g^r, d_i * PKP^r)`
- The validator MUST provide a non-interactive proof of knowledge (Fiat-Shamir Schnorr) that there exist scalars `(x_i, r)` such that:
  - `Y_i = g^{x_i}`
  - `u = g^r`
  - `v = c1^{x_i} * PKP^r`

This proof lets the chain verify the encrypted share is well-formed without learning `d_i`.

### 6.2 Key Material And Epochs

The chain operates in epochs.

Per epoch `E`, a dealer committee `C_E` is selected.

Committee selection MUST be unpredictable and unbiased relative to any single validator. The chain MUST provide an epoch randomness beacon `Rand_E` used to sample `C_E` from the validator set, e.g.:

- `C_E = Sample(Validators_E, seed = H(Rand_E || "dealer" || E))`

The committee MUST run DKG to produce:

- Epoch public key `PK_E`
- Per-validator secret key shares `sk_i` such that any `t` shares can decrypt, but fewer cannot.

The DKG transcript MUST be verifiable and slashable:

- Invalid share commitments, invalid complaints, or withheld contributions are slashable offenses.

### 6.3 Per-Hand Key Derivation (Avoid Per-Hand DKG)

To avoid running DKG per hand, the Dealer module MUST derive a per-hand key from epoch key material:

- Let `k = H_to_scalar(E || tableId || handId)` (a scalar mod `q`).
- Define `PK_hand = PK_E ^ k` (public key derivation).
- Each validator derives its share `sk_i_hand = (sk_i * k) mod q`.

This provides domain separation between hands while reusing epoch DKG.

### 6.4 Encrypted Deck Representation

The deck is represented as a list of ciphertexts:

- `DeckCipher[0..51]`, each encrypting a unique card identifier in `{0..51}` under `PK_hand`.

Card encoding:

- Each card `c` maps to a group element `M_c`.
- The mapping MUST be deterministic and collision-free for 52 values.

The module MUST commit to the deck:

- `deckCommit = MerkleRoot( hash(DeckCipher[i]) for i in 0..51 )`

This enables later audit/verification.

### 6.5 Verifiable Shuffle Procedure

To generate a fair deck order that is not predictable, the module performs a shuffle pipeline.

v1 RECOMMENDATION:

- Every member of the dealer committee MUST contribute exactly one shuffle step (so `R = |C_E|`).
- The shuffle order MUST be derived from `Rand_E` and `handId` to prevent the last shuffler from being selected adversarially.

1. Start from a canonical encrypted deck `D0` (ordered card set encrypted under `PK_hand`).
2. For shuffle round `r = 1..R`:
   - A designated shuffler `v_r` (committee member) outputs `Dr` which is a permutation + re-randomization of `D(r-1)`.
   - `v_r` MUST submit a shuffle proof `π_r` that `Dr` is a re-encrypted permutation of `D(r-1)`.
   - The chain MUST verify `π_r` and reject invalid shuffles.
   - If `v_r` fails to submit a valid shuffle by `dealerTimeoutSecs`, the chain MUST slash `v_r` and select the next shuffler.

Security requirement:

- If at least one shuffle round is performed by an honest shuffler, then the final permutation is unpredictable to adversaries controlling fewer than `t` committee members.

### 6.6 Dealing Hole Cards Privately

Hole cards MUST be private to the recipient.

For each player `P` in hand and each hole card index `h in {0,1}`:

- The protocol assigns a deck position `pos` (incrementing top-of-deck index).
- Let ciphertext `C_pos = DeckCipher[pos]`.
- Each committee member `i` computes a decryption share for `C_pos` under `sk_i_hand`.

To keep the plaintext private, the dealer committee MUST NOT publish decryption shares in the clear.

Instead, each committee member `i` MUST submit:

- `EncShare_i = Encrypt_to_player(PK_player[P], Share_i)` where `Share_i` is the decryption share for `C_pos`.
- A proof `ρ_i` attesting:
  - `Share_i` is a correct decryption share for `C_pos` under committee member i's derived public share, and
  - `EncShare_i` encrypts exactly `Share_i` under `PK_player[P]`.

The chain MUST verify `ρ_i` and reject invalid shares.

Player retrieval:

- Player `P` queries chain state for at least `t` valid encrypted shares for `(handId, pos)`.
- Player decrypts the encrypted shares locally and combines them via Lagrange interpolation to reconstruct the decryption factor and recover the plaintext card.

Timeout:

- If fewer than `t` valid shares are posted by `dealerTimeoutSecs`, the chain MUST slash missing/withholding committee members.
- If after slashing the remaining committee cannot reach threshold `t`, the hand MUST abort and all players MUST be refunded their in-hand uncommitted chips; committed pot amounts MUST be resolved by rule (see Section 8.2).

### 6.7 Revealing Community Cards Publicly

For community cards (flop/turn/river), the plaintext MUST be public.

For each reveal position `pos`:

- Committee members submit public decryption shares `Share_i` with a correctness proof.
- Once `t` valid shares are present, the chain combines them to decrypt the plaintext card and appends it to the board.

### 6.8 End-of-Hand Full Reveal (v1 Recommended)

To maximize auditability and simplify dispute resolution, v1 SHOULD decrypt and publish:

- the hole cards of all remaining players at showdown, and
- optionally all dealt cards (including mucked hands), depending on privacy goals.

This provides a public transcript proving:

- the deck matches `deckCommit`,
- all reveals match the committed encrypted deck,
- and settlement is correct.

## 7. Evidence, Challenges, And Slashing

### 7.1 Slashable Offenses (Players)

Player slashing MUST only occur for objectively provable violations:

- Timeout: failing to act by deadline (objective).
- Invalid action spam is simply rejected; optional rate-limits MAY apply.
- If the protocol requires player-provided reveals in any phase (not recommended in v1), failure is slashable.

Penalty semantics (v1):

- Offending player is marked `Folded` immediately.
- Their `playerBond` is partially or fully slashed (parameterized).
- Optionally, governance MAY configure an additional penalty that forfeits some or all of the player's remaining in-table stack to the pot or to the table (this is harsh; use carefully).
- Their current hand contributions remain in the pot; their remaining stack remains theirs unless governance opts for additional forfeiture.
- Hand continues among remaining players.

### 7.2 Slashable Offenses (Validators / Dealer Committee)

Committee members are slashable for:

- Invalid shuffle proof submission.
- Failure to submit required shuffle/proof/share within deadlines.
- Invalid decryption share proof.
- Any DKG protocol violation (invalid contributions, equivocation, withholding beyond deadlines).

Penalty semantics:

- Slashed stake is transferred:
  - a portion to the reporter (if any),
  - a portion to affected table players, and
  - a portion to treasury/burn (parameterized).
- Repeated offenses SHOULD lead to jailing/removal from validator set.

### 7.3 Challenges While Hand Continues

The chain MUST support applying penalties mid-hand without halting progress.

For players:

- Timeout-driven and immediate.

For committee members:

- Steps are parallelizable: multiple committee members can submit shares independently.
- Non-participation is handled by deadlines and slashing; as long as `t` honest members remain, dealing/revealing continues.

### 7.4 Reporting Interfaces

The chain MAY expose explicit "report" transactions to accelerate enforcement:

- `ReportDealerWithholding(handId, pos, validatorId)`
- `ReportDKGWithholding(epochId, validatorId)`

However, all rules MUST also be enforceable via timeouts without a trusted reporter.

## 8. Hand Abort And Refund Rules

Hand abort is a last resort, used when confidentiality/liveness cannot be guaranteed (e.g., dealer threshold cannot be reached).

### 8.1 Abort Conditions

A hand MUST abort if:

- The dealer committee cannot produce a valid deck within `dealerTimeoutSecs`, OR
- The dealer committee cannot deliver enough shares for hole cards or public reveals, and threshold `t` cannot be reached after applying slashing/removal rules.

### 8.2 Refund Semantics (Default)

When aborting:

- If abort occurs before any betting action (beyond posting blinds), refund all but blinds by rule (blinds can be refunded or treated as returned; parameterized).
- If abort occurs mid-hand, the chain MUST deterministically resolve escrowed funds:
  - Option A (simplest): refund each player's uncommitted stack and return committed contributions pro-rata to their committed amounts.
  - Option B (aggressive): treat committed pots as locked and refund only uncommitted.

v1 SHOULD implement Option A for user fairness unless it creates exploitable griefing.

### 8.3 Anti-Griefing Considerations

If abort refunds committed amounts, an attacker may try to repeatedly force abort to avoid losing.

Mitigations:

- Player bonds (slash for timeouts or deliberate abort triggers).
- Dealer committee slashing for withholding.
- Optional "abort penalty" shared by all participants to discourage repeated aborts.

## 9. Data Structures (Conceptual)

The exact encoding depends on the chain framework (SCALE, protobuf, etc.). Conceptually:

### 9.1 Table

- `tableId`
- `params`
- `seats[9]` (optional player ids)
- `stacks[player]` (chips)
- `bonds[player]` (slashable)
- `status`
- `currentHandId`
- `handHistoryRoot` (optional commitment to history)

### 9.2 Hand

- `handId`
- `tableId`
- `phase`
- `buttonSeat`
- `activeSeats`
- `pots` (main + side pots with eligible seat sets)
- `board[0..5]` (unknown slots until revealed)
- `deckCommit`
- `deckCursor` (next position)
- `holeCardPos[seat][2]` (deck positions for each seat's hole cards)
- `deadlines` (action and dealer step deadlines)
- `actionState` (to-call amounts, last aggressor, etc.)

### 9.3 Dealer Artifacts

- `epochId`
- `committeeMembers[]`
- `threshold t`
- `PK_epoch`
- `PK_hand`
- `shuffleRounds[]` (hashes + proofs)
- `encShares[handId][pos][validatorId]` (encrypted share + proof)
- `pubShares[handId][pos][validatorId]` (public share + proof)

## 10. Client Requirements

### 10.1 Keys

Each player MUST maintain:

- a wallet key (for signing txs),
- and a per-table or per-hand encryption keypair `(PK_player, SK_player)` for receiving private decryption shares.

Key rotation:

- v1 SHOULD rotate `PK_player` per hand to reduce linkage.

### 10.2 Hole Card Recovery

Clients MUST:

- fetch encrypted shares for their dealt card positions,
- decrypt shares locally,
- combine shares to recover card plaintext,
- and keep cards confidential.

### 10.3 Verification

Clients SHOULD:

- verify on-chain that sufficient valid shares exist before acting (avoid acting without knowing your cards),
- verify that board reveals are finalized.

## 11. Coordinator Service (Optional)

The coordinator service MAY provide:

- matchmaking and table discovery,
- push notifications,
- a relay for fetching share artifacts,
- UX that mirrors chain state.

It MUST NOT be required for correctness or custody.

## 12. Parameters And Defaults (v1 Suggested)

These are starting points and MUST be benchmarked:

- Dealer committee size `N`: 16..64 (tradeoff: confidentiality threshold vs overhead)
- Threshold `t`: e.g., `t = floor(2N/3) + 1`
- Shuffle rounds `R`: at least 3, ideally >= number of distinct shufflers to ensure at least one honest.
- `actionTimeoutSecs`: 20..45 seconds (product choice)
- `dealerTimeoutSecs`: 60..180 seconds per critical step (product + performance choice)
- Player bond: enough to deter repeated timeouts/aborts.
- Validator slashing: strong enough to deter withholding.

## 13. Testing Plan (Minimum)

### 13.1 Deterministic Poker Logic

- Unit tests for:
  - action validity,
  - side pot computation,
  - showdown evaluation correctness,
  - timeout transitions.
- Property tests / fuzz:
  - random action sequences, ensure invariant: total chips conserved (minus rake), no negative stacks.

### 13.2 Dealer Cryptography

- Unit tests for:
  - encryption/decryption correctness,
  - per-hand key derivation,
  - shuffle proof verification (valid and invalid cases),
  - decryption share proof verification,
  - verifiable encrypted share proof verification.
- Byzantine simulation:
  - withholders,
  - invalid proof submitters,
  - partial committee corruption < t and >= t.

### 13.3 Integration

- End-to-end 9-max simulation with:
  - hole card delivery,
  - betting and community reveals,
  - showdown settlement,
  - mid-hand timeouts and slashing.

## 14. Roadmap (Implementation Milestones)

1. PokerTable module without confidentiality (public dealing) to validate betting/side pots/timeouts/settlement.
2. Dealer epoch DKG + per-hand key derivation.
3. Encrypted deck + verifiable shuffles.
4. Private hole-card delivery via encrypted shares + proofs.
5. Public community card reveals.
6. Showdown decryption + hand evaluation + settlement.
7. Hardening:
   - committee rotation,
   - slashing parameters,
   - DoS protections and performance tuning.

## 15. References (Non-Normative)

- Penumbra threshold encryption overview (modern blockchain reference point):
  - https://protocol.penumbra.zone/main/crypto/flow-encryption/threshold-encryption.html
- DKG classic reference:
  - https://research.ibm.com/publications/secure-distributed-key-generation-for-discrete-log-based-cryptosystems
- Verifiable shuffles (mixnet literature):
  - https://eprint.iacr.org/2005/246
- Verifiable encryption (conceptual building block for encrypted decryption shares):
  - https://eprint.iacr.org/2002/161
