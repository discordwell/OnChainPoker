package types

import (
	"github.com/cosmos/cosmos-sdk/codec"
	"github.com/cosmos/cosmos-sdk/codec/legacy"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/msgservice"
)

// RegisterLegacyAminoCodec registers the x/poker messages for legacy Amino JSON.
//
// Cosmos SDK chains are protobuf-first; this is mainly for completeness and tooling.
func RegisterLegacyAminoCodec(cdc *codec.LegacyAmino) {
	// Amino message names must be <40 chars (ledger nano signing constraint).
	// Keep these short and stable.
	legacy.RegisterAminoMsg(cdc, &MsgCreateTable{}, "ocp/poker/CreateTable")
	legacy.RegisterAminoMsg(cdc, &MsgSit{}, "ocp/poker/Sit")
	legacy.RegisterAminoMsg(cdc, &MsgStartHand{}, "ocp/poker/StartHand")
	legacy.RegisterAminoMsg(cdc, &MsgAct{}, "ocp/poker/Act")
	legacy.RegisterAminoMsg(cdc, &MsgTick{}, "ocp/poker/Tick")
	legacy.RegisterAminoMsg(cdc, &MsgLeave{}, "ocp/poker/Leave")
	legacy.RegisterAminoMsg(cdc, &MsgRebuy{}, "ocp/poker/Rebuy")
}

// RegisterInterfaces registers the x/poker module's interface implementations.
func RegisterInterfaces(registry codectypes.InterfaceRegistry) {
	registry.RegisterImplementations((*sdk.Msg)(nil),
		&MsgCreateTable{},
		&MsgSit{},
		&MsgStartHand{},
		&MsgAct{},
		&MsgTick{},
		&MsgLeave{},
		&MsgRebuy{},
	)

	msgservice.RegisterMsgServiceDesc(registry, &_Msg_serviceDesc)
}
