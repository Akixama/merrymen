import assert from "node:assert/strict";
import test from "node:test";
import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  UNISWAP,
  allowedSpenders,
  buildCallPermissions,
  buildWallPolicies,
  usableExtraTokens,
  type GrantCaps,
} from "../../packages/core/src/index";

/**
 * THE WALL, PINNED.
 *
 * These assertions are a specification, not a snapshot. The permission list moved
 * out of the dashboard so a phone could sign the same grant, and the danger in
 * that move is silent: drop one entry, loosen one condition, reorder the args of
 * an approve, and nothing throws — grants just start carrying powers their owners
 * did not agree to, and only for the people who signed after the change.
 *
 * So each expectation below was read off the ORIGINAL dashboard implementation and
 * written down independently. If a future edit widens the wall, this fails and
 * says which entry.
 */

const CAPS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
};

/** USDG is 6dp — the units a cap is actually expressed in on-chain. */
const usdg = (v: number) => BigInt(Math.round(v * 1e6));

type Perm = ReturnType<typeof buildCallPermissions>[number] & {
  target: string;
  functionName?: string;
  args?: unknown[];
};

const perms = () => buildCallPermissions(CAPS) as unknown as Perm[];
const find = (target: string, fn?: string) =>
  perms().filter((p) => p.target.toLowerCase() === target.toLowerCase() && (fn === undefined || p.functionName === fn));

test("the four allowed spenders, and universalRouter is NOT one of them", () => {
  const s = allowedSpenders().map((a) => a.toLowerCase());
  assert.deepEqual(s, [
    RIALTO.routerSnapshot.toLowerCase(),
    UNISWAP.swapRouter02.toLowerCase(),
    MORPHO.steakhouseUsdgVault.toLowerCase(),
    UNISWAP.permit2.toLowerCase(),
  ]);
  // v4 never pulls tokens directly — Permit2 does, on the router's behalf, with a
  // bounded expiring allowance. Approving the router itself would skip that bound.
  assert.equal(s.includes(UNISWAP.universalRouter.toLowerCase()), false, "the UniversalRouter must never be an approved spender");
});

test("USDG approve is capped at ONE TRADE and restricted to the allowed spenders", () => {
  const [p] = find(CASH.USDG, "approve");
  assert.ok(p, "USDG approve permission must exist");
  const [spender, amount] = p.args as [{ condition: number; value: string[] }, { condition: number; value: bigint }];
  assert.equal(spender.value.length, 4, "spender list must be the four allowed contracts");
  // The cap is per TRADE, not per day. Using dailyUsdg here would let one approval
  // authorise ten trades' worth.
  assert.equal(amount.value, usdg(CAPS.perTradeUsdg));
});

test("USDG transfer out is capped per call at the per-trade size", () => {
  const [p] = find(CASH.USDG, "transfer");
  assert.ok(p, "USDG transfer permission must exist");
  const [recipient, amount] = p.args as [null, { value: bigint }];
  // Recipient is intentionally unconstrained — chat transfers are user-confirmed —
  // so the AMOUNT is the only on-chain bound and it must be present.
  assert.equal(recipient, null);
  assert.equal(amount.value, usdg(CAPS.perTradeUsdg));
});

test("every tradeable stock token can be approved, so nothing can be bought but not sold", () => {
  const tradeable = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol));
  assert.ok(tradeable.length > 0, "sanity: there are tradeable tokens");
  for (const t of tradeable) {
    const [p] = find(t.address, "approve");
    assert.ok(p, `${t.symbol} must be approvable or the agent could buy it and never sell`);
    // No amount condition on purpose: share counts are 18dp and not comparable to
    // a USDG cap. Asserted so nobody "tightens" it into a broken policy.
    assert.equal((p.args as unknown[])[1], null, `${t.symbol} approve must have no amount condition`);
  }
});

test("Permit2 may only ever grant an allowance to the UniversalRouter", () => {
  const [p] = find(UNISWAP.permit2, "approve");
  assert.ok(p, "permit2 approve permission must exist");
  const args = p.args as [null, { condition: number; value: string }, null, null];
  // Without this EQUAL condition, this single permission would let the session key
  // hand ANY spender an allowance on ANY token — strictly more power than trading.
  assert.equal(args[1].value.toLowerCase(), UNISWAP.universalRouter.toLowerCase());
});

test("the vault deposit is capped and the withdrawal is not", () => {
  const [dep] = find(MORPHO.steakhouseUsdgVault, "deposit");
  const [wd] = find(MORPHO.steakhouseUsdgVault, "withdraw");
  assert.ok(dep && wd);
  assert.equal((dep.args as [{ value: bigint }, null])[0].value, usdg(CAPS.dailyUsdg));
  // Money coming home is not a risk the wall needs to bound.
  assert.equal(wd.args, undefined);
});

test("the routers are narrowed to one function each, except Rialto which cannot be", () => {
  assert.equal(find(UNISWAP.swapRouter02, "exactInputSingle").length, 1);
  assert.equal(find(UNISWAP.universalRouter, "execute").length, 1);
  const [rialto] = find(RIALTO.routerSnapshot);
  // Its calldata comes from the quote API, so there is no shape to constrain —
  // target-scoping is the whole control, and it must stay that way deliberately.
  assert.equal(rialto.functionName, undefined);
});

test("owner-added tokens are validated and de-duplicated before becoming policy", () => {
  const builtinAddr = STOCK_TOKENS[0].address;
  const usable = usableExtraTokens([
    { address: builtinAddr, symbol: "DUP", decimals: 18 } as never, // already covered
    { address: "0xnothex", symbol: "BAD", decimals: 18 } as never, // malformed
    { address: "0x1111111111111111111111111111111111111111", symbol: "OK", decimals: 18 } as never,
    { address: "0x1111111111111111111111111111111111111111", symbol: "OK", decimals: 18 } as never, // repeat
  ]);
  assert.equal(usable.length, 1, "only the one valid, non-duplicate token survives");
  assert.equal(usable[0].symbol, "OK");
});

test("the wall carries exactly the expected permission set — no more, no less", () => {
  const list = perms();
  const stockCount = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).length;
  // 1 USDG approve + N stock approves + 1 USDG transfer + rialto + swapRouter02
  // + vault deposit + vault withdraw + permit2 + universalRouter
  assert.equal(list.length, stockCount + 8, "an unexpected permission count means something was added or lost");
  // Nothing may authorise sending native value.
  for (const p of list) assert.equal(p.valueLimit, 0n, `${p.target} must not be allowed to move native ETH`);
});

test("policies carry a hard expiry and a daily op limit", () => {
  const now = 1_800_000_000;
  const { policies, expiresAt } = buildWallPolicies({ caps: CAPS, now });
  assert.equal(expiresAt, now + CAPS.expiryDays * 86_400);
  // Expiry, rate limit, call policy — the key dies on schedule even if every
  // other control fails.
  assert.equal(policies.length, 3);
});
