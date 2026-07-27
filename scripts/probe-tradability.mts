/**
 * READ-ONLY: of the tokens merrymen can now PRICE, how many can it actually TRADE?
 *
 * These are different questions and it would be easy to conflate them. Pricing
 * routes TOKEN -> WETH -> USDG when that's the deeper path. Execution calls
 * exactInputSingle, which is ONE hop. So a token whose only real pool is against
 * WETH can be valued perfectly and not bought or sold at all.
 *
 * This asks the quoter directly — the same call the executor makes — so the
 * answer is what would really happen, not what the code looks like it does.
 *
 *   npx tsx scripts/probe-tradability.mts
 */

import { createPublicClient, http, parseAbi } from "viem";
import { CASH, robinhoodChain, STOCK_TOKENS } from "../packages/core/src/index";
import { bestQuote } from "../worker/src/venues/uniswap";
import { poolPriceUsable, readRoutedPrice } from "../worker/src/venues/pool-price";
import { SETTINGS_DEFAULTS } from "../packages/core/src/settings";

const client = createPublicClient({ chain: robinhoodChain, transport: http() });
const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const USDG = CASH.USDG as `0x${string}`;
const WETH = CASH.WETH as `0x${string}`;
const TEN_USDG = 10_000_000n; // $10 — a realistic first buy, small enough to route

async function discover(): Promise<`0x${string}`[]> {
  const res = await fetch("https://robinhoodchain.blockscout.com/api/v2/tokens?type=ERC-20");
  const j = (await res.json()) as { items?: { address?: string; address_hash?: string }[] };
  const skip = new Set([USDG.toLowerCase(), WETH.toLowerCase()]);
  const out: `0x${string}`[] = [];
  for (const it of j.items ?? []) {
    const a = (it.address ?? it.address_hash ?? "").toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(a) && !skip.has(a)) out.push(a as `0x${string}`);
  }
  return out;
}

async function main() {
  console.log(`\nRobinhood Chain ${robinhoodChain.id} @ block ${await client.getBlockNumber()}`);
  console.log(`can merrymen TRADE what it can PRICE? (buy size $10)\n`);

  const guard = {
    minLiquidityUsdg: BigInt(SETTINGS_DEFAULTS.minPoolLiquidityUsdg) * 1_000_000n,
    maxDivergenceBps: SETTINGS_DEFAULTS.maxPriceDivergenceBps,
  };

  const tradableStocks = STOCK_TOKENS.filter((t) => ["NVDA", "QQQ", "TSLA"].includes(t.symbol)).map(
    (t) => t.address,
  );
  const targets = [...tradableStocks, ...(await discover())];

  let pricedAndTradable = 0;
  let pricedNotTradable = 0;
  const stranded: string[] = [];

  for (const token of targets) {
    let symbol = token.slice(0, 8);
    let decimals = 18;
    try {
      symbol = (await client.readContract({ address: token, abi: ERC20, functionName: "symbol" })) as string;
      decimals = Number(await client.readContract({ address: token, abi: ERC20, functionName: "decimals" }));
    } catch {
      continue; // not a readable ERC-20
    }

    const routed = await readRoutedPrice(client, {
      token,
      tokenDecimals: decimals,
      cash: USDG,
      cashDecimals: 6,
      weth: WETH,
    });
    if (!routed) continue;
    const verdict = poolPriceUsable(routed, guard);
    if (!verdict.ok) continue; // not priced → not our question

    // The exact call the executor makes before a buy.
    const buy = await bestQuote(client, { tokenIn: USDG, tokenOut: token, amountIn: TEN_USDG });
    const canTrade = !!buy && buy.amountOut > 0n;
    if (canTrade) pricedAndTradable++;
    else {
      pricedNotTradable++;
      stranded.push(symbol);
    }
    console.log(
      `${symbol.padEnd(12)} priced via ${routed.route.padEnd(6)} ` +
        `depth $${(Number(routed.liquidityUsdg) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)}  ` +
        (canTrade ? `TRADABLE (single-hop, fee ${buy!.fee})` : `NOT TRADABLE — no direct USDG pool to swap through`),
    );
  }

  console.log(`\n── verdict ────────────────────────────────────────────────`);
  console.log(`priced AND tradable today:  ${pricedAndTradable}`);
  console.log(`priced but NOT tradable:    ${pricedNotTradable}`);
  if (stranded.length) {
    console.log(`\nstranded (valued, cannot be bought or sold): ${stranded.join(", ")}`);
    console.log(`these need multi-hop execution (exactInput with a USDG->WETH->TOKEN path);`);
    console.log(`the router target is unchanged, so the signed grant already permits it.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
