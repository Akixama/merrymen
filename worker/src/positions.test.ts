import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import { positionValueUsdg, readPositions } from "./positions";
import type { StockToken } from "../../packages/core/src/index";

const ONE = 10n ** 18n; // 1.0 in both raw-balance (18dp) and multiplier terms
const usd = (v: number) => BigInt(Math.round(v * 1e8)); // Chainlink 8dp

describe("positionValueUsdg (ERC-8056)", () => {
  it("values a whole share at multiplier 1.0", () => {
    // 1 AAPL raw × 1.0 × $250 = 250 USDG (6dp)
    const v = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(250) });
    assert.equal(v, 250_000_000n);
  });

  it("values fractional holdings", () => {
    // 0.5 shares × 1.0 × $100 = 50 USDG
    const v = positionValueUsdg({ rawBalance: ONE / 2n, uiMultiplier: ONE, price8: usd(100) });
    assert.equal(v, 50_000_000n);
  });

  it("a 2-for-1 split is NOT a crash: multiplier doubles, price halves, value unchanged", () => {
    const before = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(500) });
    const after = positionValueUsdg({ rawBalance: ONE, uiMultiplier: 2n * ONE, price8: usd(250) });
    assert.equal(before, after);
    assert.equal(after, 500_000_000n);
  });

  it("ignoring the multiplier WOULD have looked like a 50% crash (the bug this prevents)", () => {
    const naiveAfterSplit = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(250) });
    assert.equal(naiveAfterSplit, 250_000_000n); // half of the true 500
  });

  it("a 10% stock dividend scales value by the multiplier", () => {
    const v = positionValueUsdg({
      rawBalance: ONE,
      uiMultiplier: (11n * ONE) / 10n,
      price8: usd(100),
    });
    assert.equal(v, 110_000_000n);
  });

  it("zero balance is zero value", () => {
    assert.equal(positionValueUsdg({ rawBalance: 0n, uiMultiplier: ONE, price8: usd(999) }), 0n);
  });

  it("keeps precision on realistic dust (0.0342092 QQQ @ $575.31)", () => {
    const raw = 34_209_200_024_468_519n; // ~0.0342 in 18dp
    const v = positionValueUsdg({ rawBalance: raw, uiMultiplier: ONE, price8: usd(575.31) });
    // 0.034209200024468519 × 575.31 = 19.680894866… → floors to 19.680894 USDG
    assert.equal(v, 19_680_894n);
  });
});

const tok = (symbol: string, address: `0x${string}`): StockToken => ({
  symbol,
  name: symbol,
  address,
  chainlinkFeed: "0x0000000000000000000000000000000000000001",
  kind: "stock",
});
/** No feed configured at all — every memecoin, and any delisted feed. */
const feedless = (symbol: string, address: `0x${string}`): StockToken => ({
  ...tok(symbol, address),
  chainlinkFeed: null,
});
const AAPL = tok("AAPL", "0x00000000000000000000000000000000000000a1");
const TSLA = tok("TSLA", "0x00000000000000000000000000000000000000b2");
const good = (result: unknown) => ({ status: "success" as const, result });
const bad = () => ({ status: "failure" as const, error: new Error("revert") });
const client = (results: unknown[]): PublicClient => ({ multicall: async () => results }) as unknown as PublicClient;
const ACCT = "0x000000000000000000000000000000000000dEaD" as const;

describe("readPositions — a held holding is never silently valued at zero", () => {
  it("a held token with a price is valued and not flagged", async () => {
    const prices = new Map([["AAPL", { price8: usd(200), stale: false }]]);
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [AAPL], prices);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]?.symbol, "AAPL");
    assert.deepEqual(r.missingPrice, []);
  });

  it("a HELD token whose feed price is missing goes to missingPrice (the equity-crater bug)", async () => {
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [AAPL], new Map());
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, ["AAPL"]);
  });

  it("a HELD token whose multiplier read reverts is flagged, not mispriced at 1.0", async () => {
    const prices = new Map([["AAPL", { price8: usd(200), stale: false }]]);
    const r = await readPositions(client([good(5n * ONE), bad()]), ACCT, [AAPL], prices);
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, ["AAPL"]);
  });

  it("a zero-balance token is not held — absent from both lists (not a coverage gap)", async () => {
    const prices = new Map([["AAPL", { price8: usd(200), stale: false }]]);
    const r = await readPositions(client([good(0n), good(ONE)]), ACCT, [AAPL], prices);
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, []);
  });

  it("mixed: one priced holding valued, one unpriced holding flagged", async () => {
    const prices = new Map([["AAPL", { price8: usd(200), stale: false }]]); // TSLA absent
    const r = await readPositions(client([good(ONE), good(ONE), good(2n * ONE), good(ONE)]), ACCT, [AAPL, TSLA], prices);
    assert.deepEqual(r.positions.map((p) => p.symbol), ["AAPL"]);
    assert.deepEqual(r.missingPrice, ["TSLA"]);
  });

  it("stale-but-present price still values the holding (weekend prices aren't a gap)", async () => {
    const prices = new Map([["AAPL", { price8: usd(200), stale: true }]]);
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [AAPL], prices);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]?.priceStale, true);
    assert.deepEqual(r.missingPrice, []);
  });

  it("a totally failed multicall values nothing and reports no false holdings", async () => {
    const broken = { multicall: async () => { throw new Error("rpc down"); } } as unknown as PublicClient;
    const r = await readPositions(broken, ACCT, [AAPL], new Map());
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, []);
    assert.deepEqual(r.unpricedByDesign, []);
  });
});

/**
 * A feed that FAILED is transient — hold and retry. A feed that doesn't EXIST
 * never recovers, and treating the two alike froze the tick permanently: no
 * equity, no breaker, no strategy run, and therefore no way to sell out of the
 * position. Every memecoin is in the second category, so this distinction is
 * what makes holding one survivable at all.
 */
describe("readPositions — a missing feed is not a failed feed", () => {
  const DOGE = feedless("DOGE", "0x00000000000000000000000000000000000000c3");

  it("a held token with NO feed configured is unpricedByDesign, not missingPrice", async () => {
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [DOGE], new Map());
    assert.deepEqual(r.unpricedByDesign, ["DOGE"], "permanent condition, reported as such");
    assert.deepEqual(r.missingPrice, [], "must NOT look like a transient hiccup");
    assert.deepEqual(r.positions, [], "still not valued — we genuinely don't know what it's worth");
  });

  it("a held token WITH a feed that didn't read stays transient", async () => {
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [AAPL], new Map());
    assert.deepEqual(r.missingPrice, ["AAPL"]);
    assert.deepEqual(r.unpricedByDesign, []);
  });

  it("separates the two when both are held at once", async () => {
    const r = await readPositions(
      client([good(ONE), good(ONE), good(2n * ONE), good(ONE)]),
      ACCT,
      [AAPL, DOGE],
      new Map(), // neither priced
    );
    assert.deepEqual(r.missingPrice, ["AAPL"], "feed exists → retry");
    assert.deepEqual(r.unpricedByDesign, ["DOGE"], "no feed → don't wait, don't freeze");
  });

  it("a feedless token that is NOT held is simply absent", async () => {
    const r = await readPositions(client([good(0n), good(ONE)]), ACCT, [DOGE], new Map());
    assert.deepEqual(r.unpricedByDesign, [], "nothing held, nothing to report");
    assert.deepEqual(r.missingPrice, []);
  });

  it("a feedless token still values normally if a price IS supplied (e.g. a DEX quote)", async () => {
    // The seam for Phase 3: once a non-Chainlink price source exists, feeding it
    // through this same map values the position with no further changes here.
    const prices = new Map([["DOGE", { price8: usd(0.42), stale: false }]]);
    const r = await readPositions(client([good(100n * ONE), good(ONE)]), ACCT, [DOGE], prices);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]?.symbol, "DOGE");
    assert.deepEqual(r.unpricedByDesign, []);
  });
});
