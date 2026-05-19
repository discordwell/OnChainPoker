// Client-side password digest helpers.
//
// The on-chain v2 password flow keeps plaintext local: the client computes
// SHA256(salt || password) before broadcast, the chain compares byte-equal.
// Legacy tables ship with empty salt; SHA256(empty || password) reduces to
// the unsalted hash on-chain so they still authenticate.

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function sha256(input: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(hash);
}

// computePasswordProof builds the 32-byte commitment a client sends in MsgSit.
// `saltB64` is the table's params.password_salt as the LCD returns it
// (base64-encoded bytes). For pre-v2 legacy tables it is empty.
export async function computePasswordProof(saltB64: string | undefined, password: string): Promise<Uint8Array> {
  const salt = saltB64 ? base64Decode(saltB64) : new Uint8Array(0);
  const pw = new TextEncoder().encode(password);
  return sha256(concat(salt, pw));
}

// generatePasswordCommitment builds a fresh (salt, commitment) pair for
// MsgCreateTable. Returns 32 random salt bytes + the SHA256 commitment.
export async function generatePasswordCommitment(password: string): Promise<{ salt: Uint8Array; commitment: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const pw = new TextEncoder().encode(password);
  const commitment = await sha256(concat(salt, pw));
  return { salt, commitment };
}
