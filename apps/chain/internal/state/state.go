package state

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

type State struct {
	Height int64 `json:"height"`

	NextTableID uint64            `json:"nextTableId"`
	Accounts    map[string]uint64 `json:"accounts"`
	AccountKeys map[string][]byte `json:"accountKeys,omitempty"` // addr -> ed25519 pubkey (32 bytes)
	NonceMax    map[string]uint64 `json:"nonceMax,omitempty"`    // signer -> last accepted tx.nonce (u64), for replay protection
	Tables      map[uint64]*Table `json:"tables"`

	Dealer *DealerState `json:"dealer,omitempty"`
}

func NewState() *State {
	return &State{
		Height:      0,
		NextTableID: 1,
		Accounts:    map[string]uint64{},
		AccountKeys: map[string][]byte{},
		NonceMax:    map[string]uint64{},
		Tables:      map[uint64]*Table{},
		Dealer:      &DealerState{NextEpochID: 1},
	}
}

func Load(home string) (*State, error) {
	path := filepath.Join(home, "state.json")
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewState(), nil
		}
		return nil, fmt.Errorf("read state: %w", err)
	}
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("decode state: %w", err)
	}
	if st.Accounts == nil {
		st.Accounts = map[string]uint64{}
	}
	if st.AccountKeys == nil {
		st.AccountKeys = map[string][]byte{}
	}
	if st.NonceMax == nil {
		st.NonceMax = map[string]uint64{}
	}
	if st.Tables == nil {
		st.Tables = map[uint64]*Table{}
	}
	if st.NextTableID == 0 {
		st.NextTableID = 1
	}
	if st.Dealer == nil {
		st.Dealer = &DealerState{NextEpochID: 1}
	}
	if st.Dealer.NextEpochID == 0 {
		st.Dealer.NextEpochID = 1
	}
	return &st, nil
}

func (s *State) Save(home string) error {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return fmt.Errorf("mkdir home: %w", err)
	}
	path := filepath.Join(home, "state.json")
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return fmt.Errorf("write state: %w", err)
	}
	return nil
}

// Clone returns a deep copy of state suitable for staged tx execution.
func (s *State) Clone() (*State, error) {
	if s == nil {
		return nil, fmt.Errorf("state is nil")
	}
	b, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("encode state clone: %w", err)
	}
	var out State
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("decode state clone: %w", err)
	}
	if out.Accounts == nil {
		out.Accounts = map[string]uint64{}
	}
	if out.AccountKeys == nil {
		out.AccountKeys = map[string][]byte{}
	}
	if out.NonceMax == nil {
		out.NonceMax = map[string]uint64{}
	}
	if out.Tables == nil {
		out.Tables = map[uint64]*Table{}
	}
	if out.NextTableID == 0 {
		out.NextTableID = 1
	}
	if out.Dealer == nil {
		out.Dealer = &DealerState{NextEpochID: 1}
	}
	if out.Dealer.NextEpochID == 0 {
		out.Dealer.NextEpochID = 1
	}
	return &out, nil
}

func (s *State) AppHash() []byte {
	// Deterministic JSON hash: marshal with stable key ordering by serializing
	// a normalized view.
	//
	// Note: encoding/json does NOT guarantee map key order, so we manually
	// normalize maps into slices.
	type accountKV struct {
		Addr    string `json:"addr"`
		Balance uint64 `json:"balance"`
	}
	type accountKeyKV struct {
		Addr   string `json:"addr"`
		PubKey []byte `json:"pubKey"`
	}
	type nonceKV struct {
		Signer string `json:"signer"`
		Nonce  uint64 `json:"nonce"`
	}
	type tableKV struct {
		ID    uint64 `json:"id"`
		Table *Table `json:"table"`
	}

	accounts := make([]accountKV, 0, len(s.Accounts))
	for k, v := range s.Accounts {
		accounts = append(accounts, accountKV{Addr: k, Balance: v})
	}
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].Addr < accounts[j].Addr })

	accountKeys := make([]accountKeyKV, 0, len(s.AccountKeys))
	for k, v := range s.AccountKeys {
		accountKeys = append(accountKeys, accountKeyKV{Addr: k, PubKey: v})
	}
	sort.Slice(accountKeys, func(i, j int) bool { return accountKeys[i].Addr < accountKeys[j].Addr })

	nonces := make([]nonceKV, 0, len(s.NonceMax))
	for k, v := range s.NonceMax {
		nonces = append(nonces, nonceKV{Signer: k, Nonce: v})
	}
	sort.Slice(nonces, func(i, j int) bool { return nonces[i].Signer < nonces[j].Signer })

	tables := make([]tableKV, 0, len(s.Tables))
	for id, t := range s.Tables {
		tables = append(tables, tableKV{ID: id, Table: t})
	}
	sort.Slice(tables, func(i, j int) bool { return tables[i].ID < tables[j].ID })

	normalized := struct {
		Height      int64          `json:"height"`
		NextTableID uint64         `json:"nextTableId"`
		Accounts    []accountKV    `json:"accounts"`
		AccountKeys []accountKeyKV `json:"accountKeys,omitempty"`
		NonceMax    []nonceKV      `json:"nonceMax,omitempty"`
		Tables      []tableKV      `json:"tables"`
		Dealer      *DealerState   `json:"dealer,omitempty"`
	}{
		Height:      s.Height,
		NextTableID: s.NextTableID,
		Accounts:    accounts,
		AccountKeys: accountKeys,
		NonceMax:    nonces,
		Tables:      tables,
		Dealer:      s.Dealer,
	}

	b, _ := json.Marshal(normalized)
	sum := sha256.Sum256(b)
	return sum[:]
}

// ---- Bank ----

func (s *State) Balance(addr string) uint64 {
	return s.Accounts[addr]
}

func (s *State) Credit(addr string, amount uint64) error {
	bal := s.Accounts[addr]
	if bal > ^uint64(0)-amount {
		return fmt.Errorf("balance overflow: have=%d add=%d", bal, amount)
	}
	s.Accounts[addr] = bal + amount
	return nil
}

func (s *State) Debit(addr string, amount uint64) error {
	bal := s.Accounts[addr]
	if bal < amount {
		return fmt.Errorf("insufficient funds: have=%d need=%d", bal, amount)
	}
	s.Accounts[addr] = bal - amount
	return nil
}

// ---- Poker ----

type TableParams struct {
	MaxPlayers uint8  `json:"maxPlayers"`
	SmallBlind uint64 `json:"smallBlind"`
	BigBlind   uint64 `json:"bigBlind"`
	MinBuyIn   uint64 `json:"minBuyIn"`
	MaxBuyIn   uint64 `json:"maxBuyIn"`

	// v0 localnet:
	// - actionTimeoutSecs is enforced via `poker/tick` + `hand.actionDeadline`.
	// - dealerTimeoutSecs is enforced by the Dealer module (see `dealer/timeout`).
	// - playerBond/rake are accepted but not yet enforced.
	ActionTimeoutSecs uint64 `json:"actionTimeoutSecs,omitempty"`
	DealerTimeoutSecs uint64 `json:"dealerTimeoutSecs,omitempty"`
	PlayerBond        uint64 `json:"playerBond,omitempty"`
	RakeBps           uint32 `json:"rakeBps,omitempty"`
}

type Table struct {
	ID      uint64      `json:"id"`
	Creator string      `json:"creator"`
	Label   string      `json:"label,omitempty"`
	Params  TableParams `json:"params"`

	Seats [9]*Seat `json:"seats"`

	NextHandID uint64 `json:"nextHandId"`
	ButtonSeat int    `json:"buttonSeat"`
	Hand       *Hand  `json:"hand,omitempty"`
}

type Seat struct {
	Player string `json:"player"`
	PK     []byte `json:"pk,omitempty"` // 32-byte ristretto point (base64 in JSON)

	Stack uint64 `json:"stack"`
	Bond  uint64 `json:"bond,omitempty"` // slashable bond escrowed at the table

	// DealerStub (v0): public hole cards stored on-chain for now.
	Hole [2]Card `json:"hole"`
}

type HandPhase string

const (
	PhaseShuffle       HandPhase = "shuffle"
	PhaseBetting       HandPhase = "betting"
	PhaseAwaitFlop     HandPhase = "awaitFlop"
	PhaseAwaitTurn     HandPhase = "awaitTurn"
	PhaseAwaitRiver    HandPhase = "awaitRiver"
	PhaseAwaitShowdown HandPhase = "awaitShowdown"
	PhaseShowdown      HandPhase = "showdown"
)

type Street string

const (
	StreetPreflop Street = "preflop"
	StreetFlop    Street = "flop"
	StreetTurn    Street = "turn"
	StreetRiver   Street = "river"
)

type Pot struct {
	Amount        uint64 `json:"amount"`
	EligibleSeats []int  `json:"eligibleSeats"`
}

type Hand struct {
	HandID uint64    `json:"handId"`
	Phase  HandPhase `json:"phase"`
	Street Street    `json:"street"`

	// Positional state (0..8).
	ButtonSeat     int `json:"buttonSeat"`
	SmallBlindSeat int `json:"smallBlindSeat"`
	BigBlindSeat   int `json:"bigBlindSeat"`

	// Betting state.
	ActionOn int `json:"actionOn"` // 0..8, or -1 if no action (showdown)
	// ActionDeadline is the unix second timestamp at/after which the chain may
	// auto-apply a default action via poker/tick. 0 means "unset".
	ActionDeadline int64 `json:"actionDeadline,omitempty"`

	BetTo        uint64 `json:"betTo"`
	MinRaiseSize uint64 `json:"minRaiseSize"`

	IntervalID        uint32 `json:"intervalId"`
	LastIntervalActed [9]int `json:"lastIntervalActed"`

	StreetCommit [9]uint64 `json:"streetCommit"`
	TotalCommit  [9]uint64 `json:"totalCommit"`

	InHand [9]bool `json:"inHand"`
	Folded [9]bool `json:"folded"`
	AllIn  [9]bool `json:"allIn"`

	// Populated at showdown (purely derived from TotalCommit+Folded).
	Pots []Pot `json:"pots,omitempty"`

	// DealerStub (v0): deterministic deck + public board stored on-chain.
	Deck       []Card `json:"deck"`
	DeckCursor uint8  `json:"deckCursor"`
	Board      []Card `json:"board"`

	// Dealer module (v0): confidential dealing artifacts (not yet wired into gameplay).
	Dealer *DealerHand `json:"dealer,omitempty"`
}

type Card uint8 // 0..51

func (c Card) Rank() uint8 { // 2..14
	return uint8(c%13) + 2
}

func (c Card) Suit() uint8 { // 0..3
	return uint8(c / 13)
}

func (c Card) String() string {
	r := c.Rank()
	var rch byte
	switch r {
	case 14:
		rch = 'A'
	case 13:
		rch = 'K'
	case 12:
		rch = 'Q'
	case 11:
		rch = 'J'
	case 10:
		rch = 'T'
	default:
		rch = byte('0' + (r - 0)) // will be fixed below for 2..9
	}
	if r >= 2 && r <= 9 {
		rch = byte('0' + r)
	}
	s := c.Suit()
	var sch byte
	switch s {
	case 0:
		sch = 'c'
	case 1:
		sch = 'd'
	case 2:
		sch = 'h'
	case 3:
		sch = 's'
	default:
		sch = '?'
	}
	return string([]byte{rch, sch})
}

func DeterministicDeck(seed []byte) []Card {
	// Fisher-Yates shuffle driven by a sha256-based stream.
	deck := make([]Card, 52)
	for i := 0; i < 52; i++ {
		deck[i] = Card(i)
	}
	// Generate deterministic random bytes by hashing seed||counter.
	var counter uint64
	for i := 51; i > 0; i-- {
		buf := make([]byte, len(seed)+8)
		copy(buf, seed)
		binary.LittleEndian.PutUint64(buf[len(seed):], counter)
		h := sha256.Sum256(buf)
		counter++
		j := int(binary.LittleEndian.Uint64(h[:8]) % uint64(i+1))
		deck[i], deck[j] = deck[j], deck[i]
	}
	return deck
}

// ---- Dealer (v0) ----

type DealerState struct {
	// v0: staking is stubbed to a simple on-chain registry used by the Dealer module.
	Validators []Validator `json:"validators,omitempty"`

	// Next epoch id to allocate when starting DKG.
	NextEpochID uint64 `json:"nextEpochId,omitempty"`

	// Active, finalized epoch key material used by hands.
	Epoch *DealerEpoch `json:"epoch,omitempty"`

	// In-progress DKG for the next epoch.
	DKG *DealerDKG `json:"dkg,omitempty"`
}

type ValidatorStatus string

const (
	ValidatorActive ValidatorStatus = "active"
	ValidatorJailed ValidatorStatus = "jailed"
)

type Validator struct {
	ValidatorID string          `json:"validatorId"`
	PubKey      []byte          `json:"pubKey,omitempty"` // 32-byte ed25519 public key (base64 in JSON)
	Power       uint64          `json:"power,omitempty"`
	Status      ValidatorStatus `json:"status"`
	Bond        uint64          `json:"bond,omitempty"` // staked/bonded tokens locked for slashing
	SlashCount  uint32          `json:"slashCount,omitempty"`
}

type DealerEpoch struct {
	EpochID        uint64 `json:"epochId"`
	Threshold      uint8  `json:"threshold"`
	PKEpoch        []byte `json:"pkEpoch"`                  // 32-byte ristretto point
	TranscriptRoot []byte `json:"transcriptRoot,omitempty"` // sha256 hash (v0 placeholder)

	// Slashed validatorIds (excluded from QUAL) for this epoch.
	// Canonical ordering: lexicographically ascending by validatorId.
	Slashed []string `json:"slashed,omitempty"`

	Members []DealerMember `json:"members"`
}

type DealerMember struct {
	ValidatorID string `json:"validatorId"`
	Index       uint32 `json:"index"`    // Shamir x-coordinate (non-zero)
	PubShare    []byte `json:"pubShare"` // 32-byte ristretto point (Y_i)
}

// DealerDKG tracks an in-progress Feldman-style DKG for the next epoch.
//
// v0 notes:
// - Share delivery is off-chain. Complaints trigger on-chain share reveals.
// - "Slashing" is modeled by jailing validators in the stub validator registry.
type DealerDKG struct {
	EpochID   uint64 `json:"epochId"`
	Threshold uint8  `json:"threshold"`

	// Deterministic committee sampled from Validators at BeginEpoch.
	Members []DealerMember `json:"members"`

	// DKG phase timing in block heights.
	StartHeight       int64 `json:"startHeight"`
	CommitDeadline    int64 `json:"commitDeadline"`
	ComplaintDeadline int64 `json:"complaintDeadline"`
	RevealDeadline    int64 `json:"revealDeadline"`
	FinalizeDeadline  int64 `json:"finalizeDeadline"`

	// Optional beacon value used for committee sampling (opaque, v0).
	RandEpoch []byte `json:"randEpoch,omitempty"`

	Commits    []DealerDKGCommit      `json:"commits,omitempty"`
	Complaints []DealerDKGComplaint   `json:"complaints,omitempty"`
	Reveals    []DealerDKGShareReveal `json:"reveals,omitempty"`
	Slashed    []string               `json:"slashed,omitempty"` // validatorIds (sorted)
	// Penalized validatorIds that have already had jail/slash applied for this DKG.
	Penalized []string `json:"penalized,omitempty"` // validatorIds (sorted)
}

type DealerDKGCommit struct {
	DealerID    string   `json:"dealerId"`
	Commitments [][]byte `json:"commitments"` // length Threshold, each 32-byte point
}

type DealerDKGComplaint struct {
	EpochID      uint64 `json:"epochId"`
	ComplainerID string `json:"complainerId"`
	DealerID     string `json:"dealerId"`
	Kind         string `json:"kind"` // "missing" | "invalid"
	// v0: invalid-share evidence is not authenticated yet; keep optional payload for forward-compat.
	ShareMsg []byte `json:"shareMsg,omitempty"`
}

type DealerDKGShareReveal struct {
	EpochID  uint64 `json:"epochId"`
	DealerID string `json:"dealerId"`
	ToID     string `json:"toId"`
	Share    []byte `json:"share"` // 32-byte scalar
}

type DealerCiphertext struct {
	C1 []byte `json:"c1"` // 32-byte ristretto point
	C2 []byte `json:"c2"` // 32-byte ristretto point
}

type DealerPubShare struct {
	Pos         uint8  `json:"pos"`
	ValidatorID string `json:"validatorId"`
	Index       uint32 `json:"index"`
	Share       []byte `json:"share"` // 32-byte point (d_i = x_i*c1)
	Proof       []byte `json:"proof"` // Chaum-Pedersen proof bytes
}

type DealerReveal struct {
	Pos    uint8 `json:"pos"`
	CardID uint8 `json:"cardId"`
}

type DealerEncShare struct {
	Pos         uint8  `json:"pos"`
	ValidatorID string `json:"validatorId"`
	Index       uint32 `json:"index"`
	PKPlayer    []byte `json:"pkPlayer"` // 32-byte point
	EncShare    []byte `json:"encShare"` // 64 bytes (u||v)
	Proof       []byte `json:"proof"`    // verifiable encryption proof bytes
}

type DealerHand struct {
	EpochID uint64 `json:"epochId"`
	PKHand  []byte `json:"pkHand"` // 32-byte point

	DeckSize uint16             `json:"deckSize"`
	Deck     []DealerCiphertext `json:"deck"`

	ShuffleStep uint16 `json:"shuffleStep"`
	Finalized   bool   `json:"finalized"`
	Cursor      uint8  `json:"cursor"`

	// Dealer liveness deadlines (unix seconds).
	ShuffleDeadline    int64 `json:"shuffleDeadline,omitempty"`
	HoleSharesDeadline int64 `json:"holeSharesDeadline,omitempty"`
	RevealPos          uint8 `json:"revealPos,omitempty"` // 0..255; 255 = unset
	RevealDeadline     int64 `json:"revealDeadline,omitempty"`

	// Per-seat hole card deck positions, length 18: seat*2 + h -> pos (0..255). 255 = unset.
	HolePos []uint8 `json:"holePos,omitempty"`

	PubShares []DealerPubShare `json:"pubShares,omitempty"`
	EncShares []DealerEncShare `json:"encShares,omitempty"`
	Reveals   []DealerReveal   `json:"reveals,omitempty"`
}
