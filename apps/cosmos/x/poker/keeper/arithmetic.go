package keeper

import "fmt"

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
