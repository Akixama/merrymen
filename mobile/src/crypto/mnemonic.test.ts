import { describe, expect, it } from "vitest";
import { accountFromMnemonic, buildQuiz, newMnemonic, validateMnemonic } from "./mnemonic";

/**
 * The recovery phrase is the only route back to a funded account, so these tests
 * are about a person locked out of their own money at the worst moment. The
 * validator has to be right AND it has to say something useful when it says no —
 * "invalid recovery phrase" gives someone staring at a piece of paper nothing to
 * act on.
 */

describe("newMnemonic", () => {
  it("produces a valid 12-word phrase that derives an address", () => {
    const m = newMnemonic();
    expect(m.split(" ")).toHaveLength(12);
    expect(validateMnemonic(m).ok).toBe(true);
    expect(accountFromMnemonic(m).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("is deterministic in the direction that matters — same phrase, same address", () => {
    // If this ever stopped holding, a correct recovery phrase would restore the
    // wrong account and the funds would look gone.
    const m = newMnemonic();
    expect(accountFromMnemonic(m).address).toBe(accountFromMnemonic(m).address);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 20 }, () => newMnemonic()));
    expect(seen.size).toBe(20);
  });
});

describe("validateMnemonic", () => {
  it("accepts a valid phrase and normalises whitespace and case", () => {
    const m = newMnemonic();
    const messy = `  ${m.toUpperCase().split(" ").join("   ")}  `;
    const res = validateMnemonic(messy);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mnemonic).toBe(m);
  });

  it("names the word that isn't in the list", () => {
    const m = newMnemonic().split(" ");
    m[4] = "zznotaword";
    const res = validateMnemonic(m.join(" "));
    expect(res.ok).toBe(false);
    // Someone re-reading their paper needs to know WHICH word to look at.
    if (!res.ok) expect(res.reason).toContain("zznotaword");
  });

  it("distinguishes a bad checksum from a misspelling", () => {
    // Every word is real but the phrase doesn't check out — that means order or a
    // substitution, not spelling, and saying so points at the right fix.
    const words = newMnemonic().split(" ");
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    const res = validateMnemonic(swapped.join(" "));
    if (!res.ok) {
      expect(res.reason).toMatch(/order/i);
      expect(res.reason).not.toMatch(/spelling/i);
    }
  });

  it("rejects the wrong number of words and says how many were given", () => {
    const res = validateMnemonic("abandon abandon abandon");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("3");
  });

  it("rejects empty input without pretending it's a word problem", () => {
    const res = validateMnemonic("   ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/enter/i);
  });
});

describe("buildQuiz", () => {
  it("asks about distinct positions, with the right answer present", () => {
    const m = newMnemonic();
    const words = m.split(" ");
    const quiz = buildQuiz(m, 3);

    expect(quiz).toHaveLength(3);
    expect(new Set(quiz.map((q) => q.index)).size).toBe(3);
    for (const q of quiz) {
      expect(q.answer).toBe(words[q.index]);
      expect(q.options).toContain(q.answer);
    }
  });

  it("offers four DISTINCT options, so the answer can't be found by elimination", () => {
    const m = newMnemonic();
    for (const q of buildQuiz(m, 3)) {
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
    }
  });

  it("does not always put the answer in the same slot", () => {
    // A quiz whose answer is always first is a button, not a check.
    const m = newMnemonic();
    const positions = new Set<number>();
    for (let i = 0; i < 40; i++) {
      for (const q of buildQuiz(m, 3)) positions.add(q.options.indexOf(q.answer));
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it("asks about different positions across attempts", () => {
    // Re-rolling after a wrong answer only means something if the questions move.
    const m = newMnemonic();
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) seen.add(buildQuiz(m, 3).map((q) => q.index).join(","));
    expect(seen.size).toBeGreaterThan(1);
  });
});
