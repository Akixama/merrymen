import { mockFeed } from "./mock";
import type { FeedResponse } from "./types";

/**
 * The one place that decides where data comes from.
 *
 * There is no hosted API yet — the dashboard's routes assume single-tenant local
 * state with no auth, so a phone has nothing to point at until that lands. So the
 * app runs on the mock by default and this file is the seam: set
 * EXPO_PUBLIC_FEED_ORIGIN and it talks to a real worker instead, with no change
 * anywhere else in the app.
 *
 * Deliberately no auth header. When the hosted API arrives it will need one, and
 * inventing a scheme now would mean writing a client against a contract that does
 * not exist. Pointing this at a LAN worker is a DEVELOPMENT path only.
 */

// Trimmed, and an empty string counts as unset. `?? null` alone treats "" as a
// configured origin, so a blank EAS environment variable — the easy way to get
// one — would leave the app fetching `/api/feed` against nothing instead of
// falling back to the mock. Failing to the honest default is the safe direction;
// scripts/guard-release.mjs is what stops a release taking that default silently.
const RAW = (process.env.EXPO_PUBLIC_FEED_ORIGIN ?? "").trim();
const ORIGIN = RAW === "" ? null : RAW;

/** True when running on generated data rather than a real agent. */
export const isMock = ORIGIN === null;

/** Where the data claims to come from, for display. Never a silent fallback. */
export const feedOrigin = ORIGIN ?? "mock";

export async function fetchFeed(signal?: AbortSignal): Promise<FeedResponse> {
  if (!ORIGIN) {
    // Mimic a little latency so the UI is exercised with real async timing rather
    // than a synchronous update that can never reveal a loading-state bug.
    await new Promise((r) => setTimeout(r, 60));
    return mockFeed();
  }

  const res = await fetch(`${ORIGIN}/api/feed`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const json = (await res.json()) as FeedResponse;

  // Defend the store against a shape it can't fold. A malformed response should
  // read as a failed poll — which keeps the last good numbers — not as an empty
  // portfolio, which would look like everything was sold.
  if (!json || typeof json !== "object" || !Array.isArray(json.positions) || !Array.isArray(json.trades)) {
    throw new Error("feed: unexpected shape");
  }
  return json;
}
