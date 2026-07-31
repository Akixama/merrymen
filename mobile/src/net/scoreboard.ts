import { feedOrigin, isMock } from "./api";

/**
 * Scoreboard contract, mirrored from web/src/app/api/scoreboard/route.ts.
 *
 * Same hand-written-mirror reasoning as net/types.ts: the dashboard is a Next app
 * this project doesn't compile, so if the server shape changes this file is the
 * one place that follows.
 */

export interface ScoreboardEquityPoint {
  equity_usdg: number;
  at: string;
}

export interface ScoreboardAgent {
  smart_account: string;
  name: string;
  status: string;
  chain_id: number;
  caps: Record<string, number>;
  granted_at: number;
  expires_at: number;
  hwm_usdg: number;
  accrued_fee_usdg: number;
  equity: ScoreboardEquityPoint[];
  /** null when there isn't enough history to say — NOT zero. */
  pnl_usdg: number | null;
  max_drawdown_bps: number;
  trades: { landed: number; rejected: number; reverted: number; volume_usdg: number };
}

export interface ScoreboardResponse {
  source: "sqlite" | "none";
  agents: ScoreboardAgent[];
}

/** A believable agent for the mock, with a curve that actually goes somewhere. */
function mockAgent(): ScoreboardAgent {
  const start = 10_000;
  const pts: ScoreboardEquityPoint[] = [];
  let v = start;
  // A deterministic walk with a mild upward drift and one real drawdown, so the
  // chart has a shape worth drawing rather than noise.
  for (let i = 0; i < 90; i++) {
    const dip = i > 38 && i < 52 ? -0.004 : 0.0012;
    v = v * (1 + dip + Math.sin(i / 6) * 0.0022);
    pts.push({ equity_usdg: Math.round(v * 100) / 100, at: new Date(Date.now() - (90 - i) * 3_600_000).toISOString() });
  }
  const last = pts[pts.length - 1].equity_usdg;
  return {
    smart_account: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    name: "Robin",
    status: "armed",
    chain_id: 4663,
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    granted_at: Math.floor(Date.now() / 1000) - 6 * 86_400,
    expires_at: Math.floor(Date.now() / 1000) + 8 * 86_400,
    hwm_usdg: Math.max(...pts.map((p) => p.equity_usdg)),
    accrued_fee_usdg: 12.4,
    equity: pts,
    pnl_usdg: Math.round((last - start) * 100) / 100,
    max_drawdown_bps: 640,
    trades: { landed: 37, rejected: 5, reverted: 1, volume_usdg: 4_180.5 },
  };
}

export type ScoreboardOutcome =
  | { ok: true; data: ScoreboardResponse; mock: boolean }
  | { ok: false; reason: string };

export async function fetchScoreboard(signal?: AbortSignal): Promise<ScoreboardOutcome> {
  if (isMock) {
    await new Promise((r) => setTimeout(r, 140));
    return { ok: true, mock: true, data: { source: "sqlite", agents: [mockAgent()] } };
  }
  try {
    const res = await fetch(`${feedOrigin}/api/scoreboard`, { signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, reason: `agent replied ${res.status}` };
    const json = (await res.json()) as ScoreboardResponse;
    if (!json || !Array.isArray(json.agents)) return { ok: false, reason: "unexpected shape" };
    return { ok: true, mock: false, data: json };
  } catch {
    return { ok: false, reason: "couldn't reach your agent" };
  }
}
