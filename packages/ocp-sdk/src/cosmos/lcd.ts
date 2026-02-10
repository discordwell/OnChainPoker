export class CosmosLcdClient {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly fetchFn: typeof fetch;

  constructor(args: { baseUrl: string; headers?: Record<string, string>; fetchFn?: typeof fetch }) {
    this.baseUrl = args.baseUrl;
    this.headers = { ...(args.headers ?? {}) };
    this.fetchFn = args.fetchFn ?? fetch;
  }

  async getJson<T>(path: string): Promise<T> {
    const url = joinUrl(this.baseUrl, path);
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LCD HTTP ${res.status}: ${text || res.statusText}`);
    }
    return (await res.json()) as T;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const u = new URL(baseUrl);
  const basePath = u.pathname.replace(/\/+$/, "");
  const rel = String(path ?? "").trim();
  if (!rel.startsWith("/")) throw new Error(`LCD path must start with '/': ${rel}`);
  u.pathname = `${basePath}${rel}`;
  return u.toString();
}

