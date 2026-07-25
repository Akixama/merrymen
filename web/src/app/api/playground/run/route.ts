/**
 * Playground backtest endpoint. Runs one strategy — or two, side by side,
 * when `compareStrategy` is set — through the real policy layer over an
 * identical synthetic price series, so a comparison is apples-to-apples.
 */

import { NextResponse } from "next/server";
import { CASH, STOCK_TOKENS, UNISWAP, MORPHO } from "@merrymen/core";
import { runBacktest } from "@merrymen/backtest";
import { type AgentLimits } from "@merrymen/policy";
import { buildScenario } from "@merrymen/backtest-scenario";
import { steadyBasketTick, type SteadyBasketConfig } from "@merrymen/strategies/steady-basket";
import { weekendGapTick, type WeekendGapConfig } from "@merrymen/strategies/weekend-gap";

export const dynamic = "force-dynamic";

type StrategyName = "steady-basket" | "weekend-gap";

interface PlaygroundRequest {
  strategy: StrategyName;
  compareStrategy?: StrategyName | null;
  symbols: string[];
  days: number;
  startingCashUsdg: number;
  perTradeUsdg?: number;
  dailyUsdg?: number;
  maxDrawdownPct?: number;
}

const U = (v: number): bigint => BigInt(Math.round(v * 1e6));

interface RunOutput {
  strategy: StrategyName;
  finalEquityUsdg: number;
  pnlUsdg: number;
  maxDrawdownBps: number;
  executed: number;
  rejected: { rule: string; count: number }[];
  rejectedEvents: { tSec: number; rule: string }[];
  equitySeries: { tSec: number; equityUsdg: number }[];
}

export async function POST(req: Request) {
  const body = (await req.json()) as PlaygroundRequest;

  const legs = new Map<string, `0x${string}`>(
    body.symbols
      .map((s) => STOCK_TOKENS.find((t) => t.symbol === s))
      .filter((t): t is (typeof STOCK_TOKENS)[number] => !!t)
      .map((t) => [t.symbol, t.address]),
  );
  if (legs.size === 0) {
    return NextResponse.json({ error: "no valid symbols in that basket" }, { status: 400 });
  }

  const swapRouter = UNISWAP.swapRouter02;
  const vault = MORPHO.steakhouseUsdgVault;

  const weightBps = Math.floor(10_000 / legs.size);
  const basketLegs = [...legs.entries()].map(([symbol, token]) => ({ symbol, token, weightBps }));

  const limits: AgentLimits = {
    perTradeUsdg: U(body.perTradeUsdg ?? 50),
    dailyUsdg: U(body.dailyUsdg ?? 500),
    allowedTargets: [...legs.values(), CASH.USDG, swapRouter, vault],
    allowedAssets: [...legs.values(), CASH.USDG],
    maxDrawdownBps: (body.maxDrawdownPct ?? 20) * 100,
    expiresAt: Math.floor(Date.now() / 1000) + 365 * 86_400,
    maxOpsPerDay: 1_000,
  };

  // Same price series for every strategy run in this request — a fair
  // comparison means identical prices, not identical randomness.
  const startPrice = Object.fromEntries(body.symbols.map((s) => [s, 100 + Math.random() * 200]));
  const bars = buildScenario({ symbols: [...legs.keys()], startPrice, days: body.days });

  function buildStrategy(name: StrategyName) {
    return name === "weekend-gap"
      ? {
          name: "weekend-gap" as const,
          tick: (s: Parameters<typeof weekendGapTick>[1]) =>
            weekendGapTick(
              {
                legs: basketLegs,
                enterBudgetUsdg: U(Math.min(body.startingCashUsdg * 0.5, (body.perTradeUsdg ?? 50) * 0.9)),
                swapRouter,
                usdg: CASH.USDG,
              } satisfies WeekendGapConfig,
              s,
            ),
        }
      : {
          name: "steady-basket" as const,
          tick: (s: Parameters<typeof steadyBasketTick>[1]) =>
            steadyBasketTick(
              {
                legs: basketLegs,
                buyPerTickUsdg: U(body.startingCashUsdg * 0.05),
                idleFloorUsdg: U(body.startingCashUsdg * 0.1),
                swapRouter,
                vault,
                usdg: CASH.USDG,
              } satisfies SteadyBasketConfig,
              s,
            ),
        };
  }

  async function runOne(name: StrategyName): Promise<RunOutput> {
    const result = await runBacktest(
      { strategy: buildStrategy(name), limits, legs, initialCashUsdg: U(body.startingCashUsdg) },
      bars,
    );
  return {
  strategy: name,
  finalEquityUsdg: Number(result.finalEquityUsdg) / 1e6,
  pnlUsdg: Number(result.pnlUsdg) / 1e6,
  maxDrawdownBps: result.maxDrawdownBps,
  executed: result.executed,
  rejected: result.rejected,
  rejectedEvents: result.rejectedEvents,
  equitySeries: result.equitySeries.map((p) => ({
    tSec: p.tSec,
    equityUsdg: Number(p.equityUsdg) / 1e6,
  })),
};
  }

  const primary = await runOne(body.strategy);
  const compare =
    body.compareStrategy && body.compareStrategy !== body.strategy
      ? await runOne(body.compareStrategy)
      : null;

  return NextResponse.json({ primary, compare });
}