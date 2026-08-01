import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPaperOrderExecutor, type EquityOrder } from "./executor-order";

/**
 * The paper OrderExecutor — the review/place pair the broker rail's safety
 * shape is built on, exercised where its numbers can silently be wrong.
 */

const px = new Map<string, bigint>([["AAPL", 20_000_000_000n]]); // $200.00, 8dp
const exec = (slippageBps = 0) =>
  createPaperOrderExecutor({ priceUsd8Of: (t) => px.get(t) ?? null, slippageBps });

const buy = (notionalUsdg: bigint): EquityOrder => ({ ticker: "AAPL", side: "buy", notionalUsdg });

describe("paper OrderExecutor — review", () => {
  it("prices a buy and derives shares from notional (never the other way round)", async () => {
    // $100 at $200/share = 0.5 shares (1e18 convention, same as the paper book)
    const r = await exec().review(buy(100_000_000n));
    assert.equal(r.priceUsd8, 20_000_000_000n);
    assert.equal(r.shares1e18, 500_000_000_000_000_000n);
    assert.equal(r.notionalUsdg, 100_000_000n);
  });

  it("slippage works AGAINST you on both sides", async () => {
    // 100bps: buys fill 1% above mid, sells 1% below.
    const rBuy = await exec(100).review(buy(100_000_000n));
    assert.equal(rBuy.priceUsd8, 20_200_000_000n);
    const rSell = await exec(100).review({ ticker: "AAPL", side: "sell", notionalUsdg: 100_000_000n });
    assert.equal(rSell.priceUsd8, 19_800_000_000n);
    // Fewer shares for the same money on the buy — pessimism, not optimism.
    assert.ok(rBuy.shares1e18 < rSell.shares1e18);
  });

  it("REFUSES a ticker with no trustworthy price — a fill price is never invented", async () => {
    const unpriced: EquityOrder = { ticker: "GME", side: "buy", notionalUsdg: 100_000_000n };
    await assert.rejects(() => exec().review(unpriced), /no trustworthy price/);
  });

  it("refuses non-positive notional and dust that rounds to zero shares", async () => {
    await assert.rejects(() => exec().review(buy(0n)), /non-positive/);
    // With an absurd price, 1 micro-USD buys < 1e-18 shares → refuse.
    const dear = createPaperOrderExecutor({ priceUsd8Of: () => 10n ** 28n, slippageBps: 0 });
    await assert.rejects(() => dear.review(buy(1n)), /zero shares/);
  });
});

describe("paper OrderExecutor — place & poll", () => {
  it("place honors the REVIEWED terms exactly — the propose/dispose contract", async () => {
    const e = exec(50);
    const order = buy(100_000_000n);
    const review = await e.review(order);
    const ref = await e.place(order, review);
    assert.equal(ref.status, "filled");
    assert.ok(ref.fill);
    assert.equal(ref.fill!.qtyRaw1e18, review.shares1e18);
    assert.equal(ref.fill!.cashUsdg, review.notionalUsdg);
    assert.equal(ref.fill!.symbol, "AAPL");
    assert.equal(ref.fill!.side, "buy");
  });

  it("order ids are unique across fills", async () => {
    const e = exec();
    const r = await e.review(buy(50_000_000n));
    const a = await e.place(buy(50_000_000n), r);
    const b = await e.place(buy(50_000_000n), r);
    assert.notEqual(a.orderId, b.orderId);
  });

  it("poll is the identity for paper — nothing is ever in flight", async () => {
    const e = exec();
    const r = await e.review(buy(50_000_000n));
    const ref = await e.place(buy(50_000_000n), r);
    assert.deepEqual(await e.poll(ref), ref);
  });
});
