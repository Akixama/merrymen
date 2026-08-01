import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpClient } from "../../packages/core/src/mcp";
import {
  parseBrokerBalances,
  parseBrokerPositions,
  parseBrokerQuotes,
  parseToolPayload,
  readBrokerQuotes,
  usdToPrice8,
} from "./venues/robinhood-feed";

/**
 * The broker feed parsers, tested for the one property that matters: they FAIL
 * CLOSED. The wire schemas are guesses until tools/list is read on a live
 * account, so what these tests pin is not "the guess is right" — it is that a
 * WRONG guess degrades to "unpriced" (a warning) and never to a wrong number
 * (which would flow into equity, the HWM, the fee and the breaker).
 */

describe("parseToolPayload", () => {
  it("prefers structuredContent when present", () => {
    const r = { structuredContent: { a: 1 }, content: [{ type: "text", text: '{"a":2}' }] };
    assert.deepEqual(parseToolPayload(r), { a: 1 });
  });

  it("concatenates split text blocks before parsing", () => {
    // Servers may chunk one JSON document across several content parts.
    const r = { content: [{ type: "text", text: '{"quotes":[' }, { type: "text", text: "]}" }] };
    assert.deepEqual(parseToolPayload(r), { quotes: [] });
  });

  it("throws on a result with neither form — a silent {} would read as an empty portfolio", () => {
    assert.throws(() => parseToolPayload({}));
    assert.throws(() => parseToolPayload(null));
    assert.throws(() => parseToolPayload({ content: [{ type: "image" }] }));
  });
});

describe("usdToPrice8", () => {
  it("converts number and string dollars to 8dp", () => {
    assert.equal(usdToPrice8(189.87), 18_987_000_000n);
    assert.equal(usdToPrice8("189.87"), 18_987_000_000n);
    assert.equal(usdToPrice8("0.0001"), 10_000n);
  });

  it("returns null — not zero, not a throw — for anything unusable", () => {
    // Zero would VALUE a position at nothing; a throw would take every other
    // symbol down with it. Null skips exactly one row.
    for (const bad of [0, -5, NaN, Infinity, "", "  ", "abc", null, undefined, {}, true]) {
      assert.equal(usdToPrice8(bad), null, `usdToPrice8(${String(bad)})`);
    }
  });
});

describe("parseBrokerQuotes", () => {
  it("reads rows into source:'broker' quotes and never marks them stale", () => {
    const { quotes, skipped } = parseBrokerQuotes({
      quotes: [
        { symbol: "AAPL", last_trade_price: "189.87" },
        { ticker: "MSFT", price: 499.01 }, // alternate spellings both land
      ],
    });
    assert.equal(skipped.length, 0);
    assert.deepEqual(quotes.get("AAPL"), { price8: 18_987_000_000n, stale: false, source: "broker" });
    assert.deepEqual(quotes.get("MSFT"), { price8: 49_901_000_000n, stale: false, source: "broker" });
  });

  it("skips and REPORTS a row with no usable price, rather than guessing", () => {
    const { quotes, skipped } = parseBrokerQuotes([
      { symbol: "AAPL", last_trade_price: "189.87" },
      { symbol: "HALT", last_trade_price: null }, // halted / no print
      { symbol: "WEIRD", totally_new_field: "42.00" }, // schema drift
    ]);
    assert.equal(quotes.size, 1);
    assert.deepEqual(skipped.sort(), ["HALT", "WEIRD"]);
  });

  it("refuses a payload that isn't rows at all — schema drift must be loud", () => {
    assert.throws(() => parseBrokerQuotes({ quotes: "AAPL:189.87" }));
    assert.throws(() => parseBrokerQuotes(42));
  });
});

describe("parseBrokerPositions", () => {
  it("carries the share count undigested — unit policy is the store's job, not the parser's", () => {
    const { positions, skipped } = parseBrokerPositions({
      positions: [{ symbol: "AAPL", quantity: "1.5", last_trade_price: "200" }],
    });
    assert.equal(skipped, 0);
    assert.deepEqual(positions, [{ symbol: "AAPL", quantityRaw: "1.5", priceUsd8: 20_000_000_000n }]);
  });

  it("counts what it couldn't read instead of inventing shares", () => {
    const { positions, skipped } = parseBrokerPositions([{ symbol: "AAPL" }, { quantity: "2" }]);
    assert.equal(positions.length, 0);
    assert.equal(skipped, 2);
  });
});

describe("parseBrokerBalances", () => {
  it("keeps settled cash and buying power SEPARATE — margin is not money", () => {
    const b = parseBrokerBalances({ cash: "1000.50", buying_power: "4000.00" });
    assert.equal(b.cashUsd8, 100_050_000_000n);
    assert.equal(b.buyingPowerUsd8, 400_000_000_000n);
  });

  it("absent fields are null, never zero — 'not found' must not read as 'broke'", () => {
    const b = parseBrokerBalances({ something_else: 1 });
    assert.equal(b.cashUsd8, null);
    assert.equal(b.buyingPowerUsd8, null);
  });
});

describe("readBrokerQuotes end-to-end through the real McpClient", () => {
  it("calls the read tool through the gate and parses a streamed response", async () => {
    // SSE framing on purpose: the transport trap is a server that streams the
    // same response another server sends as plain JSON.
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify({ quotes: [{ symbol: "NVDA", price: "171.5" }] }) }] },
    };
    const impl = (async () =>
      new Response(`data: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const client = new McpClient({ url: "https://x/mcp", token: "t", fetchImpl: impl });
    const { quotes, skipped } = await readBrokerQuotes(client, ["NVDA"]);
    assert.equal(skipped.length, 0);
    assert.deepEqual(quotes.get("NVDA"), { price8: 17_150_000_000n, stale: false, source: "broker" });
  });
});
