/**
 * OrderExecutor — the brokerage sibling of AgentExecutor, and the seam the
 * whole Robinhood venue hangs off (DESIGN.md §4).
 *
 * Deliberately NOT a widening of AgentExecutor: that interface is EVM-shaped —
 * `execute(Call[]) → 0x txhash` — and a custodial order has no calldata and no
 * hash. Forcing one through the other's type is how a venue mistake becomes a
 * money mistake. Sibling types mean the compiler keeps the rails apart.
 *
 * The three methods mirror the venue's own safety pair:
 *
 *   review()  — the DRY RUN. Prices the order and returns the terms. This is
 *               the propose half, and its result is what the second, authoritative
 *               checkPolicy pass judges (DESIGN.md §5: on this rail there is no
 *               on-chain re-check, so the re-check against reviewed terms IS the
 *               wall).
 *   place()   — the dispose half. Takes the ReviewResult it must honor, so a
 *               place can never run except downstream of a review.
 *   poll()    — order-state refresh, for the settlement reconciler (step 6);
 *               the paper executor fills instantly so it has nothing to poll.
 *
 * Only the PAPER implementation exists. The live one arrives with step 6, and
 * is gated on a funded Agentic account and tools/list read on the wire.
 */

export interface EquityOrder {
  /** Uppercase ticker as the broker knows it — never an address. */
  ticker: string;
  side: "buy" | "sell";
  /**
   * USD notional, 6dp (the same unit as USDG — caps judge this directly).
   * Notional orders on purpose: the strategist thinks in dollars, and shares
   * are derived at the fill, never proposed by the model.
   */
  notionalUsdg: bigint;
}

export interface ReviewResult {
  /** Estimated fill price, USD 8dp. */
  priceUsd8: bigint;
  /**
   * Estimated shares at that price, 1e18 = one share — the SAME convention the
   * paper book and bookFill already use ("paper carries no multiplier, 1 share
   * = 1e18 raw"). The 1e8 brokerage share unit from DESIGN.md §6 is a STORE
   * decision and is born with the 'brokerage' BasisMode in step 5 — two unit
   * conventions in one codebase is how 10^18 errors happen, so until then
   * there is exactly one.
   */
  shares1e18: bigint;
  /**
   * The notional the caps must re-judge — fees and slippage included. Stage (b)
   * of checkPolicy runs against THIS, not the requested amount, so terms that
   * grew past a cap between propose and review are caught before place.
   */
  notionalUsdg: bigint;
  /** Human receipt line for the tape and the event feed. */
  detail: string;
}

export type OrderStatus = "filled" | "submitted" | "partial" | "cancelled" | "rejected";

export interface OrderFill {
  side: "buy" | "sell";
  symbol: string;
  qtyRaw1e18: bigint;
  /** USD actually spent (buy) or received (sell), 6dp. */
  cashUsdg: bigint;
  priceUsd: number;
}

export interface OrderRef {
  orderId: string;
  status: OrderStatus;
  /** Present when the order (or part of it) has filled. */
  fill?: OrderFill;
}

export interface OrderExecutor {
  review(order: EquityOrder): Promise<ReviewResult>;
  place(order: EquityOrder, review: ReviewResult): Promise<OrderRef>;
  poll(ref: OrderRef): Promise<OrderRef>;
}

/**
 * The paper implementation: fills instantly at the reviewed price.
 *
 * Pure over its inputs — prices come from a caller-supplied lookup (the tick's
 * own symbol-keyed price map), and nothing here touches storage. Persistence is
 * the caller's job, exactly as with applyPaperIntent.
 *
 * FAIL CLOSED: a ticker the lookup can't price REFUSES at review. Inventing a
 * fill price would book shares whose cost is fiction, and the position would
 * outlive the fiction.
 */
export function createPaperOrderExecutor(opts: {
  /** USD 8dp for a ticker, or null when there is no trustworthy price. */
  priceUsd8Of: (ticker: string) => bigint | null;
  slippageBps: number;
}): OrderExecutor {
  let seq = 0;

  return {
    async review(order) {
      if (order.notionalUsdg <= 0n) throw new Error(`refusing ${order.ticker}: non-positive notional`);
      const mid = opts.priceUsd8Of(order.ticker);
      if (mid === null || mid <= 0n) {
        throw new Error(`refusing ${order.ticker}: no trustworthy price to fill against`);
      }
      // Slippage works against you on both sides: buys fill above mid, sells
      // below — the same pessimism the EVM paper path applies.
      const bps = BigInt(Math.max(0, Math.round(opts.slippageBps)));
      const priceUsd8 =
        order.side === "buy" ? (mid * (10_000n + bps)) / 10_000n : (mid * (10_000n - bps)) / 10_000n;
      if (priceUsd8 <= 0n) throw new Error(`refusing ${order.ticker}: slippage consumed the whole price`);

      // shares(1e18) = notional(6dp) × 1e18 / price(8dp) → scale by 1e20.
      const shares1e18 = (order.notionalUsdg * 10n ** 20n) / priceUsd8;
      if (shares1e18 === 0n) throw new Error(`refusing ${order.ticker}: notional rounds to zero shares`);

      const px = Number(priceUsd8) / 1e8;
      return {
        priceUsd8,
        shares1e18,
        // Paper charges no fees; the LIVE executor reports the broker's own
        // reviewed terms here, which is the whole point of judging stage (b)
        // against this field rather than the request.
        notionalUsdg: order.notionalUsdg,
        detail: `paper ${order.side} ${order.ticker}: ${(Number(shares1e18) / 1e18).toFixed(4)} sh @ $${px.toFixed(2)}`,
      };
    },

    async place(order, review) {
      seq += 1;
      return {
        orderId: `paper-${Date.now()}-${seq}`,
        status: "filled",
        fill: {
          side: order.side,
          symbol: order.ticker,
          qtyRaw1e18: review.shares1e18,
          cashUsdg: review.notionalUsdg,
          priceUsd: Number(review.priceUsd8) / 1e8,
        },
      };
    },

    // Paper fills are instantaneous; there is never anything in flight.
    async poll(ref) {
      return ref;
    },
  };
}
