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
import { PositionRowView, Sparkline } from "@/ui/feed-ui";
import { C } from "@/ui/tokens";

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

function age(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export default function Band() {
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
        contentContainerStyle={styles.listPad}
        ListHeaderComponent={
          <View style={styles.header}>
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

            <Sparkline series={series} width={W} />

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
          <Link href="/probe" asChild>
            <Pressable style={styles.probeLink}>
              <Text style={styles.probeText}>crypto probe →</Text>
            </Pressable>
          </Link>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  listPad: { paddingHorizontal: 20, paddingBottom: 40 },
  header: { paddingTop: 16, gap: 6 },
  mockBadge: {
    backgroundColor: "rgba(234,179,8,0.12)",
    borderColor: "rgba(234,179,8,0.35)",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  mockText: { color: C.gold, fontSize: 11, lineHeight: 16 },
  who: { color: C.dim, fontSize: 13 },
  strategy: { color: C.faint },
  equity: { color: C.text, fontSize: 42, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -1 },
  equityMeta: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: -4 },
  unit: { color: C.faint, fontSize: 12 },
  delta: { fontSize: 13, fontVariant: ["tabular-nums"] },
  split: { flexDirection: "row", gap: 28, marginTop: 10 },
  splitCell: { gap: 2 },
  splitLabel: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  splitValue: { color: C.text2, fontSize: 15, fontVariant: ["tabular-nums"] },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 14 },
  dot: { width: 7, height: 7, borderRadius: 4 },
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
  probeLink: { paddingVertical: 18 },
  probeText: { color: C.faint, fontSize: 12 },
});
