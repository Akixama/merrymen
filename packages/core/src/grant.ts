/** Grant shapes shared by web (issuer) and worker (consumer). */

import { CASH, STOCK_TOKENS, TRADEABLE_SYMBOLS, type CustomToken } from "./tokens";

export interface GrantCaps {
  perTradeUsdg: number;
  dailyUsdg: number;
  expiryDays: number;
  maxDrawdownPct: number;
  maxOpsPerDay: number;
}

export interface StoredGrant {
  smartAccount: `0x${string}`;
  owner: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  /** ZeroDev serialized permission account — everything the worker needs to act. */
  serialized: string;
  caps: GrantCaps;
  grantedAt: number;
  expiresAt: number;
  chainId: number;
  /**
   * Capabilities baked into this grant's on-chain call policy beyond the
   * original set (e.g. "transfer"). Lets the worker tell a pre-transfer grant
   * apart from a new one instead of letting the UserOp revert at the wall.
   */
  grantFeatures?: string[];
  /**
   * Owner-added token addresses (lowercase) whose approve() this grant's
   * on-chain call policy actually covers, beyond the built-in tradable set.
   *
   * Recorded so the worker can tell "you added CATE in settings" apart from
   * "the signed key is allowed to sell CATE" — those are different facts, and
   * only the second one is true without a re-sign. Without this the mismatch
   * would only surface as a UserOp reverting at the wall, long after the owner
   * thought they'd enabled it.
   */
  grantTokens?: string[];
  /** TESTNET ONLY — production signers live in a TEE, never serialized. */
  demoSessionPrivateKey: `0x${string}`;
  /**
   * TESTNET ONLY — the generated owner key that controls the account. When the
   * wallet is created in-browser (no external wallet connected) this is the ONLY
   * way to recover funds, so the UI forces the user to back it up before
   * funding. Absent when an external wallet (MetaMask) was the owner.
   */
  demoOwnerPrivateKey?: `0x${string}`;
}

/**
 * Addresses every grant can already approve without being asked to: USDG plus
 * the built-in tradable stock tokens. An owner-added entry that lands here needs
 * no extra permission and is never reported as uncovered.
 *
 * Shared deliberately. web/src/lib/session.ts skips these when baking extra
 * permissions into the call policy, and the worker skips them when deciding what
 * to warn about — if those two lists drifted, the warning would be wrong in one
 * direction or the other.
 */
export function builtinGrantTargets(): Set<string> {
  return new Set<string>([
    (CASH.USDG as string).toLowerCase(),
    ...STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map(
      (t) => t.address.toLowerCase(),
    ),
  ]);
}

/**
 * Which of the owner's configured tokens this signature actually lets the agent
 * sell. `grantTokens` absent means the grant predates the field entirely — and a
 * grant signed before extras existed genuinely has no extra approve permission
 * in its call policy, so "unknown" and "none" are the same fact here.
 */
export function tokenCoverage(
  configured: readonly CustomToken[],
  grant: Pick<StoredGrant, "grantTokens"> | null | undefined,
): { covered: CustomToken[]; uncovered: CustomToken[] } {
  const builtin = builtinGrantTargets();
  const granted = new Set((grant?.grantTokens ?? []).map((a) => a.toLowerCase()));
  const covered: CustomToken[] = [];
  const uncovered: CustomToken[] = [];
  for (const t of configured) {
    const key = t.address.toLowerCase();
    (builtin.has(key) || granted.has(key) ? covered : uncovered).push(t);
  }
  return { covered, uncovered };
}
