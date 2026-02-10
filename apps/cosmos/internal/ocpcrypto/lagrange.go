package ocpcrypto

import "fmt"

// LagrangeAtZero returns the Lagrange coefficients (mod q) for reconstructing f(0)
// from shares (x_i, f(x_i)) where x_i are distinct non-zero field elements.
//
// Coefficient for x_i:
//   λ_i = Π_{j≠i} (0 - x_j) / (x_i - x_j)
func LagrangeAtZero(indices []uint32) ([]Scalar, error) {
	if len(indices) == 0 {
		return nil, fmt.Errorf("lagrange: empty indices")
	}
	// Detect duplicates.
	seen := map[uint32]bool{}
	for _, idx := range indices {
		if idx == 0 {
			return nil, fmt.Errorf("lagrange: index 0 not allowed")
		}
		if seen[idx] {
			return nil, fmt.Errorf("lagrange: duplicate index %d", idx)
		}
		seen[idx] = true
	}

	lambdas := make([]Scalar, 0, len(indices))
	for _, xiU := range indices {
		xi := ScalarFromUint64(uint64(xiU))
		num := ScalarFromUint64(1)
		den := ScalarFromUint64(1)
		for _, xjU := range indices {
			if xjU == xiU {
				continue
			}
			xj := ScalarFromUint64(uint64(xjU))
			num = ScalarMul(num, ScalarNeg(xj))        // (0 - xj)
			den = ScalarMul(den, ScalarSub(xi, xj))    // (xi - xj)
		}
		denInv, err := ScalarInv(den)
		if err != nil {
			return nil, err
		}
		lambdas = append(lambdas, ScalarMul(num, denInv))
	}
	return lambdas, nil
}

