import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest } from "./backtest";
import { buildStrategy, legsForUniverse } from "./strategies/registry";
import { loadBarsFile } from "../../cli/backtest-bars";
import { CASH, MORPHO } from "../../packages/core/src/index";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [name, ...rest] = process.argv.slice(2);
const fileFlagIdx = rest.indexOf("--file");

const SUPPORTED = ["steady-basket", "weekend-gap"];
if (!name || !SUPPORTED.includes(name)) {
  console.error(`usage: merrymen strategy backtest <name> --file bars.json  (supported: ${SUPPORTED.join(", ")})`);
  process.exit(1);
}

// `--file` with nothing after it used to fall through to the bundled sample and
// exit 0, so a typo silently backtested three fake bars and reported a number
// the user would reasonably read as their own. A backtest that quietly measures
// the wrong data is worse than one that refuses.
if (fileFlagIdx >= 0 && (!rest[fileFlagIdx + 1] || rest[fileFlagIdx + 1]!.startsWith("--"))) {
  console.error("--file needs a path, e.g. --file bars.json");
  process.exit(1);
}

const barsPath: string =
  fileFlagIdx >= 0 ? rest[fileFlagIdx + 1]! : path.join(ROOT, "strategies", "sample-bars.json");
if (fileFlagIdx < 0) console.log(`no --file given — using bundled sample: ${barsPath}`);

const bars = loadBarsFile(barsPath);
const basketSymbols = [...new Set(bars.flatMap((b) => [...b.prices.keys()]))];
const legs = new Map(legsForUniverse(basketSymbols).map((l) => [l.symbol, l.token]));

// legsForUniverse resolves against the known token registry and simply omits
// anything it does not recognise. Unnamed, that turns a typo'd or unsupported
// ticker into a clean-looking run over nothing — the same failure as above,
// arriving by a different door. Say which symbols were dropped, and refuse
// outright when none survive.
const dropped = basketSymbols.filter((s) => !legs.has(s));
if (dropped.length) {
  console.error(`  not tradeable, ignored: ${dropped.join(", ")}`);
}
if (legs.size === 0) {
  console.error(`no tradeable symbols in ${barsPath} — nothing to backtest.`);
  process.exit(1);
}

const swapRouter = "0x0000000000000000000000000000000000000001" as const;
const strategy = buildStrategy(name, {
  swapRouter,
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
      allowedTargets: [swapRouter, MORPHO.steakhouseUsdgVault as `0x${string}`],
      allowedAssets: [CASH.USDG as `0x${string}`, ...legs.values()],
      maxOpsPerDay: 500,
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