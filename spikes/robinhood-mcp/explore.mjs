#!/usr/bin/env node
/**
 * SPIKE — what does Robinhood's Agentic Trading MCP server actually expose, and
 * can a self-hosted headless worker hold the grant?
 *
 * Run:  node spikes/robinhood-mcp/explore.mjs
 *
 * This is throwaway reconnaissance, deliberately kept out of worker/ and out of
 * the published package (package.json `files` is an allowlist). It answers the
 * questions the public docs leave open, and nothing else.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NOT DO, ENFORCED IN CODE BELOW
 *
 *   It never calls a mutating tool. `place_equity_order` and anything else that
 *   moves money is refused by name AND by a deny-pattern, so a future edit that
 *   adds a call has to delete a guard rather than forget one. A spike that can
 *   accidentally place a trade is not a spike.
 *
 *   It never persists a token. The access token lives in this process and dies
 *   with it, so a scratch experiment cannot leave a brokerage refresh token
 *   sitting in a file. Re-authorizing costs one browser click.
 *
 *   It never handles a password. The whole point of the flow below is that the
 *   only place credentials are ever typed is robinhood.com, in your own
 *   browser. This process sees an authorization code and nothing else.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THE UNAUTHENTICATED PROBE ALREADY ESTABLISHED
 *
 *   Transport is streamable HTTP — GET returns 405 with `allow: POST`, so this
 *   is not the older SSE transport.
 *
 *   Auth is OAuth 2.1 per the MCP spec: a 401 carries
 *   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/
 *   oauth-protected-resource/mcp/trading"` (RFC 9728), which points at the
 *   authorization-server metadata discovered below.
 *
 *   Dynamic client registration (RFC 7591) is OPEN, issues no client secret,
 *   and accepts a loopback redirect. That is the finding that matters: a
 *   self-hosted agent can mint its own client_id with no partnership, no
 *   API-key application and no allowlist.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const MCP_URL = "https://agent.robinhood.com/mcp/trading";
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

/**
 * Tools this spike will never invoke.
 *
 * Belt and braces on purpose: an explicit list of the names we know about, plus
 * a pattern for the ones we don't. Robinhood says options, crypto and futures
 * are coming — `place_crypto_order` should be refused the day it appears,
 * without anyone remembering to add it here.
 */
const DENY_EXACT = new Set(["place_equity_order"]);
const DENY_PATTERN = /^(place|submit|create|cancel|replace|modify|delete|transfer|withdraw|deposit|move|sell|buy)_/i;
const forbidden = (name) => DENY_EXACT.has(name) || DENY_PATTERN.test(name);

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

/** RFC 8414 — where to authorize, where to exchange, whether we may register. */
async function discover() {
  const { status, body } = await json("https://agent.robinhood.com/.well-known/oauth-authorization-server");
  if (status !== 200) throw new Error(`discovery failed: ${status}`);
  return body;
}

async function register(meta) {
  const { status, body } = await json(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "merrymen",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: (meta.scopes_supported ?? ["internal"]).join(" "),
    }),
  });
  if (status !== 200 && status !== 201) throw new Error(`registration failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

/**
 * Catch the redirect on localhost.
 *
 * This is what makes a headless agent possible at all: the browser hands the
 * authorization code straight back to this process, so the code never passes
 * through a third party — or through a chat window.
 */
function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<body style="font:16px system-ui;background:#0d1512;color:#e9f2ec;padding:40px">
         ${error ? `Authorization failed: ${error}` : "Authorized. You can close this tab."}</body>`,
      );
      server.close();
      if (error) return reject(new Error(error));
      // A mismatched state means the response isn't ours. Fail rather than use it.
      if (state !== expectedState) return reject(new Error("state mismatch — discarding response"));
      resolve(code);
    });
    server.listen(REDIRECT_PORT, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the browser redirect"));
    }, 5 * 60_000);
  });
}

async function authorize() {
  const meta = await discover();
  console.log("authorization server:");
  console.log(`  authorize : ${meta.authorization_endpoint}`);
  console.log(`  token     : ${meta.token_endpoint}`);
  console.log(`  register  : ${meta.registration_endpoint ?? "(closed)"}`);
  console.log(`  pkce      : ${(meta.code_challenge_methods_supported ?? []).join(", ") || "(none)"}`);
  console.log(`  scopes    : ${(meta.scopes_supported ?? []).join(", ")}`);
  console.log(`  auth      : ${(meta.token_endpoint_auth_methods_supported ?? []).join(", ")}`);

  const client = await register(meta);
  console.log(`\nregistered client_id: ${client.client_id}`);
  if (client.client_secret) console.log("  !! server issued a client_secret to a public client");

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authUrl = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope: (meta.scopes_supported ?? ["internal"]).join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    authUrl.searchParams.set(k, v);
  }

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("Open this in your browser and approve it. You log in to Robinhood");
  console.log("directly — this process never sees your credentials.\n");
  console.log(authUrl.toString());
  console.log("──────────────────────────────────────────────────────────────\n");
  console.log(`listening on ${REDIRECT_URI} …`);

  const code = await waitForCode(state);

  const { status, body } = await json(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  if (status !== 200 || !body?.access_token) {
    throw new Error(`token exchange failed: ${status} ${JSON.stringify(body).slice(0, 400)}`);
  }
  console.log(`\ngot a token (${body.token_type ?? "bearer"}, expires_in ${body.expires_in ?? "?"}s)`);
  // In memory only. Never written to disk, never printed.
  return body.access_token;
}

/**
 * The smallest MCP client that can ask a streamable-HTTP server what it has.
 *
 * Hand-rolled rather than pulled from the SDK: this is a spike whose whole job
 * is to show exactly what goes over the wire, and merrymen ships as an npm
 * package where every dependency is a decision.
 */
class Mcp {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.session = null;
    this.id = 0;
  }

  async send(method, params, { notify = false } = {}) {
    const payload = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: ++this.id, method, params };
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.token}`,
        "MCP-Protocol-Version": "2025-06-18",
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      },
      body: JSON.stringify(payload),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (notify) return null;

    const text = await res.text();
    if (!res.ok) throw new Error(`${method} → ${res.status}: ${text.slice(0, 300)}`);

    // Streamable HTTP may answer as JSON or as a one-shot SSE stream.
    const ctype = res.headers.get("content-type") ?? "";
    const raw = ctype.includes("text/event-stream")
      ? text
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : text;

    const msg = JSON.parse(raw);
    if (msg.error) throw new Error(`${method} → ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  /**
   * The ONLY way this file may invoke a tool, and it refuses the mutating ones.
   *
   * Routing every call through here is the point. A guard that merely decorates
   * a listing is decoration; this one sits on the path, so adding a call to
   * `place_equity_order` means deleting a throw rather than forgetting a check.
   */
  async call(name, args = {}) {
    if (forbidden(name)) {
      throw new Error(`refusing to call ${name}: this spike does not place, cancel or move anything`);
    }
    return this.send("tools/call", { name, arguments: args });
  }
}

const token = await authorize();
const mcp = new Mcp(MCP_URL, token);

const init = await mcp.send("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "merrymen-spike", version: "0.0.0" },
});
console.log("\nserver:", JSON.stringify(init.serverInfo ?? {}), "protocol", init.protocolVersion);
console.log("capabilities:", JSON.stringify(init.capabilities ?? {}));
await mcp.send("notifications/initialized", {}, { notify: true });

const { tools = [] } = await mcp.send("tools/list", {});
console.log(`\n${tools.length} tools\n`);
for (const t of tools) {
  const props = t.inputSchema?.properties ?? {};
  const required = new Set(t.inputSchema?.required ?? []);
  const args = Object.entries(props)
    .map(([k, v]) => `${k}${required.has(k) ? "*" : ""}: ${v.type ?? v.anyOf?.map((a) => a.type).join("|") ?? "?"}`)
    .join(", ");
  console.log(`${forbidden(t.name) ? "⛔" : "  "} ${t.name}(${args})`);
  if (t.description) console.log(`     ${t.description.replace(/\s+/g, " ").slice(0, 180)}`);
}

// Anything else the server advertises is worth knowing about too.
for (const [method, key] of [
  ["resources/list", "resources"],
  ["prompts/list", "prompts"],
]) {
  try {
    const r = await mcp.send(method, {});
    const items = r?.[key] ?? [];
    if (items.length) console.log(`\n${items.length} ${key}: ${items.map((i) => i.name ?? i.uri).join(", ")}`);
  } catch {
    /* not supported — normal */
  }
}

console.log("\n⛔ = mutating. mcp.call() throws on these — see the guard in Mcp#call.");

// Prove the guard is real rather than cosmetic, without touching the account.
try {
  await mcp.call("place_equity_order", {});
  console.log("!! GUARD FAILED — the mutating call was not refused");
  process.exitCode = 1;
} catch (e) {
  console.log(`guard verified: ${e.message}`);
}

// One read-only call, so the spike reports what the data actually looks like
// and not merely what the schema promises. get_accounts is the cheapest.
try {
  const r = await mcp.call("get_accounts", {});
  const text = (r?.content ?? []).map((c) => c.text ?? "").join("\n");
  // Account numbers are the one thing here worth not printing.
  console.log(`\nget_accounts → ${text.replace(/[A-Z0-9]{8,}/g, "<redacted>").slice(0, 600)}`);
} catch (e) {
  console.log(`\nget_accounts → ${e.message}`);
}
