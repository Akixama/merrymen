// polyfills.ts
//
// MUST be the first import of src/app/_layout.tsx, above every other import.
// The order below is load-bearing — do not reorder it, and do not let a formatter
// sort these imports. Two specific reasons, both of which fail at runtime rather
// than at build time, which is what makes them dangerous:
//
//   - viem and ox construct `new TextEncoder()` / `new TextDecoder()` at MODULE
//     scope. So `import 'viem'` itself throws if those globals are absent — there
//     is no lazy path that would let a later polyfill rescue it.
//
//   - @noble/hashes snapshots `globalThis.crypto` into a module-level const on
//     first evaluation and never re-reads it. A getRandomValues polyfill
//     installed after the first viem import anywhere in the graph is therefore
//     permanently invisible, and key generation silently gets no entropy.

// 1. TextDecoder. Hermes ships TextEncoder, atob and btoa as engine intrinsics but
//    has NO TextDecoder — verified absent at hermes v0.16.0 and v0.17.0 (RN 0.86.2,
//    our target, is Hermes 0.17). This must load before any import of
//    viem / ox / @zerodev.
import "fastestsmallesttextencoderdecoder";

// 2. crypto.getRandomValues. React Native installs no `crypto` global at all.
//    Needed for KEY GENERATION only — ECDSA signing here is deterministic
//    (RFC-6979) and consumes no entropy.
import "react-native-get-random-values";

// 3. btoa / atob. Native in Hermes, so this branch is dead on-device; it exists so
//    a JSC or web target does not fail on the grant-serialization path, where
//    @zerodev/permissions calls btoa. `base-64` is installed rather than left as a
//    bare require inside a dead branch: Metro resolves require() statically, so an
//    uninstalled module fails the BUILD even on a code path that never runs.
if (typeof globalThis.btoa !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const b64 = require("base-64");
  globalThis.btoa = b64.encode;
  globalThis.atob = b64.decode;
}

// 4. Fail loudly at startup rather than at grant time if any of the above ever
//    regresses. A missing global surfaces here as one obvious crash on launch,
//    instead of as a mysterious failure the first time a user signs something.
for (const k of ["TextEncoder", "TextDecoder", "btoa", "atob"] as const) {
  if (typeof (globalThis as Record<string, unknown>)[k] !== "function") {
    throw new Error(`polyfills.ts: missing global ${k}`);
  }
}
if (typeof globalThis.crypto?.getRandomValues !== "function") {
  throw new Error("polyfills.ts: missing crypto.getRandomValues");
}

export {};
