import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proposalsToEquityIntents, type EquityUniverse, type ProposedAction } from "./proposals";

/**
 * The equities proposal boundary. Same discipline as the on-chain converter's
 * tests: what a model proposes and what becomes an intent are different things,
 * and every gap between them must be a recorded rejection, never a repair.
 */

const UNIVERSE: EquityUniverse = {
  tickers: new Set(["AAPL", "NVDA", "MSFT"]),
  maxPerActionUsdg: 100_000_000n, // 100 USD
  maxActionsPerTick: 3,
};

const buy = (symbol: string, sizeUsdg: number): ProposedAction => ({ action: "buy", symbol, sizeUsdg, reason: "" });
const sell = (symbol: string, sizeUsdg: number): ProposedAction => ({ action: "sell", symbol, sizeUsdg, reason: "" });

const flat = { cashUsdg: 500_000_000n, heldValueUsdg: () => 0n };
const holding = (v: bigint) => ({ cashUsdg: 500_000_000n, heldValueUsdg: () => v });

describe("proposalsToEquityIntents", () => {
  it("converts a buy into a notional order — no addresses, no share math", () => {
    const r = proposalsToEquityIntents([buy("AAPL", 50)], UNIVERSE, flat);
    assert.deepEqual(r.intents, [
      { kind: "equity-order", ticker: "AAPL", side: "buy", notionalUsdg: 50_000_000n },
    ]);
    assert.equal(r.rejected.length, 0);
  });

  it("uppercases the ticker so 'aapl' cannot slip past a case-sensitive allowlist later", () => {
    const r = proposalsToEquityIntents([buy("aapl", 10)], UNIVERSE, flat);
    assert.equal(r.intents[0]?.kind === "equity-order" && r.intents[0].ticker, "AAPL");
  });

  it("rejects out-of-universe symbols with a reason", () => {
    const r = proposalsToEquityIntents([buy("GME", 10)], UNIVERSE, flat);
    assert.equal(r.intents.length, 0);
    assert.match(r.rejected[0]!, /not in the tradable universe/);
  });

  it("gates buys on SETTLED CASH and decrements across the batch", () => {
    // 500 cash: 300 + 150 fit, the third 100 does not — order matters and the
    // ceiling is what's LEFT, not what we started with.
    const u = { ...UNIVERSE, maxPerActionUsdg: 400_000_000n };
    const r = proposalsToEquityIntents([buy("AAPL", 300), buy("NVDA", 150), buy("MSFT", 100)], u, flat);
    assert.equal(r.intents.length, 2);
    assert.match(r.rejected[0]!, /exceeds available cash/);
  });

  it("caps a sell at the held value — you cannot sell what you do not hold", () => {
    const r = proposalsToEquityIntents([sell("AAPL", 100)], UNIVERSE, holding(30_000_000n));
    assert.deepEqual(r.intents, [
      { kind: "equity-order", ticker: "AAPL", side: "sell", notionalUsdg: 30_000_000n },
    ]);
  });

  it("rejects a sell of a symbol with nothing held", () => {
    const r = proposalsToEquityIntents([sell("AAPL", 10)], UNIVERSE, flat);
    assert.equal(r.intents.length, 0);
    assert.match(r.rejected[0]!, /nothing held to sell/);
  });

  it("enforces the strategist ceiling, the per-tick action cap, and skips holds", () => {
    const r = proposalsToEquityIntents(
      [
        { action: "hold", symbol: "AAPL", sizeUsdg: 0, reason: "" },
        buy("AAPL", 101), // over maxPerActionUsdg
        buy("NVDA", 10),
        buy("MSFT", 10),
        buy("AAPL", 10),
        buy("NVDA", 10), // over maxActionsPerTick
      ],
      UNIVERSE,
      flat,
    );
    assert.equal(r.intents.length, 3);
    assert.match(r.rejected[0]!, /exceeds strategist ceiling/);
    assert.match(r.rejected[1]!, /max 3 actions/);
  });

  it("drops malformed sizes rather than repairing them", () => {
    const r = proposalsToEquityIntents([buy("AAPL", NaN), buy("NVDA", -5)], UNIVERSE, flat);
    assert.equal(r.intents.length, 0);
    assert.equal(r.rejected.length, 2);
  });

  it("pairs accepted[i] with intents[i] so every order journals its own reasoning", () => {
    const r = proposalsToEquityIntents([buy("GME", 10), buy("AAPL", 10)], UNIVERSE, flat);
    assert.equal(r.intents.length, 1);
    assert.equal(r.accepted.length, 1);
    assert.equal(r.accepted[0]!.symbol, "AAPL");
  });
});
