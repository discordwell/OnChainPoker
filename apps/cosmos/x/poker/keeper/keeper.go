package keeper

import (
	"context"
	"encoding/binary"
	"fmt"

	corestore "cosmossdk.io/core/store"
	"cosmossdk.io/log"
	storetypes "cosmossdk.io/store/types"

	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/x/poker/types"
)

type Keeper struct {
	storeService corestore.KVStoreService
	cdc          codec.BinaryCodec
	bankKeeper   types.BankKeeper
}

func NewKeeper(cdc codec.BinaryCodec, storeService corestore.KVStoreService, bankKeeper types.BankKeeper) Keeper {
	if cdc == nil {
		panic("poker keeper: cdc is nil")
	}
	if storeService == nil {
		panic("poker keeper: store service is nil")
	}
	if bankKeeper == nil {
		panic("poker keeper: bank keeper is nil")
	}
	return Keeper{
		storeService: storeService,
		cdc:          cdc,
		bankKeeper:   bankKeeper,
	}
}

func (k Keeper) Logger(ctx context.Context) log.Logger {
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	return sdkCtx.Logger().With("module", "x/"+types.ModuleName)
}

func (k Keeper) GetNextTableID(ctx context.Context) (uint64, error) {
	store := k.storeService.OpenKVStore(ctx)
	bz, err := store.Get(types.NextTableIDKey)
	if err != nil {
		return 0, err
	}
	if bz == nil {
		return 1, nil
	}
	if len(bz) != 8 {
		return 0, fmt.Errorf("invalid nextTableID encoding")
	}
	return binary.BigEndian.Uint64(bz), nil
}

func (k Keeper) SetNextTableID(ctx context.Context, next uint64) error {
	store := k.storeService.OpenKVStore(ctx)
	bz := make([]byte, 8)
	binary.BigEndian.PutUint64(bz, next)
	return store.Set(types.NextTableIDKey, bz)
}

func (k Keeper) GetTable(ctx context.Context, tableID uint64) (*types.Table, error) {
	store := k.storeService.OpenKVStore(ctx)
	bz, err := store.Get(types.TableKey(tableID))
	if err != nil {
		return nil, err
	}
	if bz == nil {
		return nil, nil
	}
	var t types.Table
	if err := k.cdc.Unmarshal(bz, &t); err != nil {
		return nil, err
	}
	normalizeTable(&t)
	return &t, nil
}

func (k Keeper) SetTable(ctx context.Context, t *types.Table) error {
	if t == nil {
		return fmt.Errorf("table is nil")
	}
	normalizeTable(t)
	store := k.storeService.OpenKVStore(ctx)
	bz, err := k.cdc.Marshal(t)
	if err != nil {
		return err
	}
	return store.Set(types.TableKey(t.Id), bz)
}

func (k Keeper) IterateTables(ctx context.Context, cb func(id uint64) (stop bool)) error {
	store := k.storeService.OpenKVStore(ctx)
	it, err := store.Iterator(types.TableKeyPrefix, storetypes.PrefixEndBytes(types.TableKeyPrefix))
	if err != nil {
		return err
	}
	defer it.Close()

	for ; it.Valid(); it.Next() {
		key := it.Key()
		if len(key) != 1+8 || key[0] != types.TableKeyPrefix[0] {
			continue
		}
		id := binary.BigEndian.Uint64(key[1:])
		if cb(id) {
			break
		}
	}
	return nil
}

// ---- Normalization helpers (defensive against older / malformed states) ----

func normalizeTable(t *types.Table) {
	if t == nil {
		return
	}
	// Seats must always be length 9.
	if len(t.Seats) < 9 {
		padded := make([]*types.Seat, 9)
		copy(padded, t.Seats)
		t.Seats = padded
	} else if len(t.Seats) > 9 {
		t.Seats = t.Seats[:9]
	}

	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		// Do not allow nil entries: protobuf marshalling rejects nil elements in
		// repeated message fields. Empty seats are represented by a Seat with an
		// empty Player string.
		if s == nil {
			s = &types.Seat{}
			t.Seats[i] = s
		}
		normalizeSeat(s)

		// Defensive cleanup: if a seat has no player, treat it as empty.
		if s.Player == "" {
			s.Pk = nil
			s.Stack = 0
			s.Bond = 0
		}
	}

	if t.Hand != nil {
		normalizeHand(t.Hand)
	}

	if t.NextHandId == 0 {
		t.NextHandId = 1
	}
	if t.ButtonSeat < -1 || t.ButtonSeat > 8 {
		t.ButtonSeat = -1
	}
}

func normalizeSeat(s *types.Seat) {
	if s == nil {
		return
	}
	// Hole must be length 2, using 255 as "unknown".
	if len(s.Hole) < 2 {
		h := make([]uint32, 2)
		for i := range h {
			h[i] = 255
		}
		copy(h, s.Hole)
		s.Hole = h
	} else if len(s.Hole) > 2 {
		s.Hole = s.Hole[:2]
	}
	for i := 0; i < 2; i++ {
		if s.Hole[i] == 0 && len(s.Hole) == 2 {
			// Keep legacy default (0) as-is; callers treat 255 as unknown.
		}
	}
}

func normalizeHand(h *types.Hand) {
	if h == nil {
		return
	}
	fixBoolLen(&h.InHand, 9)
	fixBoolLen(&h.Folded, 9)
	fixBoolLen(&h.AllIn, 9)
	fixU64Len(&h.StreetCommit, 9)
	fixU64Len(&h.TotalCommit, 9)
	fixI32Len(&h.LastIntervalActed, 9, -1)

	if h.ActionOn < -1 || h.ActionOn > 8 {
		h.ActionOn = -1
	}

	if h.Dealer != nil {
		if len(h.Dealer.HolePos) < 18 {
			padded := make([]uint32, 18)
			for i := range padded {
				padded[i] = 255
			}
			copy(padded, h.Dealer.HolePos)
			h.Dealer.HolePos = padded
		} else if len(h.Dealer.HolePos) > 18 {
			h.Dealer.HolePos = h.Dealer.HolePos[:18]
		}
	}
}

func fixBoolLen(s *[]bool, n int) {
	if *s == nil {
		*s = make([]bool, n)
		return
	}
	if len(*s) < n {
		p := make([]bool, n)
		copy(p, *s)
		*s = p
		return
	}
	if len(*s) > n {
		*s = (*s)[:n]
	}
}

func fixU64Len(s *[]uint64, n int) {
	if *s == nil {
		*s = make([]uint64, n)
		return
	}
	if len(*s) < n {
		p := make([]uint64, n)
		copy(p, *s)
		*s = p
		return
	}
	if len(*s) > n {
		*s = (*s)[:n]
	}
}

func fixI32Len(s *[]int32, n int, fill int32) {
	if *s == nil {
		*s = make([]int32, n)
		for i := range *s {
			(*s)[i] = fill
		}
		return
	}
	if len(*s) < n {
		p := make([]int32, n)
		copy(p, *s)
		for i := len(*s); i < n; i++ {
			p[i] = fill
		}
		*s = p
		return
	}
	if len(*s) > n {
		*s = (*s)[:n]
	}
}
