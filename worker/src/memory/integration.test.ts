/**
 * End-to-end proof against real soul files: a fact old enough that the previous
 * newest-15 window could never reach it comes back when the owner asks about it.
 *
 * MERRYMEN_HOME is set before importing soul.ts so everything runs in a throwaway
 * directory. node --test gives each file its own process, so this never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "mm-mem-"));
process.env.MERRYMEN_HOME = HOME;
mkdirSync(path.join(HOME, "soul"), { recursive: true });

const { identityBlock, memoryBlock, soulPromptBlock } = await import("../soul");

const NOW = Math.floor(Date.UTC(2026, 6, 27) / 1000);
const DAY = 86_400;
const dateOf = (d: number) => new Date((NOW - d * DAY) * 1000).toISOString().slice(0, 10);

// One buried fact + 30 newer unrelated ones — the exact shape that defeats
// position-based slicing.
const lines = [`- (${dateOf(60)}) The BIM coursework is due 12 August.`];
for (let i = 0; i < 30; i++) lines.push(`- (${dateOf(29 - i)}) Ran a paper trade on QQQ, batch ${i}.`);
writeFileSync(path.join(HOME, "soul", "NOTES.md"), `# Notes\n\n${lines.join("\n")}\n`, "utf8");
writeFileSync(
  path.join(HOME, "soul", "OWNER.md"),
  `# What I know about my owner\n\n- (${dateOf(90)}) They like to be called Mummy.\n`,
  "utf8",
);
writeFileSync(path.join(HOME, "soul", "IDENTITY.md"), "# Robin of the merrymen\nborn: 2026-01-01\n", "utf8");

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("memoryBlock reaches what the old slice could not", () => {
  it("recalls a 60-day-old note when the owner asks about it", () => {
    const block = memoryBlock("when is the BIM coursework due?", NOW);
    assert.ok(block.includes("BIM coursework"), "the buried note is retrieved");
  });

  it("the OLD path genuinely could not — proving this is a real change", () => {
    // soulPromptBlock still takes the newest 15 notes by position. The BIM note
    // is the 31st-newest, so it is structurally unreachable there.
    const old = soulPromptBlock(null, 0, NOW);
    assert.ok(!old.includes("BIM coursework"), "newest-15 slicing cannot see it");
  });

  it("recalls an owner fact from 90 days back when asked", () => {
    const block = memoryBlock("what should you call me?", NOW);
    assert.ok(block.includes("called Mummy"));
  });

  it("still shows recent notes when the question matches nothing", () => {
    const block = memoryBlock("xyzzy plugh nothing matches", NOW);
    assert.ok(block.includes("batch 29"), "the recency floor holds — never worse than before");
  });

  it("identityBlock carries identity but NOT recalled memory (classifier budget)", () => {
    const id = identityBlock(null, 0, NOW);
    assert.ok(id.includes("Robin"), "identity is present");
    assert.ok(!id.includes("BIM coursework"), "memory is not in the router's context");
    assert.ok(!id.includes("called Mummy"));
  });

  it("the memory block stays inside its char budget", () => {
    const block = memoryBlock("trade", NOW);
    assert.ok(block.length < 2600, `memory block was ${block.length} chars`);
  });
});
