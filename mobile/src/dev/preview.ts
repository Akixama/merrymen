/**
 * A way to LOOK at the app without a phone — and nothing more than that.
 *
 * Every screen past onboarding is behind the owner-key gate, and the gate is
 * correct: expo-secure-store's web build is literally `export default {}`, so a
 * browser genuinely has nowhere safe to put a key. That makes the design of the
 * band, tape and scoreboard unreviewable on any machine without a simulator.
 *
 * So this opens the gate for inspection, and is built so it cannot become
 * anything else:
 *
 *   IT NEVER FAKES A KEYSTORE. The tempting shortcut is a localStorage-backed
 *   SecureStore shim on web, which would make onboarding "work" — and would put a
 *   mnemonic in plain localStorage, readable by any script on the origin. A
 *   shortcut that stores a real key insecurely is the one bug in this app that
 *   loses money. Preview mode skips the gate instead, so `readOwner()` still
 *   reports "empty" and anything that needs to SIGN still fails, loudly.
 *
 *   IT IS DOUBLE-GATED. The env flag is only honoured when `__DEV__` is true, so
 *   setting EXPO_PUBLIC_PREVIEW in a release build does nothing at all. Metro
 *   inlines both, so a production bundle constant-folds this to `false` and drops
 *   the branch entirely.
 *
 * Usage: EXPO_PUBLIC_PREVIEW=1 npx expo start --web
 */
export const PREVIEW = __DEV__ && process.env.EXPO_PUBLIC_PREVIEW === "1";
