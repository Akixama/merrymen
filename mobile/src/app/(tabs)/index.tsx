import { useMemo } from "react";
import { Dimensions, Pressable, StyleSheet, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { Link } from "expo-router";
import { feedOrigin, isMock } from "@/net/api";
import {
  useAgentName,
  useCash,
  useEquity,
  useEquitySeries,
  useLastError,
  useLastOkAt,
  usePositionSymbols,
  useStrategy,
  useVault,
} from "@/store/selectors";
import { AreaChart } from "@/ui/AreaChart";
import { PositionRowView } from "@/ui/feed-ui";
import { useListBottomPad, useTopPad } from "@/ui/insets";
import { C, GUTTER } from "@/ui/tokens";

/**
 * The live band — equity, cash, and the open positions.
 *
 * Every value here comes from its own primitive subscription, so a poll that moves
 * one price re-renders only what that price touches. Note what this screen does
 * NOT do: subscribe to the whole store. If it did, the FlashList would re-render
 * on every tick and all the per-row work would be wasted.
 */

const W = Dimensions.get("window").width - 40;

function money(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * How old the numbers on screen are.
 *
 * Rolls over past minutes, which matters precisely because this line exists for
 * the failure case: a poll that fails keeps the last good figures on screen, so
 * an agent that has been unreachable for a day has to say "1d ago" and not
 * "1440m ago" — a four-digit minute count is a number you have to do arithmetic
 * on before you know whether to worry.
 */
function age(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export default function Band() {
  const topPad = useTopPad();
  const bottomPad = useListBottomPad();
  const equity = useEquity();
  const cash = useCash();
  const vault = useVault();
  const series = useEquitySeries();
  const symbols = usePositionSymbols();
  const name = useAgentName();
  const strategy = useStrategy();
  const lastOkAt = useLastOkAt();
  const lastError = useLastError();

  // Change across the visible window, so the headline figure has a reference
  // point instead of being a number with no context.
  const delta = useMemo(() => {
    if (series.length < 2) return null;
    const first = series[0];
    if (!first) return null;
    return ((series[series.length - 1] - first) / first) * 100;
  }, [series]);

  return (
    <View style={styles.root}>
      <FlashList
        data={symbols}
        keyExtractor={(s) => s}
        // Rows take an id and read their own slice, so the list never re-renders
        // just to hand new data to a row.
        renderItem={({ item }) => <PositionRowView symbol={item} />}
        // This list re-sorts as values move, and maintainVisibleContentPosition is
        // ON by default in FlashList v2 — with re-ordering data its documented
        // behaviour is that rows visibly jump. Off here; the tape keeps it, because
        // the tape only ever prepends.
        maintainVisibleContentPosition={{ disabled: true }}
        contentContainerStyle={[styles.listPad, { paddingBottom: bottomPad }]}
        ListHeaderComponent={
          <View style={[styles.header, { paddingTop: topPad }]}>
            {isMock && (
              <View style={styles.mockBadge}>
                <Text style={styles.mockText}>
                  MOCK DATA — generated on-device, no agent connected. Set EXPO_PUBLIC_FEED_ORIGIN to read a
                  real one.
                </Text>
              </View>
            )}

            <Text style={styles.who}>
              {name ?? "merryman"}
              {strategy ? <Text style={styles.strategy}> · {strategy}</Text> : null}
            </Text>

            <Text style={styles.equity}>{money(equity)}</Text>
            <View style={styles.equityMeta}>
              <Text style={styles.unit}>USDG</Text>
              {delta !== null && (
                <Text style={[styles.delta, { color: delta >= 0 ? C.green : C.red }]}>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(2)}%
                </Text>
              )}
            </View>

            {/* The SAME chart component the Scoreboard uses, at a smaller height.
                These two screens each show "how the money moved" and were drawing
                it two different ways — a bare stroke here, a filled area with a
                baseline there — so the identical idea read as two unrelated
                things. It was also the weaker of the two: no fill, and no line
                marking where the money started, so "up" was a shape you had to
                interpret rather than see. One implementation now, and it is the
                one whose geometry is unit-tested. */}
            <AreaChart series={series} width={W} height={64} />

            <View style={styles.split}>
              <View style={styles.splitCell}>
                <Text style={styles.splitLabel}>cash</Text>
                <Text style={styles.splitValue}>{money(cash)}</Text>
              </View>
              <View style={styles.splitCell}>
                <Text style={styles.splitLabel}>vault</Text>
                <Text style={styles.splitValue}>{money(vault)}</Text>
              </View>
            </View>

            {/* Staleness is shown, never hidden. A failed poll deliberately keeps
                the last good numbers on screen, so this line has to say how old
                they are — otherwise the screen presents stale data as current. */}
            <View style={styles.statusRow}>
              {/* The dot pins to the FIRST line, not the block's centre. This line
                  grows to two or three lines in exactly the case it exists to
                  announce — a failed read appends the error and the feed origin —
                  and a centred dot then floats to the middle of the paragraph. */}
              <View style={[styles.dot, { backgroundColor: lastError ? C.gold : C.green }]} />
              <Text style={styles.status}>
                {lastError ? `last read failed · ${lastError} · ` : ""}
                updated {age(lastOkAt)} · {feedOrigin}
              </Text>
            </View>

            <Text style={styles.sectionTitle}>positions</Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {lastOkAt === null
              ? "reading…"
              : "No open positions. A funded agent that hasn't bought yet looks exactly like this."}
          </Text>
        }
        ListFooterComponent={
          <View style={styles.footerLinks}>
            <Link href="/chat" asChild>
              <Pressable style={styles.footerBtn}>
                <Text style={styles.footerBtnText}>chat with your merryman</Text>
              </Pressable>
            </Link>
            <Link href="/settings" asChild>
              <Pressable style={styles.footerBtn}>
                <Text style={styles.footerBtnText}>settings &amp; the wall</Text>
              </Pressable>
            </Link>
            <Link href="/probe" asChild>
              <Pressable style={styles.probeLink}>
                <Text style={styles.probeText}>crypto probe →</Text>
              </Pressable>
            </Link>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  listPad: { paddingHorizontal: GUTTER },
  header: { gap: 6 },
  mockBadge: {
    backgroundColor: "rgba(234,179,8,0.12)",
    borderColor: "rgba(234,179,8,0.35)",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  mockText: { color: C.gold, fontSize: 11, lineHeight: 16 },
  // The agent's name IS this screen's title — the tab set's three screens each
  // open with a title-case name at title weight, and here it happens to be the
  // merryman's rather than the screen's. Set at a rank you can see from across
  // the room, because knowing WHICH agent you are looking at matters before any
  // number on the page does.
  who: { color: C.text, fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  strategy: { color: C.dim, fontSize: 13, fontWeight: "400", letterSpacing: 0 },
  equity: { color: C.text, fontSize: 42, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -1 },
  equityMeta: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: -4 },
  unit: { color: C.faint, fontSize: 12 },
  delta: { fontSize: 13, fontVariant: ["tabular-nums"] },
  split: { flexDirection: "row", gap: 28, marginTop: 10 },
  // flex:1 pins the two columns to a stable grid. Content-sized, the VAULT
  // column's position was derived from however wide the cash figure rendered, so
  // it slid left and right as the balance changed — which threw away the whole
  // point of the tabular-nums on the values below.
  splitCell: { flex: 1, gap: 2 },
  splitLabel: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  splitValue: { color: C.text2, fontSize: 15, fontVariant: ["tabular-nums"] },
  statusRow: { flexDirection: "row", alignItems: "flex-start", gap: 7, marginTop: 14 },
  // marginTop centres the dot on the first line's x-height rather than on the
  // whole (possibly wrapped) block.
  dot: { width: 7, height: 7, borderRadius: 4, marginTop: 4 },
  status: { color: C.faint, fontSize: 11, flexShrink: 1 },
  sectionTitle: {
    color: C.dim,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1.4,
    marginTop: 22,
    marginBottom: 2,
  },
  empty: { color: C.dim, fontSize: 13, lineHeight: 20, paddingVertical: 18 },
  footerLinks: { marginTop: 20, gap: 4 },
  footerBtn: {
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  footerBtnText: { color: C.text2, fontSize: 14 },
  probeLink: { minHeight: 44, justifyContent: "center" },
  probeText: { color: C.faint, fontSize: 12 },
});
