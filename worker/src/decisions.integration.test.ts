/**
 * End-to-end proof of the attribution substrate against a REAL sqlite db (a
 * throwaway MERRYMEN_HOME): a decision is written, a trade links to it via
 * decision_id, and /why joins them exactly — no time-window guessing.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(), so the whole test
 * operates on an isolated temp database. node's --test runs each file in its own
 * process, so this env override never leaks into other suites.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-dec-"));
process.env.MERRYMEN_HOME = HOME;

const { initStore, addDecision, addTrade, newDecisionId } = await import("./store");
const { readWhyEvidence } = await import("./telegram/reads");

const AGENT = "0x000000000000000000000000000000000000a9e7";

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
});

describe("decisions substrate — /why joins the trade to its own decision", () => {
  it("a strategist trade resolves to the exact reasoning that produced it", async () => {
    initStore();
    const id = newDecisionId();
    await addDecision({
      id,
      agent_id: AGENT,
      source: "strategist",
      strategy: "llm-strategist(groq)",
      provider: "groq",
      model: "llama-3.3-70b",
      symbol: "AAPL",
      action: "buy",
      size_usdg: 25,
      reason: "gap-down into a strong open — buying the dip before Monday",
      signals_json: '{"cashUsdg":1000}',
    });
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0x0000000000000000000000000000000000000001",
      amount_usdg: 25,
      status: "landed",
      tx_hash: "0xdeadbeef",
      created_at: new Date().toISOString(),
      decision_id: id,
    });

    const why = readWhyEvidence();
    assert.equal(why.hasTrade, true);
    assert.match(why.text, /buy AAPL/); // decision head
    assert.match(why.text, /gap-down into a strong open/); // the model's own reason
    assert.match(why.text, /via strategist/); // source label
    // The legacy "approx" time-window path must NOT be used for a linked trade.
    assert.doesNotMatch(why.text, /approx/);
  });

  it("a trade with no decision_id still explains itself (legacy fallback, no crash)", async () => {
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0x0000000000000000000000000000000000000001",
      amount_usdg: 10,
      status: "rejected",
      reject_rule: "no-route",
      created_at: new Date().toISOString(),
      // no decision_id — an old row from before this migration
    });
    const why = readWhyEvidence();
    assert.equal(why.hasTrade, true);
    assert.match(why.text, /no-route/); // still shows the trade + its outcome
  });
});
