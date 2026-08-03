/**
 * The iOS beta waiting list.
 *
 * APPEND-ONLY JSONL ON A RAILWAY VOLUME. Not lib/store.mjs, which is a CACHE:
 * its default backend is an in-memory Map that dies with the process, and its
 * whole design is that losing an entry is survivable (a spent nonce, a rate
 * counter, a cached balance). Losing somebody's signup is not survivable — they
 * gave you an address once and will never know it vanished. So this writes to
 * disk, on a mounted volume, and fsyncs.
 *
 * JSONL rather than a database because the shape of the job is append + export:
 * one line per person, greppable, trivially turned into a CSV, and no service to
 * keep alive or migrate. If this list ever needs querying rather than reading,
 * that is the moment to move it, not before.
 *
 * WHAT IS DELIBERATELY NOT STORED: no IP, no user agent, no referrer, no
 * timestamp beyond the day. An email address is the entire reason this endpoint
 * exists; everything else would be collected only because it was easy, and the
 * privacy page has to be able to say truthfully that the address is all there is.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Where the volume is mounted. Overridable so tests can point somewhere else. */
const DIR = process.env.MERRYMEN_DATA_DIR || "/data";
const FILE = path.join(DIR, "ios-beta.jsonl");

/** Generous but finite — the longest real addresses are ~60 chars. */
export const MAX_EMAIL = 254;

/**
 * Deliberately permissive: one @, something either side, a dot in the domain, no
 * whitespace. Stricter regexes reject valid addresses (plus-tags, new TLDs,
 * unicode locals) and the cost of a bad address here is one bounced email, while
 * the cost of a false rejection is a person who wanted in and was told no.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function normalizeEmail(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function validateEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, reason: "an email address is required" };
  if (email.length > MAX_EMAIL) return { ok: false, reason: "that address is too long" };
  if (!EMAIL.test(email)) return { ok: false, reason: "that doesn't look like an email address" };
  return { ok: true, email };
}

/** UTC day only. Enough to know when interest arrived; not enough to time anyone. */
function today(now) {
  return new Date(now ?? Date.now()).toISOString().slice(0, 10);
}

async function readAll() {
  try {
    const raw = await readFile(FILE, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // a torn final line must not break the whole list
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Record an address. Idempotent by address: signing up twice is a normal thing
 * for a person to do, not an error to shout about, so it reports `already` and
 * writes nothing.
 */
export async function addSignup({ email, platform = "ios", now }) {
  const check = validateEmail(email);
  if (!check.ok) return { ok: false, reason: check.reason };

  await mkdir(DIR, { recursive: true });
  const existing = await readAll();
  if (existing.some((e) => e.email === check.email)) {
    return { ok: true, already: true, count: existing.length };
  }

  const line = JSON.stringify({ email: check.email, platform, day: today(now) });
  // flush:true — a container can be stopped between the write and the flush, and
  // this is exactly the write that must not be the one that is lost.
  await appendFile(FILE, `${line}\n`, { encoding: "utf8", flush: true });
  return { ok: true, already: false, count: existing.length + 1 };
}

/** How many are waiting. Public — a count reveals nobody. */
export async function signupCount() {
  return (await readAll()).length;
}

/** Every address, for exporting the list. Never exposed over HTTP. */
export async function listSignups() {
  return readAll();
}
