import { useStore } from "zustand";
import { feedStore, type FeedState } from "./feedStore";
import type { PositionRow, TradeRecord } from "@/net/types";

/**
 * Selector hooks. Every one returns a PRIMITIVE or a stable object identity.
 *
 * The rule that keeps this fast: never return a freshly-built object or array from
 * a selector. zustand compares with Object.is, so `s => ({ a: s.a, b: s.b })`
 * allocates a new object on every store write and re-renders unconditionally —
 * which quietly defeats the whole normalised store. Select the fields separately
 * instead; two primitive subscriptions are cheaper than one that always fires.
 */

export const useEquity = () => useStore(feedStore, (s: FeedState) => s.equityUsdg);
export const useCash = () => useStore(feedStore, (s: FeedState) => s.cashUsdg);
export const useVault = () => useStore(feedStore, (s: FeedState) => s.vaultUsdg);
export const useAgentName = () => useStore(feedStore, (s: FeedState) => s.agentName);
export const useStrategy = () => useStore(feedStore, (s: FeedState) => s.strategy);
export const useSource = () => useStore(feedStore, (s: FeedState) => s.source);
export const useLastOkAt = () => useStore(feedStore, (s: FeedState) => s.lastOkAt);
export const useLastError = () => useStore(feedStore, (s: FeedState) => s.lastError);

/** Stable because ingest reuses the previous array when the values are unchanged. */
export const useEquitySeries = () => useStore(feedStore, (s: FeedState) => s.equitySeries);
export const usePositionSymbols = () => useStore(feedStore, (s: FeedState) => s.positionSymbols);
export const useTapeIds = () => useStore(feedStore, (s: FeedState) => s.tapeIds);

/**
 * ONE row. This is the subscription that makes the lists cheap: a price tick on
 * one symbol wakes that row and nothing else, because ingest kept every other
 * row's object identity.
 */
export const usePosition = (symbol: string): PositionRow | undefined =>
  useStore(feedStore, (s: FeedState) => s.positions[symbol]);

export const useTrade = (id: string): TradeRecord | undefined =>
  useStore(feedStore, (s: FeedState) => s.tape[id]);
