/**
 * Legs are what a strategy can actually trade. Resolving them from the shipped
 * registry alone is why an owner-added memecoin could be watched, priced and
 * valued — and then traded by nothing at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STOCK_TOKENS } from "../../../packages/core/src/index";
import { legsForUniverse, watchTokensFor } from "./registry";

const CATE = { symbol: "CATE", address: "0x00000000000000000000000000000000000000c1" as const, decimals: 18 };
const universe = watchTokensFor(["NVDA", "QQQ"], [CATE]);

describe("legsForUniverse", () => {
  it("resolves an owner-added token into a real leg when it's selected", () => {
    const legs = legsForUniverse(["NVDA", "CATE"], universe);
    assert.deepEqual(legs.map((l) => l.symbol), ["NVDA", "CATE"]);
    assert.equal(legs.find((l) => l.symbol === "CATE")?.token, CATE.address);
  });

  it("does NOT trade a token merely because it was added — selection stays explicit", () => {
    // CATE is in the universe (watched, priced, valued) but not selected. A
    // token added to be tracked must not start being bought on its own.
    assert.deepEqual(legsForUniverse(["NVDA"], universe).map((l) => l.symbol), ["NVDA"]);
  });

  it("splits weight across the selected legs, memecoin or not", () => {
    const legs = legsForUniverse(["NVDA", "QQQ", "CATE"], universe);
    assert.equal(legs.length, 3);
    for (const l of legs) assert.equal(l.weightBps, 3333);
  });

  it("falls back to the shipped registry when no universe is passed", () => {
    const legs = legsForUniverse(["NVDA", "CATE"]);
    assert.deepEqual(legs.map((l) => l.symbol), ["NVDA"], "CATE isn't in STOCK_TOKENS");
  });

  it("ignores symbols that resolve to nothing", () => {
    assert.deepEqual(legsForUniverse(["NOPE"], universe), []);
  });

  it("keeps registry addresses authoritative when a symbol collides", () => {
    const impostor = { symbol: "NVDA", address: "0x00000000000000000000000000000000000000ff" as const, decimals: 18 };
    const u = watchTokensFor(["NVDA"], [impostor]);
    const real = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!;
    assert.equal(legsForUniverse(["NVDA"], u)[0]?.token, real.address);
  });
});
