/**
 * The signup store, exercised for real against a temp directory.
 *
 * `node --test signups.test.mjs` — no framework, matching selftest.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "merrymen-signups-"));
process.env.MERRYMEN_DATA_DIR = dir;

const { addSignup, signupCount, validateEmail, listSignups } = await import("./lib/signups.mjs");

test("accepts a plain address and persists it as one JSON line", async () => {
  const r = await addSignup({ email: "someone@example.com" });
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  assert.equal(r.count, 1);

  const raw = await readFile(path.join(dir, "ios-beta.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.email, "someone@example.com");
  assert.equal(row.platform, "ios");
  assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
});

test("stores nothing beyond email, platform and the day", async () => {
  const [row] = await listSignups();
  assert.deepEqual(Object.keys(row).sort(), ["day", "email", "platform"]);
});

test("is idempotent, case- and whitespace-insensitive", async () => {
  const again = await addSignup({ email: "  SomeOne@Example.COM " });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(await signupCount(), 1, "a duplicate must not add a row");
});

test("rejects what is not an address, with a reason worth showing a person", async () => {
  for (const bad of ["", "   ", "nope", "no@domain", "two@@at.com", "spaces in@it.com"]) {
    const r = await addSignup({ email: bad });
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.ok(r.reason.length > 0);
  }
  assert.equal(await signupCount(), 1, "no rejection may write a row");
});

test("rejects an absurdly long address rather than storing it", async () => {
  const r = await addSignup({ email: `${"a".repeat(250)}@example.com` });
  assert.equal(r.ok, false);
  assert.equal(await signupCount(), 1);
});

test("accepts the shapes real people actually have", async () => {
  for (const good of ["a+tag@example.co.uk", "first.last@sub.domain.io", "x@y.dev"]) {
    assert.equal(validateEmail(good).ok, true, `should accept ${good}`);
  }
});

test("survives a torn final line rather than losing the whole list", async () => {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path.join(dir, "ios-beta.jsonl"), '{"email":"truncated', "utf8");
  assert.equal(await signupCount(), 1, "the good row is still readable");
  const r = await addSignup({ email: "after@example.com" });
  assert.equal(r.ok, true);
});

test("counts zero on a directory that has never been written", async () => {
  const fresh = await mkdtemp(path.join(tmpdir(), "merrymen-empty-"));
  process.env.MERRYMEN_DATA_DIR = fresh;
  const mod = await import(`./lib/signups.mjs?fresh=${Date.now()}`);
  assert.equal(await mod.signupCount(), 0);
  await rm(fresh, { recursive: true, force: true });
  process.env.MERRYMEN_DATA_DIR = dir;
});

process.on("exit", () => {
  rm(dir, { recursive: true, force: true }).catch(() => {});
});
