/**
 * Strategy contract: a strategy is a pure function from a market/account
 * snapshot to a list of typed intents. It NEVER executes anything, never
 * holds state the snapshot can't reconstruct, and never talks to a model —
 * the runner pushes every intent through checkPolicy → simulate → execute.
 */

import type { PriceQuote } from "../../../packages/core/src/index";
import type { TradeIntent } from "../policy";

/** One current holding, as the strategy sees it. */
export interface Holding {
  token: `0x${string}`;
  /** Raw ERC-20 balance (18dp for stock tokens). */
  rawBalance: bigint;
  /** Multiplier-aware USDG value (6dp). */
  valueUsdg: bigint;
  /** The holding's Chainlink feed is stale (market closed) right now. */
  priceStale: boolean;
}

export interface Snapshot {
  cashUsdg: bigint;
  vaultUsdg: bigint;
  /** Current stock holdings by symbol. */
  holdings: Map<string, Holding>;
  /**
   * Latest USD prices (8dp) by symbol — stale prices flagged, not hidden.
   * `source` says whether a price is a Chainlink feed or a Uniswap TWAP; a
   * strategy that wants to treat those differently can, and one that doesn't
   * gets a price that already passed the depth and divergence guards.
   */
  prices: Map<string, PriceQuote>;
  /** Per-token pause state read from the Stock contract — never trade a paused token. */
  pausedTokens: Set<string>;
  /** Chainlink staleness per symbol; stale = underlying market closed (nights/weekends). */
  staleFeeds: Set<string>;
  sequencerUp: boolean;
  /**
   * USDG (6dp) still spendable today: the grant's daily cap minus what's already
   * gone. Zero means the budget is used up.
   *
   * Strategies should SIZE to this instead of proposing what they wish for. The
   * wall still rejects anything over — this just stops a strategy re-proposing an
   * oversized intent every tick forever, which fills the ledger with rejections
   * and stalls the position. It is a hint for sizing, never a permission: the
   * proposer shrinks itself; checkPolicy and the on-chain caps remain the wall.
   */
  spendHeadroomUsdg: bigint;
  /** The grant's per-trade cap (6dp) — the ceiling for a single swap. Deposits are
   * capped at the DAILY limit instead (see policy.ts), hence the separate figure. */
  perTradeCapUsdg: bigint;
}

export interface Strategy {
  name: string;
  /** Async allowed: the LLM strategist awaits a model at decision windows. */
  tick(snap: Snapshot): TradeIntent[] | Promise<TradeIntent[]>;
}
