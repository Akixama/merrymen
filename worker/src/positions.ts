/**
 * ERC-8056 (Scaled UI Amount) position accounting.
 *
 * Stock Token raw balances NEVER rebase — corporate actions (splits, stock
 * dividends) adjust uiMultiplier() instead. Every position valuation must go
 * through the multiplier: on a 2-for-1 split the multiplier doubles and the
 * reference price halves, so value is unchanged. Skipping the multiplier makes
 * a split look like a 50% crash and trips the drawdown breaker on nothing.
 *
 * UI shares  = rawBalance × uiMultiplier / 1e18
 * USD value  = UI shares × chainlinkPrice / 1e8
 * USDG (6dp) = USD value × 1e6
 */

import type { PublicClient } from "viem";
import { STOCK_ABI, type PriceQuote, type StockToken } from "../../packages/core/src/index";

/** One valued holding. price8 = USD price, 8 decimals. */
export interface Position {
  symbol: string;
  token: `0x${string}`;
  /** Raw ERC-20 balance in the token's own decimals — what transfer() moves. */
  rawBalance: bigint;
  /** ERC-8056 multiplier, 1e18 = 1.0. Always 1e18 for non-ERC-8056 tokens. */
  uiMultiplier: bigint;
  /** ERC-20 decimals — 18 for stock tokens, whatever the owner declared otherwise. */
  decimals: number;
  /** USD price, 8dp. Stale on weekends by design (24/5 feeds). */
  price8: bigint;
  /** true when the feed is stale — value is the best available estimate. */
  priceStale: boolean;
  /**
   * Where price8 came from. A pool-priced holding is a weaker claim than a
   * Chainlink-priced one, and every surface that shows a value should be able to
   * say so rather than presenting both as the same kind of fact.
   */
  priceSource: PriceQuote["source"];
  /** Multiplier-aware value in USDG units (6dp). */
  valueUsdg: bigint;
}

/**
 * rawBalance(10^decimals) × uiMultiplier(1e18) × price8(1e8) → USDG(6dp).
 * Single division so precision is lost exactly once.
 *
 * `decimals` defaults to 18 — every Stock Token and WETH — but a memecoin can be
 * 6 or 9, and assuming 18 there would undervalue the position by a factor of a
 * billion. Equity feeds the drawdown breaker, so that is not a display bug.
 */
export function positionValueUsdg(args: {
  rawBalance: bigint;
  uiMultiplier: bigint;
  price8: bigint;
  decimals?: number;
}): bigint {
  const decimals = args.decimals ?? 18;
  // denominator: 10^decimals (raw) × 1e18 (multiplier unit) × 1e8 (price dp) / 1e6 (USDG dp)
  const DENOM = 10n ** BigInt(decimals + 20);
  return (args.rawBalance * args.uiMultiplier * args.price8) / DENOM;
}

export interface PositionsRead {
  positions: Position[];
  /**
   * Held (balance > 0) but unvaluable THIS READ, even though a price feed is
   * configured — the multiplier reverted, or the feed read failed. Valuing these
   * at zero would crater equity and can trip the drawdown breaker on a transient
   * RPC hiccup, so the caller treats the snapshot as incomplete and retries.
   * TRANSIENT by definition: the next tick usually fixes it.
   */
  missingPrice: string[];
  /**
   * Held, but the asset has NO price feed configured at all (chainlinkFeed:
   * null) — every memecoin, and any token whose feed was withdrawn.
   *
   * This is the crucial difference: a missing feed NEVER recovers, so treating it
   * like a transient gap and waiting made the tick halt forever — no equity, no
   * breaker, no strategy run, and therefore NO WAY TO SELL OUT of the position.
   * The caller must not value these, but must also not freeze because of them.
   */
  unpricedByDesign: string[];
}

/**
 * Read balances + multipliers for `tokens` from the account's chain and value
 * them with the supplied mainnet Chainlink prices. Tokens that don't exist on
 * the account's chain (testnet demo) read as zero and are dropped. A token that
 * IS held but can't be valued (feed/multiplier read failed) is reported in
 * `missingPrice` — never silently valued at zero.
 */
/** 1.0 in ERC-8056's fixed-point convention. */
export const UI_MULTIPLIER_ONE = 10n ** 18n;

/**
 * Which multiplier a price source's unit implies.
 *
 * A Chainlink feed quotes USD per ERC-8056 UI SHARE, so the multiplier converts
 * raw → shares before pricing. A pool quotes USD per WHOLE ERC-20 TOKEN, and a
 * broker quotes USD per SHARE AS THE BROKER COUNTS IT — in both cases the
 * market's own unit, which already reflects any split. Applying the multiplier
 * to those counts the split twice: after a 2-for-1 the position reads double,
 * the high-water mark ratchets to a peak that never happened, a performance fee
 * accrues on it, and the drawdown breaker trips when the phantom unwinds.
 *
 * An exhaustive switch on purpose. This used to be `source === "pool" ? 1e18 :
 * uiMultiplier`, where every FUTURE source silently fell into the Chainlink arm
 * — which is exactly the wrong default for every source added since, "broker"
 * included. Now a new member of the union fails to compile until someone
 * decides its unit here, on this comment, deliberately.
 */
export function valuationMultiplierFor(source: PriceQuote["source"], uiMultiplier: bigint): bigint {
  switch (source) {
    case "chainlink":
      return uiMultiplier;
    case "pool":
    case "broker":
      return UI_MULTIPLIER_ONE;
    default: {
      const never: never = source;
      throw new Error(`unhandled price source: ${String(never)}`);
    }
  }
}

/**
 * Just the multipliers, for callers with no on-chain balance to read.
 *
 * Paper mode needs these and can't get them from readPositions: it never queries
 * balances, because the book IS the ledger. But uiMultiplier is a property of the
 * TOKEN, not of any holding — it's just as real for a simulated position as a
 * funded one. Without it a stock split halves the paper book overnight and trips
 * the drawdown breaker on a corporate action that cost nobody anything.
 *
 * Fails closed exactly like readPositions: a token whose multiplier can't be read
 * lands in `unreadable` rather than defaulting to 1.0, because silently assuming
 * 1.0 after a split is the mis-pricing this whole file exists to prevent.
 */
export async function readMultipliers(
  client: PublicClient,
  tokens: readonly StockToken[],
): Promise<{ multipliers: Map<string, bigint>; unreadable: string[] }> {
  const multipliers = new Map<string, bigint>();
  const unreadable: string[] = [];

  // Same rule as readPositions: ERC-8056 is a Stock Token thing. Asking a
  // memecoin would revert, and honouring whatever a random contract returned
  // would let it scale the owner's equity.
  const scaled = tokens.filter((t) => t.kind !== "memecoin");
  for (const t of tokens) if (t.kind === "memecoin") multipliers.set(t.symbol, UI_MULTIPLIER_ONE);
  if (scaled.length === 0) return { multipliers, unreadable };

  type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
  const results = (await client
    .multicall({
      contracts: scaled.map((t) => ({ address: t.address, abi: STOCK_ABI, functionName: "uiMultiplier" })) as never,
    })
    .catch(() => null)) as CallResult[] | null;
  if (!results) return { multipliers, unreadable: scaled.map((t) => t.symbol) };

  scaled.forEach((t, i) => {
    const r = results[i];
    if (r?.status === "success" && typeof r.result === "bigint" && r.result > 0n) multipliers.set(t.symbol, r.result);
    else unreadable.push(t.symbol);
  });
  return { multipliers, unreadable };
}

export async function readPositions(
  client: PublicClient,
  account: `0x${string}`,
  tokens: readonly StockToken[],
  prices: ReadonlyMap<string, PriceQuote>,
): Promise<PositionsRead> {
  // ERC-8056 is a Stock Token thing. An owner-added memecoin has no
  // uiMultiplier() at all, so asking would revert and get read as "held but
  // unvaluable" — the transient gap that halts the tick forever. Worse, if some
  // token DID expose the selector, honouring whatever it returned would let an
  // arbitrary contract scale the owner's equity (and the drawdown breaker with
  // it). So we don't ask, and we don't look: non-ERC-8056 tokens are 1.0, flat.
  const isScaled = (t: StockToken) => t.kind !== "memecoin";

  // Index bookkeeping, because the contracts-per-token count now varies.
  const slots: { token: StockToken; balAt: number; multAt: number | null }[] = [];
  const contracts: {
    address: `0x${string}`;
    abi: typeof STOCK_ABI;
    functionName: string;
    args?: readonly unknown[];
  }[] = [];
  for (const t of tokens) {
    const balAt = contracts.length;
    contracts.push({ address: t.address, abi: STOCK_ABI, functionName: "balanceOf", args: [account] });
    let multAt: number | null = null;
    if (isScaled(t)) {
      multAt = contracts.length;
      contracts.push({ address: t.address, abi: STOCK_ABI, functionName: "uiMultiplier" });
    }
    slots.push({ token: t, balAt, multAt });
  }

  // viem infers per-call result types from a literal tuple; this array is built
  // at runtime (memecoins contribute one call, Stock Tokens two), so the shape is
  // asserted here instead. Each entry is still checked for success below.
  type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
  const results = (await client
    .multicall({ contracts: contracts as never })
    .catch(() => null)) as CallResult[] | null;
  // Whole read failed — we can't tell held from unheld. Report nothing valued and
  // no coverage; the tick can't trust this, but "" avoids a per-symbol miss list.
  if (!results) return { positions: [], missingPrice: [], unpricedByDesign: [] };

  const positions: Position[] = [];
  const missingPrice: string[] = [];
  const unpricedByDesign: string[] = [];
  for (const { token: t, balAt, multAt } of slots) {
    const bal = results[balAt];
    if (bal?.status !== "success") continue; // balance unreadable → can't say it's held
    const rawBalance = bal.result as bigint;
    if (rawBalance === 0n) continue; // genuinely not held — not a coverage gap

    // Held, but unvaluable: an unreadable multiplier mis-prices post-split. Fail
    // closed — flag, don't drop. (Only ERC-8056 tokens have one to read.)
    let uiMultiplier = 10n ** 18n;
    if (multAt !== null) {
      const mult = results[multAt];
      if (mult?.status !== "success") {
        missingPrice.push(t.symbol);
        continue;
      }
      uiMultiplier = mult.result as bigint;
    }

    const price = prices.get(t.symbol);
    if (!price || price.price8 <= 0n) {
      // No feed CONFIGURED is a permanent condition, not a hiccup — waiting for
      // it to clear would trap the position forever. Kept separate so the caller
      // can keep trading (and therefore selling) instead of freezing.
      if (t.chainlinkFeed === null) unpricedByDesign.push(t.symbol);
      else missingPrice.push(t.symbol);
      continue;
    }

    const decimals = t.decimals ?? 18;
    const valuationMultiplier = valuationMultiplierFor(price.source, uiMultiplier);
    positions.push({
      symbol: t.symbol,
      token: t.address,
      rawBalance,
      uiMultiplier,
      decimals,
      price8: price.price8,
      priceStale: price.stale,
      priceSource: price.source,
      valueUsdg: positionValueUsdg({
        rawBalance,
        uiMultiplier: valuationMultiplier,
        price8: price.price8,
        decimals,
      }),
    });
  }
  return { positions, missingPrice, unpricedByDesign };
}
