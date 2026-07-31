import { useEffect, useMemo, useState } from "react";
import { Dimensions, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { Link } from "expo-router";
import { feedOrigin, isMock } from "@/net/api";
import { EXPLORER } from "@/net/chainlinks";
import { readGrant } from "@/crypto/grantStore";
import {
  useAgentName,
  useCash,
  useEquity,
  useEquitySeries,
  useLastError,
  useLastOkAt,
  usePositionSymbols,
  useStrategy,
  useTapeIds,
  useVault,
} from "@/store/selectors";
import { AreaChart } from "@/ui/AreaChart";
import { PositionRowView, TapeRowView } from "@/ui/feed-ui";
import { useBottomPad, useTopPad } from "@/ui/insets";
import { C, GUTTER } from "@/ui/tokens";

/**
 * THE screen. Not "the first tab" — the only one.
 *
 * This used to be three tabs: Band (money now), Tape (what it did), Record (how
 * it has done). Three destinations for one question — "is my agent OK?" — which
 * meant the answer was never in one place and every tab had to repeat enough
 * context to stand alone. Both other tabs also drew their own equity chart from
 * the same numbers.
 *
 * So: one list. Money at the top, what it holds, what it did, in the order you
 * would ask. The Record tab's derived statistics are gone rather than moved: the
 * decisions below ARE the record, including the refused ones, and the link at
 * the bottom goes to the chain, which is the only version of the record this app
 * doesn't compute itself. A land-rate percentage we calculate is not evidence.
 *
 * ONE FlashList, not a ScrollView of two lists. Positions and decisions are both
 * unbounded, so both need recycling; nesting lists inside a scroll view gives up
 * virtualization on the inner one. A tagged row union keeps that to a single
 * pass, and getItemType keeps each kind recycling into its own kind.
 */

const W = Dimensions.get("window").width - GUTTER * 2;

/** How many decisions to show. The tape's whole history lives in the store. */
const RECENT = 40;

type Row =
  | { kind: "heading"; key: string; text: string }
  | { kind: "position"; key: string; symbol: string }
  | { kind: "trade"; key: string; id: string }
  | { kind: "empty"; key: string; text: string };

function money(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * How old the numbers on screen are. Rolls over past minutes because this line
 * exists for the failure case: a failed poll keeps the last good figures up, so
 * an agent unreachable for a day must say "1d ago", not "1440m ago".
 */
function age(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export default function Home() {
  const topPad = useTopPad();
  const bottomPad = useBottomPad();

  const equity = useEquity();
  const cash = useCash();
  const vault = useVault();
  const series = useEquitySeries();
  const symbols = usePositionSymbols();
  const tapeIds = useTapeIds();
  const name = useAgentName();
  const strategy = useStrategy();
  const lastOkAt = useLastOkAt();
  const lastError = useLastError();

  // The one thing on this screen that isn't in the feed: which account to open
  // on the explorer. Read once — it only changes when a wall is signed.
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    void readGrant().then((g) => setAccount(g?.smartAccount ?? null));
  }, []);

  // Change across the visible window, so the headline figure has a reference
  // point instead of being a number with no context.
  const delta = useMemo(() => {
    if (series.length < 2) return null;
    const first = series[0];
    if (!first) return null;
    return ((series[series.length - 1] - first) / first) * 100;
  }, [series]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [{ kind: "heading", key: "h-pos", text: "holding" }];
    if (symbols.length === 0) {
      out.push({
        kind: "empty",
        key: "e-pos",
        text:
          lastOkAt === null
            ? "reading…"
            : "Nothing open. A funded agent that hasn't bought yet looks exactly like this.",
      });
    } else {
      for (const s of symbols) out.push({ kind: "position", key: `p-${s}`, symbol: s });
    }

    out.push({ kind: "heading", key: "h-tape", text: "decisions" });
    if (tapeIds.length === 0) {
      out.push({
        kind: "empty",
        key: "e-tape",
        text:
          lastOkAt === null
            ? "reading…"
            : "Nothing yet. Every decision lands here — including the ones the wall refused, which are usually the interesting ones.",
      });
    } else {
      for (const id of tapeIds.slice(0, RECENT)) out.push({ kind: "trade", key: `t-${id}`, id });
    }
    return out;
  }, [symbols, tapeIds, lastOkAt]);

  return (
    <View style={styles.root}>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.kind}
        renderItem={({ item }) => {
          switch (item.kind) {
            case "heading":
              return <Text style={styles.sectionTitle}>{item.text}</Text>;
            case "position":
              return <PositionRowView symbol={item.symbol} />;
            case "trade":
              return <TapeRowView id={item.id} />;
            case "empty":
              return <Text style={styles.empty}>{item.text}</Text>;
          }
        }}
        // The list re-sorts as values move, and maintainVisibleContentPosition is
        // ON by default in FlashList v2 — with re-ordering data its documented
        // behaviour is that rows visibly jump.
        maintainVisibleContentPosition={{ disabled: true }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: bottomPad }}
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
                they are — otherwise the screen presents stale data as current.
                The dot pins to the first line: this text grows to two or three
                lines in exactly the case it exists to announce. */}
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: lastError ? C.gold : C.green }]} />
              <Text style={styles.status}>
                {lastError ? `last read failed · ${lastError} · ` : ""}
                updated {age(lastOkAt)} · {feedOrigin}
              </Text>
            </View>
          </View>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Link href="/settings" asChild>
              <Pressable style={styles.footerBtn}>
                <Text style={styles.footerBtnText}>settings &amp; the wall</Text>
              </Pressable>
            </Link>
            {/* The project's claim is "check, don't believe", so the screen ends
                at the ledger rather than at our arithmetic. */}
            {account && (
              <Pressable
                style={styles.verify}
                onPress={() => void Linking.openURL(`${EXPLORER}/address/${account}`)}>
                <Text style={styles.verifyText}>check all of this on-chain →</Text>
              </Pressable>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { gap: 6, paddingBottom: 4 },
  mockBadge: {
    backgroundColor: "rgba(234,179,8,0.12)",
    borderColor: "rgba(234,179,8,0.35)",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  mockText: { color: C.gold, fontSize: 11, lineHeight: 16 },
  // The agent's name is this screen's title. Knowing WHICH merryman you are
  // looking at matters before any number on the page does.
  who: { color: C.text, fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  strategy: { color: C.dim, fontSize: 13, fontWeight: "400", letterSpacing: 0 },
  equity: { color: C.text, fontSize: 42, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -1 },
  equityMeta: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: -4 },
  unit: { color: C.faint, fontSize: 12 },
  delta: { fontSize: 13, fontVariant: ["tabular-nums"] },
  split: { flexDirection: "row", gap: 28, marginTop: 10 },
  // flex:1 pins the columns to a grid, so the vault column doesn't slide as the
  // cash figure changes — which would throw away the tabular-nums below it.
  splitCell: { flex: 1, gap: 2 },
  splitLabel: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  splitValue: { color: C.text2, fontSize: 15, fontVariant: ["tabular-nums"] },
  statusRow: { flexDirection: "row", alignItems: "flex-start", gap: 7, marginTop: 14 },
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
  footer: { marginTop: 20, gap: 4 },
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
  verify: { minHeight: 44, justifyContent: "center" },
  verifyText: { color: C.green, fontSize: 12.5 },
});
