import { describe, expect, it } from "vitest";
import {
  uint8ToBase64,
  base64ToUint8,
  formatTimestamp,
  formatRelative,
  errorMessage,
  statusTone,
  prettyJson,
  wsTone,
  defaultSeatForm,
  defaultPlayerSeatForm,
  defaultPlayerActionForm,
  defaultCreateTableForm,
} from "./utils";

describe("uint8ToBase64 / base64ToUint8 roundtrip", () => {
  it("roundtrips arbitrary bytes", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const encoded = uint8ToBase64(original);
    const decoded = base64ToUint8(encoded);
    expect(decoded).toEqual(original);
  });

  it("encoding an empty array produces empty base64 which decodes to null (falsy check)", () => {
    const original = new Uint8Array([]);
    const encoded = uint8ToBase64(original);
    // btoa("") === "" which is falsy, so base64ToUint8 returns null
    expect(encoded).toBe("");
    expect(base64ToUint8(encoded)).toBeNull();
  });

  it("roundtrips a 64-byte key", () => {
    const original = new Uint8Array(64);
    for (let i = 0; i < 64; i++) original[i] = i;
    const encoded = uint8ToBase64(original);
    const decoded = base64ToUint8(encoded);
    expect(decoded).toEqual(original);
  });
});

describe("base64ToUint8 edge cases", () => {
  it("returns null for null input", () => {
    expect(base64ToUint8(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(base64ToUint8("")).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(base64ToUint8("not!valid!base64!!!")).toBeNull();
  });
});

describe("formatTimestamp", () => {
  it("returns dash for undefined", () => {
    expect(formatTimestamp(undefined)).toBe("-");
  });

  it("returns dash for 0", () => {
    expect(formatTimestamp(0)).toBe("-");
  });

  it("returns dash for NaN", () => {
    expect(formatTimestamp(NaN)).toBe("-");
  });

  it("returns a date string for valid ms", () => {
    const result = formatTimestamp(1700000000000);
    expect(result).not.toBe("-");
    expect(result.length).toBeGreaterThan(5);
  });
});

describe("formatRelative", () => {
  it("returns dash for undefined", () => {
    expect(formatRelative(undefined)).toBe("-");
  });

  it("returns 'now' for very recent timestamps", () => {
    expect(formatRelative(Date.now())).toBe("now");
  });

  it("returns seconds for near-future", () => {
    const result = formatRelative(Date.now() + 30_000);
    expect(result).toMatch(/\d+s left/);
  });

  it("returns seconds ago for near-past", () => {
    const result = formatRelative(Date.now() - 30_000);
    expect(result).toMatch(/\d+s ago/);
  });

  it("returns minutes for far-future", () => {
    const result = formatRelative(Date.now() + 120_000);
    expect(result).toMatch(/\d+m left/);
  });
});

describe("errorMessage", () => {
  it("extracts message from Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns fallback for non-Error", () => {
    expect(errorMessage("string")).toBe("Unexpected error");
    expect(errorMessage(42)).toBe("Unexpected error");
    expect(errorMessage(null)).toBe("Unexpected error");
  });
});

describe("statusTone", () => {
  it("maps statuses to CSS classes", () => {
    expect(statusTone("in_hand")).toBe("status-live");
    expect(statusTone("closed")).toBe("status-closed");
    expect(statusTone("open")).toBe("status-open");
  });
});

describe("wsTone", () => {
  it("maps WS statuses to CSS classes", () => {
    expect(wsTone("open")).toBe("status-open");
    expect(wsTone("error")).toBe("status-closed");
    expect(wsTone("connecting")).toBe("status-live");
    expect(wsTone("closed")).toBe("status-muted");
  });
});

describe("prettyJson", () => {
  it("formats objects with indentation", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("handles null", () => {
    expect(prettyJson(null)).toBe("null");
  });
});

describe("default form factories", () => {
  it("defaultSeatForm returns fresh object", () => {
    const a = defaultSeatForm();
    const b = defaultSeatForm();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.seat).toBe("0");
  });

  it("defaultPlayerSeatForm returns empty fields", () => {
    const f = defaultPlayerSeatForm();
    expect(f.buyIn).toBe("");
    expect(f.password).toBe("");
  });

  it("defaultPlayerActionForm defaults to check", () => {
    const f = defaultPlayerActionForm();
    expect(f.action).toBe("check");
    expect(f.amount).toBe("");
  });

  it("defaultCreateTableForm has sensible defaults", () => {
    const f = defaultCreateTableForm();
    expect(f.smallBlind).toBe("1");
    expect(f.bigBlind).toBe("2");
    expect(f.maxPlayers).toBe("9");
    expect(f.password).toBe("");
  });
});
