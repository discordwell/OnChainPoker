// Codec registration for the randomness-beacon messages.
//
//	cd apps/cosmos/proto && buf generate
//
// then drop the build tag.
package types

import (
	"github.com/cosmos/cosmos-sdk/codec"
	"github.com/cosmos/cosmos-sdk/codec/legacy"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

// RegisterBeaconAminoCodec registers amino names for the beacon messages.
// Intended to be called from RegisterLegacyAminoCodec after regen.
func RegisterBeaconAminoCodec(cdc *codec.LegacyAmino) {
	legacy.RegisterAminoMsg(cdc, &MsgBeaconCommit{}, "ocp/dealer/BeaconCommit")
	legacy.RegisterAminoMsg(cdc, &MsgBeaconReveal{}, "ocp/dealer/BeaconReveal")
}

// RegisterBeaconInterfaces registers the protobuf Msg interface implementations
// for the beacon messages. Intended to be called from RegisterInterfaces.
func RegisterBeaconInterfaces(registry codectypes.InterfaceRegistry) {
	registry.RegisterImplementations((*sdk.Msg)(nil),
		&MsgBeaconCommit{},
		&MsgBeaconReveal{},
	)
}
