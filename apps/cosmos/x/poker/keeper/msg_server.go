package keeper

import (
	"context"
	"fmt"

	sdkmath "cosmossdk.io/math"

	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	"onchainpoker/apps/cosmos/x/poker/types"
)

type msgServer struct {
	Keeper
	cdc codec.BinaryCodec
}

var _ types.MsgServer = msgServer{}

func NewMsgServerImpl(k Keeper, cdc codec.BinaryCodec) types.MsgServer {
	return &msgServer{Keeper: k, cdc: cdc}
}

func (m msgServer) CreateTable(ctx context.Context, req *types.MsgCreateTable) (*types.MsgCreateTableResponse, error) {
	if req == nil {
		return nil, types.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Creator == "" {
		return nil, types.ErrInvalidRequest.Wrap("missing creator")
	}

	maxPlayers := req.MaxPlayers
	if maxPlayers == 0 {
		maxPlayers = 9
	}
	if maxPlayers != 9 {
		return nil, types.ErrInvalidTableCfg.Wrap("only max_players=9 is supported")
	}
	if req.SmallBlind == 0 || req.BigBlind == 0 || req.BigBlind < req.SmallBlind {
		return nil, types.ErrInvalidTableCfg.Wrap("invalid blinds")
	}
	if req.MinBuyIn == 0 || req.MaxBuyIn == 0 || req.MaxBuyIn < req.MinBuyIn {
		return nil, types.ErrInvalidTableCfg.Wrap("invalid buy-in range")
	}

	id, err := m.GetNextTableID(ctx)
	if err != nil {
		return nil, err
	}
	if err := m.SetNextTableID(ctx, id+1); err != nil {
		return nil, err
	}

	t := &types.Table{
		Id:      id,
		Creator: req.Creator,
		Label:   req.Label,
		Params: types.TableParams{
			MaxPlayers:        maxPlayers,
			SmallBlind:        req.SmallBlind,
			BigBlind:          req.BigBlind,
			MinBuyIn:          req.MinBuyIn,
			MaxBuyIn:          req.MaxBuyIn,
			ActionTimeoutSecs: req.ActionTimeoutSecs,
			DealerTimeoutSecs: req.DealerTimeoutSecs,
			PlayerBond:        req.PlayerBond,
			RakeBps:           req.RakeBps,
		},
		Seats:      make([]*types.Seat, 9),
		NextHandId: 1,
		ButtonSeat: -1,
		Hand:       nil,
	}

	if err := m.SetTable(ctx, t); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		types.EventTypeTableCreated,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", id)),
	))

	return &types.MsgCreateTableResponse{TableId: id}, nil
}

func (m msgServer) Sit(ctx context.Context, req *types.MsgSit) (*types.MsgSitResponse, error) {
	if req == nil {
		return nil, types.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Player == "" {
		return nil, types.ErrInvalidRequest.Wrap("missing player")
	}
	playerAddr, err := sdk.AccAddressFromBech32(req.Player)
	if err != nil {
		return nil, types.ErrInvalidRequest.Wrap("invalid player address")
	}

	t, err := m.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, types.ErrTableNotFound.Wrapf("table %d not found", req.TableId)
	}

	if req.Seat > 8 {
		return nil, types.ErrInvalidRequest.Wrap("invalid seat")
	}
	if t.Seats[req.Seat] != nil && t.Seats[req.Seat].Player != "" {
		return nil, types.ErrSeatOccupied.Wrap("seat occupied")
	}
	if req.BuyIn < t.Params.MinBuyIn || req.BuyIn > t.Params.MaxBuyIn {
		return nil, types.ErrInvalidRequest.Wrap("buy-in out of range")
	}

	// Dealer mode requires pk_player.
	if len(req.PkPlayer) != ocpcrypto.PointBytes {
		return nil, types.ErrInvalidRequest.Wrap("pk_player must be 32 bytes")
	}
	if _, err := ocpcrypto.PointFromBytesCanonical(req.PkPlayer); err != nil {
		return nil, types.ErrInvalidRequest.Wrap("pk_player invalid ristretto point")
	}

	bond := t.Params.PlayerBond
	total := req.BuyIn
	if bond != 0 {
		if total > ^uint64(0)-bond {
			return nil, types.ErrInvalidRequest.Wrap("buy_in + bond overflows uint64")
		}
		total += bond
	}

	denom := sdk.DefaultBondDenom
	coins := sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewIntFromUint64(total)))
	if err := m.bankKeeper.SendCoinsFromAccountToModule(ctx, playerAddr, types.ModuleName, coins); err != nil {
		return nil, err
	}

	t.Seats[req.Seat] = &types.Seat{
		Player: req.Player,
		Pk:     append([]byte(nil), req.PkPlayer...),
		Stack:  req.BuyIn,
		Bond:   bond,
		Hole:   []uint32{255, 255},
	}

	if err := m.SetTable(ctx, t); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		types.EventTypePlayerSat,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("seat", fmt.Sprintf("%d", req.Seat)),
		sdk.NewAttribute("player", req.Player),
		sdk.NewAttribute("buyIn", fmt.Sprintf("%d", req.BuyIn)),
		sdk.NewAttribute("bond", fmt.Sprintf("%d", bond)),
	))

	return &types.MsgSitResponse{}, nil
}

func (m msgServer) StartHand(ctx context.Context, req *types.MsgStartHand) (*types.MsgStartHandResponse, error) {
	if req == nil {
		return nil, types.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Caller == "" {
		return nil, types.ErrInvalidRequest.Wrap("missing caller")
	}

	t, err := m.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, types.ErrTableNotFound.Wrapf("table %d not found", req.TableId)
	}
	if seatOfPlayer(t, req.Caller) < 0 {
		return nil, types.ErrNotSeated.Wrap("caller not seated at table")
	}
	if t.Hand != nil {
		return nil, types.ErrHandInProgress.Wrap("hand already in progress")
	}

	activeSeats := occupiedSeatsWithStack(t)
	if len(activeSeats) < 2 {
		return nil, types.ErrInvalidRequest.Wrap("need at least 2 players with chips")
	}

	// Advance button to next funded seat (or first if unset).
	if t.ButtonSeat < 0 {
		t.ButtonSeat = int32(activeSeats[0])
	} else {
		t.ButtonSeat = int32(nextOccupiedSeat(t, int(t.ButtonSeat)))
	}

	// Clear any previous hole cards.
	for i := 0; i < 9; i++ {
		if t.Seats[i] == nil {
			continue
		}
		t.Seats[i].Hole = []uint32{255, 255}
	}

	// Determine blinds and build initial hand state.
	sbSeat, bbSeat := blindSeats(t)
	if sbSeat < 0 || bbSeat < 0 {
		return nil, types.ErrInvalidRequest.Wrap("cannot determine blinds")
	}

	handID := t.NextHandId
	t.NextHandId++

	inHand := make([]bool, 9)
	for i := 0; i < 9; i++ {
		if t.Seats[i] != nil && t.Seats[i].Stack > 0 {
			inHand[i] = true
		}
	}

	lastActed := make([]int32, 9)
	for i := 0; i < 9; i++ {
		lastActed[i] = -1
	}

	h := &types.Hand{
		HandId:         handID,
		Phase:          types.HandPhase_HAND_PHASE_SHUFFLE,
		Street:         types.Street_STREET_PREFLOP,
		ButtonSeat:     t.ButtonSeat,
		SmallBlindSeat: int32(sbSeat),
		BigBlindSeat:   int32(bbSeat),
		ActionOn:       -1,
		BetTo:          0,
		MinRaiseSize:   t.Params.BigBlind,
		IntervalId:     0,

		InHand:            inHand,
		Folded:            make([]bool, 9),
		AllIn:             make([]bool, 9),
		StreetCommit:      make([]uint64, 9),
		TotalCommit:       make([]uint64, 9),
		LastIntervalActed: lastActed,

		Board:          nil,
		ActionDeadline: 0,

		Dealer: &types.DealerMeta{
			EpochId:        0,
			DeckSize:       0,
			DeckFinalized:  false,
			HolePos:        make([]uint32, 18),
			Cursor:         0,
			RevealPos:      255,
			RevealDeadline: 0,
		},
	}
	for i := range h.Dealer.HolePos {
		h.Dealer.HolePos[i] = 255
	}
	t.Hand = h

	// Post blinds (all-in if short).
	if err := postBlindCommit(t, sbSeat, t.Params.SmallBlind); err != nil {
		return nil, types.ErrInvalidRequest.Wrap("small blind: " + err.Error())
	}
	if err := postBlindCommit(t, bbSeat, t.Params.BigBlind); err != nil {
		return nil, types.ErrInvalidRequest.Wrap("big blind: " + err.Error())
	}
	h.BetTo = h.StreetCommit[bbSeat]
	h.MinRaiseSize = t.Params.BigBlind

	// Preflop action starts left of the big blind.
	h.ActionOn = int32(nextActiveToAct(t, h, bbSeat))

	if err := m.SetTable(ctx, t); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		types.EventTypeHandStarted,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
		sdk.NewAttribute("buttonSeat", fmt.Sprintf("%d", t.ButtonSeat)),
		sdk.NewAttribute("smallBlindSeat", fmt.Sprintf("%d", sbSeat)),
		sdk.NewAttribute("bigBlindSeat", fmt.Sprintf("%d", bbSeat)),
		sdk.NewAttribute("actionOn", fmt.Sprintf("%d", h.ActionOn)),
	))

	return &types.MsgStartHandResponse{}, nil
}

func (m msgServer) Act(ctx context.Context, req *types.MsgAct) (*types.MsgActResponse, error) {
	if req == nil {
		return nil, types.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Player == "" {
		return nil, types.ErrInvalidRequest.Wrap("missing player")
	}
	if _, err := sdk.AccAddressFromBech32(req.Player); err != nil {
		return nil, types.ErrInvalidRequest.Wrap("invalid player address")
	}

	t, err := m.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, types.ErrTableNotFound.Wrapf("table %d not found", req.TableId)
	}
	if t.Hand == nil {
		return nil, types.ErrNoActiveHand.Wrap("no active hand")
	}
	h := t.Hand
	if h.Phase != types.HandPhase_HAND_PHASE_BETTING {
		return nil, types.ErrInvalidRequest.Wrap("hand not in betting phase")
	}
	if h.ActionOn < 0 || h.ActionOn >= 9 || t.Seats[h.ActionOn] == nil {
		return nil, types.ErrInvalidRequest.Wrap("invalid actionOn seat")
	}
	if t.Seats[h.ActionOn].Player != req.Player {
		return nil, types.ErrNotYourTurn.Wrap("not your turn")
	}

	nowUnix := sdk.UnwrapSDKContext(ctx).BlockTime().Unix()

	extraEvents, err := applyAction(t, req.Action, req.Amount, nowUnix)
	if err != nil {
		return nil, types.ErrInvalidAction.Wrap(err.Error())
	}

	// Persist table (may clear hand).
	if err := m.SetTable(ctx, t); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	// Prefix event describing the action.
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		types.EventTypeActionApplied,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", h.HandId)),
		sdk.NewAttribute("player", req.Player),
		sdk.NewAttribute("action", req.Action),
		sdk.NewAttribute("amount", fmt.Sprintf("%d", req.Amount)),
		sdk.NewAttribute("phase", h.Phase.String()),
		sdk.NewAttribute("street", h.Street.String()),
		sdk.NewAttribute("actionOn", fmt.Sprintf("%d", h.ActionOn)),
	))
	for _, ev := range extraEvents {
		sdkCtx.EventManager().EmitEvent(ev)
	}

	// Eject bondless seats between hands.
	if t.Hand == nil {
		if err := m.ejectBondlessSeats(ctx, t); err != nil {
			return nil, err
		}
		if err := m.SetTable(ctx, t); err != nil {
			return nil, err
		}
	}

	return &types.MsgActResponse{}, nil
}

func (m msgServer) Tick(ctx context.Context, req *types.MsgTick) (*types.MsgTickResponse, error) {
	if req == nil {
		return nil, types.ErrInvalidRequest.Wrap("nil request")
	}
	t, err := m.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, types.ErrTableNotFound.Wrapf("table %d not found", req.TableId)
	}
	if t.Hand == nil {
		return nil, types.ErrNoActiveHand.Wrap("no active hand")
	}
	h := t.Hand
	if h.Phase != types.HandPhase_HAND_PHASE_BETTING {
		return nil, types.ErrInvalidRequest.Wrap("hand not in betting phase")
	}
	if h.ActionOn < 0 || h.ActionOn >= 9 || t.Seats[h.ActionOn] == nil {
		return nil, types.ErrInvalidRequest.Wrap("invalid actionOn seat")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	nowUnix := sdkCtx.BlockTime().Unix()

	// Defensive: older saved states may not have the deadline initialized.
	if h.ActionDeadline == 0 {
		if err := setActionDeadlineIfBetting(t, nowUnix); err != nil {
			return nil, err
		}
		if err := m.SetTable(ctx, t); err != nil {
			return nil, err
		}
		return &types.MsgTickResponse{}, nil
	}
	if nowUnix < h.ActionDeadline {
		return nil, types.ErrInvalidRequest.Wrap("action not timed out")
	}

	handID := h.HandId
	actorSeat := int(h.ActionOn)
	player := t.Seats[actorSeat].Player

	action := "fold"
	if toCall(h, actorSeat) == 0 {
		action = "check"
	}

	// Slash a per-player bond on timeouts (if configured on the table).
	slashAmt := uint64(0)
	seatState := t.Seats[actorSeat]
	if seatState != nil && seatState.Bond != 0 {
		slashUnit := t.Params.BigBlind
		if slashUnit == 0 {
			slashUnit = 1
		}
		slashAmt = slashUnit
		if slashAmt > seatState.Bond {
			slashAmt = seatState.Bond
		}
		seatState.Bond -= slashAmt

		// Move slashed bond out of escrow to fee collector.
		if slashAmt != 0 {
			denom := sdk.DefaultBondDenom
			coins := sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewIntFromUint64(slashAmt)))
			if err := m.bankKeeper.SendCoinsFromModuleToModule(ctx, types.ModuleName, authtypes.FeeCollectorName, coins); err != nil {
				return nil, err
			}
		}
	}

	extraEvents, err := applyAction(t, action, 0, nowUnix)
	if err != nil {
		return nil, types.ErrInvalidAction.Wrap(err.Error())
	}

	if err := m.SetTable(ctx, t); err != nil {
		return nil, err
	}

	// Timeout + optional slash events.
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		types.EventTypeTimeoutApplied,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
		sdk.NewAttribute("seat", fmt.Sprintf("%d", actorSeat)),
		sdk.NewAttribute("player", player),
		sdk.NewAttribute("action", action),
	))
	if slashAmt != 0 {
		remaining := uint64(0)
		if seatState != nil {
			remaining = seatState.Bond
		}
		sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
			types.EventTypePlayerSlashed,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
			sdk.NewAttribute("seat", fmt.Sprintf("%d", actorSeat)),
			sdk.NewAttribute("player", player),
			sdk.NewAttribute("reason", "action-timeout"),
			sdk.NewAttribute("amount", fmt.Sprintf("%d", slashAmt)),
			sdk.NewAttribute("bondRemaining", fmt.Sprintf("%d", remaining)),
		))
	}
	for _, ev := range extraEvents {
		sdkCtx.EventManager().EmitEvent(ev)
	}

	// Eject bondless seats between hands.
	if t.Hand == nil {
		if err := m.ejectBondlessSeats(ctx, t); err != nil {
			return nil, err
		}
		if err := m.SetTable(ctx, t); err != nil {
			return nil, err
		}
	}

	return &types.MsgTickResponse{}, nil
}

func (m msgServer) Leave(ctx context.Context, req *types.MsgLeave) (*types.MsgLeaveResponse, error) {
	if req == nil {
		return nil, types.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Player == "" {
		return nil, types.ErrInvalidRequest.Wrap("missing player")
	}
	playerAddr, err := sdk.AccAddressFromBech32(req.Player)
	if err != nil {
		return nil, types.ErrInvalidRequest.Wrap("invalid player address")
	}

	t, err := m.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, types.ErrTableNotFound.Wrapf("table %d not found", req.TableId)
	}

	seat := seatOfPlayer(t, req.Player)
	if seat < 0 || seat >= 9 || t.Seats[seat] == nil || t.Seats[seat].Player == "" {
		return nil, types.ErrNotSeated.Wrap("player not seated at table")
	}
	if t.Hand != nil && len(t.Hand.InHand) == 9 && t.Hand.InHand[seat] {
		return nil, types.ErrInvalidRequest.Wrap("cannot leave during active hand")
	}

	s := t.Seats[seat]
	amount := s.Stack
	if s.Bond != 0 {
		if amount > ^uint64(0)-s.Bond {
			return nil, types.ErrInvalidRequest.Wrap("stack + bond overflows uint64")
		}
		amount += s.Bond
	}

	if amount != 0 {
		denom := sdk.DefaultBondDenom
		coins := sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewIntFromUint64(amount)))
		if err := m.bankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, playerAddr, coins); err != nil {
			return nil, err
		}
	}

	t.Seats[seat] = &types.Seat{}
	if err := m.SetTable(ctx, t); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		types.EventTypePlayerLeft,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("seat", fmt.Sprintf("%d", seat)),
		sdk.NewAttribute("player", req.Player),
		sdk.NewAttribute("stack", fmt.Sprintf("%d", s.Stack)),
		sdk.NewAttribute("bond", fmt.Sprintf("%d", s.Bond)),
		sdk.NewAttribute("amount", fmt.Sprintf("%d", amount)),
	))

	return &types.MsgLeaveResponse{}, nil
}

// ejectBondlessSeats removes seated players whose bond has been depleted, returning their remaining stack.
func (m msgServer) ejectBondlessSeats(ctx context.Context, t *types.Table) error {
	if t == nil || t.Hand != nil {
		return nil
	}
	if t.Params.PlayerBond == 0 {
		return nil
	}

	denom := sdk.DefaultBondDenom
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil || s.Player == "" {
			continue
		}
		if s.Bond != 0 {
			continue
		}

		addr, err := sdk.AccAddressFromBech32(s.Player)
		if err != nil {
			return err
		}
		if s.Stack != 0 {
			coins := sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewIntFromUint64(s.Stack)))
			if err := m.bankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, addr, coins); err != nil {
				return err
			}
		}

		sdk.UnwrapSDKContext(ctx).EventManager().EmitEvent(sdk.NewEvent(
			types.EventTypePlayerEjected,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
			sdk.NewAttribute("seat", fmt.Sprintf("%d", i)),
			sdk.NewAttribute("player", s.Player),
			sdk.NewAttribute("reason", "bond depleted"),
			sdk.NewAttribute("stackReturned", fmt.Sprintf("%d", s.Stack)),
		))

		t.Seats[i] = &types.Seat{}
	}
	return nil
}
