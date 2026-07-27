/**
 * Multi-hop routing. Two things are load-bearing here and neither is obvious:
 *
 *  - The PATH ENCODING must be exactly right. It is packed bytes with no
 *    delimiters, so an off-by-one in the fee width doesn't throw — it silently
 *    addresses a different pool, or garbage.
 *  - The quote and the CALL must describe the same route. minOut is derived from
 *    whatever the quoter priced; executing a different route with that minOut
 *    means trading against a slippage bound computed for something else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData } from "viem";
import { UNISWAP_SWAP_ROUTER_ABI } from "../../../packages/core/src/index";
import { buildSwapCall, encodePath, minOutWithSlippage, pickBestQuote } from "./uniswap";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const CATE = "0x00000000000000000000000000000000000000c1" as const;
const ME = "0x000000000000000000000000000000000000dEaD" as const;

describe("encodePath", () => {
  it("packs token(20) fee(3) token(20) with no separators", () => {
    const p = encodePath([USDG, CATE], [3000]);
    // 0x + 20 + 3 + 20 bytes = 2 + 86 hex chars
    assert.equal(p.length, 2 + (20 + 3 + 20) * 2);
    assert.equal(p.slice(2, 42), USDG.slice(2).toLowerCase());
    assert.equal(p.slice(42, 48), "000bb8", "3000 as 3 bytes big-endian");
    assert.equal(p.slice(48), CATE.slice(2).toLowerCase());
  });

  it("packs a two-hop path", () => {
    const p = encodePath([USDG, WETH, CATE], [500, 10000]);
    assert.equal(p.length, 2 + (20 + 3 + 20 + 3 + 20) * 2);
    assert.equal(p.slice(42, 48), "0001f4", "500");
    assert.equal(p.slice(88, 94), "002710", "10000");
  });

  it("pads every fee to exactly 3 bytes — a short fee would shift the whole path", () => {
    // 500 is 0x1f4: two hex digits short of the field. Getting this wrong reads
    // the next token's leading bytes as part of the fee and addresses nothing.
    assert.equal(encodePath([USDG, CATE], [500]).slice(42, 48), "0001f4");
    assert.equal(encodePath([USDG, CATE], [100]).slice(42, 48), "000064");
  });

  it("lowercases addresses so a checksummed input encodes identically", () => {
    assert.equal(encodePath([USDG, CATE], [3000]), encodePath([USDG.toLowerCase() as `0x${string}`, CATE], [3000]));
  });

  it("REFUSES a malformed path rather than encoding nonsense", () => {
    assert.throws(() => encodePath([USDG], [3000]));
    assert.throws(() => encodePath([USDG, CATE], []));
    assert.throws(() => encodePath([USDG, CATE], [500, 3000]));
    assert.throws(() => encodePath([], []));
  });
});

describe("buildSwapCall — the call must match the quote", () => {
  const base = {
    tokenIn: USDG,
    tokenOut: CATE,
    fee: 3000,
    recipient: ME,
    amountIn: 10_000_000n,
    minAmountOut: 42n,
  };

  it("emits exactInputSingle with no path (unchanged single-hop behaviour)", () => {
    const d = decodeFunctionData({ abi: UNISWAP_SWAP_ROUTER_ABI, data: buildSwapCall(base).data });
    assert.equal(d.functionName, "exactInputSingle");
  });

  it("emits exactInput carrying the quote's own path when given one", () => {
    const call = buildSwapCall({ ...base, path: { tokens: [USDG, WETH, CATE], fees: [500, 10000] } });
    const d = decodeFunctionData({ abi: UNISWAP_SWAP_ROUTER_ABI, data: call.data });
    assert.equal(d.functionName, "exactInput");
    const p = (d.args as readonly { path: string; recipient: string; amountIn: bigint; amountOutMinimum: bigint }[])[0]!;
    assert.equal(p.path, encodePath([USDG, WETH, CATE], [500, 10000]));
    assert.equal(p.amountIn, base.amountIn);
    assert.equal(p.amountOutMinimum, base.minAmountOut, "the slippage bound must survive the switch");
    assert.equal(p.recipient.toLowerCase(), ME.toLowerCase());
  });

  it("targets the same router either way — which is why no re-sign is needed", () => {
    const single = buildSwapCall(base);
    const multi = buildSwapCall({ ...base, path: { tokens: [USDG, WETH, CATE], fees: [500, 3000] } });
    assert.equal(single.to, multi.to);
    assert.equal(single.value, 0n);
    assert.equal(multi.value, 0n);
  });
});

describe("pickBestQuote across route shapes", () => {
  const q = (amountOut: bigint, path?: { tokens: readonly `0x${string}`[]; fees: readonly number[] }) => ({
    fee: 3000,
    amountOut,
    gasEstimate: 1n,
    path,
  });

  it("picks the best fill regardless of hop count — adding routes can only help", () => {
    const hop = { tokens: [USDG, WETH, CATE] as const, fees: [500, 3000] as const };
    assert.equal(pickBestQuote([q(100n), q(250n, hop)])?.amountOut, 250n);
    assert.equal(pickBestQuote([q(400n), q(250n, hop)])?.amountOut, 400n);
  });

  it("carries the winning route's path through, so the caller executes THAT one", () => {
    const hop = { tokens: [USDG, WETH, CATE] as const, fees: [500, 3000] as const };
    assert.deepEqual(pickBestQuote([q(100n), q(250n, hop)])?.path, hop);
    assert.equal(pickBestQuote([q(400n), q(250n, hop)])?.path, undefined);
  });

  it("ignores zero-out quotes and returns null when nothing routes", () => {
    assert.equal(pickBestQuote([q(0n), null, q(0n)]), null);
    assert.equal(pickBestQuote([]), null);
  });

  it("slippage is applied to the winning quote, whatever its shape", () => {
    assert.equal(minOutWithSlippage(1_000n, 100), 990n);
  });
});
