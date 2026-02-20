package types

import (
	"github.com/cosmos/cosmos-sdk/codec"
	"github.com/cosmos/cosmos-sdk/codec/legacy"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/msgservice"
)

// RegisterLegacyAminoCodec registers the x/dealer messages for legacy Amino JSON.
//
// Cosmos SDK chains are protobuf-first; this is mainly for completeness and tooling.
func RegisterLegacyAminoCodec(cdc *codec.LegacyAmino) {
	// Amino message names must be <40 chars (ledger nano signing constraint).
	// Keep these short and stable.
	legacy.RegisterAminoMsg(cdc, &MsgBeginEpoch{}, "ocp/dealer/BeginEpoch")
	legacy.RegisterAminoMsg(cdc, &MsgDkgCommit{}, "ocp/dealer/DkgCommit")
	legacy.RegisterAminoMsg(cdc, &MsgDkgComplaintMissing{}, "ocp/dealer/DkgComplaintMissing")
	legacy.RegisterAminoMsg(cdc, &MsgDkgComplaintInvalid{}, "ocp/dealer/DkgComplaintInvalid")
	legacy.RegisterAminoMsg(cdc, &MsgDkgShareReveal{}, "ocp/dealer/DkgShareReveal")
	legacy.RegisterAminoMsg(cdc, &MsgFinalizeEpoch{}, "ocp/dealer/FinalizeEpoch")
	legacy.RegisterAminoMsg(cdc, &MsgDkgTimeout{}, "ocp/dealer/DkgTimeout")

	legacy.RegisterAminoMsg(cdc, &MsgInitHand{}, "ocp/dealer/InitHand")
	legacy.RegisterAminoMsg(cdc, &MsgSubmitShuffle{}, "ocp/dealer/SubmitShuffle")
	legacy.RegisterAminoMsg(cdc, &MsgFinalizeDeck{}, "ocp/dealer/FinalizeDeck")
	legacy.RegisterAminoMsg(cdc, &MsgSubmitPubShare{}, "ocp/dealer/SubmitPubShare")
	legacy.RegisterAminoMsg(cdc, &MsgSubmitEncShare{}, "ocp/dealer/SubmitEncShare")
	legacy.RegisterAminoMsg(cdc, &MsgFinalizeReveal{}, "ocp/dealer/FinalizeReveal")
	legacy.RegisterAminoMsg(cdc, &MsgTimeout{}, "ocp/dealer/Timeout")
}

// RegisterInterfaces registers the x/dealer module's interface implementations.
func RegisterInterfaces(registry codectypes.InterfaceRegistry) {
	registry.RegisterImplementations((*sdk.Msg)(nil),
		&MsgBeginEpoch{},
		&MsgDkgCommit{},
		&MsgDkgComplaintMissing{},
		&MsgDkgComplaintInvalid{},
		&MsgDkgShareReveal{},
		&MsgFinalizeEpoch{},
		&MsgDkgTimeout{},
		&MsgInitHand{},
		&MsgSubmitShuffle{},
		&MsgFinalizeDeck{},
		&MsgSubmitPubShare{},
		&MsgSubmitEncShare{},
		&MsgFinalizeReveal{},
		&MsgTimeout{},
	)

	msgservice.RegisterMsgServiceDesc(registry, &_Msg_serviceDesc)
}
