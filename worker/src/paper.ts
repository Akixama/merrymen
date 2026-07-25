/**
 * Paper trading — the full merrymen loop with zero funds.
 *
 * When the account can't sign (no bundler key), approved intents are FILLED
 * here instead of stubbed: at the live on-chain oracle price (the same
 * Chainlink feeds Robinhood publishes for every stock token), minus the
 * configured slippage as honest friction. Fills land in the real ledger as
 * status "paper" trades, the book lives in SQLite, and everything downstream
 * — equity curve, positions, pings, digests, chat trades — works unchanged.
 *
 * The policy wall is NOT relaxed: intents reach this file only after
 * checkPolicy approves them against the signed grant's caps. Paper mode
 * changes what "execute" means, never what is allowed.
 */

import type { TradeIntent } from "./policy";

export interface PaperBook {
  cashUsdg: number;
  vaultUsdg: number;
  hwmUsdg: number;
}

export interface PaperPosition {
  symbol: string;
  token: `0x${string}`;
  /** Whole shares (paper needs no 18-dp bigint gymnastics). */
  shares: number;
}

/** What actually moved on a stock fill — the inputs cost-basis accounting needs. */
export interface PaperFillDetail {
  side: "buy" | "sell";
  symbol: string;
  token: `0x${string}`;
  /** Whole shares filled (paper carries no multiplier, so 1 share = 1e18 raw). */
  shares: number;
  priceUsd: number;
  /** USDG actually spent (buy) or received (sell), slippage included. */
  cashUsdg: number;
}

export interface PaperFillResult {
  ok: boolean;
  reason?: string;
  book: PaperBook;
  positions: PaperPosition[];
  /** Human receipt line, e.g. "paper fill: 0.0138 QQQ @ $724.51 (px live)". */
  receipt?: string;
  /** Present only for stock buys/sells — vault moves and no-ops carry no basis. */
  fill?: PaperFillDetail;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Apply one approved intent to the paper book. Pure — persistence is the
 * caller's job. `priceUsdOf` returns the live oracle price for a token
 * address (null = no feed → the fill is refused, never invented).
 */
export function applyPaperIntent(
  intent: TradeIntent,
  book: PaperBook,
  positions: PaperPosition[],
  opts: {
    priceUsdOf: (token: `0x${string}`) => { priceUsd: number; stale: boolean } | null;
    symbolOf: (token: `0x${string}`) => string | null;
    usdgAddress: `0x${string}`;
    slippageBps: number;
    notionalUsdg: number;
  },
): PaperFillResult {
  const next: PaperBook = { ...book };
  const pos = positions.map((p) => ({ ...p }));
  const slip = opts.slippageBps / 10_000;
  const n = opts.notionalUsdg;

  if (intent.kind === "vault-deposit") {
    if (n > next.cashUsdg) return { ok: false, reason: "paper cash short of the deposit", book, positions };
    next.cashUsdg = round6(next.cashUsdg - n);
    next.vaultUsdg = round6(next.vaultUsdg + n);
    return { ok: true, book: next, positions: pos, receipt: `paper: ${n} USDG → vault` };
  }
  if (intent.kind === "vault-withdraw") {
    const amt = Math.min(n, next.vaultUsdg);
    next.vaultUsdg = round6(next.vaultUsdg - amt);
    next.cashUsdg = round6(next.cashUsdg + amt);
    return { ok: true, book: next, positions: pos, receipt: `paper: ${amt} USDG ← vault` };
  }
  if (intent.kind === "transfer") {
    if (n > next.cashUsdg) return { ok: false, reason: "paper cash short of the transfer", book, positions };
    next.cashUsdg = round6(next.cashUsdg - n);
    return { ok: true, book: next, positions: pos, receipt: `paper: ${n} USDG sent out` };
  }

  // ── swap ──────────────────────────────────────────────────────────────
  if (intent.kind !== "swap") return { ok: false, reason: `unsupported paper intent ${intent.kind}`, book, positions };
  const buyingStock = intent.sellToken.toLowerCase() === opts.usdgAddress.toLowerCase();
  const stockToken = (buyingStock ? intent.buyToken : intent.sellToken) as `0x${string}`;
  // The selftest no-op (USDG→USDG) fills as a zero-move success.
  if (intent.sellToken.toLowerCase() === intent.buyToken.toLowerCase()) {
    return { ok: true, book: next, positions: pos, receipt: "paper: pipeline no-op" };
  }
  const px = opts.priceUsdOf(stockToken);
  const symbol = opts.symbolOf(stockToken);
  if (!px || !symbol || px.priceUsd <= 0) {
    return { ok: false, reason: `no live price for ${symbol ?? stockToken} — paper fill refused`, book, positions };
  }
  const staleTag = px.stale ? "px 24/5" : "px live";
  const held = pos.find((p) => p.symbol === symbol);

  if (buyingStock) {
    if (n > next.cashUsdg) return { ok: false, reason: "paper cash short of the buy", book, positions };
    const shares = (n * (1 - slip)) / px.priceUsd; // slippage eats into what you get
    next.cashUsdg = round6(next.cashUsdg - n);
    if (held) held.shares += shares;
    else pos.push({ symbol, token: stockToken, shares });
    return {
      ok: true,
      book: next,
      positions: pos,
      receipt: `paper fill: +${shares.toFixed(4)} ${symbol} @ $${px.priceUsd.toFixed(2)} (${staleTag})`,
      // Cost basis takes the CASH SPENT (n), not shares×price: the slippage is a
      // real cost of the position and belongs in its basis.
      fill: { side: "buy", symbol, token: stockToken, shares, priceUsd: px.priceUsd, cashUsdg: n },
    };
  }

  // selling stock for USDG
  const sellShares = n / px.priceUsd;
  if (!held || held.shares <= 0) return { ok: false, reason: `no paper ${symbol} to sell`, book, positions };
  const actualShares = Math.min(sellShares, held.shares);
  const proceeds = actualShares * px.priceUsd * (1 - slip);
  held.shares = round6(held.shares - actualShares);
  next.cashUsdg = round6(next.cashUsdg + proceeds);
  return {
    ok: true,
    book: next,
    positions: pos.filter((p) => p.shares > 1e-9),
    receipt: `paper fill: −${actualShares.toFixed(4)} ${symbol} @ $${px.priceUsd.toFixed(2)} (${staleTag})`,
    // Proceeds are net of slippage — the cash that actually landed.
    fill: { side: "sell", symbol, token: stockToken, shares: actualShares, priceUsd: px.priceUsd, cashUsdg: round6(proceeds) },
  };
}

/** Mark-to-market the paper book at live prices. */
export function paperEquityUsdg(
  book: PaperBook,
  positions: PaperPosition[],
  priceUsdOf: (token: `0x${string}`) => { priceUsd: number; stale: boolean } | null,
): number {
  const posValue = positions.reduce((sum, p) => {
    const px = priceUsdOf(p.token);
    return sum + (px ? p.shares * px.priceUsd : 0);
  }, 0);
  return round6(book.cashUsdg + book.vaultUsdg + posValue);
}
