/**
 * Merrymen AI gateway — SHARED CORE (runtime-agnostic).
 *
 * All the security-critical logic lives here exactly once: HMAC access tokens,
 * single-use domain-bound claim nonces, the on-chain holder check, the cost
 * clamp, and the route handlers. Both runtimes are thin adapters over this:
 *   - server.mjs        → a long-lived Node http server (Docker / Railway / VPS)
 *   - api/*.js          → Vercel serverless functions
 * Each handler returns a plain { status, json | html | text } — the adapter just
 * writes it. State (nonces, rate limits, balance cache) comes from an injected
 * `store` (in-memory for one process; Redis/KV for serverless — see store.mjs).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { erc20Abi, isAddress, verifyMessage } from "viem";

export const DEFAULTS = {
  TOKEN_TTL_SEC: 7 * 24 * 3600, // issued tokens last a week; re-claim to refresh
  NONCE_TTL_SEC: 5 * 60, // a claim nonce must be signed + spent within 5 min
  MAX_COMPLETION_TOKENS: 2048, // hard clamp on client-requested output length
  RATE_PER_MIN: 60, // per-address on /v1, per-IP on /nonce + /claim
  BALANCE_TTL_SEC: 10 * 60, // re-check holdings at most this often
  // Discovery is polled by a worker on a timer, not driven by a human typing, so
  // it gets its OWN tighter bucket. Sharing the chat allowance would let a
  // background poll quietly starve the brain the same holder is paying for.
  BITQUERY_RATE_PER_MIN: 6,
};

/** Clamp a client-supplied integer into a server-decided range. */
export function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Best-effort client IP: first X-Forwarded-For hop, else the socket peer. */
export function clientIp(xff, remote) {
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return remote || "unknown";
}

export function createGateway(cfg) {
  const {
    secret,
    upstreamUrl,
    upstreamKey,
    /** Bitquery key — optional. Absent = the /bitquery route reports 503, and
     * the rest of the gateway works exactly as before. */
    bitqueryKey,
    bitqueryUrl = "https://streaming.bitquery.io/graphql",
    model,
    brandModel = "merrymen-fast",
    domain,
    minTokens,
    tokenAddress,
    decimals = 18n,
    publicClient,
    store,
    tunables = {},
  } = cfg;
  const T = { ...DEFAULTS, ...tunables };

  // ── HMAC access tokens ─────────────────────────────────────────────────────
  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");

  const issueToken = (addr) => {
    const exp = Math.floor(Date.now() / 1000) + T.TOKEN_TTL_SEC;
    const payload = Buffer.from(JSON.stringify({ a: addr.toLowerCase(), exp })).toString("base64url");
    return `mmk_${payload}.${sign(payload)}`;
  };

  /** Returns the token's address if valid + unexpired, else null. Constant-time mac. */
  const verifyToken = (token) => {
    if (typeof token !== "string" || !token.startsWith("mmk_")) return null;
    const [payload, mac] = token.slice(4).split(".");
    if (!payload || !mac) return null;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const { a: addr, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (!addr || typeof exp !== "number" || exp * 1000 < Date.now()) return null;
      return addr;
    } catch {
      return null;
    }
  };

  // ── single-use, domain-bound claim nonces ──────────────────────────────────
  const issueNonce = (addr) => {
    const exp = Math.floor(Date.now() / 1000) + T.NONCE_TTL_SEC;
    const payload = Buffer.from(
      JSON.stringify({ a: addr.toLowerCase(), exp, r: randomBytes(12).toString("base64url") }),
    ).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };

  /** True if the nonce is authentic, unexpired, and bound to `addr`. Does NOT check
   * replay — that's enforced atomically by store.spendNonce at claim time. */
  const verifyNonceAuthentic = (token, addr) => {
    if (typeof token !== "string" || !token.includes(".")) return false;
    const [payload, mac] = token.split(".");
    if (!payload || !mac) return false;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    let d;
    try {
      d = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {
      return false;
    }
    if (!d.a || typeof d.exp !== "number" || d.exp * 1000 < Date.now()) return false;
    return d.a === addr.toLowerCase();
  };

  // The exact message a holder signs — names the domain + the server nonce so a
  // wallet shows real context and the signature can't be replayed.
  const claimMessage = (addr, nonce) =>
    [
      `Merrymen AI — prove you hold $MERRYMEN`,
      `Domain: ${domain}`,
      `Address: ${addr}`,
      `Nonce: ${nonce}`,
      `This signature is free, read-only, and cannot move funds or approve spending.`,
    ].join("\n");

  // ── on-chain holder check (cached) ─────────────────────────────────────────
  async function isHolder(addr) {
    const key = addr.toLowerCase();
    const cached = await store.getBal(key);
    if (cached !== null) return cached;
    let ok = false;
    try {
      const raw = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
      ok = raw / 10n ** decimals >= minTokens;
    } catch {
      ok = false; // fail closed — never grant access we can't verify
    }
    await store.setBal(key, ok, T.BALANCE_TTL_SEC);
    return ok;
  }

  // ── cost clamp: never trust the client's model/limits ──────────────────────
  function clampPayload(payload) {
    payload.model = model;
    payload.stream = false;
    if (typeof payload.max_tokens !== "number" || payload.max_tokens > T.MAX_COMPLETION_TOKENS) payload.max_tokens = T.MAX_COMPLETION_TOKENS;
    // max_tokens alone doesn't bound cost: n/best_of fan out N completions per
    // request, and newer models honor max_completion_tokens. Pin them all.
    payload.n = 1;
    delete payload.best_of;
    if (typeof payload.max_completion_tokens === "number" && payload.max_completion_tokens > T.MAX_COMPLETION_TOKENS) {
      payload.max_completion_tokens = T.MAX_COMPLETION_TOKENS;
    }
    return payload;
  }

  // ── route handlers (return { status, json | html | text }) ─────────────────
  const health = () => ({ status: 200, json: { ok: true } });

  async function nonce({ address, ip }) {
    if (!(await store.rateHit(`claim:${ip}`, T.RATE_PER_MIN, 60))) return { status: 429, json: { error: "slow down — too many claim attempts" } };
    const addr = typeof address === "string" ? address.trim() : "";
    if (!isAddress(addr)) return { status: 400, json: { error: "valid ?address= required" } };
    const n = issueNonce(addr);
    return { status: 200, json: { nonce: n, message: claimMessage(addr, n), expiresInSec: T.NONCE_TTL_SEC } };
  }

  async function claim({ body, ip }) {
    if (!(await store.rateHit(`claim:${ip}`, T.RATE_PER_MIN, 60))) return { status: 429, json: { error: "slow down — too many claim attempts" } };
    const address = typeof body?.address === "string" ? body.address.trim() : "";
    const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
    const nonceTok = typeof body?.nonce === "string" ? body.nonce.trim() : "";
    if (!isAddress(address) || !signature.startsWith("0x") || !nonceTok) {
      return { status: 400, json: { error: "address, signature and nonce required — GET /nonce first" } };
    }
    if (!verifyNonceAuthentic(nonceTok, address)) {
      return { status: 401, json: { error: "nonce invalid, expired, or already used — refresh the page and sign again" } };
    }
    let valid = false;
    try {
      valid = await verifyMessage({ address, message: claimMessage(address, nonceTok), signature });
    } catch {
      valid = false;
    }
    if (!valid) return { status: 401, json: { error: "signature didn't verify — sign the exact message shown, with this wallet" } };
    // Atomic single-use: the FIRST spend wins; a replay (or concurrent dup) fails.
    if (!(await store.spendNonce(nonceTok, T.NONCE_TTL_SEC))) {
      return { status: 401, json: { error: "nonce already used — refresh the page and sign again" } };
    }
    if (!(await isHolder(address))) {
      return { status: 403, json: { error: `this wallet doesn't hold at least ${minTokens} $MERRYMEN — join the Circle, then claim.` } };
    }
    await store.setBal(address.toLowerCase(), true, T.BALANCE_TTL_SEC);
    return { status: 200, json: { token: issueToken(address), expiresInDays: T.TOKEN_TTL_SEC / 86400, model: brandModel } };
  }

  async function chat({ token, body, ip }) {
    const addr = verifyToken(token);
    if (!addr) return { status: 401, json: { error: { message: "invalid or expired Merrymen AI token — re-claim at /claim" } } };
    if (!(await store.rateHit(addr, T.RATE_PER_MIN, 60))) return { status: 429, json: { error: { message: "rate limit — slow down (holder quota)" } } };
    if (!(await isHolder(addr))) return { status: 403, json: { error: { message: "this wallet no longer meets the $MERRYMEN holding requirement" } } };
    if (!body || typeof body !== "object") return { status: 400, json: { error: { message: "bad request body" } } };
    clampPayload(body);
    try {
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
        body: JSON.stringify(body),
      });
      const raw = await upstream.text();
      // Pass the model name back as our brand, not the upstream's.
      const text = raw.replace(new RegExp(`"model"\\s*:\\s*"${model}"`, "g"), `"model":"${brandModel}"`);
      return { status: upstream.status, text, contentType: "application/json" };
    } catch {
      return { status: 502, json: { error: { message: "upstream unavailable" } } };
    }
  }

  /**
   * Bitquery, for holders — the same perk shape as the brain, one hard lesson
   * applied on top.
   *
   * DO NOT PROXY ARBITRARY GRAPHQL. Bitquery bills by query cost, and GraphQL is
   * unbounded by construction: one caller asking for every event since genesis,
   * unfiltered, is a five-figure invoice and a blank cheque written against the
   * operator's account. `max_tokens` was enough to bound the LLM route; there is
   * no equivalent knob here, because the expensive part is the query itself.
   *
   * So the client does not send a query. It sends a NAME, and the gateway owns
   * the GraphQL. The catalogue below is the entire attack surface: every query
   * is written here, every variable is clamped here, and a caller can ask for
   * nothing that isn't in it. Adding a capability is a deliberate act by whoever
   * runs the gateway, not something a client can reach for.
   */
  const BITQUERY_QUERIES = {
    /** Pools initialized recently — v3 factories and the v4 PoolManager alike. */
    recentPools: {
      cost: 2,
      build: (v) => ({
        query: `query ($since: DateTime, $limit: Int) {
          EVM(network: robinhood) {
            Events(
              limit: {count: $limit}
              orderBy: {descending: Block_Time}
              where: {Log: {Signature: {Name: {is: "Initialize"}}}, Block: {Time: {after: $since}}}
            ) {
              Block { Time }
              Transaction { Hash }
              Arguments { Name Value { ... on EVM_ABI_Address_Value_Arg { address } } }
            }
          }
        }`,
        variables: {
          // Clamped server-side. A client asking for "since the beginning of
          // time, limit 100000" is exactly the request that must not be possible.
          since: new Date(Date.now() - clampInt(v.sinceMinutes, 1, 1440, 60) * 60_000).toISOString(),
          limit: clampInt(v.limit, 1, 100, 25),
        },
      }),
    },
    /** Chain height — the cheapest possible liveness/credential check. */
    ping: {
      cost: 1,
      build: () => ({
        query: `{ EVM(network: robinhood) { Blocks(limit: {count: 1}, orderBy: {descending: Block_Number}) { Block { Number } } } }`,
        variables: {},
      }),
    },
  };

  async function bitquery({ token, body, ip }) {
    if (!bitqueryKey) {
      return { status: 503, json: { error: "this gateway has no Bitquery key configured" } };
    }
    const addr = verifyToken(token);
    if (!addr) return { status: 401, json: { error: "invalid or expired Merrymen token — re-claim at /claim" } };
    // A SEPARATE, tighter bucket from the chat route. Discovery is polled on a
    // timer rather than driven by a human typing, so it would otherwise quietly
    // consume the whole per-address allowance that the brain also depends on.
    if (!(await store.rateHit(`bq:${addr}`, T.BITQUERY_RATE_PER_MIN, 60))) {
      return { status: 429, json: { error: "rate limit — discovery is polled, not streamed (holder quota)" } };
    }
    if (!(await isHolder(addr))) {
      return { status: 403, json: { error: "this wallet no longer meets the $MERRYMEN holding requirement" } };
    }
    const name = body && typeof body === "object" ? body.query : null;
    const entry = Object.prototype.hasOwnProperty.call(BITQUERY_QUERIES, name)
      ? BITQUERY_QUERIES[name]
      : null;
    if (!entry) {
      return {
        status: 400,
        json: {
          error: `unknown query "${String(name).slice(0, 40)}"`,
          available: Object.keys(BITQUERY_QUERIES),
        },
      };
    }
    const built = entry.build(body.variables && typeof body.variables === "object" ? body.variables : {});
    try {
      const upstream = await fetch(bitqueryUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bitqueryKey}`,
          "X-API-KEY": bitqueryKey,
        },
        body: JSON.stringify(built),
      });
      const text = await upstream.text();
      // Upstream errors can quote the request, and the request carries our key
      // in its headers on the way out. Return the status, not the body, unless
      // the call actually succeeded.
      if (!upstream.ok) {
        return { status: upstream.status === 429 ? 429 : 502, json: { error: `bitquery upstream ${upstream.status}` } };
      }
      return { status: 200, text, contentType: "application/json" };
    } catch {
      return { status: 502, json: { error: "bitquery unavailable" } };
    }
  }

  return {
    health,
    serveClaimPage: (html) => ({ status: 200, html }),
    nonce,
    claim,
    chat,
    bitquery,
    bitqueryQueries: () => Object.keys(BITQUERY_QUERIES),
    // exposed for the standalone server + tests
    isHolder,
    _tokens: { sign, issueToken, verifyToken, issueNonce, verifyNonceAuthentic, claimMessage, clampPayload },
    tunables: T,
  };
}
