import { createStore } from "zustand/vanilla";
import { tradeId, type FeedResponse, type PositionRow, type TradeRecord } from "@/net/types";

/**
 * The feed store — a VANILLA zustand store, deliberately outside React.
 *
 * This is the piece that decides whether the app lags, and it has to exist before
 * any list does. The failure mode it avoids: hold the feed in React state, and
 * every poll produces a new array identity, so every row in every list re-renders
 * every few seconds whether or not anything about it changed. On a phone that is
 * visible as dropped frames while scrolling.
 *
 * Two properties make that impossible here:
 *
 *   NORMALISED. Positions and trades are keyed maps, not arrays, so a row can be
 *   addressed on its own. Lists render from an id array and each row subscribes
 *   to its OWN entry — a price tick on NVDA re-renders one row, not forty.
 *
 *   IDENTITY-PRESERVING. `ingest` compares field by field and REUSES the previous
 *   object when nothing changed. That is what makes per-row subscriptions
 *   worthwhile: without it every row gets a fresh object each poll and subscribing
 *   per row buys nothing at all.
 */

const TAPE_CAP = 300;

export interface FeedState {
  /** null until the first successful read — distinct from "read, and empty". */
  source: FeedResponse["source"] | null;
  equityUsdg: number | null;
  cashUsdg: number | null;
  vaultUsdg: number | null;
  /** Oldest → newest, for the sparkline. Capped; the chart cannot show more. */
  equitySeries: number[];
  positionSymbols: string[];
  positions: Record<string, PositionRow>;
  tapeIds: string[];
  tape: Record<string, TradeRecord>;
  agentName: string | null;
  strategy: string | null;
  /** Wall-clock of the last SUCCESSFUL read, so staleness is showable. */
  lastOkAt: number | null;
  /** Last error message, kept alongside the data rather than replacing it. */
  lastError: string | null;
}

const initial: FeedState = {
  source: null,
  equityUsdg: null,
  cashUsdg: null,
  vaultUsdg: null,
  equitySeries: [],
  positionSymbols: [],
  positions: {},
  tapeIds: [],
  tape: {},
  agentName: null,
  strategy: null,
  lastOkAt: null,
  lastError: null,
};

export const feedStore = createStore<FeedState>(() => initial);

/** Field-wise equality for a position. Cheaper than deep-equal, and exact. */
function samePosition(a: PositionRow, b: PositionRow): boolean {
  return (
    a.symbol === b.symbol &&
    a.raw_balance === b.raw_balance &&
    a.ui_multiplier === b.ui_multiplier &&
    a.price_usd === b.price_usd &&
    a.price_stale === b.price_stale &&
    a.price_source === b.price_source &&
    a.value_usdg === b.value_usdg
  );
}

const sameStrings = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Fold a poll response into the store, preserving identity wherever possible.
 *
 * Everything that can be capped is capped HERE rather than at render time. A list
 * that trims in the component still pays to hold and diff the whole history; one
 * that trims at ingest never sees it. The tape is the one that grows without
 * bound, so it is the one that matters.
 */
export function ingest(res: FeedResponse): void {
  const prev = feedStore.getState();
  const next: FeedState = { ...prev, source: res.source, lastOkAt: Date.now(), lastError: null };

  // ── equity ────────────────────────────────────────────────────────────────
  // The API returns oldest-first points; the last one is current.
  const latest = res.equity.length ? res.equity[res.equity.length - 1] : null;
  if (latest) {
    next.equityUsdg = latest.equity_usdg;
    next.cashUsdg = latest.cash_usdg;
    next.vaultUsdg = latest.vault_usdg;
  }
  const series = res.equity.map((p) => p.equity_usdg).slice(-120);
  // Reuse the old array when the numbers are identical, so the sparkline's
  // memoized path isn't invalidated by a poll that changed nothing.
  next.equitySeries =
    series.length === prev.equitySeries.length && series.every((v, i) => v === prev.equitySeries[i])
      ? prev.equitySeries
      : series;

  // ── positions ─────────────────────────────────────────────────────────────
  const positions: Record<string, PositionRow> = {};
  const symbols: string[] = [];
  for (const row of res.positions) {
    symbols.push(row.symbol);
    const old = prev.positions[row.symbol];
    // THE POINT: an unchanged row keeps its old object, so a subscriber to that
    // row sees no change and does not re-render.
    positions[row.symbol] = old && samePosition(old, row) ? old : row;
  }
  next.positions = positions;
  next.positionSymbols = sameStrings(symbols, prev.positionSymbols) ? prev.positionSymbols : symbols;

  // ── trade tape ────────────────────────────────────────────────────────────
  // Merge rather than replace: the server window can slide, and a row vanishing
  // and reappearing would make the tape flicker. Newest first.
  const tape: Record<string, TradeRecord> = { ...prev.tape };
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const t of res.trades) {
    const id = tradeId(t);
    if (seen.has(id)) continue; // the server can repeat a row across windows
    seen.add(id);
    merged.push(id);
    const old = tape[id];
    // A landed trade is immutable once seen, so only replace when status or hash
    // actually moved (a paper fill becoming landed, say).
    tape[id] = old && old.status === t.status && old.tx_hash === t.tx_hash ? old : t;
  }
  for (const id of prev.tapeIds) if (!seen.has(id)) merged.push(id);
  const capped = merged.slice(0, TAPE_CAP);
  // Drop anything that fell off the end, or the map grows forever.
  if (capped.length < merged.length) {
    const keep = new Set(capped);
    for (const id of Object.keys(tape)) if (!keep.has(id)) delete tape[id];
  }
  next.tape = tape;
  next.tapeIds = sameStrings(capped, prev.tapeIds) ? prev.tapeIds : capped;

  // ── identity ──────────────────────────────────────────────────────────────
  if (res.agent) {
    next.agentName = res.agent.name;
    next.strategy = res.agent.strategy;
  }

  feedStore.setState(next, true);
}

/**
 * Record a failed poll WITHOUT discarding what's on screen.
 *
 * A dropped read is not new information about the portfolio. Blanking the numbers
 * would be inventing a change that didn't happen — the honest move is to keep the
 * last known values and let the UI mark them stale from `lastOkAt`.
 */
export function ingestError(message: string): void {
  feedStore.setState({ lastError: message });
}

export function resetFeed(): void {
  feedStore.setState(initial, true);
}
