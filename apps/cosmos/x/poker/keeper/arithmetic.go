package keeper

import (
	"fmt"
	"math"
)

func addUint64Checked(a uint64, b uint64, field string) (uint64, error) {
	if a > ^uint64(0)-b {
		return 0, fmt.Errorf("%s overflows uint64", field)
	}
	return a + b, nil
}

func mulUint64Checked(a uint64, b uint64, field string) (uint64, error) {
	if a == 0 || b == 0 {
		return 0, nil
	}
	if a > ^uint64(0)/b {
		return 0, fmt.Errorf("%s overflows uint64", field)
	}
	return a * b, nil
}

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
