import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import type { HDAccount } from "viem";

/**
 * BIP-39 helpers, straight from viem — no extra dependency.
 *
 * The mnemonic IS the owner key here. Deriving the account from a phrase rather
 * than storing raw key bytes is what makes the key writable-down, and therefore
 * recoverable when a phone is lost, factory reset, or has its biometrics
 * re-enrolled. A raw key in the keychain and nowhere else is a key that dies with
 * the device — and per worker/src/recover.ts the owner key is the ONLY thing that
 * can sweep a smart account, so that death is permanent and takes the funds.
 */

/** 12 words. 128 bits of entropy, the standard everyone's backup habits assume. */
export function newMnemonic(): string {
  return generateMnemonic(english);
}

export function accountFromMnemonic(mnemonic: string): HDAccount {
  return mnemonicToAccount(mnemonic);
}

const WORDS = new Set(english);

/**
 * Validate a phrase the owner typed, and say WHICH word is wrong.
 *
 * "invalid recovery phrase" is a terrible message for someone restoring access to
 * their own money — it gives them nothing to correct. Naming the offending word,
 * and separating "not a BIP-39 word" from "checksum failed", turns a dead end into
 * a fixable typo. The checksum case specifically means every word is real but the
 * ORDER or one substitution is wrong, which is worth saying out loud.
 */
export function validateMnemonic(input: string): { ok: true; mnemonic: string } | { ok: false; reason: string } {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { ok: false, reason: "Enter your recovery phrase." };
  if (words.length !== 12 && words.length !== 24) {
    return { ok: false, reason: `A recovery phrase is 12 or 24 words — you entered ${words.length}.` };
  }
  const bad = words.find((w) => !WORDS.has(w));
  if (bad) return { ok: false, reason: `"${bad}" isn't a valid recovery word. Check the spelling.` };

  const mnemonic = words.join(" ");
  try {
    mnemonicToAccount(mnemonic);
  } catch {
    // Every word is real, so this is order or a single substitution — not spelling.
    return { ok: false, reason: "Those are all real words, but the phrase doesn't check out. Check the order." };
  }
  return { ok: true, mnemonic };
}

/**
 * Pick N distinct word positions to quiz on, and three decoys for each.
 *
 * The quiz is what turns "we showed you a phrase" into "you have actually got it
 * written down". Decoys come from the real wordlist and never include the correct
 * answer twice, because a quiz that can be passed by pattern-matching teaches the
 * owner nothing and gives us false confidence about their backup.
 */
export function buildQuiz(mnemonic: string, count = 3): { index: number; answer: string; options: string[] }[] {
  const words = mnemonic.split(" ");
  const picked = new Set<number>();
  while (picked.size < Math.min(count, words.length)) {
    picked.add(Math.floor(Math.random() * words.length));
  }
  return [...picked]
    .sort((a, b) => a - b)
    .map((index) => {
      const answer = words[index];
      const options = new Set<string>([answer]);
      while (options.size < 4) {
        const candidate = english[Math.floor(Math.random() * english.length)];
        if (candidate !== answer) options.add(candidate);
      }
      // Shuffle so the answer isn't always first.
      const shuffled = [...options].sort(() => Math.random() - 0.5);
      return { index, answer, options: shuffled };
    });
}
