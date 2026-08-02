#!/usr/bin/env node
/**
 * Refuse to build a release that would lie to whoever installs it.
 *
 * Runs as `eas-build-pre-install`, so it executes on the EAS builder before
 * anything is compiled, and locally via `npm run guard:release`.
 *
 * WHY THIS EXISTS. `src/net/api.ts` derives `isMock` from the ABSENCE of
 * EXPO_PUBLIC_FEED_ORIGIN. That is the right default for a dev machine and a
 * catastrophe for a signed artifact: an unconfigured production build installs
 * as an app that shows invented balances, invented positions and invented
 * trades, indistinguishable from a real portfolio except for one small chip.
 * Nothing else in the pipeline would have caught it — the build succeeds, the
 * APK signs, the app opens, and every number in it is fiction.
 *
 * EXPO_PUBLIC_* is inlined at build time, so this cannot be fixed after the
 * fact by a setting inside the app. It is decided here or not at all.
 */

const profile = process.env.EAS_BUILD_PROFILE ?? process.env.PROFILE ?? "";
const origin = (process.env.EXPO_PUBLIC_FEED_ORIGIN ?? "").trim();

/** Profiles where shipping generated data is the stated intent, not an accident. */
const MOCK_OK = new Set(["", "development", "demo"]);

const die = (msg) => {
  console.error(`\n  release guard: ${msg}\n`);
  process.exit(1);
};

if (MOCK_OK.has(profile)) {
  const what = origin ? origin : "the built-in mock feed";
  console.log(`  release guard: profile "${profile || "(none)"}" — reading ${what}. OK.`);
  process.exit(0);
}

if (!origin) {
  die(
    `profile "${profile}" has no EXPO_PUBLIC_FEED_ORIGIN.\n\n` +
      `  This build would install as an app whose every number is generated\n` +
      `  on-device — balances, positions and trades that look real and are not.\n` +
      `  EXPO_PUBLIC_* is inlined at build time, so no in-app setting can undo it.\n\n` +
      `  Either point it at a real agent:\n` +
      `      EXPO_PUBLIC_FEED_ORIGIN=https://your-agent.example eas build --profile ${profile}\n` +
      `  or build the demo on purpose, where the mock is the point:\n` +
      `      eas build --profile demo`,
  );
}

let url;
try {
  url = new URL(origin);
} catch {
  die(`EXPO_PUBLIC_FEED_ORIGIN is not a URL: ${JSON.stringify(origin)}`);
}

// Android blocks cleartext by default for apps targeting API 28+, so an http://
// origin does not merely leak — it does not connect at all in a release build,
// and the app sits on "couldn't reach your agent" forever. It works in `expo
// start --web` because a browser has no such policy, which is exactly why this
// has never been noticed.
if (url.protocol !== "https:") {
  die(
    `EXPO_PUBLIC_FEED_ORIGIN is ${url.protocol}//… — a release Android build cannot reach it.\n\n` +
      `  Android refuses cleartext traffic by default, so this app would never\n` +
      `  connect. Enabling cleartext would also mean shipping a wallet whose feed\n` +
      `  is readable and forgeable by anything else on the network — and the feed\n` +
      `  API has no auth of its own (see the comment in src/net/api.ts).\n\n` +
      `  Give the worker an HTTPS address — a tunnel (Tailscale, Cloudflare) in\n` +
      `  front of the dashboard is enough — and pass that instead.`,
  );
}

if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
  die(`EXPO_PUBLIC_FEED_ORIGIN is ${origin} — on a phone that resolves to the phone itself, not your PC.`);
}

console.log(`  release guard: profile "${profile}" — reading ${url.origin}. OK.`);
