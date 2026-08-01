// Relative, never the @merrymen/core alias — the alias doesn't resolve inside
// the installed package (guarded by imports.test.ts).
import type { McpClient } from "../../../packages/core/src/mcp";
import type { PriceQuote } from "../../../packages/core/src/index";

/**
 * The read-only half of the Robinhood venue: quotes, positions, balances.
 *
 * Everything here calls tools that cannot move money, through McpClient's gate,
 * which refuses mutating names by default. This module never opts anything in.
 *
 * ── PROVISIONAL WIRE SHAPES — READ THIS BEFORE TRUSTING A PARSER ──────────────
 * The live `tools/list` has never been read: the spike was blocked at the
 * Agentic-account gate (DESIGN.md §11 Q2). Every field name below is a guess
 * from Robinhood's public docs, held in one CANDIDATES table so the day the
 * real schema is on the wire there is exactly one place to correct.
 *
 * The posture that makes guessing survivable is FAIL CLOSED. A row whose shape
 * isn't recognised is skipped and reported, never coerced; a price that isn't a
 * positive finite number becomes no price at all. The worker already has the
 * right behaviour for a missing price — the position is held, not valued, and
 * still sellable — so a wrong guess here degrades to "unpriced", not to a wrong
 * number. A wrong number would flow into equity, the high-water mark, the
 * performance fee and the drawdown breaker; "unpriced" flows into a warning.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** One place to fix when the real schema lands. Order = preference. */
const CANDIDATES = {
  symbol: ["symbol", "ticker"],
  price: ["last_trade_price", "last_price", "price", "mark_price"],
  quantity: ["quantity", "qty", "shares"],
  cash: ["cash", "cash_balance", "settled_cash"],
  buyingPower: ["buying_power", "buying_power_usd"],
} as const;

function pick(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (k in row) return row[k];
  return undefined;
}

/**
 * Unwrap a tools/call result to its payload.
 *
 * MCP servers answer with `structuredContent` and/or `content:[{type:"text",
 * text}]` blocks. Prefer the structured form; otherwise concatenate the text
 * blocks and parse. Anything else is a structural surprise worth a loud throw —
 * a silent {} here would read as "empty portfolio", which is a lie.
 */
export function parseToolPayload(result: unknown): unknown {
  if (result === null || typeof result !== "object") {
    throw new Error("tool result is not an object");
  }
  const r = result as { structuredContent?: unknown; content?: unknown };
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (Array.isArray(r.content)) {
    const text = r.content
      .filter((c): c is { type: string; text: string } => {
        return !!c && typeof c === "object" && (c as { type?: unknown }).type === "text";
      })
      .map((c) => c.text)
      .join("");
    if (!text) throw new Error("tool result had no text content");
    return JSON.parse(text);
  }
  throw new Error("tool result carried neither structuredContent nor text content");
}

/**
 * USD → 8dp bigint, or null.
 *
 * Null — not zero, not a throw — because "this row has no usable price" is a
 * per-row condition the caller skips, while zero would VALUE the position at
 * nothing and a throw would take every other symbol down with it.
 */
export function usdToPrice8(v: unknown): bigint | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 1e8));
}

export interface BrokerQuotesRead {
  quotes: Map<string, PriceQuote>;
  /** Symbols whose row existed but couldn't be read — surfaced, never guessed. */
  skipped: string[];
}

export function parseBrokerQuotes(payload: unknown): BrokerQuotesRead {
  const rows = asRows(payload, ["quotes", "results"]);
  const quotes = new Map<string, PriceQuote>();
  const skipped: string[] = [];
  for (const row of rows) {
    const symbol = pick(row, CANDIDATES.symbol);
    if (typeof symbol !== "string" || !symbol) continue;
    const price8 = usdToPrice8(pick(row, CANDIDATES.price));
    if (price8 === null) {
      skipped.push(symbol);
      continue;
    }
    quotes.set(symbol, {
      price8,
      // Fresh by definition: this map exists because the call just returned.
      // Whether the MARKET is open is a different signal (DESIGN.md §6) and is
      // deliberately not encoded in `stale`, whose meaning is feed age.
      stale: false,
      source: "broker",
    });
  }
  return { quotes, skipped };
}

export interface BrokerPosition {
  symbol: string;
  /**
   * Share count exactly as the broker printed it, undigested. The share-unit
   * decision (integer at a fixed precision, DESIGN.md §6) belongs to the store
   * marshaling in step 3 — parsing and unit policy stay separate so a unit
   * mistake can't hide inside a parser.
   */
  quantityRaw: string;
  priceUsd8: bigint | null;
}

export interface BrokerPositionsRead {
  positions: BrokerPosition[];
  skipped: number;
}

export function parseBrokerPositions(payload: unknown): BrokerPositionsRead {
  const rows = asRows(payload, ["positions", "results"]);
  const positions: BrokerPosition[] = [];
  let skipped = 0;
  for (const row of rows) {
    const symbol = pick(row, CANDIDATES.symbol);
    const qty = pick(row, CANDIDATES.quantity);
    if (typeof symbol !== "string" || !symbol || (typeof qty !== "string" && typeof qty !== "number")) {
      skipped++;
      continue;
    }
    positions.push({
      symbol,
      quantityRaw: String(qty),
      priceUsd8: usdToPrice8(pick(row, CANDIDATES.price)),
    });
  }
  return { positions, skipped };
}

export interface BrokerBalances {
  /** Settled cash. Null = not found in the payload, NOT zero. */
  cashUsd8: bigint | null;
  /**
   * Kept separate from cash on purpose: margin buying power is not settled
   * money, and affordability checks that treat it as cash overspend
   * (DESIGN.md §6 — proposals gate buys on cash, never on buying power).
   */
  buyingPowerUsd8: bigint | null;
}

export function parseBrokerBalances(payload: unknown): BrokerBalances {
  const row =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    cashUsd8: usdToPrice8(pick(row, CANDIDATES.cash)),
    buyingPowerUsd8: usdToPrice8(pick(row, CANDIDATES.buyingPower)),
  };
}

/** Accept a bare array or one wrapped under a known key; refuse anything else. */
function asRows(payload: unknown, wrapperKeys: string[]): Record<string, unknown>[] {
  let arr: unknown = payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const k of wrapperKeys) {
      const v = (payload as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        arr = v;
        break;
      }
    }
  }
  if (!Array.isArray(arr)) throw new Error("expected an array of rows (schema drift? see CANDIDATES)");
  return arr.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

// ── live readers ─────────────────────────────────────────────────────────────

export async function readBrokerQuotes(client: McpClient, symbols: string[]): Promise<BrokerQuotesRead> {
  const result = await client.callTool("get_equity_quotes", { symbols });
  return parseBrokerQuotes(parseToolPayload(result));
}

export async function readBrokerPositions(client: McpClient): Promise<BrokerPositionsRead> {
  const result = await client.callTool("get_equity_positions", {});
  return parseBrokerPositions(parseToolPayload(result));
}

export async function readBrokerBalances(client: McpClient): Promise<BrokerBalances> {
  const result = await client.callTool("get_portfolio", {});
  return parseBrokerBalances(parseToolPayload(result));
}
