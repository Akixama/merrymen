/**
 * The broker rail's agent identity.
 *
 * Everything in the store keys off agent_id, and today that id IS the ERC-4337
 * smart-account address — agents, trades, decisions, positions, cost_basis,
 * equity, fee_accruals all inherit it (store.ts). A custodial account has no
 * address; it has an account number. So broker agents get a NAMESPACED id,
 * `rh:<account_number>`, chosen so the two id spaces cannot collide or be
 * confused:
 *
 *   An 0x id can never equal an rh: id, so a broker row can never key into an
 *   on-chain agent's basis, HWM, or fee ledger — the cross-contamination the
 *   cost_basis DDL comment warns about, made unrepresentable rather than
 *   merely avoided.
 *
 *   The prefix survives being read by code that doesn't know about venues:
 *   anything that renders or logs the id shows `rh:…`, which is honest, and
 *   anything that VALIDATES it as an address fails loudly instead of treating
 *   a brokerage account like a contract.
 *
 * The account number itself comes from get_accounts and is treated as opaque:
 * validated for shape, never parsed for meaning.
 */

const ACCOUNT_RE = /^[A-Za-z0-9-]{1,64}$/;

export function brokerAgentId(accountNumber: string): `rh:${string}` {
  const acct = accountNumber.trim();
  if (!ACCOUNT_RE.test(acct)) {
    // Refuse rather than sanitize: an account number with unexpected characters
    // means the wire shape drifted (see robinhood-feed.ts CANDIDATES), and a
    // "cleaned" id would silently key every table off a guess.
    throw new Error(`broker account number has an unexpected shape: ${JSON.stringify(accountNumber)}`);
  }
  return `rh:${acct}`;
}

export function isBrokerAgentId(agentId: string): boolean {
  return agentId.startsWith("rh:");
}
