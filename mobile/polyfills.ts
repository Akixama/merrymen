// polyfills.ts
//
// MUST be the first import of src/app/_layout.tsx, above every other import.
// What this file installs is load-bearing, and every failure here is a RUNTIME
// one — nothing below fails a build, which is what makes it dangerous:
//
//   - viem and ox construct `new TextEncoder()` / `new TextDecoder()` at MODULE
//     scope. So `import 'viem'` itself throws if those globals are absent — there
//     is no lazy path that would let a later polyfill rescue it.
//
//   - @noble/hashes snapshots `globalThis.crypto` into a module-level const on
//     first evaluation and never re-reads it. A getRandomValues polyfill
//     installed after the first viem import anywhere in the graph is therefore
//     permanently invisible, and key generation silently gets no entropy.
//
// READ THE ORDER AS WRITTEN. The one `import` below is hoisted above the
// statements regardless of where it sits, so it is placed first to match. The
// text codecs are installed with `require` inside a function precisely so their
// timing is controllable rather than hoisted — see installTextCodecs.

// crypto.getRandomValues. React Native installs no `crypto` global at all.
// Needed for KEY GENERATION only — ECDSA signing here is deterministic
// (RFC-6979) and consumes no entropy. Independent of the codecs below.
import "react-native-get-random-values";
import { installTextCodecs } from "./textCodecs";

// TextEncoder / TextDecoder. The whole reason this is a function call and not a
// bare import lives in textCodecs.ts — read it before touching this line. Short
// version: the shim self-disables on Hermes, which is how 0.1.0 shipped a build
// that crashed on launch on every Android device and was perfect on web.
installTextCodecs();

// btoa / atob. Native in Hermes, so this branch is dead on-device; it exists so
// a JSC or web target does not fail on the grant-serialization path, where
// @zerodev/permissions calls btoa. `base-64` is installed rather than left as a
// bare require inside a dead branch: Metro resolves require() statically, so an
// uninstalled module fails the BUILD even on a code path that never runs.
if (typeof globalThis.btoa !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const b64 = require("base-64");
  globalThis.btoa = b64.encode;
  globalThis.atob = b64.decode;
}

// Fail loudly at startup rather than at grant time if any of the above ever
// regresses. A missing global surfaces here as one obvious crash on launch,
// instead of as a mysterious failure the first time a user signs something.
//
// This is not theoretical: 0.1.0 shipped with TextDecoder missing and every
// Android install died right here, on this line, before any app code ran.
for (const k of ["TextEncoder", "TextDecoder", "btoa", "atob"] as const) {
  if (typeof (globalThis as Record<string, unknown>)[k] !== "function") {
    throw new Error(`polyfills.ts: missing global ${k}`);
  }
}
if (typeof globalThis.crypto?.getRandomValues !== "function") {
  throw new Error("polyfills.ts: missing crypto.getRandomValues");
}
