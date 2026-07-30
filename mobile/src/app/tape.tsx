import { StyleSheet, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useLastOkAt, useTapeIds } from "@/store/selectors";
import { TapeRowView } from "@/ui/feed-ui";
import { C } from "@/ui/tokens";

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
 *   getItemType by status, so FlashList recycles a "landed" row into another
 *   "landed" row rather than reshaping one that had different content.
 *
 * The tape is capped at ingest, not here. Trimming in the component still pays to
 * hold and diff the whole history.
 */
export default function Tape() {
  const ids = useTapeIds();
  const lastOkAt = useLastOkAt();

  return (
    <View style={styles.root}>
      <FlashList
        data={ids}
        keyExtractor={(id) => id}
        renderItem={({ item }) => <TapeRowView id={item} />}
        // Recycle like-for-like. A rejected row and a landed row have different
        // shapes, so letting FlashList reuse one as the other costs a re-layout.
        getItemType={(id) => id.length > 40 ? "onchain" : "offchain"}
        maintainVisibleContentPosition={{ autoscrollToTopThreshold: 80 }}
        contentContainerStyle={styles.listPad}
        ListHeaderComponent={<Text style={styles.title}>trade tape</Text>}
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
  listPad: { paddingHorizontal: 20, paddingBottom: 40 },
  title: {
    color: C.dim,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1.4,
    paddingTop: 20,
    paddingBottom: 8,
  },
  empty: { color: C.dim, fontSize: 13, lineHeight: 20, paddingVertical: 18 },
});
