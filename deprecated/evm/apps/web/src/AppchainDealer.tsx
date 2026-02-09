import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CURVE_ORDER,
  bytesToHex,
  groupElementFromBytes,
  groupElementToBytes,
  hexToBytes,
  mulBase,
  mulPoint,
  pointAdd,
  pointEq,
  pointSub,
  scalarFromBytes,
  scalarFromBytesModOrder,
  scalarToBytes,
} from "@onchainpoker/ocp-crypto";

type TableInfo = {
  tableId: string;
  params: { maxPlayers: number; smallBlind: string; bigBlind: string; minBuyIn: string; maxBuyIn: string };
  status: string;
  updatedAtMs: number;
};

type V0DealerEpoch = {
  epochId: number;
  threshold: number;
  members: Array<{ validatorId: string; index: number }>;
};

type DealerNext =
  | { kind: "none"; reason?: string }
  | { kind: "shuffle"; shuffleStep: number; nextRound: number; suggestedShuffler: string | null; canFinalize: boolean }
  | { kind: "reveal"; pos: number; havePubShares: number; threshold: number | null; missingValidatorIds: string[] | null };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(String(b64 ?? ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function modQ(x: bigint): bigint {
  const r = x % CURVE_ORDER;
  return r >= 0n ? r : r + CURVE_ORDER;
}

function invQ(a: bigint): bigint {
  // Extended Euclid modulo CURVE_ORDER.
  let t = 0n;
  let newT = 1n;
  let r = CURVE_ORDER;
  let newR = modQ(a);
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r !== 1n) throw new Error("not invertible");
  return t < 0n ? t + CURVE_ORDER : t;
}

function lagrangeAtZero(idxs: bigint[]): bigint[] {
  // idxs: distinct non-zero Shamir x-coordinates.
  return idxs.map((xi, i) => {
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < idxs.length; j++) {
      if (i === j) continue;
      const xj = idxs[j]!;
      num = modQ(num * modQ(-xj));
      den = modQ(den * modQ(xi - xj));
    }
    return modQ(num * invQ(den));
  });
}

function cardToString(id: number): string {
  const c = Number(id);
  const r = (c % 13) + 2;
  const s = Math.floor(c / 13);
  const rch = r === 14 ? "A" : r === 13 ? "K" : r === 12 ? "Q" : r === 11 ? "J" : r === 10 ? "T" : String(r);
  const sch = s === 0 ? "c" : s === 1 ? "d" : s === 2 ? "h" : "s";
  return `${rch}${sch}`;
}

function findCardIdFromPoint(pt: ReturnType<typeof groupElementFromBytes>, deckSize = 52): number | null {
  for (let c = 0; c < deckSize; c++) {
    const want = mulBase(BigInt(c + 1));
    if (pointEq(pt, want)) return c;
  }
  return null;
}

function normalizeUrl(u: string): string {
  return String(u ?? "").trim().replace(/\/+$/, "");
}

function toWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export function AppchainDealerDemo() {
  const [coordUrl, setCoordUrl] = useState<string>(() => localStorage.getItem("ocp_coord_url") ?? "http://127.0.0.1:8788");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tableId, setTableId] = useState<string>("");

  const [epoch, setEpoch] = useState<V0DealerEpoch | null>(null);
  const [tableView, setTableView] = useState<any | null>(null);
  const [dealerNext, setDealerNext] = useState<DealerNext | null>(null);

  const [seat, setSeat] = useState<number>(0);
  const [skHex, setSkHex] = useState<string>("");
  const [pkB64, setPkB64] = useState<string>("");

  const [holeOut, setHoleOut] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);

  const baseUrl = useMemo(() => normalizeUrl(coordUrl), [coordUrl]);

  useEffect(() => {
    localStorage.setItem("ocp_coord_url", baseUrl);
  }, [baseUrl]);

  const refreshTables = useCallback(async () => {
    setError("");
    const res = await fetch(`${baseUrl}/v1/tables`);
    if (!res.ok) throw new Error(`coordinator /v1/tables failed (${res.status})`);
    const json = (await res.json()) as any;
    setTables(Array.isArray(json?.tables) ? (json.tables as TableInfo[]) : []);
  }, [baseUrl]);

  const loadEpoch = useCallback(async () => {
    const res = await fetch(`${baseUrl}/v1/appchain/v0/dealer/epoch`);
    if (!res.ok) {
      setEpoch(null);
      return;
    }
    const json = (await res.json()) as any;
    setEpoch(json?.epoch ?? null);
  }, [baseUrl]);

  const loadTableView = useCallback(async () => {
    if (!tableId) return;
    const res = await fetch(`${baseUrl}/v1/appchain/v0/tables/${encodeURIComponent(tableId)}`);
    if (!res.ok) throw new Error(`table view failed (${res.status})`);
    const json = (await res.json()) as any;
    setTableView(json?.table ?? null);
  }, [baseUrl, tableId]);

  const loadDealerNext = useCallback(async () => {
    if (!tableId) return;
    const res = await fetch(`${baseUrl}/v1/appchain/v0/tables/${encodeURIComponent(tableId)}/dealer/next`);
    if (!res.ok) {
      setDealerNext(null);
      return;
    }
    const json = (await res.json()) as any;
    setDealerNext(json?.action ?? null);
  }, [baseUrl, tableId]);

  const refreshAll = useCallback(async () => {
    try {
      setStatus("Refreshing from coordinator...");
      await Promise.all([refreshTables(), loadEpoch(), loadTableView(), loadDealerNext()]);
      setStatus("");
    } catch (e: any) {
      setStatus("");
      setError(e?.message ?? String(e));
    }
  }, [refreshTables, loadEpoch, loadTableView, loadDealerNext]);

  // Best-effort WS subscription: refresh the table view on new chain events for this table.
  useEffect(() => {
    const tid = tableId.trim();
    if (!tid) return;

    let closed = false;
    let wsUrl: string;
    try {
      wsUrl = toWsUrl(baseUrl) + "/ws";
    } catch {
      return;
    }
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", topic: "table", tableId: tid }));
    });

    ws.addEventListener("message", (ev) => {
      if (closed) return;
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg?.type !== "event") return;
      if (String(msg?.event?.tableId ?? "") !== tid) return;
      void loadTableView().catch(() => {});
      void loadDealerNext().catch(() => {});
    });

    ws.addEventListener("error", () => {});

    return () => {
      closed = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [baseUrl, tableId, loadTableView, loadDealerNext]);

  const derivePk = useCallback(
    (sk: bigint) => {
      const pk = mulBase(sk);
      return bytesToB64(groupElementToBytes(pk));
    },
    []
  );

  const generateKeys = useCallback(() => {
    setError("");
    setHoleOut("");
    for (let tries = 0; tries < 16; tries++) {
      const buf = new Uint8Array(64);
      crypto.getRandomValues(buf);
      const sk = scalarFromBytesModOrder(buf);
      if (sk === 0n) continue;
      const skBytes = scalarToBytes(sk);
      const skH = bytesToHex(skBytes);
      setSkHex(skH);
      const pk = derivePk(sk);
      setPkB64(pk);
      return;
    }
    setError("failed to generate non-zero scalar");
  }, [derivePk]);

  const onSkChanged = useCallback(
    (raw: string) => {
      setSkHex(raw);
      setHoleOut("");
      setError("");
      const norm = raw.trim();
      if (norm.length === 0) {
        setPkB64("");
        return;
      }
      try {
        const bytes = hexToBytes(norm);
        const sk = scalarFromBytes(bytes);
        setPkB64(derivePk(sk));
      } catch {
        setPkB64("");
      }
    },
    [derivePk]
  );

  const decryptHoleCards = useCallback(async () => {
    try {
      setError("");
      setHoleOut("");
      if (!tableView) throw new Error("load a table first");
      if (!epoch) throw new Error("no active dealer epoch (chain missing /dealer/epoch?)");
      const threshold = Number(epoch.threshold ?? 0);
      if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("invalid epoch.threshold");

      const bytes = hexToBytes(skHex.trim());
      const sk = scalarFromBytes(bytes);
      const pk = derivePk(sk);

      const t = tableView;
      const h = t?.hand;
      const dh = h?.dealer;
      if (!h || !dh) throw new Error("table has no active dealer hand");
      if (!dh.finalized) throw new Error("deck not finalized yet");

      const holePos: unknown = dh.holePos;
      if (!Array.isArray(holePos) || holePos.length !== 18) throw new Error("missing dealer.holePos");
      const pos0 = Number(holePos[seat * 2 + 0] ?? 255);
      const pos1 = Number(holePos[seat * 2 + 1] ?? 255);
      if (!Number.isFinite(pos0) || pos0 === 255) throw new Error("hole pos0 not assigned");
      if (!Number.isFinite(pos1) || pos1 === 255) throw new Error("hole pos1 not assigned");

      const deck = Array.isArray(dh.deck) ? dh.deck : [];
      const deckSize = Number(dh.deckSize ?? 52);
      const encSharesAll = Array.isArray(dh.encShares) ? dh.encShares : [];

      const recoverOne = (pos: number): number => {
        const ct = deck[pos];
        if (!ct) throw new Error(`missing ciphertext at pos=${pos}`);
        const c2 = groupElementFromBytes(b64ToBytes(String(ct.c2 ?? "")));

        const sharesForPos = encSharesAll
          .filter((es: any) => Number(es?.pos) === pos && String(es?.pkPlayer ?? "") === pk)
          .sort(
            (a: any, b: any) =>
              Number(a?.index ?? 0) - Number(b?.index ?? 0) || String(a?.validatorId ?? "").localeCompare(String(b?.validatorId ?? ""))
          )
          .slice(0, threshold);
        if (sharesForPos.length < threshold) throw new Error(`insufficient encShares for pos=${pos}: have ${sharesForPos.length}, need ${threshold}`);

        const idxs = sharesForPos.map((s: any) => BigInt(Number(s.index)));
        const lambdas = lagrangeAtZero(idxs);

        let combined = mulBase(0n); // zero
        for (let i = 0; i < sharesForPos.length; i++) {
          const es = sharesForPos[i]!;
          const enc = b64ToBytes(String(es.encShare ?? ""));
          const u = groupElementFromBytes(enc.slice(0, 32));
          const v = groupElementFromBytes(enc.slice(32, 64));
          const di = pointSub(v, mulPoint(u, sk));
          combined = pointAdd(combined, mulPoint(di, lambdas[i]!));
        }

        const pt = pointSub(c2, combined);
        const cardId = findCardIdFromPoint(pt, deckSize);
        if (cardId == null) throw new Error(`failed to map plaintext to card id for pos=${pos}`);
        return cardId;
      };

      setStatus("Decrypting hole cards locally...");
      const c0 = recoverOne(pos0);
      const c1 = recoverOne(pos1);
      setStatus("");
      setHoleOut(`${cardToString(c0)} ${cardToString(c1)} (seat=${seat})`);
    } catch (e: any) {
      setStatus("");
      setError(e?.message ?? String(e));
    }
  }, [tableView, epoch, seat, skHex, derivePk]);

  const phase = String(tableView?.hand?.phase ?? "");
  const handId = tableView?.hand?.handId ?? "";
  const board = Array.isArray(tableView?.hand?.board) ? (tableView.hand.board as any[]) : [];
  const boardStr = board.map((c) => (typeof c === "number" ? cardToString(c) : "??")).join(" ");

  return (
    <div className="card animateIn" style={{ marginTop: 14 }}>
      <div className="cardHeader">
        <h2>Appchain Dealer Mode (v0)</h2>
        <div className="hint">Coordinator-assisted queries; hole cards decrypted in-browser from encShares.</div>
      </div>

      <div className="field">
        <label>Coordinator URL</label>
        <div className="row">
          <input value={coordUrl} onChange={(e) => setCoordUrl(e.target.value)} placeholder="http://127.0.0.1:8788" />
          <button className="btn" onClick={() => void refreshAll()}>
            Refresh
          </button>
        </div>
      </div>

      <div className="field">
        <label>Table</label>
        <div className="row">
          <input value={tableId} onChange={(e) => setTableId(e.target.value)} placeholder="e.g. 1" />
          <button className="btn" onClick={() => void refreshTables().catch((e: any) => setError(e?.message ?? String(e)))}>
            List Tables
          </button>
          <button
            className="btn btnPrimary"
            onClick={() =>
              void Promise.all([loadTableView(), loadDealerNext()]).catch((e: any) => setError(e?.message ?? String(e)))
            }
            disabled={!tableId}
          >
            Load Table
          </button>
        </div>
        {tables.length ? (
          <div className="hint" style={{ marginTop: 8 }}>
            Known tables:{" "}
            {tables.map((t) => (
              <span key={t.tableId} className="pill" style={{ marginRight: 8 }}>
                {t.tableId}:{t.status}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {tableView ? (
        <div className="kv">
          <div>hand</div>
          <div>{handId ? String(handId) : "(none)"}</div>
          <div>phase</div>
          <div>{phase || "(none)"}</div>
          <div>board</div>
          <div>{boardStr || "(empty)"}</div>
        </div>
      ) : (
        <div className="hint">Load a table to see dealer-mode state and decrypt hole cards.</div>
      )}

      {dealerNext ? (
        <div className="kv" style={{ marginTop: 10 }}>
          <div>next</div>
          <div className="mono">{dealerNext.kind}</div>
          {dealerNext.kind === "shuffle" ? (
            <>
              <div>round</div>
              <div className="mono">
                {dealerNext.nextRound} (step={dealerNext.shuffleStep})
              </div>
              <div>who</div>
              <div className="mono">{dealerNext.suggestedShuffler ?? "(any committee member)"}</div>
            </>
          ) : null}
          {dealerNext.kind === "reveal" ? (
            <>
              <div>pos</div>
              <div className="mono">{dealerNext.pos}</div>
              <div>shares</div>
              <div className="mono">
                {dealerNext.havePubShares}/{dealerNext.threshold ?? "?"}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="field" style={{ marginTop: 14 }}>
        <label>Player Key (for local decryption)</label>
        <div className="row">
          <input
            value={String(seat)}
            onChange={(e) => setSeat(Math.max(0, Math.min(8, Number(e.target.value))))}
            placeholder="seat 0..8"
            style={{ maxWidth: 120 }}
          />
          <button className="btn" onClick={generateKeys}>
            Generate Keypair
          </button>
          <button className="btn btnPrimary" onClick={() => void decryptHoleCards()} disabled={!tableView || !epoch || !skHex}>
            Decrypt Hole Cards
          </button>
        </div>
        <div className="field">
          <label>sk (hex, 32-byte little-endian scalar)</label>
          <input value={skHex} onChange={(e) => onSkChanged(e.target.value)} placeholder="0x…" />
        </div>
        <div className="field">
          <label>pk (base64, derived)</label>
          <input value={pkB64} readOnly placeholder="(derived from sk)" />
        </div>
        {holeOut ? (
          <p className="hint" style={{ marginTop: 8 }}>
            <span className="ok">hole</span>: <span className="mono">{holeOut}</span>
          </p>
        ) : null}
      </div>

      {status ? (
        <p className="hint" style={{ marginTop: 10 }}>
          <span className="ok">status</span>: <span className="mono">{status}</span>
        </p>
      ) : null}
      {error ? (
        <p className="hint" style={{ marginTop: 10 }}>
          <span className="danger">error</span>: <span className="mono">{error}</span>
        </p>
      ) : null}
    </div>
  );
}
