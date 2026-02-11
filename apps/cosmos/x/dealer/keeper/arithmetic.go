package keeper

import (
	"fmt"
	"math"
)

func addInt64AndU64Checked(base int64, delta uint64, field string) (int64, error) {
	if delta > uint64(math.MaxInt64) {
		return 0, fmt.Errorf("%s overflows int64", field)
	}
	d := int64(delta)
	if base > math.MaxInt64-d {
		return 0, fmt.Errorf("%s overflows int64", field)
	}
	return base + d, nil
}
