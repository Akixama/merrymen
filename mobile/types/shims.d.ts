/**
 * The text-codec shim, imported by its exact file rather than its package name.
 *
 * It ships no types and no "types" field, and the deep path defeats any that a
 * bare specifier might have picked up. Declared as a side-effect module because
 * that is exactly how it is used: it assigns TextEncoder/TextDecoder onto the
 * global and exports nothing.
 *
 * See textCodecs.ts for why the deep path is mandatory.
 */
declare module "fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js";
