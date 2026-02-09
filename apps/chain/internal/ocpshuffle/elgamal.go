package ocpshuffle

import "onchainpoker/apps/chain/internal/ocpcrypto"

func elgamalReencrypt(pk ocpcrypto.Point, ct ocpcrypto.ElGamalCiphertext, rho ocpcrypto.Scalar) ocpcrypto.ElGamalCiphertext {
	return ocpcrypto.ElGamalCiphertext{
		C1: ocpcrypto.PointAdd(ct.C1, ocpcrypto.MulBase(rho)),
		C2: ocpcrypto.PointAdd(ct.C2, ocpcrypto.MulPoint(pk, rho)),
	}
}

