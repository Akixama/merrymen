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
import { useListBottomPad, useTopPad } from "@/ui/insets";
import { C, GUTTER } from "@/ui/tokens";

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

/** Screen width less the page gutter on both sides. */
const W = Dimensions.get("window").width - GUTTER * 2;
/** ...less the card's own padding on both sides: the card's content box. */
const CARD_W = W - 28;

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
  const topPad = useTopPad();
  const bottomPad = useListBottomPad();
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
      contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}
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

      {/* No negative margin. The wrapper used to bleed 2dp each side while the
          chart inside was a FIXED width — and a fixed-width child in a stretch
          container falls back to flex-start, so the whole 4dp of slack landed on
          the right and the chart hung 2dp past the card's left edge only. Same
          width as the stat grid below it, so they share both edges. */}
      <View style={styles.chartWrap}>
        <AreaChart series={series} width={CARD_W} height={104} />
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
        {/* "worst drop", not "max drawdown". Measured in a 4-up grid on a 375dp
            screen each cell gives 58.75dp of text width, and DRAWDOWN needs 64.6
            — it does not fit at any size worth reading, so it clipped to
            "MAX DRAWDO…" however many lines it was allowed. WORST (36.6) and
            DROP (28.5) both fit with room to spare, it pairs with "peak" right
            beside it, and it is the plainer word anyway. */}
        <Stat label="worst drop" value={`${(agent.max_drawdown_bps / 100).toFixed(2)}%`} />
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

/**
 * One cell of the stat grid.
 *
 * The label sits in a FIXED-HEIGHT box, bottom-aligned, and the number is what
 * lines up. Without it the cells size themselves to their own label, so "landed"
 * (one line) and "max drawdown" (two) put their numbers at different heights and
 * a row of four reads visibly ragged.
 *
 * Reserving the space beats shortening the words: the phone's own text-size
 * setting can wrap a label that fits at the default, so a row tuned by eye at
 * 100% goes crooked again for anyone using large text.
 */
function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stat}>
      <View style={styles.statLabelBox}>
        <Text style={styles.statLabel} numberOfLines={2}>
          {label}
        </Text>
      </View>
      <Text style={[styles.statValue, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: GUTTER, gap: 10 },
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

  chartWrap: { marginTop: 2 },

  stats: { flexDirection: "row", gap: 8 },
  stat: {
    flex: 1,
    backgroundColor: C.bg2,
    borderRadius: 10,
    paddingVertical: 9,
    // 6, not 9. Four flex:1 cells in a 305dp card leave 70.75dp each; at 9dp a
    // side that is 51.5dp of text, and "DRAWDOWN" needs ~56 — so the label
    // clipped to "MAX DRAWDO…" no matter how many lines it was allowed. 6dp
    // gives 58.75dp and the word fits whole.
    paddingHorizontal: 6,
    gap: 3,
  },
  // Two lines' worth of 9.5/12 label, bottom-aligned — see Stat above.
  statLabelBox: { height: 24, justifyContent: "flex-end" },
  statLabel: {
    // 10.5 rather than 9.5: below Apple's smallest text style (caption2, 11pt)
    // these were the least legible thing on the screen, on the quietest colour.
    color: C.faint,
    fontSize: 10.5,
    lineHeight: 12,
    textTransform: "uppercase",
    // Tighter tracking buys back the width the larger size costs.
    letterSpacing: 0.3,
  },
  statValue: { color: C.text, fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },

  // 44, the platform minimum. It is the card's only control and it leaves the app.
  verify: { minHeight: 44, justifyContent: "center", marginTop: 2 },
  verifyText: { color: C.green, fontSize: 12.5 },
});
