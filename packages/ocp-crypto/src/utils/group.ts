import { RistrettoPoint } from "@noble/curves/ed25519";
import { GROUP_ELEMENT_BYTES } from "./bytes.js";
import type { Scalar } from "./scalar.js";

export class GroupElement {
  // We intentionally keep this as `any` to avoid leaking noble's private-point type into
  // our public .d.ts surface area.
  private readonly p: any;

  private constructor(p: any) {
    this.p = p;
  }

  static fromBytes(bytes: Uint8Array): GroupElement {
    if (!(bytes instanceof Uint8Array) || bytes.length !== GROUP_ELEMENT_BYTES) {
      throw new Error("GroupElement.fromBytes: expected 32 bytes");
    }
    const p = RistrettoPoint.fromHex(bytes);
    // Defensive: ensure encoding is canonical (round-trip check).
    const rt = p.toRawBytes();
    for (let i = 0; i < bytes.length; i++) {
      if (rt[i] !== bytes[i]) throw new Error("GroupElement.fromBytes: non-canonical");
    }
    return new GroupElement(p);
  }

  static base(): GroupElement {
    return new GroupElement(RistrettoPoint.BASE);
  }

  static zero(): GroupElement {
    return new GroupElement(RistrettoPoint.ZERO);
  }

  toBytes(): Uint8Array {
    return this.p.toRawBytes();
  }

  equals(other: GroupElement): boolean {
    return this.p.equals(other.p);
  }

  add(other: GroupElement): GroupElement {
    return new GroupElement(this.p.add(other.p));
  }

  subtract(other: GroupElement): GroupElement {
    return new GroupElement(this.p.subtract(other.p));
  }

  multiply(scalar: Scalar): GroupElement {
    return new GroupElement(this.p.multiply(scalar));
  }
}

export function groupElementFromBytes(bytes: Uint8Array): GroupElement {
  return GroupElement.fromBytes(bytes);
}

export function groupElementToBytes(p: GroupElement): Uint8Array {
  return p.toBytes();
}

export function isGroupElementBytes(bytes: Uint8Array): boolean {
  return bytes instanceof Uint8Array && bytes.length === GROUP_ELEMENT_BYTES;
}

export function basePoint(): GroupElement {
  return GroupElement.base();
}

export function pointAdd(a: GroupElement, b: GroupElement): GroupElement {
  return a.add(b);
}

export function pointSub(a: GroupElement, b: GroupElement): GroupElement {
  return a.subtract(b);
}

export function mulBase(k: Scalar): GroupElement {
  return GroupElement.base().multiply(k);
}

export function mulPoint(p: GroupElement, k: Scalar): GroupElement {
  return p.multiply(k);
}

export function pointEq(a: GroupElement, b: GroupElement): boolean {
  return a.equals(b);
}

