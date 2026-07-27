/**
 * The watch set is where an owner-supplied address first becomes something the
 * worker reads balances for and prices. The curated registry has verified
 * addresses and Chainlink feeds behind it; a settings entry has whatever the
 * owner pasted. Those two must never be able to swap places.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STOCK_TOKENS } from "../../../packages/core/src/index";
import { watchTokensFor } from "./registry";

const CATE = { symbol: "CATE", address: "0x00000000000000000000000000000000000000c1" as const, decimals: 18 };
const SIXDP = { symbol: "SIXDP", address: "0x00000000000000000000000000000000000000c2" as const, decimals: 6 };
const NVDA_REAL = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!;

describe("watchTokensFor", () => {
  it("returns just the basket when nothing was added", () => {
    const w = watchTokensFor(["NVDA", "QQQ"], []);
    assert.deepEqual(w.map((t) => t.symbol), ["NVDA", "QQQ"]);
    assert.ok(w.every((t) => t.chainlinkFeed !== null));
  });

  it("appends owner tokens as feedless memecoins carrying their own decimals", () => {
    const w = watchTokensFor(["NVDA"], [CATE, SIXDP]);
    assert.deepEqual(w.map((t) => t.symbol), ["NVDA", "CATE", "SIXDP"]);
    const cate = w.find((t) => t.symbol === "CATE")!;
    assert.equal(cate.kind, "memecoin", "kind routes it to pool pricing, away from ERC-8056");
    assert.equal(cate.chainlinkFeed, null, "no feed is the whole point — it's why it gets a TWAP");
    assert.equal(w.find((t) => t.symbol === "SIXDP")!.decimals, 6);
  });

  it("REFUSES to let a settings entry shadow a registry symbol", () => {
    // A hostile (or just wrong) address under a real ticker would otherwise be
    // read, priced and traded as if it were the issuer-backed token.
    const impostor = { symbol: "NVDA", address: "0x00000000000000000000000000000000000000ff" as const, decimals: 18 };
    const w = watchTokensFor(["NVDA"], [impostor]);
    assert.equal(w.length, 1);
    assert.equal(w[0]?.address, NVDA_REAL.address, "the verified address wins");
    assert.equal(w[0]?.chainlinkFeed, NVDA_REAL.chainlinkFeed);
  });

  it("blocks the shadow even when the registry token isn't in the basket", () => {
    // AAPL is a real Stock Token; not selecting it must not open its ticker up.
    const impostor = { symbol: "AAPL", address: "0x00000000000000000000000000000000000000ff" as const, decimals: 18 };
    assert.deepEqual(watchTokensFor(["NVDA"], [impostor]).map((t) => t.symbol), ["NVDA"]);
  });

  it("is case-insensitive about ticker collisions", () => {
    const impostor = { symbol: "nvda", address: "0x00000000000000000000000000000000000000ff" as const, decimals: 18 };
    assert.deepEqual(watchTokensFor(["NVDA"], [impostor]).map((t) => t.symbol), ["NVDA"]);
  });

  it("drops a duplicate address even under a different ticker", () => {
    const dupe = { symbol: "CATE2", address: CATE.address, decimals: 18 };
    const w = watchTokensFor([], [CATE, dupe]);
    assert.deepEqual(w.map((t) => t.symbol), ["CATE"]);
  });

  it("drops an owner entry pointing at a basket token's address", () => {
    const w = watchTokensFor(["NVDA"], [{ symbol: "SNEAK", address: NVDA_REAL.address, decimals: 18 }]);
    assert.deepEqual(w.map((t) => t.symbol), ["NVDA"]);
  });

  it("works with an empty basket — a memecoin-only agent is legitimate", () => {
    assert.deepEqual(watchTokensFor([], [CATE]).map((t) => t.symbol), ["CATE"]);
  });

  it("ignores unknown basket symbols, as before", () => {
    assert.deepEqual(watchTokensFor(["NOPE", "NVDA"], []).map((t) => t.symbol), ["NVDA"]);
  });
});
