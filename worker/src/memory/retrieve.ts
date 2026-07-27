/**
 * Memory retrieval — pick what the merryman actually remembers RIGHT NOW.
 *
 * THE PROBLEM THIS SOLVES: soulPromptBlock used to take `ownerFacts().slice(-15)`
 * — the newest fifteen lines, chosen purely by position. With caps of 60 facts
 * and 120 notes, facts 1–45 were unreachable no matter how relevant they were.
 * Ask "when's the BIM coursework due" and the answer could be sitting on disk,
 * permanently invisible, because eleven newer unrelated notes came after it.
 *
 * THE APPROACH: BM25-flavoured lexical scoring plus recency decay. No embeddings,
 * no vector store, no service, no new dependency — at a couple of thousand
 * one-line memories, term matching is genuinely competitive, and the corpus is
 * far too small for dense retrieval to earn its cost.
 *
 * THE SAFETY PROPERTY THAT MAKES THIS SHIPPABLE: retrieval AUGMENTS the recency
 * window, it never replaces it. The result is always
 *
 *     [the N most recent] ∪ [the best-scoring by relevance]
 *
 * so the worst case is exactly the old behaviour and never worse. A query whose
 * wording misses everything costs nothing that was previously available.
 *
 * NOT A PRIVILEGE SURFACE: what comes out of here only ever reaches narrateChat,
 * whose entire output becomes `cmd.reply` — free text that can trigger nothing.
 * Ranking cannot escalate anything; the worst a poisoned memory achieves is
 * being read aloud, and every line has already passed the sanitizer twice.
 *
 * Pure: no clock, no fs, no randomness. `nowSec` is a parameter, so tests are
 * exact rather than approximate.
 */

import { jaccard, tokenize, uniq } from "./tokens";

export type MemorySource = "index" | "owner" | "note" | "day" | "journal";

export interface MemoryItem {
  /** Stable across restarts — see corpus.ts. */
  id: string;
  /** Sanitized body, without the `- (YYYY-MM-DD) ` prefix. */
  text: string;
  /** YYYY-MM-DD. */
  date: string;
  source: MemorySource;
  /** Heading this item sat under, when it came from MEMORY.md. */
  section?: string;
  /** Always in context, regardless of score. */
  pinned: boolean;
}

/** Days for a source's relevance to halve. Notes about today matter more than
 * a journal entry from last month; an owner fact is close to timeless. */
const HALF_LIFE: Record<MemorySource, number> = {
  index: 365,
  owner: 180,
  note: 45,
  day: 21,
  journal: 30,
};

/** A small nudge for sources that are curated rather than incidental. */
const PRIOR: Record<MemorySource, number> = {
  index: 0.06,
  owner: 0.04,
  note: 0,
  day: -0.02,
  journal: -0.04,
};

const DAY_SEC = 86_400;

export interface SelectOptions {
  /** Unix seconds — injected so tests are deterministic. */
  nowSec: number;
  /** Total characters the rendered block may occupy. */
  budgetChars?: number;
  /** Always include this many newest items, whatever they score. */
  recencyFloor?: number;
  /** Ids surfaced on the previous turn — keeps a thread alive across pronouns. */
  stickyIds?: ReadonlySet<string>;
  /** Below this, an item is not worth its tokens. */
  minScore?: number;
}

const DEFAULTS = {
  budgetChars: 1600,
  recencyFloor: 4,
  minScore: 0.18,
  pinChars: 400,
};

function ageDaysOf(date: string, nowSec: number): number {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return 3650; // undated → treat as ancient, never as fresh
  return Math.max(0, (nowSec - t / 1000) / DAY_SEC);
}

/**
 * Score every item against the query and return them ranked. Exported for
 * tests and for callers that want to inspect the ranking.
 */
export function scoreItems(
  items: readonly MemoryItem[],
  query: string,
  opts: SelectOptions,
): { item: MemoryItem; score: number; lex: number }[] {
  const qTokens = uniq(tokenize(query));
  const nowSec = opts.nowSec;
  const sticky = opts.stickyIds ?? new Set<string>();

  // Document frequency over the corpus itself — so "trade" is cheap for a
  // trading agent's memory, while "coursework" is expensive and discriminating.
  const docTokens = items.map((it) => uniq(tokenize(it.text)));
  const df = new Map<string, number>();
  for (const toks of docTokens) for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  const N = Math.max(1, items.length);
  const idf = (t: string): number => {
    const d = df.get(t) ?? 0;
    return Math.log(1 + (N - d + 0.5) / (d + 0.5)); // BM25 idf, always positive
  };

  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / N || 1;
  const qMass = qTokens.reduce((s, t) => s + idf(t), 0);

  return items.map((item, i) => {
    const toks = docTokens[i] ?? [];
    const tokSet = new Set(toks);

    let matched = 0;
    for (const t of qTokens) if (tokSet.has(t)) matched += idf(t);
    // A MEMORY.md heading is a weak signal about its items — half weight.
    if (item.section) {
      const secTokens = new Set(uniq(tokenize(item.section)));
      for (const t of qTokens) if (secTokens.has(t) && !tokSet.has(t)) matched += 0.5 * idf(t);
    }

    // Penalize only ABOVE-average length, so a rambling note can't out-rank a
    // focused one just by containing more words.
    const lenNorm = 1 / (1 + 0.35 * Math.max(0, toks.length - avgLen) / avgLen);
    // Normalizing by the query's own IDF mass makes lex a 0..1 "how much of what
    // they asked does this line answer" — comparable across queries, which is
    // what lets one global minScore work everywhere.
    const lex = qMass > 0 ? (matched / qMass) * lenNorm : 0;

    const rec = Math.pow(0.5, ageDaysOf(item.date, nowSec) / HALF_LIFE[item.source]);
    const stick = sticky.has(item.id) ? 1 : 0;
    const score = 0.62 * lex + 0.24 * rec + 0.14 * stick + PRIOR[item.source];

    return { item, score, lex };
  });
}

/**
 * Choose the memories that go into this turn's prompt.
 *
 * Order of business: pins first (they bypass scoring entirely), then the recency
 * floor (the never-worse guarantee), then the best of the rest until the budget
 * runs out. Output is emitted CHRONOLOGICALLY rather than by score — ranked
 * output reads like search results, dated output reads like memory and gives the
 * model a timeline it can narrate from.
 */
export function selectMemories(
  items: readonly MemoryItem[],
  query: string,
  opts: SelectOptions,
): MemoryItem[] {
  const budget = opts.budgetChars ?? DEFAULTS.budgetChars;
  const floor = opts.recencyFloor ?? DEFAULTS.recencyFloor;
  const minScore = opts.minScore ?? DEFAULTS.minScore;

  const chosen: MemoryItem[] = [];
  const takenIds = new Set<string>();
  const takenTokens: string[][] = [];
  let used = 0;

  /** Add unless it duplicates something already chosen or breaks the budget. */
  const take = (item: MemoryItem, cap: number): boolean => {
    if (takenIds.has(item.id)) return false;
    const cost = item.text.length + 16; // + the rendered "- (date) " scaffolding
    if (used + cost > cap) return false;
    const toks = uniq(tokenize(item.text));
    for (const prev of takenTokens) {
      if (jaccard(prev, toks) >= 0.85) return false; // same thing, said twice
    }
    chosen.push(item);
    takenIds.add(item.id);
    takenTokens.push(toks);
    used += cost;
    return true;
  };

  // 1. Pins — the owner said "always know this". Capped so they can't crowd out
  //    everything else, but never subject to the score threshold.
  for (const it of items.filter((i) => i.pinned)) take(it, DEFAULTS.pinChars);

  const byDateDesc = [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1));

  // 2. The recency floor — this is the never-worse guarantee, made explicit so a
  //    future weight change cannot silently break "what did we do yesterday".
  for (const it of byDateDesc.slice(0, floor)) take(it, budget);

  // 3. Everything else, best first.
  const ranked = scoreItems(items, query, opts)
    .filter((r) => !takenIds.has(r.item.id) && r.score >= minScore)
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.item.date < b.item.date
          ? 1
          : a.item.date > b.item.date
            ? -1
            : a.item.id < b.item.id
              ? -1
              : 1,
    );
  for (const r of ranked) take(r.item, budget);

  // Chronological for the model: oldest first reads as a story, not a result set.
  return chosen.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * "about twenty minutes", "yesterday evening", "six days" — the gap since the
 * owner last spoke, in words rather than a timestamp.
 *
 * Tiny, and the best warmth-per-token in the whole context block: it's the
 * difference between opening cold every single time and "been a few days — how'd
 * the coursework land?". Returns null when there's no previous turn, so a first
 * message doesn't get a phantom gap.
 */
export function describeGap(lastAtSec: number | null, nowSec: number): string | null {
  if (lastAtSec === null) return null;
  const s = Math.max(0, nowSec - lastAtSec);
  if (s < 90) return "moments ago";
  const mins = Math.round(s / 60);
  if (mins < 60) return `about ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(s / 3600);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(s / 86_400);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `about ${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return `about ${months} month${months === 1 ? "" : "s"} ago`;
}

/**
 * Render selected memories as prompt text. Whole items only — never truncated
 * mid-line, because half a fact is worse than no fact.
 */
export function renderMemories(items: readonly MemoryItem[], budgetChars = DEFAULTS.budgetChars): string {
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    const line = `- (${it.date}) ${it.pinned ? "★ " : ""}${it.text}`;
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
