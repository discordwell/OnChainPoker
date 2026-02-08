import type { RpcTransport } from "../client.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
};

type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: number | string | null;
  error: JsonRpcErrorObject;
};

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export class JsonRpcTransport implements RpcTransport {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly fetchFn: typeof fetch;

  private nextId = 1;

  constructor(args: { url: string; headers?: Record<string, string>; fetchFn?: typeof fetch }) {
    this.url = args.url;
    this.headers = { "content-type": "application/json", ...(args.headers ?? {}) };
    this.fetchFn = args.fetchFn ?? fetch;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(req)
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`JSON-RPC HTTP ${res.status}: ${text || res.statusText}`);
    }

    const json = (await res.json()) as JsonRpcResponse;
    const rid = (json as any)?.id;
    if (!json || json.jsonrpc !== "2.0" || (rid !== id && rid !== String(id))) {
      throw new Error(`invalid JSON-RPC response (id mismatch)`);
    }

    if ("error" in json) {
      const { code, message, data } = json.error;
      const extra = data == null ? "" : ` (${safeJson(data)})`;
      throw new Error(`JSON-RPC error ${code}: ${message}${extra}`);
    }

    return json.result as T;
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
