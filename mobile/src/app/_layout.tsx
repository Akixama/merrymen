// FIRST IMPORT, ALWAYS. viem and ox build TextEncoder/TextDecoder at module scope
// and @noble/hashes snapshots globalThis.crypto on first evaluation, so anything
// that loads before this permanently misses the polyfills. Do not move it, and do
// not let an import sorter move it. See polyfills.ts for the full reasoning.
import '../../polyfills';

import { useEffect } from 'react';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useFeedPoller } from '@/net/poller';
import { warmCurve } from '@/crypto/warmup';
import { useOwnerGate } from '@/crypto/useOwnerGate';
import { PREVIEW } from '@/dev/preview';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // Route by key state before anything else matters: no key -> onboarding, key
  // destroyed by the OS -> recovery (never onboarding, which would generate a new
  // key over a funded account).
  useOwnerGate();

  // ONE poller for the whole app, mounted here so it exists exactly once. Screens
  // read the store and never fetch — two screens each running the same hook would
  // mean two intervals pulling the same payload.
  useFeedPoller();

  // Build the secp256k1 precompute table off the critical path, so the first
  // signature isn't the slow one. Fire-and-forget by design: a cold curve is a
  // performance problem, but a throw here would be a dead app.
  useEffect(() => {
    warmCurve();
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      {/* A Stack at the root, with the tab bar as ONE of its screens. Settings,
          the probe, recovery and onboarding are pushed over the tabs rather than
          living inside them — which is what lets them exist without each needing
          a tab trigger. */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0d1512' } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="settings" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="chat" options={{ presentation: 'modal' }} />
        <Stack.Screen name="probe" options={{ presentation: 'modal' }} />
        {/* Recovery is not dismissable by gesture: it is reached only when the key
            is already gone, and swiping past it lands on a dashboard that cannot
            work. */}
        <Stack.Screen name="recover" options={{ gestureEnabled: false }} />
        <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
      </Stack>
      {/* Loud on purpose. A preview session has no key, so every screen it shows
          is chrome over nothing — it must never be mistaken for a working app. */}
      {PREVIEW && (
        <View style={styles.previewBar} pointerEvents="none">
          <Text style={styles.previewText}>PREVIEW — no key, nothing can sign</Text>
        </View>
      )}
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  previewBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#7a3b12',
    paddingTop: 2,
    paddingBottom: 3,
    alignItems: 'center',
  },
  previewText: { color: '#ffd9b0', fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
});
