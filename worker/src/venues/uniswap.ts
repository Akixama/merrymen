/**
 * Uniswap v3 direct execution — the permissionless swap venue.
 *
 * Rialto's /quote API needs integrator onboarding; Uniswap v3 needs nobody's
 * permission. Flow per swap: QuoterV2 simulation across fee tiers (this IS the
 * pre-trade simulation — it reverts where the swap would revert and returns a
 * gas estimate we store as the receipt) → slippage-bounded minOut →
 * exactInputSingle through SwapRouter02.
 *
 * LIQUIDITY REALITY (2026-07): stock-token v3 pools are seed-sized. The quoter
 * tells us the truth about impact before any money moves — a missing pool or
 * dust liquidity shows up as no-quote/terrible-quote and the trade is skipped
 * by the impact guard upstream.
 */

import { encodeFunctionData, parseAbi, type Hex, type PublicClient } from "viem";
import { UNISWAP, UNISWAP_SWAP_ROUTER_ABI } from "../../../packages/core/src/index";

/** Fee tiers to scan, most-likely-liquid first. */
export const FEE_TIERS = [500, 3000, 10000] as const;

export const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export interface Quote {
  fee: number;
  amountOut: bigint;
  gasEstimate: bigint;
  /**
   * The hops, in order, when this quote is multi-hop. Absent = a direct
   * single-hop swap, which is what most of this file's callers still produce.
   */
  path?: { tokens: readonly `0x${string}`[]; fees: readonly number[] };
}

/**
 * Pack a Uniswap v3 path: token(20) fee(3) token(20) [fee(3) token(20)]…
 *
 * The router walks this itself and holds the intermediate leg, which is the
 * detail that matters for the permission wall: a USDG→WETH→CATE swap still only
 * ever pulls USDG from the account, so it needs no approval beyond the one every
 * grant already carries. Multi-hop widens where a trade can GO, never what the
 * key can TOUCH.
 */
export function encodePath(
  tokens: readonly `0x${string}`[],
  fees: readonly number[],
): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error(`bad path: ${tokens.length} tokens, ${fees.length} fees`);
  }
  let out = "0x";
  tokens.forEach((t, i) => {
    out += t.slice(2).toLowerCase();
    if (i < fees.length) out += fees[i]!.toString(16).padStart(6, "0");
  });
  return out as Hex;
}

/** Highest amountOut wins; null when no tier has a pool with liquidity. */
export function pickBestQuote(quotes: readonly (Quote | null)[]): Quote | null {
  let best: Quote | null = null;
  for (const q of quotes) {
    if (q && q.amountOut > 0n && (!best || q.amountOut > best.amountOut)) best = q;
  }
  return best;
}

/** minOut = quoted × (10000 − slippageBps) / 10000, floor semantics. */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Quote one tier via eth_call simulation; null = no pool / no liquidity there. */
export async function quoteTier(
  client: PublicClient,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; fee: number },
): Promise<Quote | null> {
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP.v3QuoterV2 as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amountIn,
          fee: args.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const [amountOut, , , gasEstimate] = result;
    return { fee: args.fee, amountOut, gasEstimate };
  } catch {
    return null;
  }
}

/** Quote one explicit multi-hop path. null = some leg has no pool / no liquidity. */
export async function quotePath(
  client: PublicClient,
  args: { tokens: readonly `0x${string}`[]; fees: readonly number[]; amountIn: bigint },
): Promise<Quote | null> {
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP.v3QuoterV2 as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInput",
      args: [encodePath(args.tokens, args.fees), args.amountIn],
    });
    const [amountOut, , , gasEstimate] = result;
    if (amountOut <= 0n) return null;
    return {
      // Reported for the receipt only — a multi-hop swap has no single fee.
      fee: args.fees[0]!,
      amountOut,
      gasEstimate,
      path: { tokens: args.tokens, fees: args.fees },
    };
  } catch {
    return null;
  }
}

/** Scan all fee tiers concurrently and return the best executable quote. */
export async function bestQuote(
  client: PublicClient,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint },
): Promise<Quote | null> {
  const quotes = await Promise.all(FEE_TIERS.map((fee) => quoteTier(client, { ...args, fee })));
  return pickBestQuote(quotes);
}

/**
 * Best executable quote allowing ONE intermediate hop through `via` (WETH).
 *
 * Direct-only execution was leaving real tokens untradable. Live pools on
 * Robinhood Chain (2026-07-27): of the tokens merrymen can price, nine — UP,
 * YOLO, APES, MUMU, WEN, TYGR, WISHBONE, KITSU, wire — have no direct USDG pool
 * at all. They could be valued perfectly and never bought or sold, which is the
 * same trapped-position shape the no-exit rule exists to prevent, arrived at
 * from the execution side instead of the permission side.
 *
 * Every direct tier and every two-hop fee combination is quoted, and the best
 * amountOut wins outright — so a direct pool that happens to be better is still
 * chosen, and adding hops can only ever improve the fill the caller gets.
 */
export async function bestRoute(
  client: PublicClient,
  args: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    /** Intermediate token to try routing through. Omit to stay single-hop. */
    via?: `0x${string}`;
  },
): Promise<Quote | null> {
  const lc = (a: string) => a.toLowerCase();
  const direct = FEE_TIERS.map((fee) => quoteTier(client, { ...args, fee }));

  // Hopping through one of the endpoints is the same swap with extra steps.
  const viaUsable =
    args.via && lc(args.via) !== lc(args.tokenIn) && lc(args.via) !== lc(args.tokenOut);
  const hops = viaUsable
    ? FEE_TIERS.flatMap((a) =>
        FEE_TIERS.map((b) =>
          quotePath(client, {
            tokens: [args.tokenIn, args.via!, args.tokenOut],
            fees: [a, b],
            amountIn: args.amountIn,
          }),
        ),
      )
    : [];

  return pickBestQuote(await Promise.all([...direct, ...hops]));
}

export interface SwapCall {
  to: `0x${string}`;
  value: 0n;
  data: Hex;
}

/**
 * Build the swap call. Caller must have approved amountIn of tokenIn to the router.
 *
 * Pass the quote's `path` to execute the multi-hop route it found — the router
 * still only pulls tokenIn, so this needs no permission the single-hop form
 * didn't. Executing a single-hop call for a quote that was multi-hop would
 * silently trade a DIFFERENT (worse, or non-existent) route than the one whose
 * minOut the caller computed, so the two must be threaded together.
 */
export function buildSwapCall(args: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  recipient: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  path?: { tokens: readonly `0x${string}`[]; fees: readonly number[] };
}): SwapCall {
  if (args.path) {
    return {
      to: UNISWAP.swapRouter02 as `0x${string}`,
      value: 0n,
      data: encodeFunctionData({
        abi: UNISWAP_SWAP_ROUTER_ABI,
        functionName: "exactInput",
        args: [
          {
            path: encodePath(args.path.tokens, args.path.fees),
            recipient: args.recipient,
            amountIn: args.amountIn,
            amountOutMinimum: args.minAmountOut,
          },
        ],
      }),
    };
  }
  return {
    to: UNISWAP.swapRouter02 as `0x${string}`,
    value: 0n,
    data: encodeFunctionData({
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          fee: args.fee,
          recipient: args.recipient,
          amountIn: args.amountIn,
          amountOutMinimum: args.minAmountOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  };
}
