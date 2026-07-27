/**
 * Offline self-test for the gateway's security-critical pure logic, exercising the
 * REAL shared core (lib/core.mjs) — HMAC token issue/verify (tamper + expiry +
 * wrong-secret + garbage), single-use domain-bound nonces (authenticity + binding
 * + expiry + tamper), and atomic replay protection via the store. No network, no
 * real keys. Run: node selftest.mjs
 */
process.env.MERRYMEN_GATEWAY_UPSTREAM_KEY ||= "test-upstream-key";
process.env.MERRYMEN_GATEWAY_SECRET ||= "test-secret-at-least-32-bytes-long-for-hmac!!";
process.env.MERRYMEN_GATEWAY_RPC ||= "https://example.invalid";

import assert from "node:assert/strict";
import { createGateway, DEFAULTS } from "./lib/core.mjs";
import { createStore } from "./lib/store.mjs";

const SECRET = process.env.MERRYMEN_GATEWAY_SECRET;
const baseCfg = {
  upstreamUrl: "https://example.invalid",
  upstreamKey: "x",
  model: "test-model",
  domain: "merrymen.dev",
  minTokens: 10000n,
  tokenAddress: "0x0000000000000000000000000000000000000000",
  publicClient: { readContract: async () => 0n }, // isHolder isn't exercised here
};
const store = createStore(); // in-memory (no KV env in the test)
const gw = createGateway({ ...baseCfg, secret: SECRET, store });
const gwOther = createGateway({ ...baseCfg, secret: "a-totally-different-secret-value-32bytes!!", store });
const { sign, issueToken, verifyToken, issueNonce, verifyNonceAuthentic, claimMessage } = gw._tokens;

const ADDR = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

// ── HMAC access tokens ───────────────────────────────────────────────────────
assert.equal(verifyToken(issueToken(ADDR)), ADDR.toLowerCase(), "valid token verifies to its address");

const t = issueToken(ADDR);
const mac = t.slice(4).split(".")[1];
const evilPayload = Buffer.from(JSON.stringify({ a: OTHER, exp: 9e9 })).toString("base64url");
assert.equal(verifyToken(`mmk_${evilPayload}.${mac}`), null, "swapping the payload but keeping the mac is rejected");

const expiredPayload = Buffer.from(JSON.stringify({ a: ADDR.toLowerCase(), exp: Math.floor(Date.now() / 1000) - 10 })).toString("base64url");
assert.equal(verifyToken(`mmk_${expiredPayload}.${sign(expiredPayload)}`), null, "an expired token is rejected");

assert.equal(gwOther._tokens.verifyToken(t), null, "a token signed with a different secret is rejected");

for (const bad of ["", "hello", "mmk_", "mmk_a.b", "Bearer x"]) assert.equal(verifyToken(bad), null, `garbage rejected: ${bad}`);

// ── single-use, domain-bound claim nonces ────────────────────────────────────
const n = issueNonce(ADDR);
assert.equal(verifyNonceAuthentic(n, ADDR), true, "a fresh nonce is authentic for its own address");
assert.equal(verifyNonceAuthentic(n, OTHER), false, "a nonce is bound to its address (can't be reused for another wallet)");

const nMac = issueNonce(ADDR).split(".")[1];
const evilNonce = Buffer.from(JSON.stringify({ a: ADDR.toLowerCase(), exp: 9e9, r: "x" })).toString("base64url");
assert.equal(verifyNonceAuthentic(`${evilNonce}.${nMac}`, ADDR), false, "swapping the nonce payload but keeping a mac is rejected");

const expiredNonce = Buffer.from(JSON.stringify({ a: ADDR.toLowerCase(), exp: Math.floor(Date.now() / 1000) - 10, r: "x" })).toString("base64url");
assert.equal(verifyNonceAuthentic(`${expiredNonce}.${sign(expiredNonce)}`, ADDR), false, "an expired nonce is rejected");

// atomic replay protection lives in the store: first spend wins, the rest fail
assert.equal(await store.spendNonce(n, 300), true, "first spend of a nonce succeeds");
assert.equal(await store.spendNonce(n, 300), false, "a spent nonce cannot be spent again — no replay");

// message is domain- + nonce-bound (no reusable date-stamped template)
const message = claimMessage(ADDR, n);
assert.ok(message.includes(`Nonce: ${n}`) && message.includes("Domain: merrymen.dev"), "the signed message binds a fresh nonce + the domain");

console.log("[gateway] selftest OK — shared core: token scheme + single-use nonce + replay protection verified");

// ── /bitquery: the catalogue IS the attack surface ───────────────────────────
// Bitquery bills by query cost and GraphQL is unbounded, so the one thing that
// must never be true is "a caller can choose the query". These assertions are
// the whole safety argument for putting an operator's paid key behind a public
// endpoint, so they check refusal FIRST and reachability second.
const holderClient = { readContract: async () => 10_000n * 10n ** 18n };
const bq = createGateway({
  ...baseCfg,
  secret: SECRET,
  store,
  bitqueryKey: "test-bitquery-key",
  bitqueryUrl: "https://example.invalid/graphql",
  publicClient: holderClient,
  // Raised so the refusal assertions below can all run; the real (tighter)
  // default is asserted separately at the end.
  tunables: { BITQUERY_RATE_PER_MIN: 1000 },
});
const goodToken = bq._tokens.issueToken(ADDR);

assert.equal(
  (await bq.bitquery({ token: "mmk_nope.bad", body: { query: "ping" }, ip: "1.1.1.1" })).status,
  401,
  "an unsigned token can't reach the operator's Bitquery key",
);

// Raw GraphQL must be refused BY NAME LOOKUP — not sanitised, not escaped.
for (const attempt of [
  "{ EVM(network: robinhood) { Blocks { Block { Number } } } }",
  "query { __schema { types { name } } }",
  "ping\n{ evil }",
  "__proto__",
  "constructor",
  "toString",
  "",
  null,
  undefined,
  42,
  { nested: true },
]) {
  const r = await bq.bitquery({ token: goodToken, body: { query: attempt }, ip: "1.1.1.1" });
  assert.equal(r.status, 400, `raw/hostile query must be rejected: ${String(attempt).slice(0, 30)}`);
  assert.ok(Array.isArray(r.json.available), "the refusal names what IS allowed");
}

// Prototype keys must not resolve to inherited Object members.
assert.deepEqual(
  bq.bitqueryQueries().sort(),
  ["ping", "recentPools"],
  "the catalogue is exactly what's declared — nothing inherited",
);

// A gateway with no Bitquery key configured refuses the route outright rather
// than failing somewhere upstream with the operator's other credentials in play.
const noKey = createGateway({ ...baseCfg, secret: SECRET, store, publicClient: holderClient });
assert.equal(
  (await noKey.bitquery({ token: noKey._tokens.issueToken(ADDR), body: { query: "ping" }, ip: "2.2.2.2" })).status,
  503,
  "no key configured = 503, not a confusing upstream error",
);

// Discovery gets its own bucket, tighter than chat: a polled background feed
// must not be able to eat the allowance the holder's brain also depends on.
const rated = createGateway({ ...baseCfg, secret: SECRET, store, bitqueryKey: "k", bitqueryUrl: "https://example.invalid/graphql", publicClient: holderClient, tunables: { BITQUERY_RATE_PER_MIN: 2 } });
const rt = rated._tokens.issueToken(OTHER);
assert.equal((await rated.bitquery({ token: rt, body: { query: "ping" }, ip: "3.3.3.3" })).status !== 429, true, "first discovery call is allowed");
await rated.bitquery({ token: rt, body: { query: "ping" }, ip: "3.3.3.3" });
assert.equal((await rated.bitquery({ token: rt, body: { query: "ping" }, ip: "3.3.3.3" })).status, 429, "discovery is rate-limited per address");
assert.ok(DEFAULTS.BITQUERY_RATE_PER_MIN < DEFAULTS.RATE_PER_MIN, "discovery is limited harder than chat by default");

console.log("[gateway] selftest OK — /bitquery: named queries only, no raw GraphQL, key-gated, own rate bucket");
