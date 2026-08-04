import { readFileSync } from "node:fs";
import type { Bar } from "../worker/src/backtest";

export function loadBarsFile(path: string): Bar[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array of bars`);

  return raw.map((row, i) => {
    if (typeof row.tSec !== "number") throw new Error(`bar ${i}: missing/invalid tSec`);
    if (typeof row.prices !== "object" || row.prices === null) {
      throw new Error(`bar ${i}: missing prices object`);
    }
    const prices = new Map<string, bigint>();
    for (const [symbol, v] of Object.entries(row.prices)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`bar ${i}: bad price for ${symbol}: ${v}`);
      prices.set(symbol, BigInt(Math.round(n * 1e8)));
    }
    const staleSymbols = Array.isArray(row.staleSymbols) ? new Set<string>(row.staleSymbols) : undefined;
    return { tSec: row.tSec, prices, staleSymbols };
  });
}