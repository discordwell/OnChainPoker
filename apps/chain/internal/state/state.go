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
	Tables      map[uint64]*Table `json:"tables"`
}

func NewState() *State {
	return &State{
		Height:      0,
		NextTableID: 1,
		Accounts:    map[string]uint64{},
		Tables:      map[uint64]*Table{},
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
	if st.Tables == nil {
		st.Tables = map[uint64]*Table{}
	}
	if st.NextTableID == 0 {
		st.NextTableID = 1
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
	type tableKV struct {
		ID    uint64 `json:"id"`
		Table *Table `json:"table"`
	}

	accounts := make([]accountKV, 0, len(s.Accounts))
	for k, v := range s.Accounts {
		accounts = append(accounts, accountKV{Addr: k, Balance: v})
	}
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].Addr < accounts[j].Addr })

	tables := make([]tableKV, 0, len(s.Tables))
	for id, t := range s.Tables {
		tables = append(tables, tableKV{ID: id, Table: t})
	}
	sort.Slice(tables, func(i, j int) bool { return tables[i].ID < tables[j].ID })

	normalized := struct {
		Height      int64       `json:"height"`
		NextTableID uint64      `json:"nextTableId"`
		Accounts    []accountKV `json:"accounts"`
		Tables      []tableKV   `json:"tables"`
	}{
		Height:      s.Height,
		NextTableID: s.NextTableID,
		Accounts:    accounts,
		Tables:      tables,
	}

	b, _ := json.Marshal(normalized)
	sum := sha256.Sum256(b)
	return sum[:]
}

// ---- Bank ----

func (s *State) Balance(addr string) uint64 {
	return s.Accounts[addr]
}

func (s *State) Credit(addr string, amount uint64) {
	s.Accounts[addr] = s.Accounts[addr] + amount
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

	// v0 localnet: timeouts/rake are accepted at table creation but not yet enforced.
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
	PK     string `json:"pk,omitempty"`

	Stack uint64 `json:"stack"`

	// DealerStub (v0): public hole cards stored on-chain for now.
	Hole [2]Card `json:"hole"`
}

type HandPhase string

const (
	PhaseBetting  HandPhase = "betting"
	PhaseShowdown HandPhase = "showdown"
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
