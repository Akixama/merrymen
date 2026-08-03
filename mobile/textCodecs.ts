/**
 * TextEncoder / TextDecoder installation, split out of polyfills.ts for ONE
 * reason: polyfills.ts imports react-native-get-random-values, which pulls in
 * react-native itself, which is Flow-typed and unparseable by a node test
 * runner. This logic has no React Native dependency, so keeping it here is what
 * makes it testable at all — and it is the logic that most needs a test, because
 * the environment it protects against cannot be reproduced in a browser.
 *
 * THE BUG. Hermes ships TextEncoder, atob and btoa as engine intrinsics but has
 * NO TextDecoder — verified absent at hermes v0.16.0 and v0.17.0 (RN 0.86.2, our
 * target, is Hermes 0.17). And the shim we use self-disables in exactly that
 * situation. The last statement of EncoderDecoderTogether.min.js is:
 *
 *     E || (r.TextDecoder = x, r.TextEncoder = y)
 *
 * where `E` is the environment's PRE-EXISTING TextEncoder, captured at the top
 * of that file. It is all-or-nothing, gated on TextEncoder. So on Hermes, `E` is
 * truthy and the shim installs NEITHER — leaving TextDecoder undefined, which
 * polyfills.ts then throws on. A browser has both natively, so the whole failure
 * is invisible on web. 0.1.0 shipped that way and died on launch on every
 * Android device while every screenshot looked perfect.
 *
 * So: hide TextEncoder to make `E` falsy, let the shim install both, then put
 * the engine's own TextEncoder back.
 *
 * The deep import path is deliberate. The package's "main" is the NodeJS build,
 * whose module scope reads `n.allocUnsafe` off an undefined Buffer OUTSIDE its
 * try/catch — fatal under Hermes. Expo's metro config sets resolverMainFields to
 * ['react-native','browser','main'], so "browser" wins today and that build is
 * never reached; naming the file keeps it that way if the order ever changes.
 */
/**
 * Operates on globalThis and takes no target parameter, ON PURPOSE.
 *
 * The shim resolves its own global (`""+void 0 == typeof global ? … : global`)
 * and assigns there. Passing it an object to populate does nothing — an earlier
 * version of this function took one, and the test that "proved" it worked only
 * ever passed because the other assertions were weaker. A parameter that the
 * dependency ignores is a lie in the signature.
 */
export function installTextCodecs(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.TextDecoder === "function") return;

  const nativeEncoder = g.TextEncoder;
  try {
    delete g.TextEncoder;
  } catch {
    /* A non-configurable intrinsic. The require below then installs nothing and
       polyfills.ts's assertion turns that into one loud error on launch, rather
       than a mystery the first time someone signs. */
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js");

  if (typeof nativeEncoder === "function" && typeof g.TextEncoder !== "function") {
    g.TextEncoder = nativeEncoder;
  }
}
