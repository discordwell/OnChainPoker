package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/codec"
	"onchainpoker/apps/chain/internal/ocpcrypto"
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
		res := a.deliverTx(txBytes, req.Height, req.Time.Unix())
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
	// - /dealer/epoch
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
	case path == "/dealer/epoch":
		if a.st.Dealer == nil || a.st.Dealer.Epoch == nil {
			return &abci.QueryResponse{Code: 1, Log: "no active dealer epoch", Height: a.st.Height}, nil
		}
		b, _ := json.Marshal(a.st.Dealer.Epoch)
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

func (a *OCPApp) deliverTx(txBytes []byte, height int64, nowUnixOpt ...int64) *abci.ExecTxResult {
	env, err := codec.DecodeTxEnvelope(txBytes)
	if err != nil {
		return &abci.ExecTxResult{Code: 1, Log: err.Error()}
	}

	// v0: keep state height consistent even in tests that call deliverTx() directly.
	a.st.Height = height
	nowUnix := height
	if len(nowUnixOpt) > 0 {
		nowUnix = nowUnixOpt[0]
	}

	switch env.Type {
	case "auth/register_account":
		var msg codec.AuthRegisterAccountTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad auth/register_account value"}
		}
		if err := requireRegisterAccountAuth(env, msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		// Idempotent registration; key rotation is out of scope for v0.
		if existing := a.st.AccountKeys[msg.Account]; len(existing) != 0 {
			if string(existing) != string(msg.PubKey) {
				return &abci.ExecTxResult{Code: 1, Log: "account pubKey already set (rotation not supported in v0)"}
			}
			return okEvent("AccountKeyRegistered", map[string]string{
				"account":  msg.Account,
				"existing": "true",
			})
		}
		a.st.AccountKeys[msg.Account] = append([]byte(nil), msg.PubKey...)
		return okEvent("AccountKeyRegistered", map[string]string{
			"account": msg.Account,
		})

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
		if err := requireAccountAuth(a.st, env, msg.From); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
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
		if err := requireAccountAuth(a.st, env, msg.Creator); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
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

				ActionTimeoutSecs: msg.ActionTO,
				DealerTimeoutSecs: msg.DealerTO,
				PlayerBond:        msg.PlayerBond,
				RakeBps:           msg.RakeBps,
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
		if err := requireAccountAuth(a.st, env, msg.Player); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
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
		var pkPlayer []byte
		if strings.TrimSpace(msg.PKPlayer) != "" {
			b, err := base64.StdEncoding.DecodeString(msg.PKPlayer)
			if err != nil {
				return &abci.ExecTxResult{Code: 1, Log: "invalid pkPlayer: must be base64"}
			}
			if len(b) != ocpcrypto.PointBytes {
				return &abci.ExecTxResult{Code: 1, Log: "invalid pkPlayer: must decode to 32 bytes"}
			}
			if _, err := ocpcrypto.PointFromBytesCanonical(b); err != nil {
				return &abci.ExecTxResult{Code: 1, Log: "invalid pkPlayer point"}
			}
			pkPlayer = b
		}
		t.Seats[msg.Seat] = &state.Seat{
			Player: msg.Player,
			PK:     pkPlayer,
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
		if msg.Caller == "" {
			return &abci.ExecTxResult{Code: 1, Log: "missing caller"}
		}
		if err := requireAccountAuth(a.st, env, msg.Caller); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		if seatOfPlayer(t, msg.Caller) < 0 {
			return &abci.ExecTxResult{Code: 1, Log: "caller not seated at table"}
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

		epoch := a.st.Dealer.Epoch
		useDealer := epoch != nil

		// Advance button to next funded seat (or first if unset).
		if t.ButtonSeat < 0 {
			t.ButtonSeat = activeSeats[0]
		} else {
			t.ButtonSeat = nextOccupiedSeat(t, t.ButtonSeat)
		}

		// Clear any previous hole cards.
		for i := 0; i < 9; i++ {
			if t.Seats[i] == nil {
				continue
			}
			t.Seats[i].Hole = [2]state.Card{}
		}

		// Determine blinds and build initial hand state.
		sbSeat, bbSeat := blindSeats(t)
		if sbSeat < 0 || bbSeat < 0 {
			return &abci.ExecTxResult{Code: 1, Log: "cannot determine blinds"}
		}

		var inHand [9]bool
		for i := 0; i < 9; i++ {
			if t.Seats[i] != nil && t.Seats[i].Stack > 0 {
				inHand[i] = true
			}
		}

		var lastActed [9]int
		for i := 0; i < 9; i++ {
			lastActed[i] = -1
		}

		deck := []state.Card{}
		if !useDealer {
			// DealerStub: deterministic deck seed = H(height||tableId||handId).
			seed := []byte(fmt.Sprintf("%d|%d|%d", height, msg.TableID, handId))
			deck = state.DeterministicDeck(seed)
		}

		h := &state.Hand{
			HandID:            handId,
			Phase:             state.PhaseBetting,
			Street:            state.StreetPreflop,
			ButtonSeat:        t.ButtonSeat,
			SmallBlindSeat:    sbSeat,
			BigBlindSeat:      bbSeat,
			ActionOn:          -1,
			BetTo:             0,
			MinRaiseSize:      t.Params.BigBlind,
			IntervalID:        0,
			LastIntervalActed: lastActed,
			Deck:              deck,
			DeckCursor:        0,
			Board:             []state.Card{},
		}
		// Note: the remaining fixed-size arrays default to zero values.
		h.InHand = inHand
		t.Hand = h

		// Post blinds (all-in if short).
		if err := postBlindCommit(t, sbSeat, t.Params.SmallBlind); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "small blind: " + err.Error()}
		}
		if err := postBlindCommit(t, bbSeat, t.Params.BigBlind); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "big blind: " + err.Error()}
		}
		h.BetTo = h.StreetCommit[bbSeat]
		h.MinRaiseSize = t.Params.BigBlind

		// Preflop action starts left of the big blind (even if we are still shuffling / dealing privately).
		h.ActionOn = nextActiveToAct(t, h, bbSeat)

		ev := okEvent("HandStarted", map[string]string{
			"tableId":        fmt.Sprintf("%d", msg.TableID),
			"handId":         fmt.Sprintf("%d", handId),
			"buttonSeat":     fmt.Sprintf("%d", t.ButtonSeat),
			"smallBlindSeat": fmt.Sprintf("%d", sbSeat),
			"bigBlindSeat":   fmt.Sprintf("%d", bbSeat),
			"actionOn":       fmt.Sprintf("%d", h.ActionOn),
		})
		if useDealer {
			// Dealer module: start in shuffle/deal phase, initialize the encrypted deck.
			for i := 0; i < 9; i++ {
				if !h.InHand[i] {
					continue
				}
				if t.Seats[i] == nil || len(t.Seats[i].PK) != ocpcrypto.PointBytes {
					return &abci.ExecTxResult{Code: 1, Log: fmt.Sprintf("seat %d missing pk; required for dealer mode", i)}
				}
			}
			h.Phase = state.PhaseShuffle
			initEv, err := dealerInitHand(a.st, t, codec.DealerInitHandTx{
				TableID:  msg.TableID,
				HandID:   handId,
				EpochID:  epoch.EpochID,
				DeckSize: 0,
			}, nowUnix)
			if err != nil {
				return &abci.ExecTxResult{Code: 1, Log: err.Error()}
			}
			ev.Events = append(ev.Events, initEv.Events...)
		} else {
			// DealerStub: deal hole cards publicly.
			dealHoleCards(t)
			// Emit hole cards as part of the tx (public dealing stub).
			ev.Events = append(ev.Events, holeCardEvents(msg.TableID, handId, t)...)
			// If no action is possible (everyone all-in), run out and settle immediately.
			if h.ActionOn == -1 {
				ev.Events = append(ev.Events, runoutAndSettleHand(t)...)
			}
		}

		return ev

	case "poker/act":
		var msg codec.PokerActTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad poker/act value"}
		}
		if msg.Player == "" {
			return &abci.ExecTxResult{Code: 1, Log: "missing player"}
		}
		if err := requireAccountAuth(a.st, env, msg.Player); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		if t.Hand == nil {
			return &abci.ExecTxResult{Code: 1, Log: "no active hand"}
		}
		h := t.Hand
		if h.Phase != state.PhaseBetting {
			return &abci.ExecTxResult{Code: 1, Log: "hand not in betting phase"}
		}
		if h.ActionOn < 0 || h.ActionOn >= 9 || t.Seats[h.ActionOn] == nil {
			return &abci.ExecTxResult{Code: 1, Log: "invalid actionOn seat"}
		}
		if t.Seats[h.ActionOn].Player != msg.Player {
			return &abci.ExecTxResult{Code: 1, Log: "not your turn"}
		}
		res := applyAction(t, msg.Action, msg.Amount, nowUnix)
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
				// Semantics: for bet/raise, amount is the desired total street commitment ("BetTo").
				{Key: "amount", Value: fmt.Sprintf("%d", msg.Amount), Index: false},
				{Key: "phase", Value: string(h.Phase), Index: true},
				{Key: "street", Value: string(h.Street), Index: true},
				{Key: "actionOn", Value: fmt.Sprintf("%d", h.ActionOn), Index: true},
			},
		})
		return res

	case "staking/register_validator":
		var msg codec.StakingRegisterValidatorTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad staking/register_validator value"}
		}
		if err := requireRegisterValidatorAuth(env, msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		ev, err := stakingRegisterValidator(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "staking/bond":
		var msg codec.StakingBondTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad staking/bond value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.ValidatorID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		ev, err := stakingBond(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "staking/unbond":
		var msg codec.StakingUnbondTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad staking/unbond value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.ValidatorID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		ev, err := stakingUnbond(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "staking/unjail":
		var msg codec.StakingUnjailTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad staking/unjail value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.ValidatorID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		ev, err := stakingUnjail(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/begin_epoch":
		var msg codec.DealerBeginEpochTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/begin_epoch value"}
		}
		ev, err := dealerBeginEpoch(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/dkg_commit":
		var msg codec.DealerDKGCommitTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/dkg_commit value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.DealerID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		ev, err := dealerDKGCommit(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/dkg_complaint_missing":
		var msg codec.DealerDKGComplaintMissingTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/dkg_complaint_missing value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.ComplainerID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		ev, err := dealerDKGComplaintMissing(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/dkg_complaint_invalid":
		var msg codec.DealerDKGComplaintInvalidTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/dkg_complaint_invalid value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.ComplainerID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		ev, err := dealerDKGComplaintInvalid(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/dkg_share_reveal":
		var msg codec.DealerDKGShareRevealTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/dkg_share_reveal value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.DealerID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		ev, err := dealerDKGShareReveal(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/finalize_epoch":
		var msg codec.DealerFinalizeEpochTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/finalize_epoch value"}
		}
		ev, err := dealerFinalizeEpoch(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/dkg_timeout":
		var msg codec.DealerDKGTimeoutTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/dkg_timeout value"}
		}
		ev, err := dealerDKGTimeout(a.st, msg)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/init_hand":
		var msg codec.DealerInitHandTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/init_hand value"}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		ev, err := dealerInitHand(a.st, t, msg, nowUnix)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/submit_shuffle":
		var msg codec.DealerSubmitShuffleTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/submit_shuffle value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.ShufflerID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		ev, err := dealerSubmitShuffle(a.st, t, msg, nowUnix)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/finalize_deck":
		var msg codec.DealerFinalizeDeckTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/finalize_deck value"}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		ev, err := dealerFinalizeDeck(a.st, t, msg, nowUnix)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/submit_pub_share":
		var msg codec.DealerSubmitPubShareTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/submit_pub_share value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.ValidatorID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		ev, err := dealerSubmitPubShare(a.st, t, msg, nowUnix)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/submit_enc_share":
		var msg codec.DealerSubmitEncShareTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/submit_enc_share value"}
		}
		if err := requireValidatorAuth(a.st, env, msg.ValidatorID); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		ev, err := dealerSubmitEncShare(a.st, t, msg, nowUnix)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/finalize_reveal":
		var msg codec.DealerFinalizeRevealTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/finalize_reveal value"}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		ev, err := dealerFinalizeReveal(a.st, t, msg, nowUnix)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

	case "dealer/timeout":
		var msg codec.DealerTimeoutTx
		if err := json.Unmarshal(env.Value, &msg); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: "bad dealer/timeout value"}
		}
		t := a.st.Tables[msg.TableID]
		if t == nil {
			return &abci.ExecTxResult{Code: 1, Log: "table not found"}
		}
		ev, err := dealerTimeout(a.st, t, msg, nowUnix)
		if err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
		return ev

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
