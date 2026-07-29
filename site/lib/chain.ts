/**
 * A tiny Robinhood Chain reader for the browser — no dependency, no backend.
 *
 * The whole claim merrymen makes is "you don't have to trust us", so a page that
 * proxied this through a server of ours would be asking for exactly the trust
 * the project says you shouldn't extend. Everything here reads the chain's OWN
 * public infrastructure — the Blockscout explorer for history and the public RPC
 * for liveness — both of which serve `access-control-allow-origin: *`. There is
 * no key to leak and no server of ours in the path. Open the network tab and
 * every request is to a host you can verify independently.
 *
 * HISTORY COMES FROM THE EXPLORER, NOT FROM RAW LOGS. The first version of this
 * scanned `eth_getLogs` and halved the range whenever the node refused. On a
 * chain producing a block every 0.1s with ~12 transfers in each, a one-hour
 * window for an active account needed six levels of splitting — up to 128
 * requests for a single page load, which the browser simply refused. Blockscout
 * answers the same question in one request, with symbol, decimals and timestamp
 * already resolved. Fewer moving parts and a far better answer.
 */

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** One token movement in or out of the watched account. */
export interface Leg {
  token: string;
  amount: bigint;
  meta: TokenMeta;
}

/** One transaction, read as a trade: what left the account and what arrived. */
export interface Trade {
  txHash: string;
  timestamp: number | null;
  out: Leg[];
  in: Leg[];
}

export function isAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}

/**
 * A token's own name, made safe to render.
 *
 * Mirrors sanitizeSymbol in the worker and the gateway. A symbol is whatever an
 * anonymous deployer wrote into their contract, and the explorer passes it
 * through verbatim, so it reaches the DOM stripped to a known alphabet and
 * length-capped. React escapes HTML on its own — what stripping adds is removing
 * the right-to-left overrides and zero-width joiners that let a token render as
 * a convincing copy of a different one.
 */
export function sanitizeSymbol(raw: unknown): string {
  if (typeof raw !== "string") return "?";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
  return cleaned.length > 0 ? cleaned : "?";
}

export function formatAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(Math.max(0, Math.min(36, decimals)));
  const whole = amount / base;
  const frac = amount % base;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  // Below a millionth of a unit renders as "0" and reads like a bug.
  if (whole === 0n && fracStr === "") return "<0.000001";
  return `${whole.toLocaleString()}${fracStr ? `.${fracStr}` : ""}`;
}

export function ageOf(seconds: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** Current block height — one cheap call, purely so the page can prove it's live. */
export async function headBlock(): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "rpc error");
  return Number(BigInt(json.result));
}

interface BsTransfer {
  transaction_hash?: string;
  tx_hash?: string;
  timestamp?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  token?: { address?: string; address_hash?: string; symbol?: string; decimals?: string | number };
  total?: { value?: string; decimals?: string | number };
}

/**
 * ERC-20 transfers touching `account`, newest first, grouped into trades.
 *
 * A swap is not a transfer — it's a matched pair of them inside one
 * transaction. Grouping by transaction is what turns a raw ledger into
 * "sold 100 USDG, bought 4,200 PEPE", and it's also what makes a multi-hop
 * route read as the single trade it actually was rather than three.
 */
export async function fetchTrades(account: string, signal?: AbortSignal): Promise<Trade[]> {
  const url = `${EXPLORER}/api/v2/addresses/${account}/token-transfers?type=ERC-20`;
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`explorer ${res.status}`);
  const json = (await res.json()) as { items?: BsTransfer[] };
  const items = Array.isArray(json.items) ? json.items : [];
  const me = account.toLowerCase();

  const byTx = new Map<string, { ts: number | null; out: Map<string, Leg>; in: Map<string, Leg> }>();

  for (const it of items) {
    const txHash = it.transaction_hash || it.tx_hash;
    if (!txHash) continue;
    const token = (it.token?.address || it.token?.address_hash || "").toLowerCase();
    if (!token) continue;

    const rawValue = it.total?.value;
    if (typeof rawValue !== "string" || !/^\d+$/.test(rawValue)) continue;
    const amount = BigInt(rawValue);
    if (amount === 0n) continue;

    const decimals = Number(it.total?.decimals ?? it.token?.decimals ?? 18);
    const meta: TokenMeta = {
      symbol: sanitizeSymbol(it.token?.symbol),
      decimals: Number.isFinite(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18,
    };

    const ts = it.timestamp ? Math.floor(new Date(it.timestamp).getTime() / 1000) : null;
    const entry = byTx.get(txHash) ?? {
      ts: Number.isFinite(ts as number) ? ts : null,
      out: new Map<string, Leg>(),
      in: new Map<string, Leg>(),
    };

    const from = it.from?.hash?.toLowerCase();
    const to = it.to?.hash?.toLowerCase();
    // A transaction can move the same token more than once — a multi-hop route
    // through the same pool, say — so legs accumulate rather than overwrite.
    const add = (side: Map<string, Leg>) => {
      const prev = side.get(token);
      side.set(token, { token, amount: (prev?.amount ?? 0n) + amount, meta });
    };
    if (from === me) add(entry.out);
    if (to === me) add(entry.in);
    byTx.set(txHash, entry);
  }

  const trades: Trade[] = [...byTx]
    .map(([txHash, e]) => ({ txHash, timestamp: e.ts, out: [...e.out.values()], in: [...e.in.values()] }))
    // Drop transactions where the account neither sent nor received anything,
    // which can happen when the explorer includes a transfer between two other
    // parties inside a transaction this account merely appears in.
    .filter((t) => t.out.length > 0 || t.in.length > 0);

  trades.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return disambiguate(trades);
}

/**
 * Where two DIFFERENT contracts claim the same symbol, show which is which.
 *
 * This is not hypothetical tidying. On this chain right now, "GME" is two
 * unrelated contracts and so is "PIPEDOG" — anyone can deploy a token and name
 * it whatever they like, and impersonating a real ticker is the oldest trick
 * there is. Rendering both as a bare "GME" on a page people use to check what
 * their agent actually bought would be actively misleading, so a colliding
 * symbol carries a slice of its address and stops being a claim you have to
 * take on faith.
 */
function disambiguate(trades: Trade[]): Trade[] {
  const addrsBySymbol = new Map<string, Set<string>>();
  for (const t of trades) {
    for (const l of [...t.out, ...t.in]) {
      const set = addrsBySymbol.get(l.meta.symbol) ?? new Set<string>();
      set.add(l.token);
      addrsBySymbol.set(l.meta.symbol, set);
    }
  }
  const colliding = new Set([...addrsBySymbol].filter(([, s]) => s.size > 1).map(([sym]) => sym));
  if (colliding.size === 0) return trades;

  const mark = (l: Leg): Leg =>
    colliding.has(l.meta.symbol)
      ? { ...l, meta: { ...l.meta, symbol: `${l.meta.symbol}·${l.token.slice(2, 6)}` } }
      : l;
  return trades.map((t) => ({ ...t, out: t.out.map(mark), in: t.in.map(mark) }));
}
