import { Tabs, TabList, TabTrigger, TabSlot, TabTriggerSlotProps, TabListProps } from 'expo-router/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { C } from '@/ui/tokens';

/**
 * The tab bar for the web target, which exists only so the app can be LOOKED at
 * on a machine with no simulator. Native uses app-tabs.tsx and real NativeTabs.
 *
 * It mirrors the native bar deliberately — same three destinations, same order,
 * same words, bottom-anchored — because its whole job is to make a browser
 * preview representative of the phone. A different-looking web shell would mean
 * every design judgement made here had to be re-made on a device.
 */
export default function AppTabs() {
  return (
    <Tabs>
      <TabSlot style={styles.slot} />
      <TabList asChild>
        <BottomBar>
          <TabTrigger name="index" href="/" asChild>
            <TabButton>Band</TabButton>
          </TabTrigger>
          <TabTrigger name="tape" href="/tape" asChild>
            <TabButton>Tape</TabButton>
          </TabTrigger>
          <TabTrigger name="scoreboard" href="/scoreboard" asChild>
            <TabButton>Record</TabButton>
          </TabTrigger>
        </BottomBar>
      </TabList>
    </Tabs>
  );
}

function TabButton({ children, isFocused, ...props }: TabTriggerSlotProps) {
  return (
    <Pressable {...props} style={styles.tab}>
      <Text style={[styles.label, isFocused && styles.labelActive]}>{children}</Text>
      {/* An underline rather than a filled pill: at this size a pill crowds three
          words into a bar that also has to clear the home indicator. */}
      <View style={[styles.rule, isFocused && styles.ruleActive]} />
    </Pressable>
  );
}

function BottomBar(props: TabListProps) {
  // flex: 1 on each tab and no minimum width — the earlier version sized itself
  // from its content and pushed the page to 409px inside a 375px viewport, which
  // is the one layout bug a phone-shaped app cannot have.
  return <View {...props} style={styles.bar} />;
}

const styles = StyleSheet.create({
  slot: { height: '100%' },
  bar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    backgroundColor: C.bg1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    paddingBottom: 10,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: 10, gap: 6 },
  label: { color: C.faint, fontSize: 12, fontWeight: '600', letterSpacing: 0.3 },
  labelActive: { color: C.text },
  rule: { height: 2, width: 18, borderRadius: 1, backgroundColor: 'transparent' },
  ruleActive: { backgroundColor: C.green },
});
