package app

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/codec"
	"onchainpoker/apps/chain/internal/state"
)

const (
	AppVersion uint64 = 1
)

type OCPApp struct {
	*abci.BaseApplication

	home string

	mu       sync.Mutex
	st       *state.State
	lastHash []byte
}

func New(home string) (*OCPApp, error) {
	appHome := filepath.Join(home, "app")
	st, err := state.Load(appHome)
	if err != nil {
		return nil, err
	}
	a := &OCPApp{
		BaseApplication: abci.NewBaseApplication(),
		home:            home,
		st:              st,
		lastHash:        st.AppHash(),
	}
	return a, nil
}

func (a *OCPApp) Info(_ context.Context, _ *abci.InfoRequest) (*abci.InfoResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	return &abci.InfoResponse{
		Data:             "OCP (v0)",
		Version:          "v0",
		AppVersion:       AppVersion,
		LastBlockHeight:  a.st.Height,
		LastBlockAppHash: a.lastHash,
	}, nil
}

func (a *OCPApp) CheckTx(_ context.Context, req *abci.CheckTxRequest) (*abci.CheckTxResponse, error) {
	_, err := codec.DecodeTxEnvelope(req.Tx)
	if err != nil {
		return &abci.CheckTxResponse{Code: 1, Log: err.Error()}, nil
	}
	// v0: only structural validation; signatures/auth are deferred.
	return &abci.CheckTxResponse{Code: 0}, nil
}

func (a *OCPApp) InitChain(_ context.Context, _ *abci.InitChainRequest) (*abci.InitChainResponse, error) {
	// v0: no special genesis handling.
	return &abci.InitChainResponse{}, nil
}

func (a *OCPApp) FinalizeBlock(_ context.Context, req *abci.FinalizeBlockRequest) (*abci.FinalizeBlockResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.st.Height = req.Height

	txResults := make([]*abci.ExecTxResult, 0, len(req.Txs))
	for _, txBytes := range req.Txs {
		res := a.deliverTx(txBytes, req.Height)
		txResults = append(txResults, res)
	}

	a.lastHash = a.st.AppHash()

	return &abci.FinalizeBlockResponse{
		TxResults: txResults,
		AppHash:   a.lastHash,
	}, nil
}

func (a *OCPApp) Commit(_ context.Context, _ *abci.CommitRequest) (*abci.CommitResponse, error) {
	// Persist after each block for devnet durability.
	appHome := filepath.Join(a.home, "app")
	if err := a.st.Save(appHome); err != nil {
		// CometBFT expects Commit to not crash; return error so node halts loudly.
		return nil, err
	}
	return &abci.CommitResponse{}, nil
}

func (a *OCPApp) Query(_ context.Context, req *abci.QueryRequest) (*abci.QueryResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	// Paths:
	// - /account/<addr>
	// - /table/<id>
	// - /tables
	path := strings.TrimSpace(req.Path)
	switch {
	case path == "/tables":
		ids := make([]uint64, 0, len(a.st.Tables))
		for id := range a.st.Tables {
			ids = append(ids, id)
		}
		b, _ := json.Marshal(ids)
		return &abci.QueryResponse{Code: 0, Value: b, Height: a.st.Height}, nil
	case strings.HasPrefix(path, "/account/"):
		addr := strings.TrimPrefix(path, "/account/")
		bal := a.st.Balance(addr)
		b, _ := json.Marshal(map[string]any{"addr": addr, "balance": bal})
		return &abci.QueryResponse{Code: 0, Value: b, Height: a.st.Height}, nil
	case strings.HasPrefix(path, "/table/"):
		raw := strings.TrimPrefix(path, "/table/")
		id, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return &abci.QueryResponse{Code: 1, Log: "invalid table id", Height: a.st.Height}, nil
		}
		t, ok := a.st.Tables[id]
		if !ok {
			return &abci.QueryResponse{Code: 1, Log: "table not found", Height: a.st.Height}, nil
		}
		b, _ := json.Marshal(t)
		return &abci.QueryResponse{Code: 0, Value: b, Height: a.st.Height}, nil
	default:
		return &abci.QueryResponse{Code: 1, Log: "unknown query path", Height: a.st.Height}, nil
	}
}

func (a *OCPApp) deliverTx(txBytes []byte, height int64) *abci.ExecTxResult {
	env, err := codec.DecodeTxEnvelope(txBytes)
	if err != nil {
		return &abci.ExecTxResult{Code: 1, Log: err.Error()}
	}

	switch env.Type {
	case "bank/mint":
		var msg codec.BankMintTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad bank/mint value"}
		}
		if msg.To == "" || msg.Amount == 0 {
			return &abci.ExecTxResult{Code: 1, Log: "missing to/amount"}
		}
		a.st.Credit(msg.To, msg.Amount)
		return okEvent("BankMinted", map[string]string{
			"to":     msg.To,
			"amount": fmt.Sprintf("%d", msg.Amount),
		})

	case "bank/send":
		var msg codec.BankSendTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad bank/send value"}
		}
		if msg.From == "" || msg.To == "" || msg.Amount == 0 {
			return &abci.ExecTxResult{Code: 1, Log: "missing from/to/amount"}
		}
		if err := a.st.Debit(msg.From, msg.Amount); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		a.st.Credit(msg.To, msg.Amount)
		return okEvent("BankSent", map[string]string{
			"from":   msg.From,
			"to":     msg.To,
			"amount": fmt.Sprintf("%d", msg.Amount),
		})

	case "poker/create_table":
		var msg codec.PokerCreateTableTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad poker/create_table value"}
		}
		if msg.Creator == "" {
			return &abci.ExecTxResult{Code: 1, Log: "missing creator"}
		}
		maxPlayers := msg.MaxPlayers
		if maxPlayers == 0 {
			maxPlayers = 9
		}
		if maxPlayers != 9 {
			return &abci.ExecTxResult{Code: 1, Log: "v0 supports maxPlayers=9 only"}
		}
		if msg.SmallBlind == 0 || msg.BigBlind == 0 || msg.BigBlind < msg.SmallBlind {
			return &abci.ExecTxResult{Code: 1, Log: "invalid blinds"}
		}
		if msg.MinBuyIn == 0 || msg.MaxBuyIn == 0 || msg.MaxBuyIn < msg.MinBuyIn {
			return &abci.ExecTxResult{Code: 1, Log: "invalid buy-in range"}
		}

		id := a.st.NextTableID
		a.st.NextTableID++
		t := &state.Table{
			ID:      id,
			Creator: msg.Creator,
			Label:   msg.TableLabel,
			Params: state.TableParams{
				MaxPlayers: maxPlayers,
				SmallBlind: msg.SmallBlind,
				BigBlind:   msg.BigBlind,
				MinBuyIn:   msg.MinBuyIn,
				MaxBuyIn:   msg.MaxBuyIn,
			},
			NextHandID: 1,
			ButtonSeat: -1,
			Hand:       nil,
		}
		a.st.Tables[id] = t

		return okEvent("TableCreated", map[string]string{
			"tableId": fmt.Sprintf("%d", id),
		})

	case "poker/sit":
		var msg codec.PokerSitTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad poker/sit value"}
		}
		if msg.Player == "" {
			return &abci.ExecTxResult{Code: 1, Log: "missing player"}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		if msg.Seat >= 9 {
			return &abci.ExecTxResult{Code: 1, Log: "invalid seat"}
		}
		if t.Seats[msg.Seat] != nil {
			return &abci.ExecTxResult{Code: 1, Log: "seat occupied"}
		}
		if msg.BuyIn < t.Params.MinBuyIn || msg.BuyIn > t.Params.MaxBuyIn {
			return &abci.ExecTxResult{Code: 1, Log: "buy-in out of range"}
		}
		if err := a.st.Debit(msg.Player, msg.BuyIn); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		t.Seats[msg.Seat] = &state.Seat{
			Player: msg.Player,
			PK:     msg.PKPlayer,
			Stack:  msg.BuyIn,
		}
		return okEvent("PlayerSat", map[string]string{
			"tableId": fmt.Sprintf("%d", msg.TableID),
			"seat":    fmt.Sprintf("%d", msg.Seat),
			"player":  msg.Player,
			"buyIn":   fmt.Sprintf("%d", msg.BuyIn),
		})

	case "poker/start_hand":
		var msg codec.PokerStartHandTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad poker/start_hand value"}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		if t.Hand != nil {
			return &abci.ExecTxResult{Code: 1, Log: "hand already in progress"}
		}
		handId := t.NextHandID
		t.NextHandID++

		activeSeats := occupiedSeatsWithStack(t)
		if len(activeSeats) < 2 {
			return &abci.ExecTxResult{Code: 1, Log: "need at least 2 players with chips"}
		}

		// Advance button to next occupied seat (or first if unset).
		if t.ButtonSeat < 0 {
			t.ButtonSeat = activeSeats[0]
		} else {
			t.ButtonSeat = nextOccupiedSeat(t, t.ButtonSeat)
		}

		// Reset per-seat flags.
		for i := 0; i < 9; i++ {
			if t.Seats[i] == nil {
				continue
			}
			s := t.Seats[i]
			// Only funded seats participate in the hand.
			s.InHand = s.Stack > 0
			s.Folded = false
			s.AllIn = false
			s.BetThisRound = 0
			s.ActedThisRound = false
			s.Hole = [2]state.Card{}
		}

		// Deterministic deck seed = H(height||tableId||handId).
		seed := []byte(fmt.Sprintf("%d|%d|%d", height, msg.TableID, handId))
		deck := state.DeterministicDeck(seed)

		h := &state.Hand{
			HandID:     handId,
			Phase:      state.PhasePreflop,
			Pot:        0,
			Deck:       deck,
			DeckCursor: 0,
			Board:      []state.Card{},
			CurrentBet: 0,
			ActingSeat: -1,
		}
		t.Hand = h

		// Post blinds.
		sbSeat, bbSeat := blindSeats(t)
		if sbSeat < 0 || bbSeat < 0 {
			return &abci.ExecTxResult{Code: 1, Log: "cannot determine blinds"}
		}
		if err := postBlind(t, sbSeat, t.Params.SmallBlind); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "small blind: " + err.Error()}
		}
		if err := postBlind(t, bbSeat, t.Params.BigBlind); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "big blind: " + err.Error()}
		}
		h.CurrentBet = t.Seats[bbSeat].BetThisRound

		// Deal hole cards (public in DealerStub).
		dealHoleCards(t)

		// Set acting seat.
		h.ActingSeat = firstToActPreflop(t, sbSeat, bbSeat)

		ev := okEvent("HandStarted", map[string]string{
			"tableId":    fmt.Sprintf("%d", msg.TableID),
			"handId":     fmt.Sprintf("%d", handId),
			"buttonSeat": fmt.Sprintf("%d", t.ButtonSeat),
			"smallBlind": fmt.Sprintf("%d", sbSeat),
			"bigBlind":   fmt.Sprintf("%d", bbSeat),
			"actingSeat": fmt.Sprintf("%d", h.ActingSeat),
		})
		// Emit hole cards as part of the tx (public dealing stub).
		ev.Events = append(ev.Events, holeCardEvents(msg.TableID, handId, t)...)
		return ev

	case "poker/act":
		var msg codec.PokerActTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad poker/act value"}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		if t.Hand == nil {
			return &abci.ExecTxResult{Code: 1, Log: "no active hand"}
		}
		h := t.Hand
		if h.ActingSeat < 0 || h.ActingSeat >= 9 || t.Seats[h.ActingSeat] == nil {
			return &abci.ExecTxResult{Code: 1, Log: "invalid acting seat"}
		}
		if t.Seats[h.ActingSeat].Player != msg.Player {
			return &abci.ExecTxResult{Code: 1, Log: "not your turn"}
		}
		res := applyAction(t, msg.Action, msg.Amount)
		if res.Code != 0 {
			return res
		}
		res.Events = append(res.Events, abci.Event{
			Type: "ActionApplied",
			Attributes: []abci.EventAttribute{
				{Key: "tableId", Value: fmt.Sprintf("%d", msg.TableID), Index: true},
				{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
				{Key: "player", Value: msg.Player, Index: true},
				{Key: "action", Value: msg.Action, Index: true},
				{Key: "amount", Value: fmt.Sprintf("%d", msg.Amount), Index: false},
				{Key: "phase", Value: string(h.Phase), Index: true},
				{Key: "actingSeat", Value: fmt.Sprintf("%d", h.ActingSeat), Index: true},
			},
		})
		return res

	default:
		return &abci.ExecTxResult{Code: 1, Log: "unknown tx type: " + env.Type}
	}
}

func okEvent(typ string, attrs map[string]string) *abci.ExecTxResult {
	ev := abci.Event{Type: typ}
	keys := make([]string, 0, len(attrs))
	for k := range attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		ev.Attributes = append(ev.Attributes, abci.EventAttribute{Key: k, Value: attrs[k], Index: true})
	}
	return &abci.ExecTxResult{
		Code:   0,
		Events: []abci.Event{ev},
	}
}
