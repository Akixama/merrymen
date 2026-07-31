import { StyleSheet, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useLastOkAt, useTapeIds } from "@/store/selectors";
import { TapeRowView } from "@/ui/feed-ui";
import { useListBottomPad, useTopPad } from "@/ui/insets";
import { C, GUTTER } from "@/ui/tokens";

/**
 * The trade tape — every decision the agent made, newest first.
 *
 * This is the list that grows, and the one FlashList's prepend behaviour matters
 * for. Config choices, each deliberate:
 *
 *   maintainVisibleContentPosition stays ON (the v2 default). New trades arrive at
 *   the top, and without it the rows you are reading get pushed down under your
 *   thumb every few seconds. autoscrollToTopThreshold means it follows the feed
 *   only when you are already near the top — scroll down to read history and it
 *   leaves you alone.
 *
 *   A real keyExtractor, so a prepended row does not cause every row below it to
 *   be treated as changed.
 *
 * The tape is capped at ingest, not here. Trimming in the component still pays to
 * hold and diff the whole history.
 */
export default function Tape() {
  const topPad = useTopPad();
  const bottomPad = useListBottomPad();
  const ids = useTapeIds();
  const lastOkAt = useLastOkAt();

  return (
    <View style={styles.root}>
      <FlashList
        data={ids}
        keyExtractor={(id) => id}
        renderItem={({ item }) => <TapeRowView id={item} />}
        // Recycle like-for-like: a row with a receipt renders a hash, one without
        // renders a refusal reason, and the two measure differently.
        //
        // This used to test `id.length > 40`, which never split anything —
        // tradeId returns a 66-char tx_hash OR "<ISO timestamp>|kind|buy|sell|amt",
        // and an ISO timestamp alone is 24 characters, so BOTH branches cleared 40
        // and every row typed the same. The distinction the old comment described
        // was never actually made. `0x` is the real discriminator, because it is
        // precisely tradeId's "there is a tx_hash" branch.
        getItemType={(id) => (id.startsWith("0x") ? "receipt" : "no-receipt")}
        maintainVisibleContentPosition={{ autoscrollToTopThreshold: 80 }}
        contentContainerStyle={[styles.listPad, { paddingBottom: bottomPad }]}
        ListHeaderComponent={
          <View style={{ paddingTop: topPad, paddingBottom: 10 }}>
            <Text style={styles.title}>Tape</Text>
            <Text style={styles.lede}>Every decision, newest first — including the refused ones.</Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {lastOkAt === null
              ? "reading…"
              : "Nothing yet. Every decision lands here — including the ones the wall refused, which are usually the interesting ones."}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  listPad: { paddingHorizontal: GUTTER },
  // A page title, at the same rank as the Scoreboard's. It was previously
  // byte-identical to the Band's "POSITIONS" sub-heading — so the top-level label
  // on one tab carried exactly the weight of a third-level label on another.
  title: { color: C.text, fontSize: 30, fontWeight: "700", letterSpacing: -0.8 },
  lede: { color: C.dim, fontSize: 14, lineHeight: 20, marginTop: 6 },
  empty: { color: C.dim, fontSize: 13, lineHeight: 20, paddingVertical: 18 },
});
