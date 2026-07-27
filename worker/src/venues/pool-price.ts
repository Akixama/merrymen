/**
 * DEX price for assets with no Chainlink feed — the second step of memecoin
 * support, and the one that decides whether the safety wall stays real.
 *
 * WHY THIS IS DELICATE. Chainlink is what makes merrymen's valuation
 * trustworthy: it's an external, expensive-to-move number. A DEX pool is not —
 * on a thin memecoin pool, anyone with moderate capital can push the spot price
 * for one block. That price would otherwise feed equity, P&L and the DRAWDOWN
 * BREAKER, so trusting spot would let an outsider fake your net worth or trip
 * your circuit breaker on demand. The safety wall would become decorative.
 *
 * THE SPLIT THIS MODULE IMPLEMENTS:
 *   • TWAP  → valuation and safety (equity, P&L, the breaker). Time-averaged
 *             through the pool's own oracle, so moving it means holding the
 *             price away from the market for the whole window and eating the
 *             arbitrage — expensive, not free.
 *   • SPOT  → execution sizing only. What you'd actually trade at right now.
 *             Wrong-but-current beats right-but-stale when you're sizing a swap.
 *
 * Plus two refusals, because a price you can't trust is worse than no price:
 *   • a LIQUIDITY FLOOR — a pool too thin to value is simply refused
 *   • a DIVERGENCE BAND — spot far from TWAP means someone is pushing the pool
 *     right now; refuse rather than trade into it
 *
 * Everything is quoted as USDG-per-whole-token in 8dp (`price8`), the same unit
 * Chainlink feeds already produce, so positionValueUsdg and the entire asset
 * model downstream need no changes at all.
 */

import { parseAbi, type PublicClient } from "viem";
import { UNISWAP } from "../../../packages/core/src/index";
import { FEE_TIERS } from "./uniswap";

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)",
]);

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Default averaging window. Long enough that moving it costs real money, short
 * enough to track an asset that genuinely reprices in minutes. */
export const DEFAULT_TWAP_WINDOW_SEC = 900; // 15 minutes

export interface PoolPrice {
  pool: `0x${string}`;
  fee: number;
  /** TWAP, USDG per whole token, 8dp — use for valuation and safety. */
  price8: bigint;
  /** Spot, same units — use for execution sizing only. */
  spot8: bigint;
  /** USDG sitting in the pool (6dp) — the honest "how deep is this" number. */
  liquidityUsdg: bigint;
  twapWindowSec: number;
  /** |spot − twap| / twap, in bps. Large ⇒ the pool is being pushed right now. */
  divergenceBps: number;
}

// ── pure math (exported for tests; no RPC, no clock) ────────────────────────

/**
 * Convert a Uniswap v3 tick to USDG-per-whole-token at 8dp.
 *
 * A tick encodes token1_raw per token0_raw as 1.0001^tick. Two adjustments turn
 * that into a human price: invert when the token is token1 rather than token0,
 * and shift by the decimal difference between the two sides.
 *
 * Float exponentiation is deliberate. price8 carries 8 decimal places and a
 * double holds ~15 significant digits, so the rounding is far below the least
 * significant digit we emit — and the alternative (exact bigint 1.0001^n) costs
 * far more than the precision is worth for a valuation number.
 */
export function tickToPrice8(args: {
  tick: number;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  cashDecimals: number;
}): bigint {
  const ratio = Math.pow(1.0001, args.tick); // token1_raw per token0_raw
  const shift = Math.pow(10, args.tokenDecimals - args.cashDecimals);
  // token0 = TOKEN → ratio is cash per token; token0 = CASH → invert.
  const human = args.tokenIsToken0 ? ratio * shift : shift / ratio;
  if (!Number.isFinite(human) || human <= 0) return 0n;
  return BigInt(Math.round(human * 1e8));
}

/** Same, from slot0's sqrtPriceX96. (sqrt/2^96)² is token1_raw per token0_raw. */
export function sqrtPriceX96ToPrice8(args: {
  sqrtPriceX96: bigint;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  cashDecimals: number;
}): bigint {
  const sqrt = Number(args.sqrtPriceX96) / 2 ** 96;
  const ratio = sqrt * sqrt;
  const shift = Math.pow(10, args.tokenDecimals - args.cashDecimals);
  const human = args.tokenIsToken0 ? ratio * shift : shift / ratio;
  if (!Number.isFinite(human) || human <= 0) return 0n;
  return BigInt(Math.round(human * 1e8));
}

/** Mean tick over the window, from the two cumulative readings observe() gives. */
export function meanTick(tickCumulatives: readonly bigint[], windowSec: number): number | null {
  if (tickCumulatives.length < 2 || windowSec <= 0) return null;
  const older = tickCumulatives[0];
  const newer = tickCumulatives[1];
  if (older === undefined || newer === undefined) return null;
  // observe() returns [olderCumulative, newerCumulative] for [windowSec, 0].
  return Number(newer - older) / windowSec;
}

/** |a − b| / b in bps. Zero when the reference is zero (nothing to compare to). */
export function divergenceBps(spot8: bigint, twap8: bigint): number {
  if (twap8 <= 0n) return 0;
  const diff = spot8 > twap8 ? spot8 - twap8 : twap8 - spot8;
  return Number((diff * 10_000n) / twap8);
}

export interface PriceGuard {
  /** Refuse pools shallower than this (USDG, 6dp). */
  minLiquidityUsdg: bigint;
  /** Refuse when spot has run this far from the TWAP — someone's pushing it. */
  maxDivergenceBps: number;
}

/**
 * Is this price safe to act on? A refusal is a feature: valuing a position off a
 * pool that can be moved for pocket change is how a "safe" agent gets drained.
 */
export function poolPriceUsable(p: PoolPrice, guard: PriceGuard): { ok: true } | { ok: false; reason: string } {
  if (p.price8 <= 0n) return { ok: false, reason: "no usable TWAP from the pool" };
  if (p.liquidityUsdg < guard.minLiquidityUsdg) {
    return {
      ok: false,
      reason: `pool too thin: ${Number(p.liquidityUsdg) / 1e6} USDG < ${Number(guard.minLiquidityUsdg) / 1e6} floor`,
    };
  }
  if (p.divergenceBps > guard.maxDivergenceBps) {
    return {
      ok: false,
      reason: `spot is ${(p.divergenceBps / 100).toFixed(1)}% off the ${p.twapWindowSec}s TWAP — pool may be under manipulation`,
    };
  }
  return { ok: true };
}

/**
 * Combine two TWAP legs into one price: TOKEN→WETH→USDG.
 *
 * ON-CHAIN REALITY (checked against live Robinhood Chain pools, 2026-07):
 * roughly three quarters of pools quote against WETH, not USDG — CATE, VIRTUAL,
 * KITTY, GRAILS, POTUS, HOODER and friends all pair with WETH. Only the stock
 * tokens (nvda, gme) and a couple of others have direct USDG pairs. So a
 * memecoin price is nearly always two hops, and pricing that assumed a direct
 * cash pair would simply find nothing for most of the chain.
 *
 * The depth of a two-hop route is the SHALLOWER leg — a deep WETH/USDG pool
 * does not make a $3k memecoin pool safe to value.
 */
export function combineLegs(tokenPerWeth8: bigint, wethPerCash8: bigint): bigint {
  if (tokenPerWeth8 <= 0n || wethPerCash8 <= 0n) return 0n;
  return (tokenPerWeth8 * wethPerCash8) / 100_000_000n; // both 8dp → keep 8dp
}

// ── on-chain read ───────────────────────────────────────────────────────────

/**
 * Read TWAP + spot + depth for one token against the cash leg, picking the fee
 * tier with the deepest cash. Returns null when no pool exists or the oracle
 * can't serve the window.
 */
export async function readPoolPrice(
  client: PublicClient,
  args: {
    token: `0x${string}`;
    tokenDecimals: number;
    cash: `0x${string}`;
    cashDecimals: number;
    windowSec?: number;
  },
): Promise<PoolPrice | null> {
  const windowSec = args.windowSec ?? DEFAULT_TWAP_WINDOW_SEC;

  const pools = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const pool = (await client.readContract({
          address: UNISWAP.v3Factory as `0x${string}`,
          abi: FACTORY_ABI,
          functionName: "getPool",
          args: [args.token, args.cash, fee],
        })) as `0x${string}`;
        if (!pool || /^0x0{40}$/i.test(pool)) return null;
        const cashInPool = (await client.readContract({
          address: args.cash,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [pool],
        })) as bigint;
        return { fee, pool, cashInPool };
      } catch {
        return null;
      }
    }),
  );

  // Deepest cash wins — that's the pool a trade would actually route through.
  let best: { fee: number; pool: `0x${string}`; cashInPool: bigint } | null = null;
  for (const p of pools) if (p && (!best || p.cashInPool > best.cashInPool)) best = p;
  if (!best || best.cashInPool === 0n) return null;

  try {
    const [token0, slot0] = await Promise.all([
      client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "token0" }) as Promise<`0x${string}`>,
      client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "slot0" }) as Promise<
        readonly [bigint, number, number, number, number, number, boolean]
      >,
    ]);
    const tokenIsToken0 = token0.toLowerCase() === args.token.toLowerCase();
    const shape = {
      tokenIsToken0,
      tokenDecimals: args.tokenDecimals,
      cashDecimals: args.cashDecimals,
    };

    const spot8 = sqrtPriceX96ToPrice8({ sqrtPriceX96: slot0[0], ...shape });

    // A brand-new pool has observation cardinality 1, so observe() over any real
    // window reverts. That is a legitimate "no TWAP yet", not an error — and it
    // must NOT silently degrade to spot, which is the whole thing we're avoiding.
    let twap8 = 0n;
    try {
      const [tickCumulatives] = (await client.readContract({
        address: best.pool,
        abi: POOL_ABI,
        functionName: "observe",
        args: [[windowSec, 0]],
      })) as readonly [readonly bigint[], readonly bigint[]];
      const tick = meanTick(tickCumulatives, windowSec);
      if (tick !== null) twap8 = tickToPrice8({ tick, ...shape });
    } catch {
      twap8 = 0n; // oracle can't serve this window — poolPriceUsable will refuse
    }

    return {
      pool: best.pool,
      fee: best.fee,
      price8: twap8,
      spot8,
      liquidityUsdg: best.cashInPool,
      twapWindowSec: windowSec,
      divergenceBps: divergenceBps(spot8, twap8),
    };
  } catch {
    return null;
  }
}

export interface RoutedPrice {
  /** TWAP, USD per whole token, 8dp — valuation and safety. */
  price8: bigint;
  /** Spot, same units — execution sizing only. */
  spot8: bigint;
  /** "direct" (TOKEN/USDG) or "weth" (TOKEN/WETH × WETH/USDG). */
  route: "direct" | "weth";
  /** USD depth of the SHALLOWEST leg — what actually bounds manipulation cost. */
  liquidityUsdg: bigint;
  /** Worst divergence across the legs. */
  divergenceBps: number;
  twapWindowSec: number;
}

/**
 * Price one token in USD, routing through WETH when there's no direct cash pair.
 *
 * Tries the direct TOKEN/USDG pool first (stock tokens, PONS), then falls back
 * to TOKEN/WETH priced through WETH/USDG — which is how most of this chain's
 * memecoins actually trade. Returns null when neither route exists.
 *
 * The caller still runs poolPriceUsable() on the result: routing finds a price,
 * it does not vouch for one.
 */
export async function readRoutedPrice(
  client: PublicClient,
  args: {
    token: `0x${string}`;
    tokenDecimals: number;
    cash: `0x${string}`;
    cashDecimals: number;
    weth: `0x${string}`;
    wethDecimals?: number;
    windowSec?: number;
  },
): Promise<RoutedPrice | null> {
  const windowSec = args.windowSec ?? DEFAULT_TWAP_WINDOW_SEC;
  const wethDecimals = args.wethDecimals ?? 18;

  // Same token on both sides would "price" WETH against itself.
  const isWeth = args.token.toLowerCase() === args.weth.toLowerCase();

  const direct = await readPoolPrice(client, {
    token: args.token,
    tokenDecimals: args.tokenDecimals,
    cash: args.cash,
    cashDecimals: args.cashDecimals,
    windowSec,
  });
  if (direct && direct.price8 > 0n) {
    return {
      price8: direct.price8,
      spot8: direct.spot8,
      route: "direct",
      liquidityUsdg: direct.liquidityUsdg,
      divergenceBps: direct.divergenceBps,
      twapWindowSec: windowSec,
    };
  }
  if (isWeth) return null; // no direct WETH/USDG pool and nothing to hop through

  // Two hops. Both legs are read in parallel — they're independent pools.
  const [leg, wethLeg] = await Promise.all([
    readPoolPrice(client, {
      token: args.token,
      tokenDecimals: args.tokenDecimals,
      cash: args.weth,
      cashDecimals: wethDecimals,
      windowSec,
    }),
    readPoolPrice(client, {
      token: args.weth,
      tokenDecimals: wethDecimals,
      cash: args.cash,
      cashDecimals: args.cashDecimals,
      windowSec,
    }),
  ]);
  if (!leg || !wethLeg || leg.price8 <= 0n || wethLeg.price8 <= 0n) return null;

  // The TOKEN/WETH pool's depth is denominated in WETH, so convert it to USD
  // before comparing against a USD floor.
  const legDepthUsdg = (leg.liquidityUsdg * wethLeg.price8) / 100_000_000n;

  return {
    price8: combineLegs(leg.price8, wethLeg.price8),
    spot8: combineLegs(leg.spot8, wethLeg.spot8),
    route: "weth",
    // A deep WETH/USDG pool does NOT make a shallow memecoin pool safe: the
    // route is only as manipulable as its thinnest leg.
    liquidityUsdg: legDepthUsdg < wethLeg.liquidityUsdg ? legDepthUsdg : wethLeg.liquidityUsdg,
    divergenceBps: Math.max(leg.divergenceBps, wethLeg.divergenceBps),
    twapWindowSec: windowSec,
  };
}
