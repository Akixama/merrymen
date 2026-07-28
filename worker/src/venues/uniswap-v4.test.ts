/**
 * v4 calldata. The quoter validates the PoolKey shape for us — a wrong key
 * returns no quote — but it never sees the SWAP calldata, so everything below is
 * the part that can only fail on-chain, with funds committed.
 *
 * Three things are load-bearing and none of them are type errors:
 *   - currency ORDER, because it's hashed into the pool id AND defines what
 *     `zeroForOne` means;
 *   - ACTION order, because settling before swapping pays against a balance that
 *     doesn't exist yet;
 *   - the minOut reaching TAKE_ALL, because that — not the swap params — is what
 *     actually bounds the fill.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeAbiParameters, decodeFunctionData, parseAbi } from "viem";
import { UNISWAP } from "../../../packages/core/src/index";
import {
  ACTION_SETTLE_ALL,
  ACTION_SWAP_EXACT_IN_SINGLE,
  ACTION_TAKE_ALL,
  CMD_V4_SWAP,
  UNIVERSAL_ROUTER_ABI,
  buildV4SwapCalls,
  encodeV4SwapInput,
  isZeroForOne,
  makePoolKey,
  poolId,
} from "./uniswap-v4";

const LOW = "0x00000000000000000000000000000000000000aa" as const;
const HIGH = "0x00000000000000000000000000000000000000bb" as const;

describe("makePoolKey — order is part of the identity", () => {
  it("sorts currencies ascending regardless of argument order", () => {
    const a = makePoolKey(HIGH, LOW, 3000, 60);
    const b = makePoolKey(LOW, HIGH, 3000, 60);
    assert.equal(a.currency0, LOW);
    assert.equal(a.currency1, HIGH);
    assert.deepEqual(a, b, "the same pair must produce the same key either way round");
  });

  it("lowercases, so a checksummed address hashes to the same pool", () => {
    const mixed = HIGH.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.equal(poolId(makePoolKey(LOW, mixed, 500, 10)), poolId(makePoolKey(LOW, HIGH, 500, 10)));
  });

  it("changes the pool id when ANY component changes", () => {
    const base = poolId(makePoolKey(LOW, HIGH, 3000, 60));
    assert.notEqual(base, poolId(makePoolKey(LOW, HIGH, 500, 60)), "fee");
    assert.notEqual(base, poolId(makePoolKey(LOW, HIGH, 3000, 10)), "tickSpacing");
    assert.notEqual(
      base,
      poolId(makePoolKey(LOW, HIGH, 3000, 60, "0x00000000000000000000000000000000000000ff")),
      "hooks",
    );
  });

  it("isZeroForOne follows the sorted order, not the caller's", () => {
    const key = makePoolKey(HIGH, LOW, 3000, 60);
    assert.equal(isZeroForOne(key, LOW), true, "the lower address is currency0");
    assert.equal(isZeroForOne(key, HIGH), false);
  });
});

const SWAP_PARAMS_ABI = [
  {
    type: "tuple",
    components: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

describe("encodeV4SwapInput", () => {
  const key = makePoolKey(LOW, HIGH, 3000, 60);
  const input = encodeV4SwapInput({ key, zeroForOne: true, amountIn: 1000n, minAmountOut: 990n });
  const [actions, params] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    input,
  ) as [`0x${string}`, `0x${string}`[]];

  it("emits swap, then settle, then take — in that order", () => {
    const expected = `0x${[ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL]
      .map((a) => a.toString(16).padStart(2, "0"))
      .join("")}`;
    assert.equal(actions, expected);
    assert.equal(params.length, 3, "one parameter set per action");
  });

  it("carries the pool key and direction into the swap params", () => {
    const [p] = decodeAbiParameters(SWAP_PARAMS_ABI, params[0]!);
    // viem hands addresses back checksummed; the key stores them lowercased.
    // Comparing raw would fail on case alone and say nothing about correctness.
    assert.deepEqual(
      {
        currency0: p.poolKey.currency0.toLowerCase(),
        currency1: p.poolKey.currency1.toLowerCase(),
        fee: Number(p.poolKey.fee),
        tickSpacing: Number(p.poolKey.tickSpacing),
        hooks: p.poolKey.hooks.toLowerCase(),
      },
      key,
    );
    assert.equal(p.zeroForOne, true);
    assert.equal(p.amountIn, 1000n);
    assert.equal(p.amountOutMinimum, 990n);
  });

  it("settles the INPUT currency and takes the OUTPUT one", () => {
    const [settleCur, settleMax] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]!);
    const [takeCur, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]!);
    assert.equal((settleCur as string).toLowerCase(), LOW, "zeroForOne pays currency0");
    assert.equal(settleMax, 1000n, "settle caps what the router may pull");
    assert.equal((takeCur as string).toLowerCase(), HIGH, "and receives currency1");
    assert.equal(takeMin, 990n, "TAKE_ALL carries the slippage floor");
  });

  it("flips both currencies when the direction flips", () => {
    const other = encodeV4SwapInput({ key, zeroForOne: false, amountIn: 1000n, minAmountOut: 990n });
    const [, p] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], other) as [
      `0x${string}`,
      `0x${string}`[],
    ];
    const [settleCur] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], p[1]!);
    const [takeCur] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], p[2]!);
    assert.equal((settleCur as string).toLowerCase(), HIGH);
    assert.equal((takeCur as string).toLowerCase(), LOW);
  });

  it("the minOut in TAKE_ALL matches the one in the swap params — one bound, not two", () => {
    // These are separate fields in separate structs and nothing forces them to
    // agree. If they drift, the trade executes to a limit nobody computed.
    const [p] = decodeAbiParameters(SWAP_PARAMS_ABI, params[0]!);
    const [, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]!);
    assert.equal(p.amountOutMinimum, takeMin);
  });
});

describe("buildV4SwapCalls — approve Permit2, Permit2 grants the router, execute", () => {
  const key = makePoolKey(LOW, HIGH, 3000, 60);
  const DEADLINE = 1_800_000_000;
  const calls = buildV4SwapCalls({
    key,
    tokenIn: LOW,
    amountIn: 1000n,
    minAmountOut: 990n,
    deadline: DEADLINE,
  });

  it("is exactly three calls, in the only order that works", () => {
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.to, LOW, "1. the TOKEN approves Permit2");
    assert.equal(calls[1]!.to.toLowerCase(), (UNISWAP.permit2 as string).toLowerCase(), "2. Permit2 grants the router");
    assert.equal(calls[2]!.to.toLowerCase(), (UNISWAP.universalRouter as string).toLowerCase(), "3. the router executes");
    for (const c of calls) assert.equal(c.value, 0n, "no native value on an ERC-20 swap");
  });

  it("approves Permit2 for exactly the trade size, not max", () => {
    const d = decodeFunctionData({
      abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
      data: calls[0]!.data,
    });
    assert.equal((d.args as readonly [string, bigint])[0].toLowerCase(), (UNISWAP.permit2 as string).toLowerCase());
    assert.equal((d.args as readonly [string, bigint])[1], 1000n);
  });

  it("gives the router a bounded, EXPIRING allowance", () => {
    // A standing max approval to a router turns one router bug into everyone's
    // loss. Scoping it to this trade and expiring it is the whole point.
    const d = decodeFunctionData({
      abi: parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]),
      data: calls[1]!.data,
    });
    const [token, spender, amount, expiration] = d.args as readonly [string, string, bigint, number];
    assert.equal(token.toLowerCase(), LOW);
    assert.equal(spender.toLowerCase(), (UNISWAP.universalRouter as string).toLowerCase());
    assert.equal(amount, 1000n);
    assert.equal(Number(expiration), DEADLINE);
  });

  it("executes exactly one V4_SWAP command carrying the swap input", () => {
    const d = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: calls[2]!.data });
    const [commands, inputs, deadline] = d.args as readonly [`0x${string}`, `0x${string}`[], bigint];
    assert.equal(commands, `0x${CMD_V4_SWAP.toString(16).padStart(2, "0")}`);
    assert.equal(inputs.length, 1, "one input per command byte");
    assert.equal(deadline, BigInt(DEADLINE));
    assert.equal(
      inputs[0],
      encodeV4SwapInput({ key, zeroForOne: true, amountIn: 1000n, minAmountOut: 990n }),
    );
  });

  it("derives direction from the key, not from the argument order", () => {
    const reversed = buildV4SwapCalls({ key, tokenIn: HIGH, amountIn: 1000n, minAmountOut: 990n, deadline: DEADLINE });
    const d = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: reversed[2]!.data });
    const [, inputs] = d.args as readonly [`0x${string}`, `0x${string}`[], bigint];
    assert.equal(
      inputs[0],
      encodeV4SwapInput({ key, zeroForOne: false, amountIn: 1000n, minAmountOut: 990n }),
    );
  });
});
