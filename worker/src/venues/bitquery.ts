/**
 * Bitquery — the eyes merrymen doesn't have.
 *
 * merrymen reads Uniswap **v3** directly: factory, pools, quoter. That is enough
 * to trade what already exists and blind to almost everything that's new. New
 * pairs on Robinhood Chain launch through Pons/Doppler on **Uniswap v4**, whose
 * pools live inside a singleton PoolManager with no per-pair contract to find by
 * scanning. Bitquery indexes this chain from genesis and decodes v4 events, so
 * it can answer "what launched, and when" — a question no amount of v3 reading
 * will ever answer.
 *
 * WHAT THIS IS ALLOWED TO BE. A discovery source, and nothing else. It can tell
 * the agent a pair exists; it can never authorise a trade in one. Everything it
 * returns is untrusted input on the PROPOSE side of the wall:
 *
 *   - No value from here reaches equity, P&L, the high-water mark or the
 *     drawdown breaker. Those still come from a pool TWAP that passed the depth
 *     and divergence guards, or from Chainlink.
 *   - A token Bitquery surfaces is still an owner-added token like any other:
 *     it must be added, selected, and covered by a re-signed grant before the
 *     agent can touch it. Discovery does not widen a cap, ever.
 *   - It is off the hot path. A slow or failing API must degrade to "no new
 *     information", never to a stalled tick.
 *
 * That last point is why every call here is bounded and every failure is a
 * caught, typed miss rather than a throw.
 */

/** Bitquery's V2 (streaming) GraphQL endpoint — the one carrying EVM(network:). */
export const BITQUERY_DEFAULT_ENDPOINT = "https://streaming.bitquery.io/graphql";

/** This chain's identifier in Bitquery's EVM schema. */
export const BITQUERY_NETWORK = "robinhood";

export interface BitqueryCreds {
  apiKey: string;
  /** Override for self-hosted/enterprise endpoints, or if Bitquery moves it. */
  endpoint?: string;
}

export interface BitqueryResult<T> {
  ok: boolean;
  data?: T;
  /** Human-readable reason, safe to show an owner. Never contains the key. */
  error?: string;
}

/**
 * One bounded GraphQL call.
 *
 * Errors are RETURNED, not thrown: this runs alongside a trading loop, and an
 * outage in a data provider must not be able to stop the agent from selling.
 */
export async function bitqueryQuery<T = unknown>(
  creds: BitqueryCreds,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<BitqueryResult<T>> {
  const endpoint = creds.endpoint || BITQUERY_DEFAULT_ENDPOINT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // V2 takes a bearer token; V1 took X-API-KEY. Sending both is harmless
        // and means a key from either console works without the owner having to
        // know which generation of the API they signed up for.
        Authorization: `Bearer ${creds.apiKey}`,
        "X-API-KEY": creds.apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Deliberately not echoing the body — an auth error can quote the request.
      return { ok: false, error: `bitquery HTTP ${res.status}${res.status === 401 || res.status === 403 ? " — check the API key in /settings" : ""}` };
    }
    const json = (await res.json()) as { data?: T; errors?: { message?: string }[] };
    if (json.errors?.length) {
      return { ok: false, error: `bitquery: ${json.errors.map((e) => e.message ?? "?").join("; ").slice(0, 300)}` };
    }
    if (!json.data) return { ok: false, error: "bitquery returned no data" };
    return { ok: true, data: json.data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.includes("abort") ? "bitquery timed out" : `bitquery unreachable: ${msg.slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cheapest possible round-trip: is the key valid and is this chain indexed?
 *
 * Exists so an owner can find out their key is wrong from `merrymen doctor`,
 * rather than from a discovery feed that is quietly always empty.
 */
export async function bitqueryPing(creds: BitqueryCreds): Promise<BitqueryResult<{ blockHeight: number }>> {
  const q = `{
    EVM(network: ${BITQUERY_NETWORK}) {
      Blocks(limit: {count: 1}, orderBy: {descending: Block_Number}) {
        Block { Number }
      }
    }
  }`;
  const r = await bitqueryQuery<{ EVM?: { Blocks?: { Block?: { Number?: string | number } }[] } }>(creds, q);
  if (!r.ok) return { ok: false, error: r.error };
  const raw = r.data?.EVM?.Blocks?.[0]?.Block?.Number;
  const blockHeight = Number(raw);
  if (!Number.isFinite(blockHeight) || blockHeight <= 0) {
    return { ok: false, error: "bitquery answered but returned no Robinhood Chain blocks" };
  }
  return { ok: true, data: { blockHeight } };
}

export interface NewPair {
  /** The non-cash token in the pair, lowercased. */
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  /** What it pairs against (USDG or WETH), lowercased. */
  quote: `0x${string}`;
  /** Uniswap protocol the pool belongs to, as Bitquery reports it. */
  protocol: string;
  /** Unix seconds the pool was initialized. */
  createdAt: number;
  txHash: string;
}

/**
 * Pools initialized in the last `sinceMinutes`.
 *
 * `Initialize` is emitted by v3 factories and by the v4 PoolManager alike, which
 * is why this is the one query that sees a graduating token at all: a v4 pool
 * has no address of its own to watch.
 *
 * Returns candidates, not recommendations. Everything downstream still has to
 * decide whether a pool minutes old can be priced at all — and by the standards
 * merrymen already applies, usually it cannot: a fresh pool has no TWAP history
 * and almost no depth, which is exactly the shape the guards refuse.
 */
export async function recentPools(
  creds: BitqueryCreds,
  opts: { sinceMinutes?: number; limit?: number } = {},
): Promise<BitqueryResult<NewPair[]>> {
  const limit = Math.min(opts.limit ?? 25, 100);
  const sinceMinutes = opts.sinceMinutes ?? 60;
  const q = `query ($since: DateTime, $limit: Int) {
    EVM(network: ${BITQUERY_NETWORK}) {
      Events(
        limit: {count: $limit}
        orderBy: {descending: Block_Time}
        where: {Log: {Signature: {Name: {is: "Initialize"}}}, Block: {Time: {after: $since}}}
      ) {
        Block { Time }
        Transaction { Hash }
        Log { Signature { Name } }
        Arguments { Name Value { ... on EVM_ABI_Address_Value_Arg { address } } }
      }
    }
  }`;
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  const r = await bitqueryQuery<{ EVM?: { Events?: unknown[] } }>(creds, q, { since, limit });
  if (!r.ok) return { ok: false, error: r.error };
  // Shape-parse defensively: this is third-party JSON reaching a trading agent,
  // and a schema change must degrade to "nothing found", not to a crash.
  const out: NewPair[] = [];
  for (const ev of r.data?.EVM?.Events ?? []) {
    const parsed = parsePoolEvent(ev);
    if (parsed) out.push(parsed);
  }
  return { ok: true, data: out };
}

/** Pure, exported for tests: third-party JSON → a NewPair, or null. */
export function parsePoolEvent(ev: unknown): NewPair | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as {
    Block?: { Time?: string };
    Transaction?: { Hash?: string };
    Arguments?: { Name?: string; Value?: { address?: string } }[];
  };
  const addrs: string[] = [];
  for (const a of e.Arguments ?? []) {
    const v = a?.Value?.address;
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) addrs.push(v.toLowerCase());
  }
  if (addrs.length < 2) return null;
  const time = e.Block?.Time ? Math.floor(new Date(e.Block.Time).getTime() / 1000) : 0;
  if (!Number.isFinite(time) || time <= 0) return null;
  const hash = typeof e.Transaction?.Hash === "string" ? e.Transaction.Hash : "";
  return {
    token: addrs[0] as `0x${string}`,
    symbol: "",
    decimals: 18,
    quote: addrs[1] as `0x${string}`,
    protocol: "uniswap",
    createdAt: time,
    txHash: hash,
  };
}
