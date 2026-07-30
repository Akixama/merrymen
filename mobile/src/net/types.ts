/**
 * The feed contract, mirrored from web/src/app/api/feed/route.ts.
 *
 * Kept as a hand-written mirror rather than an import because the dashboard is a
 * Next app that this project does not compile. If the server shape changes, this
 * file is the one place that has to follow — and `source` exists precisely so the
 * client can tell "the agent has no database yet" apart from "the agent is idle".
 */

export interface FeedEvent {
  level: "ok" | "warn" | "err";
  message: string;
  created_at: string;
}

export interface EquityPoint {
  cash_usdg: number;
  vault_usdg: number;
  equity_usdg: number;
  at: string;
}

export interface PositionRow {
  symbol: string;
  raw_balance: string;
  ui_multiplier: string;
  price_usd: number;
  price_stale: number;
  /**
   * 'chainlink' or 'pool'. A pool price is a Uniswap TWAP that cleared the depth
   * and divergence guards — actionable, but a thinner claim than an external
   * feed. The UI must say which, never blur them.
   */
  price_source: string;
  value_usdg: number;
}

export interface TradeRecord {
  kind: string;
  sell_token: string | null;
  buy_token: string | null;
  amount_usdg: number;
  tx_hash: string | null;
  status: "landed" | "reverted" | "rejected" | "paper";
  reject_rule: string | null;
  sim_quote_out: string | null;
  sim_min_out: string | null;
  sim_fee_tier: number | null;
  sim_gas: string | null;
  created_at: string;
}

export interface AgentFinancials {
  hwm_usdg: number;
  accrued_fee_usdg: number;
}

export interface AgentIdentity {
  name: string;
  strategy: string;
  basket: string[];
}

export interface FeedResponse {
  source: "sqlite" | "none";
  events: FeedEvent[];
  equity: EquityPoint[];
  positions: PositionRow[];
  trades: TradeRecord[];
  financials: AgentFinancials | null;
  agent: AgentIdentity | null;
}

/**
 * A stable id for a trade.
 *
 * The server sends no id, and the tape needs one for keyExtractor, for dedupe
 * across polls, and for FlashList's recycling to track a row. tx_hash is the
 * natural key when it exists, but a rejected or paper trade never gets one — so
 * fall back to the fields that together identify it. Getting this wrong makes
 * rows duplicate on every poll or, worse, silently replace each other.
 */
export function tradeId(t: TradeRecord): string {
  if (t.tx_hash) return t.tx_hash;
  return `${t.created_at}|${t.kind}|${t.buy_token ?? "-"}|${t.sell_token ?? "-"}|${t.amount_usdg}`;
}
