/**
 * A minimal MCP client for streamable-HTTP servers, and the guard that decides
 * which of their tools this codebase is allowed to invoke.
 *
 * THIS FILE MUST STAY REACT-NATIVE SAFE. It lives in packages/core, which Metro
 * aliases straight into the phone app (mobile/metro.config.js:28), so it may use
 * nothing but `fetch` and standard JS. No `node:` imports, no Buffer. The
 * loopback redirect catcher that the desktop worker needs is deliberately NOT
 * here for exactly that reason — it is node-only and lives in the worker.
 *
 * Why hand-rolled rather than @modelcontextprotocol/sdk: merrymen ships as an
 * npm package and is bundled into a phone app, so every dependency is a
 * decision, and the wire format here is about sixty lines. The framing has one
 * genuine trap (below) that a wrapper would hide rather than remove.
 */

/** JSON-RPC id counter is per-client, so two clients never collide. */
export interface McpClientOptions {
  url: string;
  /** OAuth bearer. Never logged — see redactSecrets on the worker side. */
  token: string;
  /**
   * Tools this client may invoke even though they look mutating. Empty by
   * default, which is the point: a client is read-only unless someone opts in
   * to specific names at the call site, in code, on purpose.
   */
  allowMutating?: readonly string[];
  protocolVersion?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Tools that place, cancel, or move something.
 *
 * A verb-prefix pattern rather than a fixed list, so the day Robinhood ships
 * options/crypto/futures — `place_crypto_order`, `cancel_options_order` — they
 * are refused on arrival instead of waiting for someone to remember to add
 * them. `review_*` is deliberately NOT matched: reviewing is the dry run, and
 * it is the half of the propose/dispose pair that must stay callable.
 */
const MUTATING = /^(place|submit|create|cancel|replace|modify|delete|transfer|withdraw|deposit|move|sell|buy|execute|approve)_/i;

export function isMutatingTool(name: string): boolean {
  return MUTATING.test(name);
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export class McpClient {
  private session: string | null = null;
  private id = 0;
  private readonly fetch: typeof fetch;
  private readonly allowMutating: ReadonlySet<string>;

  constructor(private readonly opts: McpClientOptions) {
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
    this.allowMutating = new Set(opts.allowMutating ?? []);
  }

  /**
   * One JSON-RPC round trip.
   *
   * THE FRAMING TRAP: a streamable-HTTP server may answer the very same request
   * either as `application/json` or as a one-shot `text/event-stream`. A naive
   * `res.json()` works in testing and then throws in production the first time
   * the server decides to stream. Both shapes are handled here, and both are
   * covered by tests.
   */
  private async send(method: string, params: unknown, notify = false): Promise<unknown> {
    const body = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: ++this.id, method, params };

    const res = await this.fetch(this.opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.opts.token}`,
        "MCP-Protocol-Version": this.opts.protocolVersion ?? "2025-06-18",
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      },
      body: JSON.stringify(body),
    });

    // The server may hand back a session id on ANY response, not just initialize.
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;

    if (notify) return null;

    const text = await res.text();
    if (!res.ok) {
      // Deliberately does not echo the body wholesale — an auth failure can
      // carry request context, and this string reaches logs.
      throw new McpError(`${method} → HTTP ${res.status}`, res.status);
    }

    const msg = JSON.parse(parseFrame(text, res.headers.get("content-type") ?? ""));
    if (msg.error) throw new McpError(`${method} → ${msg.error.message}`, msg.error.code);
    return msg.result;
  }

  async initialize(clientName = "merrymen", clientVersion = "0.0.0"): Promise<unknown> {
    const result = await this.send("initialize", {
      protocolVersion: this.opts.protocolVersion ?? "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });
    // Required by the spec before any other request; servers may reject without it.
    await this.send("notifications/initialized", {}, true);
    return result;
  }

  async listTools(): Promise<McpToolDef[]> {
    const r = (await this.send("tools/list", {})) as { tools?: McpToolDef[] };
    return r?.tools ?? [];
  }

  /**
   * The ONLY way to invoke a tool, and the choke point the safety story rests on.
   *
   * Every mutating tool is refused unless its exact name was passed to
   * `allowMutating` at construction. The default is nothing, so a client is
   * read-only until someone writes the name down. This is what keeps a
   * strategy, an LLM proposal, or a stray refactor from reaching
   * `place_equity_order` — the model proposes, this disposes.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (isMutatingTool(name) && !this.allowMutating.has(name)) {
      throw new McpError(
        `refusing to call ${name}: mutating tools require explicit opt-in via allowMutating`,
      );
    }
    return this.send("tools/call", { name, arguments: args });
  }
}

/**
 * Unwrap a streamable-HTTP response body to a single JSON string.
 *
 * SSE arrives as `event:`/`data:` lines; the payload is every `data:` line
 * concatenated. Anything else is already JSON.
 */
export function parseFrame(text: string, contentType: string): string {
  if (!contentType.includes("text/event-stream")) return text;
  const data = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  // A stream with no data lines is a protocol error, not an empty result —
  // returning "" would surface as a confusing JSON.parse failure.
  if (!data) throw new McpError("event-stream response carried no data lines");
  return data;
}
