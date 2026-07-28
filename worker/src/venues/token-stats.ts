/**
 * On-chain facts about a token, for deciding whether to touch it.
 *
 * Everything here is READ FROM THE CHAIN and checkable by anyone. No provider's
 * opinion, no score anybody markets, no "trending" list. That matters because
 * these numbers gate whether an agent spends money, and a signal you can't
 * verify is a signal someone can manufacture.
 *
 * ON "MARKET CAP", because the honest name is different from the popular one:
 * what's computable here is totalSupply × price — which is FULLY DILUTED value.
 * Real float is smaller whenever supply is burned, locked, vested or sitting in
 * a team wallet, and none of that is legible from an ERC-20 balance. So this
 * reports FDV and calls it FDV. Treating it as market cap systematically makes
 * a token look bigger and safer than it is, which is exactly the wrong error.
 */

import { parseAbi, type PublicClient } from "viem";

const ERC20 = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

/** Addresses tokens are burned to. Supply sitting here is gone, not circulating. */
const BURN_ADDRESSES = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
] as const;

export interface TokenStats {
  /** Raw total supply. */
  totalSupplyRaw: bigint;
  decimals: number;
  /**
   * Fully diluted value in USD: total supply × price. NOT market cap — see the
   * header. Named for what it is so nobody reads it as the smaller number.
   */
  fdvUsd: number;
  /** FDV with provably-burned supply removed. Still an upper bound on real float. */
  fdvExBurnedUsd: number;
  /** Supply verifiably sent to a burn address, as a fraction of total. */
  burnedFraction: number;
}

/**
 * Read supply and derive value at a given price.
 *
 * `price8` must come from the guarded pool reader — passing an unguarded spot
 * price here would produce an FDV anyone could move, and FDV gates spending.
 */
export async function readTokenStats(
  client: PublicClient,
  args: { token: `0x${string}`; price8: bigint; decimals?: number },
): Promise<TokenStats | null> {
  try {
    const [supply, dec] = await Promise.all([
      client.readContract({ address: args.token, abi: ERC20, functionName: "totalSupply" }) as Promise<bigint>,
      args.decimals !== undefined
        ? Promise.resolve(args.decimals)
        : (client.readContract({ address: args.token, abi: ERC20, functionName: "decimals" }) as Promise<number>),
    ]);
    const decimals = Number(dec);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    if (supply <= 0n) return null;

    const burned = await Promise.all(
      BURN_ADDRESSES.map((a) =>
        (client.readContract({
          address: args.token,
          abi: ERC20,
          functionName: "balanceOf",
          args: [a as `0x${string}`],
        }) as Promise<bigint>).catch(() => 0n),
      ),
    );
    const burnedRaw = burned.reduce((s, b) => s + b, 0n);
    const circulating = supply > burnedRaw ? supply - burnedRaw : 0n;

    return {
      totalSupplyRaw: supply,
      decimals,
      fdvUsd: valueUsd(supply, decimals, args.price8),
      fdvExBurnedUsd: valueUsd(circulating, decimals, args.price8),
      burnedFraction: supply > 0n ? Number((burnedRaw * 10_000n) / supply) / 10_000 : 0,
    };
  } catch {
    return null;
  }
}

/**
 * raw units × price8 → USD, as a float.
 *
 * Deliberately float, unlike the money path. This feeds thresholds ("is FDV
 * under $2m"), never a balance or a transfer, and a memecoin's supply times its
 * price overflows anything convenient long before the precision matters.
 */
export function valueUsd(raw: bigint, decimals: number, price8: bigint): number {
  if (raw <= 0n || price8 <= 0n) return 0;
  // Scale down before converting: 10^27 supply at 18dp overflows Number() whole.
  const whole = Number(raw / 10n ** BigInt(decimals));
  const frac = Number(raw % 10n ** BigInt(decimals)) / 10 ** decimals;
  return (whole + frac) * (Number(price8) / 1e8);
}
