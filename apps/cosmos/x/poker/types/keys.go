package types

import "encoding/binary"

const (
	// ModuleName defines the module name.
	ModuleName = "poker"

	// StoreKey defines the primary module store key.
	StoreKey = ModuleName
)

var (
	// NextTableIDKey stores the next table id as big-endian u64.
	NextTableIDKey = []byte{0x01}

	// TableKeyPrefix stores Table by id: TableKeyPrefix || u64be(tableID).
	TableKeyPrefix = []byte{0x02}
)

func TableKey(tableID uint64) []byte {
	bz := make([]byte, 1+8)
	bz[0] = TableKeyPrefix[0]
	binary.BigEndian.PutUint64(bz[1:], tableID)
	return bz
}

