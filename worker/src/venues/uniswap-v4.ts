/**
 * Uniswap v4 execution — a different shape of venue, not just a newer one.
 *
 * WHAT CHANGES FROM v3, and why each change matters here:
 *
 *  1. NO FACTORY. Every pool lives inside one PoolManager, identified by a
 *     PoolKey hashed into a poolId. You don't look a pool up; you compute the id
 *     of a key you guessed and ask whether it's initialized. That works for
 *     vanilla pools and CANNOT work for hooked ones — a hook address is
 *     unguessable — so anything launched through Pons/Doppler needs its real
 *     PoolKey discovered (Bitquery Initialize events) before it can be touched.
 *
 *  2. PERMIT2, NOT approve(). The router never pulls tokens directly. The
 *     account approves Permit2 once, then Permit2 grants the router a bounded,
 *     EXPIRING allowance. That's two approvals per swap instead of one, and both
 *     are new call-policy targets — which is why v4 needs a re-signed grant and
 *     v3 didn't.
 *
 *  3. COMMANDS, NOT A FUNCTION CALL. UniversalRouter.execute takes a byte string
 *     of commands and a matching array of encoded inputs. A v4 swap is one
 *     command (V4_SWAP) whose input is itself an action list: do the swap, pay
 *     what you owe, take what you're owed. Getting the action order or the
 *     encoding wrong doesn't throw a type error — it reverts on-chain, or worse,
 *     settles a different amount than the minOut was computed for.
 *
 * Everything in this file is pure encoding plus read-only calls. Nothing here
 * decides WHETHER to trade; it only says what a trade would look like.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import { UNISWAP } from "../../../packages/core/src/index";

/** UniversalRouter command byte for "run these v4 actions". */
export const CMD_V4_SWAP = 0x10;

/** v4-periphery Actions. The three a spot swap needs, in the order it needs them. */
export const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
export const ACTION_SETTLE_ALL = 0x0c;
export const ACTION_TAKE_ALL = 0x0f;

/** Native ETH is address(0) in v4 and always sorts first. */
export const NATIVE = "0x0000000000000000000000000000000000000000" as const;

/** Hookless. A pool with hooks has a real address here and can't be guessed. */
export const NO_HOOKS = "0x0000000000000000000000000000000000000000" as const;

/**
 * (fee, tickSpacing) pairs Uniswap ships by default. Verified live on Robinhood
 * Chain 2026-07-28: 22 initialized hookless pools across these tiers, including
 * NVDA/QQQ/TSLA/AAPL/SPY against USDG and ETH/USDG natively. A hooked pool may
 * use any spacing, which is the other half of why hooks need discovery.
 */
export const V4_TIERS: readonly (readonly [fee: number, tickSpacing: number])[] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

export interface PoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

const POOL_KEY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

/** PoolKey → poolId, exactly as PoolManager derives it. */
export function poolId(key: PoolKey): `0x${string}` {
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [key]));
}

/**
 * Build a PoolKey with the currencies in v4's required order.
 *
 * Sorting is not cosmetic: currency0/currency1 are part of the hashed id, so a
 * key built in the wrong order addresses a pool that doesn't exist, and
 * `zeroForOne` — the swap's direction — is defined relative to that order.
 */
export function makePoolKey(
  a: `0x${string}`,
  b: `0x${string}`,
  fee: number,
  tickSpacing: number,
  hooks: `0x${string}` = NO_HOOKS,
): PoolKey {
  const lo = a.toLowerCase() as `0x${string}`;
  const hi = b.toLowerCase() as `0x${string}`;
  const [c0, c1] = lo < hi ? [lo, hi] : [hi, lo];
  return { currency0: c0, currency1: c1, fee, tickSpacing, hooks: hooks.toLowerCase() as `0x${string}` };
}

/** Is `tokenIn` currency0 of this key? Decides the swap direction. */
export function isZeroForOne(key: PoolKey, tokenIn: `0x${string}`): boolean {
  return key.currency0.toLowerCase() === tokenIn.toLowerCase();
}

export const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const V4_QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const PERMIT2_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

export const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

export interface V4Pool {
  key: PoolKey;
  id: `0x${string}`;
  /** In-range liquidity. Zero means initialized but nothing to trade against. */
  liquidity: bigint;
}

/**
 * Find the deepest initialized hookless pool for a pair.
 *
 * Returns null when nothing is initialized — which on this chain usually means
 * the liquidity is on v3, or the pool is hooked and therefore invisible to a
 * guessed key. Both are honest "not here", not errors.
 */
export async function findV4Pool(
  client: PublicClient,
  a: `0x${string}`,
  b: `0x${string}`,
): Promise<V4Pool | null> {
  const candidates = await Promise.all(
    V4_TIERS.map(async ([fee, tickSpacing]) => {
      const key = makePoolKey(a, b, fee, tickSpacing);
      const id = poolId(key);
      try {
        const slot0 = (await client.readContract({
          address: UNISWAP.v4StateView as `0x${string}`,
          abi: STATE_VIEW_ABI,
          functionName: "getSlot0",
          args: [id],
        })) as readonly [bigint, number, number, number];
        // sqrtPriceX96 == 0 is the canonical "never initialized" signal.
        if (slot0[0] === 0n) return null;
        const liquidity = (await client.readContract({
          address: UNISWAP.v4StateView as `0x${string}`,
          abi: STATE_VIEW_ABI,
          functionName: "getLiquidity",
          args: [id],
        })) as bigint;
        return { key, id, liquidity } satisfies V4Pool;
      } catch {
        return null;
      }
    }),
  );
  let best: V4Pool | null = null;
  for (const c of candidates) {
    // Depth decides, same as v3 routing: it's what bounds manipulation cost.
    if (c && c.liquidity > 0n && (!best || c.liquidity > best.liquidity)) best = c;
  }
  return best;
}

export interface V4Quote {
  key: PoolKey;
  zeroForOne: boolean;
  amountOut: bigint;
  gasEstimate: bigint;
}

/** Simulate a swap through the V4Quoter. null = no route / no liquidity. */
export async function quoteV4(
  client: PublicClient,
  args: { key: PoolKey; tokenIn: `0x${string}`; amountIn: bigint },
): Promise<V4Quote | null> {
  const zeroForOne = isZeroForOne(args.key, args.tokenIn);
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP.v4Quoter as `0x${string}`,
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: args.key, zeroForOne, exactAmount: args.amountIn, hookData: "0x" }],
    });
    const [amountOut, gasEstimate] = result as readonly [bigint, bigint];
    if (amountOut <= 0n) return null;
    return { key: args.key, zeroForOne, amountOut, gasEstimate };
  } catch {
    return null;
  }
}

// ── calldata ────────────────────────────────────────────────────────────────

/**
 * The V4_SWAP input: an action list plus one encoded parameter set per action.
 *
 * The three actions must stay in this order. SWAP registers what's owed and
 * owing; SETTLE_ALL pays the input side; TAKE_ALL collects the output. Reorder
 * them and the router either reverts or settles against a balance that isn't
 * there yet — a failure that only shows up on-chain, with real funds committed.
 */
export function encodeV4SwapInput(args: {
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
}): Hex {
  const currencyIn = args.zeroForOne ? args.key.currency0 : args.key.currency1;
  const currencyOut = args.zeroForOne ? args.key.currency1 : args.key.currency0;

  const actions = `0x${[ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL]
    .map((a) => a.toString(16).padStart(2, "0"))
    .join("")}` as Hex;

  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey: args.key,
        zeroForOne: args.zeroForOne,
        amountIn: args.amountIn,
        amountOutMinimum: args.minAmountOut,
        hookData: "0x",
      },
    ],
  );

  // SETTLE_ALL caps what the router may pull; TAKE_ALL floors what we accept.
  // The second is the slippage bound — it has to be the SAME minOut the quote
  // was judged against, or the trade executes to a limit nobody computed.
  const settleParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyIn, args.amountIn],
  );
  const takeParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyOut, args.minAmountOut],
  );

  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]],
  );
}

export interface Call {
  to: `0x${string}`;
  value: 0n;
  data: Hex;
}

/**
 * The full call sequence for one v4 swap: approve Permit2, let Permit2 grant the
 * router a bounded expiring allowance, then execute.
 *
 * Three calls where v3 needed two. The allowance is scoped to this trade's size
 * and expires, rather than being left standing at max — a standing max approval
 * to a router is the thing that turns one router bug into everyone's loss.
 */
export function buildV4SwapCalls(args: {
  key: PoolKey;
  tokenIn: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  /** Unix seconds. Both the Permit2 allowance and the router call expire on it. */
  deadline: number;
}): Call[] {
  const permit2 = UNISWAP.permit2 as `0x${string}`;
  const router = UNISWAP.universalRouter as `0x${string}`;
  const zeroForOne = isZeroForOne(args.key, args.tokenIn);

  const erc20Approve = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [permit2, args.amountIn],
  });

  const permit2Approve = encodeFunctionData({
    abi: PERMIT2_ABI,
    functionName: "approve",
    // uint160 amount / uint48 expiration — both are narrower than the usual
    // uint256, and silently truncating either would grant the wrong allowance.
    args: [args.tokenIn, router, args.amountIn, args.deadline],
  });

  const execute = encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [
      `0x${CMD_V4_SWAP.toString(16).padStart(2, "0")}` as Hex,
      [encodeV4SwapInput({ key: args.key, zeroForOne, amountIn: args.amountIn, minAmountOut: args.minAmountOut })],
      BigInt(args.deadline),
    ],
  });

  return [
    { to: args.tokenIn, value: 0n, data: erc20Approve },
    { to: permit2, value: 0n, data: permit2Approve },
    { to: router, value: 0n, data: execute },
  ];
}
