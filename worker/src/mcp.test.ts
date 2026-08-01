import assert from "node:assert/strict";
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import test from "node:test";
import { McpClient, McpError, isMutatingTool, parseFrame } from "../../packages/core/src/mcp";
import {
  RH_CLIENT_ID,
  base64url,
  buildAuthorizeRequest,
  createPkce,
  discoverAuthServer,
  exchangeCode,
  type AuthServerMeta,
} from "../../packages/core/src/robinhood-oauth";

/**
 * The MCP client and the OAuth flow, tested where they can silently be wrong.
 *
 * Two things here are load-bearing rather than merely functional: the framing
 * parser (a server may answer the same request as JSON or as SSE, and only one
 * of those shows up in casual testing), and the mutating-tool gate — which on
 * the Robinhood venue is the thing standing between a model's proposal and a
 * real brokerage order, because the OAuth scope cannot express "read only".
 */

// ── framing ────────────────────────────────────────────────────────────────

test("parseFrame passes plain JSON through untouched", () => {
  const body = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';
  assert.equal(parseFrame(body, "application/json"), body);
});

test("parseFrame concatenates the data: lines of a one-shot SSE response", () => {
  // The trap: the same server answers either way, so a naive res.json() works
  // in testing and throws the first time production streams.
  const sse = ["event: message", 'data: {"jsonrpc":"2.0","id":1,', 'data: "result":{"ok":true}}', ""].join("\r\n");
  assert.equal(parseFrame(sse, "text/event-stream"), '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
});

test("parseFrame tolerates CRLF and bare LF, and charset on the content-type", () => {
  const payload = '{"a":1}';
  for (const nl of ["\r\n", "\n"]) {
    assert.equal(parseFrame(`data: ${payload}${nl}`, "text/event-stream; charset=utf-8"), payload);
  }
});

test("parseFrame throws on an event-stream carrying no data lines", () => {
  // Returning "" would surface later as an inscrutable JSON.parse failure.
  assert.throws(() => parseFrame("event: ping\r\n\r\n", "text/event-stream"), McpError);
});

// ── the gate ───────────────────────────────────────────────────────────────

test("isMutatingTool recognises the documented and the not-yet-shipped mutators", () => {
  for (const n of [
    "place_equity_order",
    "place_crypto_order", // ships when Robinhood adds crypto
    "place_options_order",
    "cancel_equity_order",
    "transfer_funds",
    "withdraw_funds",
    "sell_position",
    "execute_trade",
  ]) {
    assert.equal(isMutatingTool(n), true, `${n} must be treated as mutating`);
  }
});

test("isMutatingTool leaves reads — and review — callable", () => {
  // review_equity_order is the DRY RUN half of the propose/dispose pair. If it
  // were refused, there would be no way to price an order before deciding.
  for (const n of [
    "get_accounts",
    "get_portfolio",
    "get_equity_positions",
    "get_equity_quotes",
    "get_equity_orders",
    "search",
    "review_equity_order",
  ]) {
    assert.equal(isMutatingTool(n), false, `${n} must stay callable`);
  }
});

/** A fetch that records calls and replays canned responses. */
function stubFetch(reply: { status?: number; body: string; contentType?: string; headers?: Record<string, string> }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const h = new Headers({ "content-type": reply.contentType ?? "application/json", ...(reply.headers ?? {}) });
    return new Response(reply.body, { status: reply.status ?? 200, headers: h });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("callTool REFUSES a mutating tool by default, and never reaches the network", async () => {
  const { impl, calls } = stubFetch({ body: "{}" });
  const c = new McpClient({ url: "https://x/mcp", token: "t", fetchImpl: impl });
  await assert.rejects(() => c.callTool("place_equity_order", { symbol: "AAPL" }), /explicit opt-in/);
  // The refusal must happen before any request — a guard that fires after the
  // order is already on the wire is not a guard.
  assert.equal(calls.length, 0);
});

test("callTool allows a mutating tool only when its exact name is opted in", async () => {
  const { impl, calls } = stubFetch({ body: '{"jsonrpc":"2.0","id":1,"result":{"placed":true}}' });
  const c = new McpClient({
    url: "https://x/mcp",
    token: "t",
    fetchImpl: impl,
    allowMutating: ["place_equity_order"],
  });
  await c.callTool("place_equity_order", {});
  assert.equal(calls.length, 1);
  // Opting one in must not open the others.
  await assert.rejects(() => c.callTool("cancel_equity_order", {}), /explicit opt-in/);
  assert.equal(calls.length, 1);
});

test("callTool passes read tools straight through", async () => {
  const { impl, calls } = stubFetch({ body: '{"jsonrpc":"2.0","id":1,"result":{"accounts":[]}}' });
  const c = new McpClient({ url: "https://x/mcp", token: "t", fetchImpl: impl });
  await c.callTool("get_accounts");
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.method, "tools/call");
  assert.equal(body.params.name, "get_accounts");
});

// ── transport details ──────────────────────────────────────────────────────

test("the bearer and protocol version go on every request; session id is captured and echoed", async () => {
  const { impl, calls } = stubFetch({
    body: '{"jsonrpc":"2.0","id":1,"result":{}}',
    headers: { "mcp-session-id": "sess-42" },
  });
  const c = new McpClient({ url: "https://x/mcp", token: "secret-token", fetchImpl: impl });
  await c.callTool("get_accounts");
  const h1 = new Headers(calls[0]!.init.headers as HeadersInit);
  assert.equal(h1.get("Authorization"), "Bearer secret-token");
  assert.equal(h1.get("MCP-Protocol-Version"), "2025-06-18");
  assert.equal(h1.get("Mcp-Session-Id"), null, "no session on the first call");

  await c.callTool("get_portfolio");
  const h2 = new Headers(calls[1]!.init.headers as HeadersInit);
  assert.equal(h2.get("Mcp-Session-Id"), "sess-42", "session captured from the first response");
});

test("a JSON-RPC error becomes McpError, and an HTTP error does not echo the body", async () => {
  const bad = stubFetch({ body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"nope"}}' });
  const c1 = new McpClient({ url: "https://x/mcp", token: "t", fetchImpl: bad.impl });
  await assert.rejects(() => c1.callTool("get_accounts"), /nope/);

  const denied = stubFetch({ status: 401, body: "token=abc123 leaked in an error body" });
  const c2 = new McpClient({ url: "https://x/mcp", token: "t", fetchImpl: denied.impl });
  await assert.rejects(
    () => c2.callTool("get_accounts"),
    (e: Error) => e.message.includes("401") && !e.message.includes("abc123"),
  );
});

// ── PKCE / OAuth ───────────────────────────────────────────────────────────

test("base64url matches Node's reference encoder", () => {
  // Hand-rolled because Hermes has no Buffer — so it has to be checked against
  // something authoritative, at every length mod 3.
  for (const n of [0, 1, 2, 3, 4, 5, 16, 31, 32, 33, 64]) {
    const bytes = nodeRandomBytes(n);
    assert.equal(base64url(bytes), Buffer.from(bytes).toString("base64url"), `length ${n}`);
  }
});

test("createPkce produces a verifier whose S256 challenge is correct and unpadded", () => {
  const { verifier, challenge } = createPkce();
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
  assert.match(verifier, /^[A-Za-z0-9\-_]+$/, "verifier must be base64url with no padding");
  assert.match(challenge, /^[A-Za-z0-9\-_]{43}$/, "S256 challenge is 43 unpadded chars");
});

test("createPkce is not deterministic", () => {
  assert.notEqual(createPkce().verifier, createPkce().verifier);
});

test("discovery refuses a server that cannot do S256", async () => {
  const { impl } = stubFetch({
    body: JSON.stringify({
      authorization_endpoint: "https://rh/oauth",
      token_endpoint: "https://rh/token",
      code_challenge_methods_supported: ["plain"],
    }),
  });
  // Accepting `plain` would silently downgrade the only thing binding the
  // exchange to the request, since this is a public client with no secret.
  await assert.rejects(() => discoverAuthServer(impl), /S256/);
});

const META: AuthServerMeta = {
  authorization_endpoint: "https://robinhood.com/oauth",
  token_endpoint: "https://api.robinhood.com/oauth2/token/",
  scopes_supported: ["internal"],
  code_challenge_methods_supported: ["S256"],
};

test("buildAuthorizeRequest carries PKCE, state and the shared client id", () => {
  const req = buildAuthorizeRequest(META, "http://127.0.0.1:8765/callback");
  const u = new URL(req.url);
  assert.equal(u.origin + u.pathname, "https://robinhood.com/oauth");
  assert.equal(u.searchParams.get("client_id"), RH_CLIENT_ID);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:8765/callback");
  assert.equal(u.searchParams.get("scope"), "internal");
  assert.equal(u.searchParams.get("state"), req.state);
  // The verifier is the secret half — it must never appear in the URL.
  assert.ok(!req.url.includes(req.verifier), "verifier must not travel in the authorize URL");
  assert.equal(u.searchParams.get("code_challenge"), createHash("sha256").update(req.verifier).digest("base64url"));
});

test("buildAuthorizeRequest accepts a mobile custom-scheme redirect unchanged", () => {
  // The phone cannot run a loopback listener; it gets the code back through a
  // registered URL scheme instead. The shared code must not assume http.
  const req = buildAuthorizeRequest(META, "merrymen://oauth/callback");
  assert.equal(new URL(req.url).searchParams.get("redirect_uri"), "merrymen://oauth/callback");
});

test("exchangeCode posts a form-encoded public-client grant with the verifier", async () => {
  const { impl, calls } = stubFetch({ body: JSON.stringify({ access_token: "at", token_type: "Bearer" }) });
  const tok = await exchangeCode(META, { code: "c0de", verifier: "v3rif", redirectUri: "merrymen://cb" }, impl);
  assert.equal(tok.access_token, "at");
  const sent = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "c0de");
  assert.equal(sent.get("code_verifier"), "v3rif");
  assert.equal(sent.get("client_id"), RH_CLIENT_ID);
  // Public client: there is no secret to send, and inventing one would fail.
  assert.equal(sent.get("client_secret"), null);
});

test("exchangeCode rejects a 2xx that carries no access_token", async () => {
  const { impl } = stubFetch({ body: JSON.stringify({ token_type: "Bearer" }) });
  await assert.rejects(
    () => exchangeCode(META, { code: "c", verifier: "v", redirectUri: "x://y" }, impl),
    /no access_token/,
  );
});
