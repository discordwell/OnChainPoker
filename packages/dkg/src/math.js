export function mod(a, m) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

export function addMod(a, b, m) {
  return mod(a + b, m);
}

export function subMod(a, b, m) {
  return mod(a - b, m);
}

export function mulMod(a, b, m) {
  return mod(a * b, m);
}

export function powMod(base, exp, m) {
  if (exp < 0n) throw new Error("powMod: negative exponent");
  let r = 1n % m;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

export function egcd(a, b) {
  let oldR = a;
  let r = b;
  let oldS = 1n;
  let s = 0n;
  let oldT = 0n;
  let t = 1n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  return { g: oldR, x: oldS, y: oldT };
}

export function invMod(a, m) {
  const { g, x } = egcd(mod(a, m), m);
  if (g !== 1n) throw new Error("invMod: not invertible");
  return mod(x, m);
}

