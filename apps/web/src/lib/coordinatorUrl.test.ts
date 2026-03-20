import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { normalizeCoordinatorBase, toWsUrl } from "./coordinatorUrl";

// These functions use `window.location.origin` and `new URL(input, window.location.origin)`.
// In Node test environment, we need to mock window.
const MOCK_ORIGIN = "http://localhost:3000";

beforeEach(() => {
  // @ts-expect-error -- mock window for Node test env
  globalThis.window = {
    location: { origin: MOCK_ORIGIN, href: MOCK_ORIGIN },
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  };
});

afterEach(() => {
  // @ts-expect-error -- cleanup
  delete globalThis.window;
});

describe("normalizeCoordinatorBase", () => {
  it("trims trailing slashes from absolute URLs", () => {
    const result = normalizeCoordinatorBase("http://example.com:8788///");
    expect(result).toBe("http://example.com:8788");
  });

  it("returns default for empty input", () => {
    const result = normalizeCoordinatorBase("");
    expect(result).toMatch(/^http/);
    expect(result).not.toMatch(/\/$/);
  });

  it("returns default for whitespace-only input", () => {
    const result = normalizeCoordinatorBase("   ");
    expect(result).toMatch(/^http/);
  });

  it("resolves relative paths against window.location.origin", () => {
    const result = normalizeCoordinatorBase("/ocp/api");
    expect(result).toBe(`${MOCK_ORIGIN}/ocp/api`);
  });

  it("preserves absolute URLs", () => {
    const result = normalizeCoordinatorBase("https://my-server.com:9999/api");
    expect(result).toBe("https://my-server.com:9999/api");
  });
});

describe("normalizeCoordinatorBase rejects dangerous schemes", () => {
  it("falls back to default for javascript: URLs", () => {
    const result = normalizeCoordinatorBase("javascript:alert(1)");
    // normalizeCoordinatorBase resolves against window.location.origin,
    // so javascript: becomes a path — verify it doesn't produce a javascript: URL
    expect(result).not.toMatch(/^javascript:/i);
    expect(result).toMatch(/^http/);
  });

  it("falls back to default for data: URLs", () => {
    const result = normalizeCoordinatorBase("data:text/html,<h1>hi</h1>");
    expect(result).not.toMatch(/^data:/i);
    expect(result).toMatch(/^http/);
  });
});

describe("toWsUrl", () => {
  it("converts http to ws and appends /ws", () => {
    const result = toWsUrl("http://127.0.0.1:8788");
    expect(result).toBe("ws://127.0.0.1:8788/ws");
  });

  it("converts https to wss", () => {
    const result = toWsUrl("https://example.com/api");
    expect(result).toBe("wss://example.com/api/ws");
  });

  it("strips trailing slashes before appending /ws", () => {
    const result = toWsUrl("http://localhost:8788/");
    expect(result).toBe("ws://localhost:8788/ws");
  });

  it("strips query and hash", () => {
    const result = toWsUrl("http://localhost:8788?foo=bar#baz");
    expect(result).not.toContain("?");
    expect(result).not.toContain("#");
    expect(result).toMatch(/\/ws$/);
  });
});
