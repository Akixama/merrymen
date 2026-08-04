import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest } from "./backtest";
import { buildStrategy, legsForUniverse } from "./strategies/registry";
import { loadBarsFile } from "../../cli/backtest-bars";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [name, ...rest] = process.argv.slice(2);
const fileFlagIdx = rest.indexOf("--file");
const barsPath = fileFlagIdx >= 0 ? rest[fileFlagIdx + 1] : path.join(ROOT, "strategies", "sample-bars.json");

const SUPPORTED = ["steady-basket", "weekend-gap"];
if (!name || !SUPPORTED.includes(name)) {
  console.error(`usage: merrymen strategy backtest <name> --file bars.json  (supported: ${SUPPORTED.join(", ")})`);
  process.exit(1);
}
if (fileFlagIdx < 0) console.log(`no --file given — using bundled sample: ${barsPath}`);

const bars = loadBarsFile(barsPath);
const basketSymbols = [...new Set(bars.flatMap((b) => [...b.prices.keys()]))];
const legs = new Map(legsForUniverse(basketSymbols).map((l) => [l.symbol, l.token]));

const strategy = buildStrategy(name, {
  swapRouter: "0x0000000000000000000000000000000000000001",
  usdg6: (v: number) => BigInt(Math.round(v * 1e6)),
  basketSymbols,
  buyPerTickUsdg: 25,
  idleFloorUsdg: 50,
  gapEnterBudgetUsdg: 100,
  llm: { creds: null, intervalMin: 60, maxActionUsdg: 0 },
});

const result = await runBacktest(
  {
    strategy,
    legs,
    initialCashUsdg: 1_000_000_000n,
    limits: {
      perTradeUsdg: 500_000_000n,
      dailyUsdg: 500_000_000n,
      allowedTargets: [],
      allowedAssets: [...legs.values()],
      maxDrawdownBps: 2000,
      expiresAt: Math.floor(Date.now() / 1000) + 365 * 86_400,
    },
  },
  bars,
);

console.log(`\nbacktest: ${name}  (${bars.length} bars)`);
console.log(`  final equity   ${(Number(result.finalEquityUsdg) / 1e6).toFixed(2)} USDG`);
console.log(`  pnl            ${(Number(result.pnlUsdg) / 1e6).toFixed(2)} USDG`);
console.log(`  max drawdown   ${(result.maxDrawdownBps / 100).toFixed(2)}%`);
console.log(`  executed       ${result.executed}`);
if (result.rejected.length) {
  console.log(`  rejected:`);
  result.rejected.forEach((r) => console.log(`    ${r.rule}: ${r.count}`));
}