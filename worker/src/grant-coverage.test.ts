/**
 * The tradable set is sealed into a signed session key, so "the owner listed a
 * token" and "the agent may sell that token" are two different facts. This is
 * the function that keeps them apart — get it wrong in the permissive direction
 * and the owner is told they can exit a memecoin they actually cannot.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CASH,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  builtinGrantTargets,
  tokenCoverage,
  type CustomToken,
} from "../../packages/core/src/index";

const CATE: CustomToken = {
  symbol: "CATE",
  address: "0x00000000000000000000000000000000000000c1",
  decimals: 18,
};
const DOGE: CustomToken = {
  symbol: "DOGE",
  address: "0x00000000000000000000000000000000000000d0",
  decimals: 9,
};

const grantWith = (...addrs: string[]) => ({ grantTokens: addrs });
const symbols = (list: CustomToken[]) => list.map((t) => t.symbol);

describe("tokenCoverage", () => {
  it("reports a listed-but-unsigned token as uncovered", () => {
    const { covered, uncovered } = tokenCoverage([CATE], grantWith());
    assert.deepEqual(symbols(covered), []);
    assert.deepEqual(symbols(uncovered), ["CATE"]);
  });

  it("reports a token the grant actually names as covered", () => {
    const { covered, uncovered } = tokenCoverage([CATE], grantWith(CATE.address));
    assert.deepEqual(symbols(covered), ["CATE"]);
    assert.deepEqual(symbols(uncovered), []);
  });

  it("splits a mixed set instead of judging it as a whole", () => {
    const { covered, uncovered } = tokenCoverage([CATE, DOGE], grantWith(CATE.address));
    assert.deepEqual(symbols(covered), ["CATE"]);
    assert.deepEqual(symbols(uncovered), ["DOGE"]);
  });

  it("matches addresses case-insensitively — a checksummed entry is the same token", () => {
    const mixed = { ...CATE, address: CATE.address.toUpperCase().replace("0X", "0x") as `0x${string}` };
    assert.deepEqual(symbols(tokenCoverage([mixed], grantWith(CATE.address)).covered), ["CATE"]);
    assert.deepEqual(
      symbols(tokenCoverage([CATE], grantWith(CATE.address.toUpperCase())).covered),
      ["CATE"],
    );
  });

  it("treats a grant with NO grantTokens field as covering nothing extra", () => {
    // A grant signed before extras existed has no extra approve permission in
    // its call policy, so "field missing" and "nothing covered" are the same
    // fact. Reading absence as "unknown, assume fine" would be the dangerous
    // direction: the owner would be told they can sell, and the op would revert.
    assert.deepEqual(symbols(tokenCoverage([CATE], {}).uncovered), ["CATE"]);
    assert.deepEqual(symbols(tokenCoverage([CATE], null).uncovered), ["CATE"]);
    assert.deepEqual(symbols(tokenCoverage([CATE], undefined).uncovered), ["CATE"]);
  });

  it("never flags what every grant already approves — USDG and the built-in tradables", () => {
    // These are in the call policy unconditionally, so the issuer drops them
    // from grantTokens. If coverage didn't know that, listing NVDA in settings
    // would produce a permanent "re-sign" nag that re-signing cannot clear.
    const usdg: CustomToken = { symbol: "USDG", address: CASH.USDG as `0x${string}`, decimals: 6 };
    const builtin = STOCK_TOKENS.find((t) =>
      (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol),
    )!;
    const stock: CustomToken = { symbol: builtin.symbol, address: builtin.address, decimals: 18 };
    const { uncovered } = tokenCoverage([usdg, stock], grantWith());
    assert.deepEqual(symbols(uncovered), []);
  });

  it("is empty-safe in both directions", () => {
    assert.deepEqual(tokenCoverage([], grantWith(CATE.address)).uncovered, []);
    assert.deepEqual(tokenCoverage([], null).covered, []);
  });
});

describe("builtinGrantTargets", () => {
  it("holds USDG plus every tradable stock, lowercased", () => {
    const set = builtinGrantTargets();
    assert.equal(set.has((CASH.USDG as string).toLowerCase()), true);
    for (const sym of TRADEABLE_SYMBOLS) {
      const t = STOCK_TOKENS.find((s) => s.symbol === sym)!;
      assert.equal(set.has(t.address.toLowerCase()), true, `${sym} missing`);
    }
    for (const a of set) assert.equal(a, a.toLowerCase());
  });

  it("does NOT include stocks with no v3 route — they aren't in the sell allowlist either", () => {
    // AAPL has no Uniswap v3 pool, so it is deliberately absent from the grant's
    // approve permissions. Coverage must agree with the policy, not with the
    // registry, or it would vouch for a sell the wall would reject.
    const aapl = STOCK_TOKENS.find((t) => t.symbol === "AAPL")!;
    assert.equal(builtinGrantTargets().has(aapl.address.toLowerCase()), false);
  });
});
