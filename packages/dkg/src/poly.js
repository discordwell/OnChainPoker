import { addMod, invMod, mod, mulMod, subMod } from "./math.js";

export function evalPoly(coeffs, x, q) {
  // Horner: (((a_{t-1} x + a_{t-2}) x + ...) x + a_0)
  let acc = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    acc = addMod(mulMod(acc, x, q), coeffs[i], q);
  }
  return acc;
}

export function lagrangeInterpolateAt0(points, q) {
  // points: [{x, y}], with distinct nonzero x values (in Z_q)
  let secret = 0n;
  for (let i = 0; i < points.length; i++) {
    const xi = mod(points[i].x, q);
    const yi = mod(points[i].y, q);
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const xj = mod(points[j].x, q);
      num = mulMod(num, subMod(0n, xj, q), q); // (0 - xj)
      den = mulMod(den, subMod(xi, xj, q), q); // (xi - xj)
    }
    const li0 = mulMod(num, invMod(den, q), q);
    secret = addMod(secret, mulMod(yi, li0, q), q);
  }
  return secret;
}

