"use client";

import { useEffect, useState } from "react";
import { CASH, STOCK_TOKENS } from "@merrymen/core";
import type { AgentStatus } from "@/app/api/grants/route";
import type { FeedResponse } from "@/app/api/feed/route";

/**
 * Portfolio heatmap — cell width = share of the book, tint = unrealized P&L.
 * Sits alongside TradesPanel/MarketTable on the dashboard; no new endpoint —
 * it reuses the same /api/feed poll every other panel already does.
 *
 * P&L is approximate: net cost basis per symbol is reconstructed from the
 * trade record (buys add cost, sells reduce it), not from a stored entry
 * price. Good enough for a tint; the tooltip says so.
 *
 * A stale price feed (24/5 market, README's documented behavior) renders
 * hatched and grey, never a fake green/red — the heatmap should never show
 * more confidence than the data actually has.
 */

const SYMBOLS = new Map<string, string>([
  [CASH.USDG.toLowerCase(), "USDG"],
  ...STOCK_TOKENS.map((t) => [t.address.toLowerCase(), t.symbol] as [string, string]),
]);

function sym(addr: string | null): string {
  if (!addr) return "—";
  return SYMBOLS.get(addr.toLowerCase()) ?? addr.slice(0, 6);
}

interface Cell {
  symbol: string;
  valueUsdg: number;
  stale: boolean;
  pnlPct: number | null;
}

function buildCells(feed: FeedResponse): Cell[] {
  // Net cost basis per symbol from trade history: buys add cost, sells reduce it.
  const costBySymbol = new Map<string, number>();
  for (const t of feed.trades ?? []) {
    if (t.kind !== "swap" || t.status === "rejected") continue;
    const buySym = sym(t.buy_token);
    const sellSym = sym(t.sell_token);
    if (buySym !== "USDG") costBySymbol.set(buySym, (costBySymbol.get(buySym) ?? 0) + t.amount_usdg);
    if (sellSym !== "USDG") costBySymbol.set(sellSym, (costBySymbol.get(sellSym) ?? 0) - t.amount_usdg);
  }

  return (feed.positions ?? []).map((p) => {
    const cost = costBySymbol.get(p.symbol);
    const pnlPct = cost && cost > 0 ? ((p.value_usdg - cost) / cost) * 100 : null;
    return { symbol: p.symbol, valueUsdg: p.value_usdg, stale: Boolean(p.price_stale), pnlPct };
  });
}

/** lime (brand accent, matches Logo.tsx #a5ce1f) for gains, red for losses. */
function heat(pnlPct: number | null): string | undefined {
  if (pnlPct === null) return undefined;
  const clamped = Math.max(-15, Math.min(15, pnlPct));
  const intensity = Math.abs(clamped) / 15;
  const alpha = 0.15 + intensity * 0.55;
  return clamped >= 0 ? `rgba(165, 206, 31, ${alpha})` : `rgba(214, 74, 74, ${alpha})`;
}

export function PortfolioHeatmap() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [feed, setFeed] = useState<FeedResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [gRes, fRes] = await Promise.all([fetch("/api/grants"), fetch("/api/feed")]);
        if (!alive) return;
        if (gRes.ok) setStatus((await gRes.json()) as AgentStatus);
        if (fRes.ok) setFeed((await fRes.json()) as FeedResponse);
      } catch {
        /* keep last state */
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!status?.exists || !feed || (feed.positions ?? []).length === 0) return null;

  const cells = buildCells(feed).sort((a, b) => b.valueUsdg - a.valueUsdg);

  return (
    <>
      <div className="section-title market-title">portfolio heatmap · size = weight, tint = P&amp;L</div>
      <div className="heatmap-wrap">
        {cells.map((c) => (
          <div
            key={c.symbol}
            className={`heat-cell${c.stale ? " heat-stale" : ""}`}
            style={{ flexGrow: Math.max(c.valueUsdg, 1), background: c.stale ? undefined : heat(c.pnlPct) }}
            title={
              c.stale
                ? `${c.symbol} · price feed stale (24/5 market) — tint withheld`
                : c.pnlPct !== null
                  ? `${c.symbol} · $${c.valueUsdg.toFixed(2)} · ${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(1)}% (from trade history, approximate)`
                  : `${c.symbol} · $${c.valueUsdg.toFixed(2)} · cost basis unknown`
            }
          >
            <span className="heat-symbol mono">{c.symbol}</span>
            <span className="heat-value mono dim">${c.valueUsdg.toFixed(0)}</span>
            {c.pnlPct !== null ? (
              <span className="heat-pnl mono">
                {c.pnlPct >= 0 ? "+" : ""}
                {c.pnlPct.toFixed(1)}%
              </span>
            ) : (
              <span className="heat-pnl mono dim">{c.stale ? "stale" : "—"}</span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
