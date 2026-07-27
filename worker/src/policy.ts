/**
 * Deterministic policy layer — the half of the permission wall that lives off-chain.
 * It MIRRORS (never replaces) the on-chain Kernel session-key policies: the
 * on-chain caps are the hard wall; this layer exists to reject bad intents cheaply
 * and log WHY, before gas is spent. If this code and the on-chain policy ever
 * disagree, the on-chain policy wins and that divergence is a bug to alert on.
 *
 * Nothing in this file may call an LLM, read agent memory, or take a string that
 * originated from a model. Intents come in typed; verdicts go out typed.
 */

export interface AgentLimits {
  /** USDG (6dp) ceiling for a single trade. */
  perTradeUsdg: bigint;
  /** USDG (6dp) ceiling summed over a rolling 24h window. */
  dailyUsdg: bigint;
  /** Allowed target contracts (Rialto router via registry, Morpho vault, tokens for approvals). */
  allowedTargets: readonly `0x${string}`[];
  /** Allowed token addresses the agent may hold or trade. */
  allowedAssets: readonly `0x${string}`[];
  /**
   * Token addresses the SIGNED KEY can actually approve for a sell — i.e. what
   * it can get back OUT of. Distinct from allowedAssets, which is only what the
   * owner pointed the agent at.
   *
   * These diverge for a real and previously costly reason: approving USDG is a
   * single generic permission, so a BUY works for any token with a pool, while
   * a SELL needs a per-token approve baked into the signature at signing time.
   * A token in the first set but not the second is a one-way door.
   *
   * Undefined disables the check — for callers (backtests, fixtures) that have
   * no grant to reason about. Never leave it undefined on a live path.
   */
  sellableAssets?: readonly string[];
  /** Drawdown (bps from high-water mark) at which the breaker pauses the agent. */
  maxDrawdownBps: number;
  /** Unix seconds after which the session key is dead regardless of anything. */
  expiresAt: number;
  /** Ops ceiling per rolling 24h — mirrors the on-chain rate-limit policy. */
  maxOpsPerDay: number;
}

export type TradeIntent = {
  /**
   * Opaque link to the `decisions` row that produced this intent — set upstream
   * (strategist / chat / tick fallback), stamped onto the trade for attribution.
   * checkPolicy MUST ignore it: this stays a numbers-only decision. It is NOT the
   * model's reason (that free text lives only in the decisions table, never here),
   * so the policy-purity rule above is preserved.
   */
  decisionId?: string;
} & ({
  kind: "swap";
  target: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  /** Raw units of sellToken (USDG = 6dp, stock tokens = 18dp) — what executes. */
  sellAmountRaw: bigint;
  /** USDG-equivalent size (6dp) — what the caps judge. */
  notionalUsdg: bigint;
} | {
  kind: "vault-deposit" | "vault-withdraw";
  target: `0x${string}`;
  amountUsdg: bigint;
} | {
  /**
   * USDG leaving the wall to an external recipient (chat /transfer, confirmed).
   * target is the USDG token contract; the recipient is free-form but the
   * amount is capped on-chain by the grant's transfer permission and here by
   * the same per-trade/daily caps as any spend.
   */
  kind: "transfer";
  target: `0x${string}`;
  recipient: `0x${string}`;
  amountUsdg: bigint;
});

export type Verdict =
  | { ok: true }
  | { ok: false; rule: string; detail: string };

export interface AgentState {
  spentTodayUsdg: bigint;
  /** Executed operations in the trailing 24h — mirrors the on-chain rate limit. */
  opsToday: number;
  highWaterMarkUsdg: bigint;
  equityUsdg: bigint;
  /**
   * Is `equityUsdg` the WHOLE book? False when a held asset couldn't be valued
   * this tick, in which case the figure is a partial sum — lower than reality,
   * not equal to it.
   *
   * The drawdown rule must not run on a partial total. Doing so reads the
   * missing asset as a loss and rejects every intent, INCLUDING the sell that
   * would clear the position — the agent locks itself in precisely when the
   * owner most needs it to act. Absent = true, so existing callers keep today's
   * behaviour; only a caller that KNOWS the book is short passes false.
   */
  equityKnown?: boolean;
  nowSec: number;
}

export function checkPolicy(intent: TradeIntent, limits: AgentLimits, state: AgentState): Verdict {
  if (state.nowSec >= limits.expiresAt) {
    return { ok: false, rule: "expiry", detail: "session key expired" };
  }

  const lc = (a: string) => a.toLowerCase();
  if (!limits.allowedTargets.map(lc).includes(lc(intent.target))) {
    return { ok: false, rule: "target-allowlist", detail: `target ${intent.target} not allowed` };
  }

  if (intent.kind === "swap") {
    for (const token of [intent.sellToken, intent.buyToken]) {
      if (!limits.allowedAssets.map(lc).includes(lc(token))) {
        return { ok: false, rule: "asset-allowlist", detail: `asset ${token} not allowed` };
      }
    }

    // NEVER ENTER A POSITION THE KEY CANNOT EXIT.
    //
    // Buying spends USDG, which every grant can approve generically; selling
    // needs a per-token approve sealed into the signature. So a token with a
    // live pool but no approve permission buys fine and can never be sold —
    // the exit reverts at the wall, and no cap or breaker helps, because the
    // owner's money is in an asset the agent has no way to give back.
    //
    // This is checked here rather than left to the on-chain policy on purpose:
    // on-chain, the failure lands on the SELL, long after the buy succeeded and
    // the position exists. Refusing the buy is the only moment it's still free.
    //
    // Sells are never blocked by this rule — an exit must always be attemptable.
    if (limits.sellableAssets) {
      const sellable = limits.sellableAssets.map(lc);
      if (!sellable.includes(lc(intent.buyToken))) {
        return {
          ok: false,
          rule: "no-exit",
          detail:
            `refusing to buy ${intent.buyToken}: this key can't approve it for a sell, ` +
            `so the position could be opened and never closed. Re-sign the grant at /grant to cover it.`,
        };
      }
    }
  }

  if (intent.kind === "transfer") {
    // Recipient is free-form by design (user-confirmed in chat) but must at
    // least be a plausible address — garbage never reaches calldata.
    if (!/^0x[0-9a-fA-F]{40}$/.test(intent.recipient)) {
      return { ok: false, rule: "transfer-recipient", detail: `recipient ${intent.recipient} is not an address` };
    }
    if (intent.amountUsdg <= 0n) {
      return { ok: false, rule: "transfer-amount", detail: "transfer amount must be positive" };
    }
  }

  if (state.opsToday >= limits.maxOpsPerDay) {
    return { ok: false, rule: "ops-cap", detail: `${state.opsToday} ops in 24h >= ${limits.maxOpsPerDay}` };
  }

  // Per-op size ceiling — mirrors the on-chain call policy EXACTLY, because a
  // stricter mirror rejects trades the chain would happily allow (a real bug per
  // this file's contract). On-chain (web/src/lib/session.ts):
  //   • swaps & transfers  → approve/transfer USDG capped at the PER-TRADE limit
  //   • vault deposits      → capped at the DAILY limit (parking idle cash in the
  //                           Morpho vault isn't a market spend; it's reversible)
  //   • vault withdrawals   → unsized (funds return to the account)
  // The old mirror capped deposits at the per-trade limit, so a large idle-cash
  // sweep (e.g. 80 USDG with a 30-USDG per-trade cap) was rejected every tick
  // while the chain would have accepted it.
  if (intent.kind !== "vault-withdraw") {
    const notional = intent.kind === "swap" ? intent.notionalUsdg : intent.amountUsdg;
    const isDeposit = intent.kind === "vault-deposit";
    const perOpCap = isDeposit ? limits.dailyUsdg : limits.perTradeUsdg;
    if (notional > perOpCap) {
      return {
        ok: false,
        rule: isDeposit ? "deposit-cap" : "per-trade-cap",
        detail: `${notional} > ${perOpCap}`,
      };
    }
    if (state.spentTodayUsdg + notional > limits.dailyUsdg) {
      return { ok: false, rule: "daily-cap", detail: `would exceed daily cap ${limits.dailyUsdg}` };
    }
  }

  // Unknown equity is not low equity. Every other rule above still applies —
  // caps, allowlists, expiry, budgets — but a drawdown can only be measured
  // against a book we can actually total.
  if (state.highWaterMarkUsdg > 0n && state.equityKnown !== false) {
    const drawdownBps = Number(
      ((state.highWaterMarkUsdg - state.equityUsdg) * 10_000n) / state.highWaterMarkUsdg,
    );
    if (drawdownBps >= limits.maxDrawdownBps) {
      return { ok: false, rule: "drawdown-breaker", detail: `${drawdownBps}bps >= ${limits.maxDrawdownBps}bps` };
    }
  }

  return { ok: true };
}
