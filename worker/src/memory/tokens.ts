/**
 * Tokenizer for memory retrieval — deliberately tiny, deterministic, and
 * dependency-free (this ships inside an npm package that must install clean, so
 * no embeddings service and no native deps).
 *
 * Everything here is a pure function of its input: no clock, no randomness, no
 * filesystem. Identical input always produces byte-identical output, which is
 * what makes the retrieval tests exact rather than approximate.
 */

/**
 * Structural words only — pronouns, articles, auxiliaries, prepositions.
 *
 * Deliberately short, because IDF is the real stopword list: a term appearing in
 * half the corpus earns a near-zero weight automatically, and that adapts to how
 * this particular owner writes. This list exists only so a query like "the" or
 * "is it done" doesn't degenerate to an empty token set.
 */
const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does",
  "for", "from", "had", "has", "have", "he", "her", "him", "his", "how", "i", "if", "in", "is",
  "it", "its", "me", "my", "no", "not", "of", "on", "or", "our", "out", "she", "so", "than",
  "that", "the", "their", "them", "then", "there", "they", "this", "to", "up", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you",
  "your",
]);

/**
 * A crude but stable suffix stemmer. Not linguistically correct — it only needs
 * to make "trading"/"trades"/"trade" collide so a question matches a note that
 * used a different form. Order matters; each rule is guarded by a length floor
 * so short words are left alone.
 */
function stem(w: string): string {
  let s = w;
  if (s.length >= 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length >= 5 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length >= 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length >= 4 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  // Drop a trailing silent 'e' LAST, so the two spellings of the same verb meet
  // in the middle: "trading" → "trad" and "trade" → "trad". Without this the
  // most common word pair in an English memory ("doing"/"do", "coding"/"code")
  // never matches, which is exactly the recall this feature exists to fix.
  if (s.length >= 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** Lowercase → split on non-alphanumerics → stem → drop stopwords and 1-char noise. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
    .filter((w) => w.length > 1);
}

/** Unique tokens, order-stable (first occurrence wins). */
export function uniq(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Jaccard overlap of two token sets — used for near-duplicate detection so the
 * same fact restated three different ways doesn't occupy three context slots.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** FNV-1a — a stable id for a line of memory, so ids survive restarts. */
export function fnv1a(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}
