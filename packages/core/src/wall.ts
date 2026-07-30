import { erc20Abi, parseAbi, type Address } from "viem";
import { CallPolicyVersion, ParamCondition, toCallPolicy } from "@zerodev/permissions/policies";
import { toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { UNISWAP_SWAP_ROUTER_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI } from "./abis";
import { MORPHO, RIALTO, UNISWAP } from "./protocols";
import { CASH, STOCK_TOKENS, TRADEABLE_SYMBOLS, USDG_DECIMALS, isValidCustomToken, type CustomToken } from "./tokens";
import { builtinGrantTargets, type GrantCaps } from "./grant";

/**
 * THE WALL. One definition, shared by every client that can sign a grant.
 *
 * This file decides what a session key is permitted to do once the account
 * contract is enforcing it — which assets it may approve, which routers may pull
 * them, how much per call, and when the key dies. It used to live inside the
 * dashboard's session.ts, which was fine while the dashboard was the only thing
 * that could sign. It is not fine with a phone app that can sign too: two copies
 * of this list would drift, nothing would fail when they did, and the difference
 * would be a wallet with permissions its owner never agreed to.
 *
 * So it is here, imported by both, and the tests in worker/src/wall.test.ts assert
 * the exact shape rather than trusting that a refactor preserved it.
 *
 * READ BEFORE CHANGING. Every entry below is a power granted to an automated
 * agent. Widening one is not a feature flag — it is a permanent change to what a
 * compromised agent could do with someone's money, and it only takes effect for
 * grants signed afterwards, so the fleet will be running a mix of walls.
 */

const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
]);

const usdgUnits = (v: number): bigint => BigInt(Math.round(v * 10 ** USDG_DECIMALS));

/**
 * The only contracts a token approval may ever name as spender.
 *
 * v4 is the reason permit2 is here and universalRouter is not: v4 never pulls
 * tokens directly. The account approves PERMIT2, and Permit2 grants the router a
 * bounded, expiring allowance — so the router itself is approved for nothing.
 */
export function allowedSpenders(): Address[] {
  return [
    RIALTO.routerSnapshot as Address,
    UNISWAP.swapRouter02 as Address,
    MORPHO.steakhouseUsdgVault as Address,
    UNISWAP.permit2 as Address,
  ];
}

/**
 * Owner-added tokens that are safe to seal into a policy.
 *
 * Validated HERE, at the last point before an address becomes on-chain policy: a
 * malformed entry either bricks the grant or silently widens it. Anything already
 * covered by the built-in set is dropped so the policy carries no duplicates.
 */
export function usableExtraTokens(extraTokens: readonly CustomToken[] = []): CustomToken[] {
  const builtin = builtinGrantTargets();
  const seen = new Set<string>();
  return extraTokens.filter((t) => {
    if (!isValidCustomToken(t)) return false;
    const key = t.address.toLowerCase();
    if (builtin.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The call-policy permission list — pure data, which is what makes it testable.
 *
 * Deliberately separate from `buildWallPolicies` below: the ZeroDev Policy objects
 * are opaque once constructed, so asserting on them proves little. This returns
 * the thing that actually defines the wall, in a shape a test can read.
 */
export function buildCallPermissions(caps: GrantCaps, extraTokens: readonly CustomToken[] = []) {
  const spenders = allowedSpenders();
  const extras = usableExtraTokens(extraTokens);

  return [
    {
      // approve USDG, only to the allowed spenders, only up to one trade's size.
      target: CASH.USDG as Address,
      valueLimit: 0n,
      abi: erc20Abi,
      functionName: "approve",
      args: [
        { condition: ParamCondition.ONE_OF, value: spenders },
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) },
      ],
    },
    // approve the TRADEABLE stock tokens so the agent can SELL what it may buy.
    // No amount condition: share counts are 18dp and not comparable to a USDG
    // cap, and a router can only pull what was approved — while the USDG cap
    // above already bounds what could ever have been bought.
    ...STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map(
      (t) =>
        ({
          target: t.address as Address,
          valueLimit: 0n,
          abi: erc20Abi,
          functionName: "approve",
          args: [{ condition: ParamCondition.ONE_OF, value: spenders }, null],
        }) as const,
    ),
    // Owner-added tokens, same shape and same routers. Present ONLY because the
    // owner listed them and is signing this grant right now — which is precisely
    // why the wall cannot widen by itself.
    ...extras.map(
      (t) =>
        ({
          target: t.address as Address,
          valueLimit: 0n,
          abi: erc20Abi,
          functionName: "approve",
          args: [{ condition: ParamCondition.ONE_OF, value: spenders }, null],
        }) as const,
    ),
    {
      // USDG out of the wall. The recipient is free-form because chat transfers
      // are user-confirmed, but the AMOUNT is capped per call on-chain. Daily
      // budgets bound it further, worker-side.
      target: CASH.USDG as Address,
      valueLimit: 0n,
      abi: erc20Abi,
      functionName: "transfer",
      args: [null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) }],
    },
    {
      // Rialto router: target-scoped only, since its calldata comes from the
      // quote API and cannot be constrained by shape.
      target: RIALTO.routerSnapshot as Address,
      valueLimit: 0n,
    },
    {
      // Uniswap SwapRouter02: exactInputSingle only. Spend is bounded by the
      // approve cap above — the router can pull nothing beyond it.
      target: UNISWAP.swapRouter02 as Address,
      valueLimit: 0n,
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
    },
    {
      // Morpho vault deposits, capped per call at the daily limit.
      target: MORPHO.steakhouseUsdgVault as Address,
      valueLimit: 0n,
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [{ condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.dailyUsdg) }, null],
    },
    {
      // Withdrawals back to the account are unrestricted in size — money coming
      // home is not a risk the wall needs to bound.
      target: MORPHO.steakhouseUsdgVault as Address,
      valueLimit: 0n,
      abi: VAULT_ABI,
      functionName: "withdraw",
    },
    {
      // Permit2 may be told to grant an allowance, but ONLY to the
      // UniversalRouter. Without that EQUAL condition this single permission
      // would let the session key hand any spender an allowance on any token —
      // strictly more power than trading.
      target: UNISWAP.permit2 as Address,
      valueLimit: 0n,
      abi: PERMIT2_ABI,
      functionName: "approve",
      args: [null, { condition: ParamCondition.EQUAL, value: UNISWAP.universalRouter as Address }, null, null],
    },
    {
      // The UniversalRouter executes opaque command bundles, so a call policy
      // cannot constrain its calldata. What bounds it is upstream: it can only
      // move what Permit2 allowed, and Permit2 is only ever granted one trade's
      // worth, expiring.
      target: UNISWAP.universalRouter as Address,
      valueLimit: 0n,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
    },
  ];
}

/**
 * The complete policy set for a grant: expiry, rate limit, and the call policy.
 *
 * `now` is injectable so a test can assert the timestamps rather than racing the
 * clock. Callers should leave it alone.
 */
export function buildWallPolicies(args: {
  caps: GrantCaps;
  extraTokens?: readonly CustomToken[];
  now?: number;
}) {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + args.caps.expiryDays * 86_400;

  const policies = [
    // Hard expiry — the key dies even if every other control fails.
    toTimestampPolicy({ validAfter: now, validUntil: expiresAt }),
    // Bounded ops per day, so a runaway loop cannot spam trades.
    toRateLimitPolicy({ count: args.caps.maxOpsPerDay, interval: 86_400 }),
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_4,
      permissions: buildCallPermissions(args.caps, args.extraTokens) as never,
    }),
  ];

  return { policies, now, expiresAt };
}
