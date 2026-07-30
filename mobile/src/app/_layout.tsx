// FIRST IMPORT, ALWAYS. viem and ox build TextEncoder/TextDecoder at module scope
// and @noble/hashes snapshots globalThis.crypto on first evaluation, so anything
// that loads before this permanently misses the polyfills. Do not move it, and do
// not let an import sorter move it. See polyfills.ts for the full reasoning.
import '../../polyfills';

import { useEffect } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { useFeedPoller } from '@/net/poller';
import { warmCurve } from '@/crypto/warmup';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  const colorScheme = useColorScheme();

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
      <AppTabs />
    </ThemeProvider>
  );
}
