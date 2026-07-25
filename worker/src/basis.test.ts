import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFill, avgCostUsdgPerUnit, unrealizedUsdg, ZERO_BASIS, type BasisRow, type Fill } from "./basis";

const SHARE = 10n ** 18n; // one whole raw unit (18dp)
const usdg = (v: number) => BigInt(Math.round(v * 1e6)); // 6dp USDG

describe("applyFill — weighted-average cost basis", () => {
  it("a buy accumulates quantity and cost", () => {
    const r = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: SHARE, cashUsdg: usdg(100) });
    assert.equal(r.basis.qtyRaw, SHARE);
    assert.equal(r.basis.costUsdg, usdg(100));
    assert.equal(r.realizedUsdg, 0n, "a buy never books P&L");
  });

  it("buy, buy, sell books P&L against the WEIGHTED AVERAGE, not the last price", () => {
    // 1 share @ $100, then 1 share @ $200 → avg cost $150/share.
    let b: BasisRow = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: SHARE, cashUsdg: usdg(100) }).basis;
    b = applyFill(b, { side: "buy", qtyRaw: SHARE, cashUsdg: usdg(200) }).basis;
    assert.equal(b.qtyRaw, 2n * SHARE);
    assert.equal(b.costUsdg, usdg(300));

    // Sell 1 share for $250 → cost out $150, realized +$100.
    const r = applyFill(b, { side: "sell", qtyRaw: SHARE, cashUsdg: usdg(250) });
    assert.equal(r.costOutUsdg, usdg(150));
    assert.equal(r.realizedUsdg, usdg(100));
    assert.equal(r.basis.qtyRaw, SHARE);
    assert.equal(r.basis.costUsdg, usdg(150), "the remaining share keeps its half of the cost");
  });

  it("a losing sell books a NEGATIVE realized figure (no flattering rounding)", () => {
    const b = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: SHARE, cashUsdg: usdg(200) }).basis;
    const r = applyFill(b, { side: "sell", qtyRaw: SHARE, cashUsdg: usdg(180) });
    assert.equal(r.realizedUsdg, usdg(-20));
  });

  it("selling the ENTIRE position zeroes the basis exactly — no stranded residue", () => {
    // An awkward quantity + cost so pro-rata truncation would leave dust behind.
    const qty = 333_333_333_333_333_333n;
    const b = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: qty, cashUsdg: 99_999_991n }).basis;
    const r = applyFill(b, { side: "sell", qtyRaw: qty, cashUsdg: usdg(120) });
    assert.equal(r.basis.qtyRaw, 0n);
    assert.equal(r.basis.costUsdg, 0n, "no cost left on a zero position");
    assert.equal(r.costOutUsdg, 99_999_991n, "the whole cost came out");
    assert.equal(r.realizedUsdg, usdg(120) - 99_999_991n);
  });

  it("a partial sell of an awkward quantity keeps basis non-negative and consistent", () => {
    const b = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: 7n * SHARE / 3n, cashUsdg: 123_456_789n }).basis;
    const r = applyFill(b, { side: "sell", qtyRaw: SHARE / 3n, cashUsdg: 20_000_001n });
    assert.ok(r.basis.qtyRaw > 0n);
    assert.ok(r.basis.costUsdg >= 0n);
    assert.equal(r.basis.qtyRaw, b.qtyRaw - SHARE / 3n);
    assert.equal(r.basis.costUsdg, b.costUsdg - r.costOutUsdg, "cost tracks the quantity removed");
  });

  it("overselling is capped at the holding — basis can never go negative", () => {
    const b = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: SHARE, cashUsdg: usdg(100) }).basis;
    const r = applyFill(b, { side: "sell", qtyRaw: 5n * SHARE, cashUsdg: usdg(500) });
    assert.equal(r.appliedQtyRaw, SHARE, "only what was held is applied");
    assert.equal(r.basis.qtyRaw, 0n);
    assert.equal(r.basis.costUsdg, 0n);
    assert.equal(r.basisUnknown, true, "the unbacked excess makes the fill's P&L unknowable");
    assert.equal(r.realizedUsdg, 0n, "no flattering figure from cost-free quantity");
  });

  // UNKNOWN COST IS NOT ZERO COST. Getting this wrong reports a loss as a gain,
  // at the magnitude of the entire original cost — and it fires on the first
  // sell of any position opened before basis tracking existed.
  it("selling with NO basis books no realized figure — it does not credit the proceeds as profit", () => {
    const r = applyFill(ZERO_BASIS, { side: "sell", qtyRaw: SHARE, cashUsdg: usdg(75) });
    assert.equal(r.basisUnknown, true);
    assert.equal(r.realizedUsdg, 0n, "unknown cost must never become pure profit");
    assert.equal(r.costOutUsdg, 0n);
    assert.equal(r.basis.qtyRaw, 0n);
  });

  it("the pre-migration loss case: a $1000 lot sold for $888 is NOT reported as +$888", () => {
    // The exact scenario on an upgraded install: real position, no basis row.
    const r = applyFill(ZERO_BASIS, { side: "sell", qtyRaw: 1_380_590_000_000_000_000n, cashUsdg: usdg(888.41) });
    assert.equal(r.basisUnknown, true);
    assert.notEqual(r.realizedUsdg, usdg(888.41), "the old behaviour inverted the sign on a real loss");
    assert.equal(r.realizedUsdg, 0n);
  });

  it("a zero-quantity fill is a no-op", () => {
    const b = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: SHARE, cashUsdg: usdg(100) }).basis;
    const r = applyFill(b, { side: "buy", qtyRaw: 0n, cashUsdg: usdg(50) });
    assert.deepEqual(r.basis, b, "no quantity, no cost change");
    assert.equal(r.appliedQtyRaw, 0n);
  });
});

describe("basis is split-invariant (ERC-8056)", () => {
  it("a 2-for-1 split changes uiMultiplier, not rawBalance — so basis is untouched", () => {
    // Bought 1 raw unit for $500. A split doubles uiMultiplier and halves the
    // reference price; rawBalance (and therefore basis) does not move at all.
    const b = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: SHARE, cashUsdg: usdg(500) }).basis;
    // Market value post-split is still $500 (positionValueUsdg handles the
    // multiplier), so unrealized is still 0 — a split is not a 50% loss.
    assert.equal(unrealizedUsdg(b, usdg(500)), 0n);
    assert.equal(avgCostUsdgPerUnit(b), usdg(500), "cost per RAW unit is unchanged by the split");
  });
});

describe("unrealized + avg cost", () => {
  it("unrealized is market value minus remaining cost", () => {
    const b = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: 2n * SHARE, cashUsdg: usdg(300) }).basis;
    assert.equal(unrealizedUsdg(b, usdg(360)), usdg(60));
    assert.equal(unrealizedUsdg(b, usdg(240)), usdg(-60));
  });

  it("an empty position has no average cost and no unrealized P&L", () => {
    assert.equal(avgCostUsdgPerUnit(ZERO_BASIS), null);
    assert.equal(unrealizedUsdg(ZERO_BASIS, usdg(999)), 0n);
  });
});

/**
 * THE CONSERVATION INVARIANT. For any FULLY-BACKED sequence (every sell covered
 * by tracked basis) starting from a clean book:
 *
 *   Σ realized + unrealized(finalBasis, marketValue) == Σ proceeds + marketValue − Σ spent
 *
 * i.e. accounting P&L equals economic P&L. It holds EXACTLY, not within a
 * tolerance, because the pro-rata cost split is truncated once and the same
 * truncated figure is both booked to realized and removed from the basis.
 *
 * What this does and does NOT prove: it proves no value leaks or is invented
 * across a sequence. It cannot by itself catch a mis-split BETWEEN realized and
 * unrealized (both sides move together) — the hand-computed weighted-average
 * cases above are what pin the split itself. Both are needed.
 *
 * The precondition is enforced below: an unbacked sell books no realized figure
 * (cost unknown), so such a sequence is deliberately outside this identity.
 */
describe("accounting P&L == economic P&L, exactly", () => {
  const runSequence = (fills: Fill[], marketValueUsdg: bigint) => {
    let basis = ZERO_BASIS;
    let realized = 0n;
    let spent = 0n;
    let proceeds = 0n;
    for (const f of fills) {
      const r = applyFill(basis, f);
      assert.equal(r.basisUnknown, false, "invariant sequences must be fully backed");
      basis = r.basis;
      realized += r.realizedUsdg;
      if (f.side === "buy") spent += f.cashUsdg;
      else proceeds += f.cashUsdg;
    }
    return {
      accounting: realized + unrealizedUsdg(basis, marketValueUsdg),
      economic: proceeds + marketValueUsdg - spent,
      basis,
      realized,
    };
  };

  it("holds for a simple round trip", () => {
    const r = runSequence(
      [
        { side: "buy", qtyRaw: SHARE, cashUsdg: usdg(100) },
        { side: "sell", qtyRaw: SHARE, cashUsdg: usdg(130) },
      ],
      0n,
    );
    assert.equal(r.accounting, r.economic);
    assert.equal(r.realized, usdg(30));
  });

  it("holds while a partial position is still open", () => {
    const r = runSequence(
      [
        { side: "buy", qtyRaw: 2n * SHARE, cashUsdg: usdg(200) },
        { side: "sell", qtyRaw: SHARE, cashUsdg: usdg(150) },
      ],
      usdg(150), // the remaining share now marks at $150
    );
    assert.equal(r.accounting, r.economic);
    assert.equal(r.accounting, usdg(100)); // +50 realized, +50 unrealized
  });

  it("holds across a long mixed sequence with awkward quantities (truncation stress)", () => {
    const fills: Fill[] = [
      { side: "buy", qtyRaw: 333_333_333_333_333_333n, cashUsdg: 77_777_777n },
      { side: "buy", qtyRaw: 111_111_111_111_111_111n, cashUsdg: 33_333_331n },
      { side: "sell", qtyRaw: 99_999_999_999_999_999n, cashUsdg: 41_234_567n },
      { side: "buy", qtyRaw: 7n * SHARE / 3n, cashUsdg: 512_345_679n },
      { side: "sell", qtyRaw: 250_000_000_000_000_001n, cashUsdg: 61_111_113n },
      { side: "sell", qtyRaw: 1n, cashUsdg: 1n },
      { side: "buy", qtyRaw: 1n, cashUsdg: 1n },
      { side: "sell", qtyRaw: 1_000_000_000_000_000_000n, cashUsdg: 219_999_997n },
    ];
    const r = runSequence(fills, 87_654_321n);
    assert.equal(r.accounting, r.economic, "no drift after 8 awkward fills");
    assert.ok(r.basis.qtyRaw > 0n, "still holding something");
    assert.ok(r.basis.costUsdg >= 0n);
  });

  it("holds when the position is fully closed (unrealized must be exactly 0)", () => {
    const r = runSequence(
      [
        { side: "buy", qtyRaw: 333_333_333_333_333_333n, cashUsdg: 99_999_991n },
        { side: "buy", qtyRaw: 666_666_666_666_666_667n, cashUsdg: 200_000_009n },
        { side: "sell", qtyRaw: 1_000_000_000_000_000_000n, cashUsdg: 340_000_003n },
      ],
      0n,
    );
    assert.equal(r.basis.qtyRaw, 0n);
    assert.equal(r.basis.costUsdg, 0n);
    assert.equal(r.accounting, r.economic);
    assert.equal(r.realized, 340_000_003n - 300_000_000n, "realized is exactly the full round-trip gain");
  });
});
