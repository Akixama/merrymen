import { secp256k1 } from "@noble/curves/secp256k1";

/**
 * Pre-build the secp256k1 wNAF table so the first signature isn't the slow one.
 *
 * noble lazily builds a precompute table for the curve's base point on the first
 * scalar multiplication. Measured on desktop V8 that is ~47 ms cold against
 * ~0.6 ms warm; under Hermes, which has no JIT and reaches into C++ for BigInt,
 * expect it to be considerably worse. Whatever the real number turns out to be on
 * device, it should not be paid while a user is watching a button.
 *
 * Deliberately NOT imported from polyfills.ts: that file's import order is already
 * delicate, and putting a heavy module evaluation inside it invites someone to
 * "tidy" the imports and break entropy or TextDecoder as a side effect.
 *
 * setTimeout(0) rather than a bare call so it lands after the first paint, and the
 * try/catch is because a slow warm-up must never be the thing that stops the app
 * from starting — a cold curve is a performance problem, a throw is a dead app.
 */
export function warmCurve(): void {
  setTimeout(() => {
    try {
      secp256k1.utils.precompute(8);
    } catch {
      /* warm-up is best-effort by design */
    }
  }, 0);
}
