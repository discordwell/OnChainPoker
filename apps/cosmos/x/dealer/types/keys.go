package types

import "encoding/binary"

const (
	ModuleName = "dealer"
	StoreKey   = ModuleName
)

var (
	NextEpochIDKey = []byte{0x01} // u64be
	EpochKey       = []byte{0x02} // DealerEpoch
	DKGKey         = []byte{0x03} // DealerDKG

	HandKeyPrefix = []byte{0x10} // HandKeyPrefix || u64be(tableID) || u64be(handID)
)

func HandKey(tableID, handID uint64) []byte {
	bz := make([]byte, 1+8+8)
	bz[0] = HandKeyPrefix[0]
	binary.BigEndian.PutUint64(bz[1:], tableID)
	binary.BigEndian.PutUint64(bz[1+8:], handID)
	return bz
}
