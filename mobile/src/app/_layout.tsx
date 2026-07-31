// FIRST IMPORT, ALWAYS. viem and ox build TextEncoder/TextDecoder at module scope
// and @noble/hashes snapshots globalThis.crypto on first evaluation, so anything
// that loads before this permanently misses the polyfills. Do not move it, and do
// not let an import sorter move it. See polyfills.ts for the full reasoning.
import '../../polyfills';

import { useEffect } from 'react';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useFeedPoller } from '@/net/poller';
import { warmCurve } from '@/crypto/warmup';
import { useOwnerGate } from '@/crypto/useOwnerGate';
import { PREVIEW } from '@/dev/preview';
import { C } from '@/ui/tokens';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
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
    // SafeAreaProvider must wrap everything, because useSafeAreaInsets reads from
    // its context — a screen calling it outside the provider gets zeros, which is
    // exactly the bug this whole change exists to fix, only silent.
    <SafeAreaProvider>
      {/* DarkTheme unconditionally, not by colorScheme. Every screen paints the
          dark palette regardless of system appearance, so following the system
          here only produced a light navigation container behind a dark app. The
          same reasoning sets userInterfaceStyle "dark" in app.json and pins the
          status bar below: this app has one appearance, and the chrome has to
          agree with it or the OS draws black glyphs on a near-black screen. */}
      <ThemeProvider value={DarkTheme}>
        <StatusBar style="light" />
        <AnimatedSplashOverlay />
        {/* A Stack at the root, with the tab bar as ONE of its screens. Settings,
            the probe, recovery and onboarding are pushed over the tabs rather than
            living inside them — which is what lets them exist without each needing
            a tab trigger. */}
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
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
    </SafeAreaProvider>
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
