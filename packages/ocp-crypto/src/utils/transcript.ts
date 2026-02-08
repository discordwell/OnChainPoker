import { sha512 } from "@noble/hashes/sha512";
import { u32le, utf8 } from "./bytes.js";
import { scalarFromBytesModOrder } from "./scalar.js";
import type { Scalar } from "./scalar.js";

const TRANSCRIPT_PREFIX = utf8("OCPv1|transcript|");

type HashState = ReturnType<typeof sha512.create>;

function updateLenBytes(h: HashState, bytes: Uint8Array): void {
  h.update(u32le(bytes.length));
  h.update(bytes);
}

export class Transcript {
  private h: HashState;

  constructor(domainSep: string) {
    this.h = sha512.create();
    this.h.update(TRANSCRIPT_PREFIX);
    updateLenBytes(this.h, utf8(domainSep));
  }

  appendMessage(label: string, msg: Uint8Array): void {
    const l = utf8(label);
    this.h.update(utf8("msg"));
    updateLenBytes(this.h, l);
    updateLenBytes(this.h, msg);
  }

  challengeScalar(label: string): Scalar {
    const l = utf8(label);
    const c = this.h.clone();
    c.update(utf8("challenge"));
    updateLenBytes(c, l);
    const digest = c.digest();
    return scalarFromBytesModOrder(digest);
  }
}
