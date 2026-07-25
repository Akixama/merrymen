/**
 * Cost basis + realized P&L — the accounting that makes "did that trade make
 * money?" a number instead of a vibe.
 *
 * WEIGHTED-AVERAGE cost, not FIFO lots. One row per (agent, symbol): the raw
 * quantity held and the total USDG it cost. A sell removes cost pro-rata and
 * books the difference as realized P&L. Average cost is the right call here —
 * merrymen isn't a tax reporter, and one row per symbol has no lot-matching
 * complexity to get subtly wrong.
 *
 * UNITS (the part that must never drift):
 *   qtyRaw   — 18dp RAW token units, exactly what transfer() moves
 *   costUsdg — 6dp USDG, the total paid for the currently-held qtyRaw
 *
 * Basis is per RAW unit, which makes it SPLIT-INVARIANT for free: ERC-8056
 * corporate actions change uiMultiplier(), never rawBalance, so a 2-for-1 split
 * leaves both qtyRaw and costUsdg untouched — the position is worth the same and
 * cost the same. Storing basis per UI share would silently halve on every split.
 *
 * Everything here is pure integer arithmetic. Truncation on the pro-rata cost
 * split is deliberate and self-cancelling: the SAME truncated costOut is added
 * to realized and subtracted from the remaining basis, so the identity
 *
 *     Σ realized + unrealized  ==  proceeds + marketValue − spent
 *
 * holds EXACTLY for any sequence of fills (see basis.test.ts).
 */

/** The running basis for one symbol. */
export interface BasisRow {
  /** 18dp raw units currently held. */
  qtyRaw: bigint;
  /** 6dp USDG total cost of exactly those qtyRaw units. */
  costUsdg: bigint;
}

export interface Fill {
  side: "buy" | "sell";
  /** 18dp raw units bought or sold. */
  qtyRaw: bigint;
  /** 6dp USDG paid (buy) or received (sell). Slippage/fees included — this is
   * the cash that actually moved, so basis reflects real cost, not the quote. */
  cashUsdg: bigint;
}

export interface FillResult {
  basis: BasisRow;
  /** 6dp USDG booked on this fill. Always 0n for a buy. */
  realizedUsdg: bigint;
  /** 6dp USDG of basis removed by a sell (what those units originally cost). */
  costOutUsdg: bigint;
  /** Raw units actually applied — a sell is capped at the held quantity. */
  appliedQtyRaw: bigint;
}

export const ZERO_BASIS: BasisRow = { qtyRaw: 0n, costUsdg: 0n };

/**
 * Apply one fill to a basis row. Pure: no clock, no db, no rounding modes.
 * A sell of more than is held is capped at the holding (the caller's sizing
 * already caps this; belt-and-braces so basis can never go negative).
 */
export function applyFill(prev: BasisRow, fill: Fill): FillResult {
  if (fill.qtyRaw <= 0n) {
    return { basis: prev, realizedUsdg: 0n, costOutUsdg: 0n, appliedQtyRaw: 0n };
  }

  if (fill.side === "buy") {
    return {
      basis: { qtyRaw: prev.qtyRaw + fill.qtyRaw, costUsdg: prev.costUsdg + fill.cashUsdg },
      realizedUsdg: 0n,
      costOutUsdg: 0n,
      appliedQtyRaw: fill.qtyRaw,
    };
  }

  // ── sell ────────────────────────────────────────────────────────────────
  if (prev.qtyRaw <= 0n) {
    // Nothing on the books (pre-basis holding, or an external transfer in).
    // Book the whole proceeds as realized rather than inventing a negative cost.
    return { basis: ZERO_BASIS, realizedUsdg: fill.cashUsdg, costOutUsdg: 0n, appliedQtyRaw: 0n };
  }
  const sold = fill.qtyRaw < prev.qtyRaw ? fill.qtyRaw : prev.qtyRaw;
  // Selling the whole position takes the whole remaining cost — no truncation
  // residue left stranded on a zero quantity.
  const costOut = sold === prev.qtyRaw ? prev.costUsdg : (prev.costUsdg * sold) / prev.qtyRaw;
  return {
    basis: { qtyRaw: prev.qtyRaw - sold, costUsdg: prev.costUsdg - costOut },
    realizedUsdg: fill.cashUsdg - costOut,
    costOutUsdg: costOut,
    appliedQtyRaw: sold,
  };
}

/**
 * Average cost per WHOLE unit (1e18 raw), in 6dp USDG — the "what did I pay for
 * this" number for display. Null when nothing is held.
 */
export function avgCostUsdgPerUnit(basis: BasisRow): bigint | null {
  if (basis.qtyRaw <= 0n) return null;
  return (basis.costUsdg * 10n ** 18n) / basis.qtyRaw;
}

/**
 * Unrealized P&L (6dp USDG) at a given market value of the held units.
 * marketValueUsdg comes from positionValueUsdg() so the multiplier is respected.
 */
export function unrealizedUsdg(basis: BasisRow, marketValueUsdg: bigint): bigint {
  if (basis.qtyRaw <= 0n) return 0n;
  return marketValueUsdg - basis.costUsdg;
}
