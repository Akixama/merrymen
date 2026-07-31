import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { EXPLORER } from "@/net/chainlinks";
import { fetchScoreboard, type ScoreboardAgent } from "@/net/scoreboard";
import { AreaChart } from "@/ui/AreaChart";
import { C } from "@/ui/tokens";

/**
 * The scoreboard — how the band is actually doing.
 *
 * One dominant number per agent and everything else quiet. The temptation with
 * this much data (P&L, drawdown, win rate, volume, HWM, fees, expiry) is to give
 * each field equal weight, which produces a spreadsheet nobody reads. So: P&L is
 * the headline, the curve carries the story, and the rest sits in a single row of
 * small stats underneath.
 *
 * Every figure that can be null stays null rather than rendering as 0 — "not
 * enough history to say" and "made exactly nothing" are different facts, and a
 * scoreboard that confuses them is worse than one that admits the gap.
 */

const W = Dimensions.get("window").width - 40;

const fmt = (n: number, dp = 2) =>
  n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

function signed(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
}

function expiryLabel(expiresAt: number): { text: string; tone: string } {
  const left = expiresAt - Math.floor(Date.now() / 1000);
  if (left <= 0) return { text: "key expired", tone: C.red };
  const d = Math.floor(left / 86_400);
  const h = Math.floor((left % 86_400) / 3600);
  return { text: d > 0 ? `${d}d ${h}h left` : `${h}h left`, tone: d < 2 ? C.gold : C.faint };
}

export default function Scoreboard() {
  const [agents, setAgents] = useState<ScoreboardAgent[] | null>(null);
  const [mock, setMock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const out = await fetchScoreboard();
    if (out.ok) {
      setAgents(out.data.agents);
      setMock(out.mock);
      setError(null);
    } else {
      setError(out.reason);
      // Keep whatever is on screen. A failed read is not news about performance.
      setAgents((a) => a ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.dim} />}
    >
      <Text style={styles.h1}>Scoreboard</Text>
      <Text style={styles.sub}>What the band has actually done — not what it was aiming for.</Text>

      {mock && (
        <View style={styles.mockBadge}>
          <Text style={styles.mockText}>MOCK — generated numbers, no agent connected.</Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {agents === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.green} />
        </View>
      ) : agents.length === 0 ? (
        <Text style={styles.empty}>
          No agents yet. Sign a wall and fund an account, and its record shows up here — including the trades
          the wall refused, which are usually the interesting ones.
        </Text>
      ) : (
        agents.map((a) => <AgentCard key={a.smart_account} agent={a} />)
      )}
    </ScrollView>
  );
}

function AgentCard({ agent }: { agent: ScoreboardAgent }) {
  const series = useMemo(() => agent.equity.map((p) => p.equity_usdg), [agent.equity]);

  const pnl = agent.pnl_usdg;
  const start = series.length ? series[0] : null;
  const pnlPct = pnl !== null && start ? (pnl / start) * 100 : null;
  const up = (pnl ?? 0) >= 0;
  const tone = pnl === null ? C.dim : up ? C.green : C.red;

  const { landed, rejected, reverted, volume_usdg } = agent.trades;
  const attempted = landed + rejected + reverted;
  // "Landed" as a share of everything ATTEMPTED, so refusals and reverts both
  // count against it. A rate that ignores them flatters the agent.
  const landRate = attempted > 0 ? (landed / attempted) * 100 : null;
  const expiry = expiryLabel(agent.expires_at);

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.nameWrap}>
          <Text style={styles.name}>{agent.name}</Text>
          <View style={[styles.pill, agent.status === "armed" ? styles.pillOn : styles.pillOff]}>
            <Text style={[styles.pillText, agent.status === "armed" && styles.pillTextOn]}>{agent.status}</Text>
          </View>
        </View>
        <Text style={[styles.expiry, { color: expiry.tone }]}>{expiry.text}</Text>
      </View>

      <View style={styles.pnlRow}>
        <Text style={[styles.pnl, { color: tone }]}>{pnl === null ? "—" : signed(pnl)}</Text>
        <View style={styles.pnlMeta}>
          <Text style={styles.unit}>USDG</Text>
          {pnlPct !== null && (
            <Text style={[styles.pct, { color: tone }]}>
              {pnlPct >= 0 ? "+" : "−"}
              {Math.abs(pnlPct).toFixed(2)}%
            </Text>
          )}
        </View>
      </View>
      {pnl === null && <Text style={styles.pnlNote}>Not enough history yet to say.</Text>}

      <View style={styles.chartWrap}>
        <AreaChart series={series} width={W - 28} height={104} />
      </View>

      <View style={styles.stats}>
        <Stat label="landed" value={String(landed)} />
        <Stat label="refused" value={String(rejected)} tone={rejected > 0 ? C.gold : undefined} />
        <Stat label="reverted" value={String(reverted)} tone={reverted > 0 ? C.red : undefined} />
        <Stat label="land rate" value={landRate === null ? "—" : `${landRate.toFixed(0)}%`} />
      </View>
      <View style={styles.stats}>
        <Stat label="volume" value={fmt(volume_usdg, 0)} />
        <Stat label="peak" value={fmt(agent.hwm_usdg, 0)} />
        <Stat label="max drawdown" value={`${(agent.max_drawdown_bps / 100).toFixed(2)}%`} />
        <Stat label="fees owed" value={fmt(agent.accrued_fee_usdg)} />
      </View>

      <Pressable
        style={styles.verify}
        onPress={() => Linking.openURL(`${EXPLORER}/address/${agent.smart_account}`)}
      >
        {/* The project's whole claim is "check, don't believe" — so every card
            ends at the ledger rather than at our arithmetic. */}
        <Text style={styles.verifyText}>check this on-chain →</Text>
      </Pressable>
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 56, paddingBottom: 48, gap: 10 },
  h1: { color: C.text, fontSize: 30, fontWeight: "700", letterSpacing: -0.8 },
  sub: { color: C.dim, fontSize: 14, lineHeight: 20, marginBottom: 6 },
  center: { paddingVertical: 40, alignItems: "center" },
  empty: { color: C.dim, fontSize: 14, lineHeight: 21, paddingVertical: 20 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
  mockBadge: {
    backgroundColor: "rgba(234,179,8,0.12)",
    borderColor: "rgba(234,179,8,0.3)",
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 11,
  },
  mockText: { color: C.gold, fontSize: 11, letterSpacing: 0.3 },

  card: {
    backgroundColor: C.bg1,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 10,
    marginTop: 8,
  },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  nameWrap: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  name: { color: C.text, fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1 },
  pillOn: { borderColor: "rgba(52,211,153,0.4)", backgroundColor: "rgba(52,211,153,0.12)" },
  pillOff: { borderColor: C.border, backgroundColor: C.bg2 },
  pillText: { color: C.faint, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.8 },
  pillTextOn: { color: C.green },
  expiry: { fontSize: 11.5 },

  pnlRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 2 },
  // Tabular figures and tight tracking: a number this size dancing on every
  // refresh is the difference between "instrument" and "toy".
  pnl: { fontSize: 40, fontWeight: "800", letterSpacing: -1.6, fontVariant: ["tabular-nums"], lineHeight: 44 },
  pnlMeta: { paddingBottom: 6, gap: 1 },
  unit: { color: C.faint, fontSize: 11, letterSpacing: 0.4 },
  pct: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  pnlNote: { color: C.faint, fontSize: 12, marginTop: -4 },

  chartWrap: { marginTop: 2, marginHorizontal: -2 },

  stats: { flexDirection: "row", gap: 8 },
  stat: {
    flex: 1,
    backgroundColor: C.bg2,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 9,
    gap: 3,
  },
  statLabel: { color: C.faint, fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.7 },
  statValue: { color: C.text, fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },

  verify: { minHeight: 40, justifyContent: "center", marginTop: 2 },
  verifyText: { color: C.green, fontSize: 12.5 },
});
