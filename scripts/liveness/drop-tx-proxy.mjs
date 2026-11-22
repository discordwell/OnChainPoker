#!/usr/bin/env node
// A CometBFT RPC proxy that loses chosen transactions, for liveness-repro.sh. It answers a matching
// broadcast_tx_sync as the node would ("accepted") and never passes it on, so the sender sees a
// transaction that no block ever takes. Every other request goes to the node unchanged.
//
//   node drop-tx-proxy.mjs --listen 41990 --upstream http://127.0.0.1:41007 \
//        --type /onchainpoker.dealer.v1.MsgDkgEncryptedShare --field 3=2
//
// --type   the message type url to lose
// --field  N=V: only when the message's protobuf field N (a varint) is V. Optional.
// Prints one line per transaction it loses.

import { createHash } from "node:crypto";
import http from "node:http";
import process from "node:process";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    listen: { type: "string" },
    upstream: { type: "string" },
    type: { type: "string" },
    field: { type: "string" },
  },
});
if (!flags.listen || !flags.upstream || !flags.type) {
  console.error("usage: drop-tx-proxy.mjs --listen PORT --upstream URL --type TYPE_URL [--field N=V]");
  process.exit(2);
}
const [fieldNumber, fieldValue] = (flags.field ?? "").split("=").map(Number);

/** The fields of one protobuf message: [number, varint value or bytes] in wire order. */
function fieldsOf(bytes) {
  const out = [];
  let at = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = bytes[at++];
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
  };
  while (at < bytes.length) {
    const tag = Number(varint());
    const wire = tag & 7;
    if (wire === 0) out.push([tag >> 3, varint()]);
    else if (wire === 2) {
      const length = Number(varint());
      out.push([tag >> 3, bytes.subarray(at, at + length)]);
      at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error(`wire type ${wire}`);
  }
  return out;
}

/** TxRaw.body_bytes (1) -> TxBody.messages (1) -> Any { type_url (1), value (2) }. */
function messagesOf(tx) {
  const body = fieldsOf(tx).find(([n]) => n === 1)[1];
  return fieldsOf(body)
    .filter(([n]) => n === 1)
    .map(([, any]) => {
      const fields = fieldsOf(any);
      return { typeUrl: Buffer.from(fields.find(([n]) => n === 1)[1]).toString(), value: fields.find(([n]) => n === 2)?.[1] ?? new Uint8Array() };
    });
}

function isLost(tx) {
  return messagesOf(tx).some(
    (m) =>
      m.typeUrl === flags.type &&
      (flags.field === undefined || fieldsOf(m.value).some(([n, v]) => n === fieldNumber && typeof v === "bigint" && Number(v) === fieldValue)),
  );
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  let call = null;
  try {
    call = JSON.parse(body.toString());
  } catch {
    // Not JSON-RPC over POST: passed on as it is.
  }
  if (call?.method?.startsWith("broadcast_tx") && typeof call.params?.tx === "string") {
    const tx = Buffer.from(call.params.tx, "base64");
    if (isLost(tx)) {
      const hash = createHash("sha256").update(tx).digest("hex").toUpperCase();
      console.log(`${new Date().toISOString()} lost ${flags.type}${flags.field ? ` (field ${flags.field})` : ""} ${hash}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { code: 0, data: "", log: "", codespace: "", hash } }));
      return;
    }
  }

  try {
    const upstream = await fetch(new URL(req.url, flags.upstream), {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(String(err));
  }
});

server.listen(Number(flags.listen), "127.0.0.1", () => console.log(`listening on 127.0.0.1:${flags.listen} for ${flags.upstream}`));
