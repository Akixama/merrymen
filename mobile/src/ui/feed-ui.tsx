import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { usePosition, useTrade } from "@/store/selectors";
import { C } from "./tokens";

/**
 * Rows that subscribe to THEMSELVES.
 *
 * Each row takes an id, not data. It reads its own slice out of the store, so a
 * price tick on one symbol wakes one row instead of the whole list. That only
 * works because ingest preserves object identity for rows that didn't change — the
 * two halves are a single design and neither is useful alone.
 *
 * Passing the row object down as a prop instead would undo it: the list would have
 * to re-render to hand out new props, which is exactly the re-render being avoided.
 */

/** Money, with a fixed width so digits don't dance as values change. */
function usd(n: number, dp = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function shortHash(h: string): string {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

export const PositionRowView = memo(function PositionRowView({ symbol }: { symbol: string }) {
  const p = usePosition(symbol);
  if (!p) return null;

  // A pool price cleared the depth and divergence guards, so it's actionable —
  // but it's a thinner claim than an external feed and the row says which. Never
  // render both the same way.
  const pooled = p.price_source === "pool";
  const stale = p.price_stale === 1;

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.sym}>{p.symbol}</Text>
        <View style={styles.tags}>
          {pooled && <Text style={[styles.tag, styles.tagPool]}>pool</Text>}
          {stale && <Text style={[styles.tag, styles.tagStale]}>stale</Text>}
        </View>
      </View>
      <View style={styles.rowNums}>
        <Text style={styles.value}>{usd(p.value_usdg)}</Text>
        <Text style={styles.price}>@ {usd(p.price_usd, p.price_usd < 1 ? 6 : 2)}</Text>
      </View>
    </View>
  );
});

export const TapeRowView = memo(function TapeRowView({ id }: { id: string }) {
  const t = useTrade(id);
  if (!t) return null;

  const tone =
    t.status === "landed" ? C.green : t.status === "paper" ? C.text2 : t.status === "rejected" ? C.gold : C.red;

  const what =
    t.kind === "swap"
      ? `${t.sell_token ?? "?"} → ${t.buy_token ?? "?"}`
      : t.kind.replace("vault-", "vault ");

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.what} numberOfLines={1}>
          {what}
        </Text>
        {/* A rejected trade explains itself. "rejected" alone tells the owner
            nothing about which wall it hit. */}
        <Text style={styles.meta} numberOfLines={1}>
          {t.reject_rule ? `refused · ${t.reject_rule}` : t.tx_hash ? shortHash(t.tx_hash) : "no receipt"}
        </Text>
      </View>
      <View style={styles.rowNums}>
        <Text style={styles.value}>{usd(t.amount_usdg)}</Text>
        <Text style={[styles.status, { color: tone }]}>{t.status}</Text>
      </View>
    </View>
  );
});

/**
 * Equity sparkline. Pure SVG over a numeric series.
 *
 * memo'd on the array identity, which the store keeps stable when the numbers
 * haven't moved — so a poll that changes nothing does not rebuild the path string.
 */
export const Sparkline = memo(function Sparkline({
  series,
  width = 320,
  height = 44,
}: {
  series: number[];
  width?: number;
  height?: number;
}) {
  if (series.length < 2) return <View style={{ height }} />;

  const min = Math.min(...series);
  const max = Math.max(...series);
  // A flat series has zero range; dividing by it would put the line at NaN and
  // render nothing, which reads as "no data" rather than "no change".
  const span = max - min || 1;
  const dx = width / (series.length - 1);

  let d = "";
  for (let i = 0; i < series.length; i++) {
    const x = Math.round(i * dx * 10) / 10;
    const y = Math.round((height - ((series[i] - min) / span) * height) * 10) / 10;
    d += `${i === 0 ? "M" : "L"}${x} ${y}`;
  }

  const up = series[series.length - 1] >= series[0];
  return (
    <Svg width={width} height={height}>
      <Path d={d} stroke={up ? C.green : C.red} strokeWidth={1.5} fill="none" />
    </Svg>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 4,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  rowMain: { flexShrink: 1, gap: 3 },
  rowNums: { alignItems: "flex-end", gap: 3 },
  sym: { color: C.text, fontSize: 15, fontWeight: "600" },
  what: { color: C.text, fontSize: 14 },
  meta: { color: C.faint, fontSize: 11 },
  // tabular-nums so a changing figure doesn't shift the row's width.
  value: { color: C.text, fontSize: 15, fontVariant: ["tabular-nums"] },
  price: { color: C.dim, fontSize: 11, fontVariant: ["tabular-nums"] },
  status: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  tags: { flexDirection: "row", gap: 6 },
  tag: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: "hidden" },
  tagPool: { color: C.gold, backgroundColor: "rgba(234,179,8,0.14)" },
  tagStale: { color: C.dim, backgroundColor: "rgba(148,168,158,0.14)" },
});
