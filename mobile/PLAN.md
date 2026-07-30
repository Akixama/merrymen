# merrymen mobile — native build plan

Expo SDK 56 · React Native 0.85.3 · React 19.2.3 · genuinely native, no webview.

Produced by parallel investigation of the four things that could each sink this
independently: the real SDK/RN/React pairing, viem + ZeroDev under Hermes, key
storage on iOS/Android, and the anti-jank architecture.

## What was independently re-verified before trusting this plan

| claim | result |
| --- | --- |
| `expo` latest is 57.0.9; SDK 56 resolves to 56.0.18 | confirmed — SDK 56 is one major behind |
| `react-native@0.85.3`, `react@19.2.3` exist | confirmed |
| `react-native-reanimated@4.3.1` peers `react-native: 0.81 - 0.85`, worklets `0.8.x` | confirmed — 0.85.3 is in range |
| `react-native-reanimated@4.5.0` peers `0.83 - 0.86`, worklets `0.10.x` | confirmed — do not mix the two |
| `@shopify/flash-list` 2.0.2 and 2.3.2 declare identical peers | confirmed |
| "three copies of `@noble/curves` in this repo" | **four**: 1.9.7 hoisted, 1.4.2 under ethereum-cryptography, 1.9.1 under ox, 1.9.1 under viem |

## The owner-key finding, stated precisely

The plan's decision #4 says the owner private key "leaves the device over HTTP".
Verified, and the exact reading matters:

- `web/src/lib/session.ts:332` puts `demoOwnerPrivateKey` on the grant object.
- `session.ts:339` POSTs **the whole grant object** to `/api/grants`.
- `/api/grants` writes it to `grant.json` at mode `0600`, and says so in a comment:
  *"grant.json holds the owner + session PRIVATE KEYS — owner-only perms (0600)."*

So it is deliberate and documented, not an accident, and on a self-hosted install
it is **not a leak** — the POST goes to localhost, i.e. the same machine, and
lands in a 0600 file in the owner's own home directory.

It becomes a catastrophic leak the instant that API is remote, which is exactly
the hosted product this app is for. Port `session.ts` unchanged into the native
client and the owner key is uploaded to our servers on first grant.

It is also not free to remove: `web/src/app/api/recover/route.ts` and
`worker/src/telegram/service.ts:246` both read `demoOwnerPrivateKey` to sweep
funds. Deleting the field breaks recovery. So hosted recovery cannot work the way
self-hosted recovery does — that is the same unresolved question as #83, arriving
from a second direction.

---

# 1. THE DECISION

**Stay on the user's trio exactly: Expo SDK `~56.0.18` · react-native `0.85.3` (exact) · react `19.2.3` (exact) · react-dom `19.2.3` (exact).**

Nothing differs from what was requested. I am overruling recon #4's push to SDK 57 / RN 0.86.2, for three reasons:

1. **The support-window argument in the recon is arithmetically wrong.** SDK 56 shipped 2026-05-21, SDK 57 shipped 2026-06-30. At a ~1-year rolling window that is **six weeks** of extra headroom, not "roughly a year" (recon #1's phrasing). Not worth invalidating verification work.
2. **The "Expo Go isn't on the App Store for SDK 56" cost is zero here.** This app needs a development build on day one regardless: `expo-secure-store` with `requireAuthentication` requires `NSFaceIDUsageDescription` via a config plugin, and `react-native-get-random-values` is a third-party native module. Expo Go was never on the table. That was recon #1's headline risk and it does not apply.
3. **The crypto layer — the only genuinely novel part of this app — was proven end-to-end against the SDK 56 tree.** Moving to 57 makes recon #2's global-surface enumeration stale (it was exhaustive for RN 0.85.3, not 0.86.2; only "TextDecoder still absent in Hermes 0.17" was re-checked). Zero upside, real re-verification cost.

I verified the SDK 56 native triple is internally coherent, which the recon did not: `react-native-reanimated@4.3.1` declares `peerDependencies: { "react-native": "0.81 - 0.85", "react-native-worklets": "0.8.x" }`. RN 0.85.3 + worklets 0.8.3 is inside that range. Reanimated 4.5.x declares `0.83 - 0.86` — do not mix.

**Nothing else from recon #4 changes.** Its architecture guidance (New Architecture is mandatory, FlashList v2, per-row store subscriptions, the 14 jank traps) is version-independent and applies identically on SDK 56. Its FlashList override is *also* needed on 56 — both SDKs pin the same stale `2.0.2`.

# 2. EXACT INSTALL COMMANDS

```bash
npx create-expo-app@latest mobile --template default@sdk-56
cd mobile

# --- pure JS, npm is correct here (not in Expo's bundled matrix) ---
npm i events@3.3.0 fastestsmallesttextencoderdecoder@1.0.22 \
      zustand@5.0.14 use-sync-external-store@1.5.0 \
      @noble/curves@1.9.7 \
      viem@2.55.0 \
      @zerodev/sdk@5.5.10 @zerodev/ecdsa-validator@5.4.9 @zerodev/permissions@5.6.3 \
      @tanstack/react-query@5.101.4

# --- native / Expo-pinned: MUST be `expo install`, never `npm i` ---
npx expo install expo-secure-store expo-local-authentication \
                 react-native-get-random-values react-native-svg \
                 @expo/vector-icons

# --- deliberate deviation from Expo's pin (see note) ---
npm i @shopify/flash-list@2.3.2

# --- optional insurance ---
npx expo install @craftzdog/react-native-buffer   # only if passkeys land later
npm i base-64@1.0.0                               # only if you ship a web/JSC target
```

`package.json` — these overrides are load-bearing, not hygiene:

```json
"overrides": {
  "react": "19.2.3",
  "react-dom": "19.2.3",
  "@noble/curves": "1.9.7",
  "@shopify/flash-list": "2.3.2"
}
```

- `react` exact + override: RN's embedded renderer does a literal `"19.2.3" !== isomorphicReactPackageVersion` check and throws at launch, while its peer range `^19.2.3` permits drift. This is a crash, not a warning.
- `@noble/curves` override: verified three copies in this repo (1.9.7 hoisted, 1.9.1 nested under `viem` and `ox`). Three copies = three separate wNAF precompute tables = the ~47 ms cold cost paid three times, plus triple the EC code in the bundle.
- `@shopify/flash-list@2.3.2` over Expo's `2.0.2`: I checked the peer ranges — `2.3.2` declares `{react:"*", react-native:"*", @babel/runtime:"*"}`, identical to `2.0.2`, and v2 has no native module, so there is no prebuilt-binary risk on RN 0.85.3. Expo's `2.0.2` predates every prepend/scroll-position fix the trade tape depends on (2.2.3 prepend jitter, 2.3.0 `inverted`, 2.3.1 maintain-position-on-prepend, 2.3.2 the Android `removeClippedSubviews` crash). `npx expo-doctor` will flag exactly one version mismatch — accept it.

`@expo/vector-icons` is explicit because SDK 56 dropped it from the `expo` package's dependencies (verified by registry diff against expo@55).

`app.json`: add `"experiments": { "reactCompiler": true }`. FlashList v2's docs require memoized props; the compiler enforces that mechanically instead of by discipline.

`metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
const base = config.resolver.resolveRequest;
config.resolver.resolveRequest = (ctx, moduleName, platform) => {
  // @zerodev/permissions' barrel re-exports serializeMultiChainPermissionAccounts,
  // which drags in merkletreejs -> require('buffer') and crypto-js -> require('crypto')
  // and web3-utils. We only ever sign SINGLE-CHAIN grants, so stub it.
  // NOTE: this makes serializeMultiChainPermissionAccounts throw at runtime.
  // If merrymen ever adds multi-chain grants, DELETE THIS and add buffer + crypto shims.
  if (moduleName === 'merkletreejs') return { type: 'empty' };
  return (base ?? ctx.resolveRequest)(ctx, moduleName, platform);
};
module.exports = config;
```

Do **not** install `node-libs-react-native`, `crypto-browserify`, `readable-stream`, or `stream-browserify`. viem 2.55 pulls zero Node-core modules; that advice is legacy from viem ~2.9 / RN 0.73 and costs hundreds of KB.

# 3. THE POLYFILL ENTRY FILE, VERBATIM

`mobile/polyfills.ts` — order is load-bearing. `@noble/hashes/esm/crypto.js` is one line that snapshots `globalThis.crypto` into a module-level const at evaluation time, so a polyfill installed after the first `import 'viem'` anywhere in the graph is permanently invisible. And `viem`/`ox` construct `new TextEncoder()` / `new TextDecoder()` at module top level, so `import 'viem'` itself throws if they are absent.

```ts
// polyfills.ts
// MUST be the first import of app/_layout.tsx, above every other import.
// Order below is load-bearing — do not reorder, do not let a formatter sort it.

// 1. TextDecoder. Hermes 0.16 (RN 0.85.3) ships TextEncoder, atob and btoa as engine
//    intrinsics but has NO TextDecoder (verified: lib/VM/JSLib/TextDecoder.cpp does not
//    exist at hermes-v0.16.0 or v0.17.0). viem and ox construct encoders AND decoders at
//    module-evaluation time, so this must load before any import of viem/ox/@zerodev.
import 'fastestsmallesttextencoderdecoder';

// 2. crypto.getRandomValues. RN installs no `crypto` global at all. This must come before
//    viem because @noble/hashes/esm/crypto.js snapshots globalThis.crypto into a
//    module-level const on first evaluation and never re-reads it.
//    Needed for KEY GENERATION only — signing is deterministic RFC-6979 and needs no entropy.
import 'react-native-get-random-values';

// 3. btoa/atob. Native in Hermes 0.16+, so this branch is dead on-device; it exists so a
//    JSC or web target does not fail at grant-serialization time.
//    (@zerodev/permissions/_esm/utils.js:8 calls btoa on the serialize path.)
if (typeof globalThis.btoa !== 'function') {
  const b64 = require('base-64');
  globalThis.btoa = b64.encode;
  globalThis.atob = b64.decode;
}

// 4. Fail loudly at startup instead of at grant time if any of the above regresses.
for (const k of ['TextEncoder', 'TextDecoder', 'btoa', 'atob'] as const) {
  if (typeof (globalThis as any)[k] !== 'function') {
    throw new Error(`polyfills.ts: missing global ${k}`);
  }
}
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  throw new Error('polyfills.ts: missing crypto.getRandomValues');
}

export {};
```

The secp256k1 wNAF warm-up is deliberately **not** in this file — importing `@noble/curves` here would put a heavy module evaluation inside the polyfill file where import ordering is already delicate. It lives in `src/crypto/warmup.ts` and is called from a `useEffect` in the root layout:

```ts
// src/crypto/warmup.ts
import { secp256k1 } from '@noble/curves/secp256k1';
// noble builds a wNAF precompute table for the base point on first scalar multiplication.
// Measured 47ms cold vs 0.61ms warm on desktop V8; expect ~0.5-1.5s on a mid-range phone
// under Hermes (no JIT, BigInt via C++ runtime calls). Keep it off the button-press path.
export function warmCurve() {
  setTimeout(() => { try { secp256k1.utils.precompute(8); } catch {} }, 0);
}
```

# 4. FILE / FOLDER PLAN

```
mobile/
  app.json                        experiments.reactCompiler:true; NSFaceIDUsageDescription
  metro.config.js                 merkletreejs stub (above)
  polyfills.ts                    verbatim above
  eas.json                        development + preview(release) profiles
  app/
    _layout.tsx                   import '../polyfills' AS LINE 1, then warmCurve(),
                                  then <QueryClientProvider> + <GestureHandlerRootView>
    index.tsx                     gate: no key -> /onboarding, key but no grant -> /onboarding/grant,
                                  key invalidated (sentinel present + read null) -> /recover
    onboarding/
      index.tsx                   generate or import owner key
      backup.tsx                  MANDATORY BIP-39 show + verify-quiz. Non-skippable.
      grant.tsx                   PERMISSION WALL: renders the policy set (call/rate-limit/
                                  timestamp) in plain language, then GRANT SIGNING on confirm
    recover.tsx                   "your device key was invalidated" -> restore from mnemonic
    (tabs)/
      _layout.tsx                 expo-router Tabs (native screens, lazy in prod)
      index.tsx                   LIVE BAND: equity figure + sparkline + positions FlashList
      tape.tsx                    TRADE TAPE: inverted FlashList, getItemType by kind
      settings.tsx                revoke grant, rotate session key, RPC, view policies
  src/
    store/
      feedStore.ts                vanilla zustand createStore (NOT React state)
      ingest.ts                   identity-preserving diff; normalize to
                                  { positions: Record<sym,Row>, tapeIds: string[], tape: Record<id,Trade> };
                                  cap tape at 300 AT INGEST
      selectors.ts                per-field selectors; useShallow for object/array returns
    net/
      poller.ts                   ONE interval over /api/feed, gated on AppState==='active'
                                  && useIsFocused, handler wrapped in useEffectEvent
      api.ts                      typed client mirroring web/src/app/api/feed/route.ts
                                  (FeedEvent | EquityPoint | PositionRow | TradeRecord | AgentFinancials)
      queryClient.ts              react-query for COLD endpoints ONLY (grants, scoreboard, settings)
    crypto/
      keystore.ts                 expo-secure-store wrapper + non-authenticated SENTINEL flag
                                  so "key invalidated" is distinguishable from "first run"
      mnemonic.ts                 BIP-39 generate / verify / restore
      session.ts                  port of web/src/lib/session.ts — MUST drop demoOwnerPrivateKey
      warmup.ts                   above
    ui/
      EquityBand.tsx              plain React leaf; fontVariant:['tabular-nums']
      Sparkline.tsx               react-native-svg <Path> over a memoized series
      PositionRow.tsx             subscribes to its OWN slice: useStore(store, s=>s.positions[id])
      TapeRow.tsx                 useRecyclingState, never useState
      FlashPrice.tsx              reanimated shared value, RESET in useEffect keyed on item.id
      PolicyRow.tsx               one policy line on the permission wall
    theme/tokens.ts
```

Two list configs that are not optional:
- **Positions table** (re-sorts by % change): `maintainVisibleContentPosition={{ disabled: true }}`. It is ON by default in v2 and its documented known issue is that data re-ordering makes rows visibly jump.
- **Tape** (prepends): keep MVCP ON with `autoscrollToTopThreshold`, supply a real `keyExtractor`, raise `drawDistance`, `getItemType={t => t.kind}`. Never re-enable `removeClippedSubviews`.

# 5. TOP THREE RISKS — CHEAPEST DISPROOF FIRST

**Risk 1 — the polyfill/shim set is incomplete and Metro won't resolve the bundle.**
Recon #2's module-graph walk was a *static emulation* of Metro: it honored exports conditions and main fields but not platform extensions (`.ios.js`/`.native.js`), Haste, or blockList. So "viem pulls zero node-core; `events` + `merkletreejs` are the only two problems" is an inference, not a build result.
**Disproof (~10 min, no device, no Xcode, no Android SDK):**
```bash
npx expo export --platform ios --platform android
```
This runs the real Metro resolver over the real graph. Every `Unable to resolve module X` surfaces here. Do this **before writing any UI**, with a single throwaway file that imports the four `@zerodev` barrels and calls the grant flow, so the graph is fully exercised. If it exports clean, the shim set is final.

**Risk 2 — the owner key is silently and permanently destroyed by an ordinary Settings action.**
`expo-secure-store` with `requireAuthentication: true` opts into biometric-set invalidation on both platforms (iOS `kSecAccessControlBiometryCurrentSet`; Android's `setInvalidatedByBiometricEnrollment` defaults to true and the module never overrides it). Worse, Android *catches* `KeyPermanentlyInvalidatedException` and **returns null**, indistinguishable from "nothing was stored" — so a naive app generates a fresh key and strands the funded account.
**Disproof (~20 min, needs one physical Android device + a dev build):** scratch screen that writes a value with `requireAuthentication:true`, reads it back OK, then you add a fingerprint in Android Settings and read again. Expect `null`, not a throw. Same test on iOS by re-enrolling Face ID. This is a *confirmation* run, not an exploration — the source says it will fail, and you are proving your sentinel + recovery path handles it.

**Risk 3 — Hermes is too slow on the grant path, or the wNAF cold cost blocks the first interaction.**
Every perf number in the recon was measured on **desktop V8**, not Hermes (0.65 ms/sign, 47 ms cold precompute). The "10-30× on Hermes" multiplier is an inference from Hermes being a non-JIT interpreter with C++-backed BigInt. Unproven.
**Disproof (~1 hr, needs a release build on the cheapest target Android):**
```bash
npx expo run:android --variant release
```
Instrument `performance.now()` around each step of `generatePrivateKey → signerToEcdsaValidator → toECDSASigner → toPermissionValidator → createKernelAccount → serializePermissionAccount`. Measure with and without `warmCurve()`. **Never profile in dev mode** — FlashList is deliberately slower in dev (much smaller window), so a dev-mode reading will send you chasing phantom problems. Same run: assert the derived `smartAccount` address matches what the same owner key produces on the web app. That single equality check proves the polyfilled crypto is byte-identical.

# 6. DECIDE BEFORE ANY CODE IS WRITTEN

1. **Does the owner key stay secp256k1, or does the device signer become P-256?** This determines whether `src/crypto/` is a port or a new native module. Raw secp256k1 can *never* be hardware-non-exportable — Apple's Secure Enclave is P-256 only and Android's KeyMint `EcCurve` enum has no secp256k1 wire representation at all. My recommendation: **ship Phase 1 on secp256k1** (it is what the ZeroDev flow was verified against) and treat P-256/passkey as Phase 2, gated on question 2.
2. **Does Robinhood Chain include the EIP-7951 `P256VERIFY` precompile at `0x100`?** Unverified by any recon. Cheap check: `eth_call` to `0x100` with a known-good P-256 vector against the chain's RPC. If absent, the P-256 path costs a ~200-330k-gas Solidity verifier per signature instead of 6900, which likely kills it.
3. **`requireAuthentication: true` or `false` on the stored key?** `true` gives a real cryptographic biometric gate but adds the silent-destruction path. `false` + `WHEN_UNLOCKED_THIS_DEVICE_ONLY` + an `expo-local-authentication` UX gate survives biometric re-enrollment but the gate is bypassable by anything with JS execution. **Either way, a mandatory verified BIP-39 backup at onboarding is non-negotiable** — it is what makes key loss recoverable rather than terminal. Decide whether onboarding is allowed to be that long.
4. **Confirm the fix to the owner-key leak.** `web/src/lib/session.ts` currently keeps `demoOwnerPrivateKey` in localStorage and echoes it into the JSON posted to `/api/grants`. If that shape is ported unchanged, the owner key leaves the device over HTTP and the core product promise is false. This is a code change, not a storage swap — confirm the worker's `/api/grants` contract can accept a grant *without* that field before the native client is written.
5. **Does the native app own a mnemonic, or is the on-device key an account it can't recover?** Follows from 1 and 3, but it changes the onboarding screen count and the `recover.tsx` route's existence.

**Build order:** scaffold SDK 56 → `expo export` smoke test of the crypto graph (Risk 1) → store + poller + ingest diffing against mock data → one FlashList (the tape) with per-row subscriptions → **verify in a release build on a mid-range Android** → grant signing + permission wall → the other panels → Reanimated polish last. Getting the store/diff layer right before any list exists is what makes this not lag; retrofitting it means rewriting every component.