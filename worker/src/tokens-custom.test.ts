/**
 * Owner-added tokens are the one path by which an arbitrary address enters the
 * agent's world, and it eventually reaches a policy allowlist. The shape gate is
 * therefore load-bearing, and is applied twice — here in core (used by the
 * settings API on the way in) and again in the worker's resolver on the way out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidCustomToken } from "../../packages/core/src/index";

const ok = { symbol: "CATE", address: "0x00000000000000000000000000000000000000c1", decimals: 18 };

describe("isValidCustomToken", () => {
  it("accepts a well-formed ERC-20 entry", () => {
    assert.equal(isValidCustomToken(ok), true);
  });

  it("accepts the decimals memecoins actually use, not just 18", () => {
    assert.equal(isValidCustomToken({ ...ok, decimals: 6 }), true);
    assert.equal(isValidCustomToken({ ...ok, decimals: 9 }), true);
    assert.equal(isValidCustomToken({ ...ok, decimals: 0 }), true);
  });

  it("REFUSES a malformed address — this becomes a policy allowlist entry", () => {
    assert.equal(isValidCustomToken({ ...ok, address: "0x123" }), false);
    assert.equal(isValidCustomToken({ ...ok, address: "not-an-address" }), false);
    assert.equal(isValidCustomToken({ ...ok, address: "" }), false);
    // 39 hex chars — the off-by-one a typo actually produces.
    assert.equal(isValidCustomToken({ ...ok, address: `0x${"a".repeat(39)}` }), false);
  });

  it("REFUSES a symbol carrying markup or separators that could confuse a prompt or a list", () => {
    assert.equal(isValidCustomToken({ ...ok, symbol: "<b>CATE</b>" }), false);
    assert.equal(isValidCustomToken({ ...ok, symbol: "CATE,NVDA" }), false);
    assert.equal(isValidCustomToken({ ...ok, symbol: "CA TE" }), false);
    assert.equal(isValidCustomToken({ ...ok, symbol: "" }), false);
    assert.equal(isValidCustomToken({ ...ok, symbol: "x".repeat(17) }), false);
  });

  it("REFUSES nonsense decimals — the asset model divides by 10^decimals", () => {
    assert.equal(isValidCustomToken({ ...ok, decimals: -1 }), false);
    assert.equal(isValidCustomToken({ ...ok, decimals: 99 }), false);
    assert.equal(isValidCustomToken({ ...ok, decimals: 18.5 }), false);
    assert.equal(isValidCustomToken({ ...ok, decimals: Number.NaN }), false);
    assert.equal(isValidCustomToken({ ...ok, decimals: "18" as unknown as number }), false);
  });

  it("REFUSES missing fields and non-objects", () => {
    assert.equal(isValidCustomToken({ symbol: "CATE", address: ok.address }), false);
    assert.equal(isValidCustomToken({ address: ok.address, decimals: 18 }), false);
    assert.equal(isValidCustomToken(null), false);
    assert.equal(isValidCustomToken("CATE"), false);
    assert.equal(isValidCustomToken(undefined), false);
  });
});
