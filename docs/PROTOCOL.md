# OCP Client Protocol (Cosmos Canonical)

Date: 2026-02-08
Status: Active (Cosmos runtime / WS7)

This document defines the client-facing protocol surface area that the SDK (`packages/ocp-sdk`) will target:

- **Tx schemas**: the *logical* transaction types a client can construct.
- **Events**: the minimum event contract clients rely on to drive UI/gameplay.
- **Queries**: the minimum read APIs clients need for state + dealer artifacts.

This protocol is Cosmos-canonical. The production chain runtime is `apps/cosmos`, and SDK clients should treat
Cosmos protobuf tx/query/event behavior as the source of truth. Legacy `apps/chain` wire behavior is retained only
as a devnet appendix.

## 1. Conventions

### 1.1 Scalars / Amounts / IDs

- `U64`: **decimal string** (`"0"`, `"42"`, `"18446744073709551615"`) to avoid JSON number precision loss.
- `SeatIndex`: integer `0..8` (v1 is 9-max).
- `CardId`: integer `0..51` (as in `docs/SPEC.md` 6.4).

### 1.2 Bytes

- `Hex`: `0x`-prefixed lowercase hex string (chain SHOULD accept uppercase but MUST canonicalize to lowercase in responses).
- Crypto objects not yet stabilized by WS3/WS5 (proofs, group elements, ciphertexts) are treated as opaque `Hex` blobs at the boundary.

### 1.3 Event Cursor

Every event MUST include a stable, monotonic cursor. Valid options:

- `eventIndex: U64` (monotonic, per-table or global), OR
- `cursor = "<height>:<txIndex>:<logIndex>"`.

The SDK assumes cursor monotonicity for replay/resume.

### 1.4 Canonical Wire Format (`apps/cosmos`)

The canonical wire format is Cosmos protobuf + ABCI events:

- **Tx submission**: protobuf `Msg` types signed and broadcast through Cosmos RPC.
  - SDK path: `connectOcpCosmosSigningClient` + `createOcpCosmosClient` (`packages/ocp-sdk/src/cosmos`).
  - Methods map to protobuf services in:
    - `apps/cosmos/proto/onchainpoker/poker/v1/tx.proto`
    - `apps/cosmos/proto/onchainpoker/dealer/v1/tx.proto`
- **Queries**: grpc-gateway/LCD JSON endpoints from:
  - `apps/cosmos/proto/onchainpoker/poker/v1/query.proto`
  - `apps/cosmos/proto/onchainpoker/dealer/v1/query.proto`
- **Events**: ABCI events emitted by Cosmos tx execution (`tx_response.events`), optionally streamed over WebSocket.

### 1.5 Legacy Wire Format (`apps/chain`, devnet-only)

The older CometBFT JSON envelope transport from `apps/chain` is retained only for legacy/devnet usage and is not
the production protocol contract.

## 2. Logical Transactions

All txs are modeled as:

```ts
type OcpTx = { type: string; value: object };
```

The remainder of this section describes the *logical* txs. For canonical Cosmos bindings, see the table below.

### 2.0 Cosmos Msg Mapping (Canonical)

- `PokerTable.CreateTable` -> `onchainpoker.poker.v1.Msg/CreateTable`
- `PokerTable.Sit` -> `onchainpoker.poker.v1.Msg/Sit`
- `PokerTable.StartHand` -> `onchainpoker.poker.v1.Msg/StartHand`
- `PokerTable.Act` -> `onchainpoker.poker.v1.Msg/Act`
- `PokerTable.Leave` -> `onchainpoker.poker.v1.Msg/Leave`
- `PokerTable.Tick` -> `onchainpoker.poker.v1.Msg/Tick`
- `Dealer.BeginEpoch` -> `onchainpoker.dealer.v1.Msg/BeginEpoch`
- `Dealer.DkgCommit` -> `onchainpoker.dealer.v1.Msg/DkgCommit`
- `Dealer.DkgComplaintMissing` -> `onchainpoker.dealer.v1.Msg/DkgComplaintMissing`
- `Dealer.DkgComplaintInvalid` -> `onchainpoker.dealer.v1.Msg/DkgComplaintInvalid`
- `Dealer.DkgShareReveal` -> `onchainpoker.dealer.v1.Msg/DkgShareReveal`
- `Dealer.FinalizeEpoch` -> `onchainpoker.dealer.v1.Msg/FinalizeEpoch`
- `Dealer.DkgTimeout` -> `onchainpoker.dealer.v1.Msg/DkgTimeout`
- `Dealer.InitHand` -> `onchainpoker.dealer.v1.Msg/InitHand`
- `Dealer.SubmitShuffle` -> `onchainpoker.dealer.v1.Msg/SubmitShuffle`
- `Dealer.FinalizeDeck` -> `onchainpoker.dealer.v1.Msg/FinalizeDeck`
- `Dealer.SubmitEncShare` -> `onchainpoker.dealer.v1.Msg/SubmitEncShare`
- `Dealer.SubmitPubShare` -> `onchainpoker.dealer.v1.Msg/SubmitPubShare`
- `Dealer.FinalizeReveal` -> `onchainpoker.dealer.v1.Msg/FinalizeReveal`
- `Dealer.Timeout` -> `onchainpoker.dealer.v1.Msg/Timeout`

### 2.1 PokerTable Txs

#### `PokerTable.CreateTable`

```json
{
  "type": "PokerTable.CreateTable",
  "value": {
    "params": {
      "maxPlayers": 9,
      "smallBlind": "1",
      "bigBlind": "2",
      "minBuyIn": "100",
      "maxBuyIn": "10000",
      "playerBond": "100",
      "actionTimeoutSecs": 30,
      "dealerTimeoutSecs": 120,
      "rakeBps": 0
    }
  }
}
```

#### `PokerTable.Sit`

```json
{
  "type": "PokerTable.Sit",
  "value": {
    "tableId": "1",
    "seat": 3,
    "buyIn": "1000",
    "playerBond": "100",
    "pkPlayer": "0x..."
  }
}
```

#### `PokerTable.Leave`

```json
{ "type": "PokerTable.Leave", "value": { "tableId": "1" } }
```

#### `PokerTable.StartHand`

```json
{ "type": "PokerTable.StartHand", "value": { "tableId": "1" } }
```

#### `PokerTable.Act`

`actionType` is one of `Fold|Check|Call|Bet|Raise`.

```json
{
  "type": "PokerTable.Act",
  "value": {
    "tableId": "1",
    "action": { "actionType": "Raise", "amount": "12" }
  }
}
```

#### `PokerTable.Tick`

Advances deterministic timeouts (see `docs/SPEC.md` 5.5).

```json
{ "type": "PokerTable.Tick", "value": { "tableId": "1" } }
```

#### Street + Showdown

```json
{ "type": "PokerTable.RequestFlop", "value": { "tableId": "1" } }
{ "type": "PokerTable.RequestTurn", "value": { "tableId": "1" } }
{ "type": "PokerTable.RequestRiver", "value": { "tableId": "1" } }
{ "type": "PokerTable.Showdown", "value": { "tableId": "1" } }
```

### 2.2 Dealer Txs

All `proof*`, `cipher*`, `contribution`, etc are opaque `Hex` until WS3/WS5 define canonical encodings.

#### Epoch / Committee

```json
{
  "type": "Dealer.BeginEpoch",
  "value": {
    "epochId": "7",
    "committee": ["val1", "val2"],
    "thresholdT": 11,
    "randEpoch": "0x..."
  }
}
```

```json
{
  "type": "Dealer.SubmitDKGContribution",
  "value": { "epochId": "7", "validatorId": "val1", "contribution": "0x...", "proof": "0x..." }
}
```

```json
{
  "type": "Dealer.FinalizeEpoch",
  "value": { "epochId": "7", "pkEpoch": "0x...", "transcriptRoot": "0x..." }
}
```

#### Per-Hand Deck

```json
{ "type": "Dealer.InitHand", "value": { "tableId": "1", "handId": "12", "epochId": "7" } }
```

```json
{
  "type": "Dealer.SubmitShuffle",
  "value": {
    "tableId": "1",
    "handId": "12",
    "round": 3,
    "shufflerId": "val7",
    "deckRootNew": "0x...",
    "proofShuffle": "0x..."
  }
}
```

```json
{ "type": "Dealer.FinalizeDeck", "value": { "tableId": "1", "handId": "12", "deckCommit": "0x...", "deckCursor": 0 } }
```

#### Hole Card Delivery (Private)

```json
{ "type": "Dealer.AssignHoleCardPos", "value": { "tableId": "1", "handId": "12", "seat": 3, "h": 0, "pos": 9 } }
```

```json
{
  "type": "Dealer.SubmitEncShare",
  "value": {
    "tableId": "1",
    "handId": "12",
    "pos": 9,
    "validatorId": "val7",
    "pkPlayer": "0x...",
    "encShare": "0x...",
    "proofEncShare": "0x..."
  }
}
```

#### Community Reveal (Public)

```json
{
  "type": "Dealer.SubmitPubShare",
  "value": {
    "tableId": "1",
    "handId": "12",
    "pos": 9,
    "validatorId": "val7",
    "pubShare": "0x...",
    "proofPubShare": "0x..."
  }
}
```

```json
{ "type": "Dealer.FinalizeReveal", "value": { "tableId": "1", "handId": "12", "pos": 9, "plaintextCard": 17 } }
```

## 3. Events (Minimum Contract)

All events follow:

```ts
type OcpEvent = {
  type: string;
  cursor: string;
  height?: U64;
  txHash?: Hex;
  tableId?: U64;
  handId?: U64;
  data: object;
};
```

Minimum set (from `docs/INTERFACES.md`):

- Table lifecycle: `TableCreated`, `PlayerSat`, `PlayerLeft`, `PlayerEjected`
- Hand lifecycle: `HandStarted`, `DeckFinalized`, `HoleCardAssigned`, `StreetRevealed`, `HandCompleted`, `HandAborted`
- Action log: `ActionApplied`, `TimeoutApplied`
- Dealer artifacts: `ShuffleAccepted`, `EncShareAccepted`, `PubShareAccepted`
- Slashing: `PlayerSlashed`, `ValidatorSlashed`

Event payloads MUST include enough data for a thin client to stay in sync. At minimum:

- always: `tableId` (when applicable), `handId` (when applicable), `cursor`
- for actions: actor seat/address, action type, amount
- for reveals: `street` and revealed `CardId[]` (for public streets)
- for share acceptance: `pos`, `validatorId`

## 4. Queries (Minimum Read API)

The chain MUST expose read APIs that let clients:

### 4.1 Table/Hand State

- `GetTable(tableId)` -> table params + seating + current hand pointer
- `GetHand(tableId, handId)` -> phase + pots + board + actionState + deadlines

Canonical Cosmos query paths:

- `/onchainpoker/poker/v1/tables` -> list tables
- `/onchainpoker/poker/v1/tables/{table_id}` -> table with current hand state
- `/onchainpoker/dealer/v1/epoch` -> active dealer epoch
- `/onchainpoker/dealer/v1/dkg` -> in-flight DKG state
- `/onchainpoker/dealer/v1/tables/{table_id}/hands/{hand_id}` -> dealer hand artifacts/state

### 4.2 Dealer Artifacts (for clients)

Clients need to recover hole cards (see `docs/SPEC.md` 10.2).

- `GetHoleCardPositions(tableId, handId, seat)` -> `{ pos0, pos1 }`
- `GetCiphertext(tableId, handId, pos)` -> `ciphertext: Hex`
- `GetEncShares(tableId, handId, pos, pkPlayer)` -> list of `{ validatorId, encShare, proofEncShare }`
- `GetPubShares(tableId, handId, pos)` -> list of `{ validatorId, pubShare, proofPubShare }`

### 4.3 Events

- `GetEvents({ cursor?, filter?, limit? })` -> `{ events[], nextCursor }`

This query is sufficient to implement event subscription by polling. WebSocket/streaming is optional.

## 5. Appendix: Legacy `apps/chain` Mapping (Devnet-only)

Legacy (non-production) tx mappings:

- `PokerTable.CreateTable` -> `poker/create_table`
- `PokerTable.Sit` -> `poker/sit`
- `PokerTable.StartHand` -> `poker/start_hand`
- `PokerTable.Act` -> `poker/act`
- `PokerTable.Leave` -> `poker/leave`
- `PokerTable.Tick` -> `poker/tick`
- Devnet funding only:
  - `Bank.Mint` -> `bank/mint` (devnet-only; validator-signed)
  - `Bank.Send` -> `bank/send`

Legacy (non-production) query paths:

- `/tables` -> `tableId[]`
- `/table/<id>` -> table JSON (includes current hand)
- `/account/<addr>` -> `{ addr, balance }`

## 6. Appendix: EVM Prototype (PokerVault)

**Deprecated.** The EVM prototype has been archived under `deprecated/evm` and is not part of the active workspace/CI.

The EVM prototype (`deprecated/evm/packages/contracts`) is a settlement layer for **off-chain dealt** poker.
It is not the confidential-dealing appchain described above, but it *does* define a client protocol
worth capturing for SDK support.

### 5.1 Contracts

- `OCPToken` (ERC-20, owner-mintable for testing)
- `PokerVault` escrow + internal ledger

### 5.2 PokerVault EIP-712 Approval

Players sign an approval over the *exact* hand settlement payload:

- `resultHash = keccak256(abi.encode(handId, vaultAddress, tokenAddress, players[], deltas[]))`
- Typed data domain:
  - `name: "PokerVault"`
  - `version: "1"`
  - `chainId: <evm chain id>`
  - `verifyingContract: <vault address>`
- Primary type:
  - `HandResultApproval(resultHash bytes32, nonce uint256, deadline uint256)`

The vault requires a signature from every `player[i]` over `(resultHash, nonces[player[i]], deadline)`.
