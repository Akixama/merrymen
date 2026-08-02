# Releasing the phone app

Android, signed, via EAS Build. Everything below except the two commands marked
**you** is already wired.

## What signs it

EAS holds the upload keystore. On the first `eas build` for this project it
offers to generate one; say yes. From then on every build is signed with the
same key, and losing it means you can never update the app under the same
package name again — so once it exists, back it up:

```bash
npx eas-cli credentials --platform android
```

Nothing in this repo holds the keystore, and nothing should. `.gitignore`
already refuses `*.jks`, `*.p12`, `*.key` and `*.p8`.

## Build it

> Use `npx eas-cli`, **not** `npx eas-cli@latest`. The `@latest` form crashes
> here with `npm error Invalid Version:` — an npm arborist bug in `canDedupe →
> semver.gte` while it builds the CLI's own temp install tree (it dies placing
> `uuid` for `@expo/bunyan`). Nothing to do with this project; the plain form
> works. eas-cli is deliberately NOT a devDependency: it drags in ~700 packages
> and two high-severity advisories, and EAS Build runs its own pinned CLI
> server-side anyway, so the local one only submits the job.

**you** — one time, with your own Expo account:

```bash
npx eas-cli login
```

The project is already linked — `extra.eas.projectId` in `app.json` is
`8da0c95f-0501-437e-ba78-5c6b9eeab29c`, so `eas init` does not need re-running.
`eas whoami` reports "Not logged in" until you do the above; every EAS command
fails with "An Expo user account is required to proceed" until then.

Then, from `mobile/`:

```bash
EXPO_PUBLIC_FEED_ORIGIN=https://your-agent.example npx eas-cli build --platform android --profile production
```

The origin is not optional. See "the feed origin decides what the app is".

## Profiles

| Profile | Output | Distribution | Feed |
|---|---|---|---|
| `development` | APK + dev client | internal | mock |
| `demo` | APK | internal | mock, on purpose |
| `preview` | APK | internal | real, required |
| `production` | AAB | store | real, required |

`appVersionSource: "remote"` — EAS owns `versionCode` and `autoIncrement` bumps
it per production build. Do not hand-edit a version code; there isn't one to
edit. `version` in `app.json` is the human-facing string and is yours to bump.

## The feed origin decides what the app is

`src/net/api.ts` derives `isMock` from the *absence* of
`EXPO_PUBLIC_FEED_ORIGIN`. That default is right on a laptop and disastrous in a
signed artifact: an unconfigured production build installs as an app whose
balances, positions and trades are all generated on-device, and looks exactly
like a real portfolio apart from one small chip.

`EXPO_PUBLIC_*` is inlined into the JS bundle at build time, so this cannot be
corrected by a setting inside the app — it is decided at build time or not at
all. `scripts/guard-release.mjs` runs as `eas-build-pre-install` and fails the
build rather than let that ship. It also refuses:

- an `http://` origin, because a release Android build blocks cleartext and
  would never connect. This works in `expo start --web` only because a browser
  has no such policy, which is why it has never been noticed.
- `localhost` / `127.0.0.1`, which on a phone is the phone.

Run it yourself any time: `EAS_BUILD_PROFILE=production npm run guard:release`.

## Known limits, stated plainly

**There is no hosted API yet.** The dashboard's routes assume single-tenant
local state and send no auth header at all — `src/net/api.ts` says so in a
comment. So a `production` build today has no correct origin to point at:

- a LAN address is HTTP, which the guard refuses and Android would block anyway;
- putting a tunnel (Tailscale, Cloudflare) in front of the dashboard gives you
  HTTPS and satisfies the guard, but the feed behind it is still unauthenticated
  — anyone who reaches that URL reads your portfolio.

Until the hosted worker lands, `demo` and `development` are the honest profiles.
A `production` build is buildable and signable, but what it would contain is a
client for an API that isn't ready.

**Never run on a device.** The app has only ever been exercised in
`expo start --web`. Web has no Android keystore (`expo-secure-store`'s web build
is literally `export default {}`), so the key handling, the biometric gate and
the ERC-4337 signing path have not run on real hardware. Install the `demo` APK
on a phone and walk onboarding → grant → recover before trusting any of it.

## What the manifest asks for, and what it doesn't

Expo's prebuild template ships `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE`
and `WRITE_EXTERNAL_STORAGE` under a comment reading "OPTIONAL PERMISSIONS,
REMOVE WHATEVER YOU DO NOT NEED". They are now removed via
`android.blockedPermissions`, along with `VIBRATE` (nothing here vibrates). A
wallet asking to draw over other apps is the exact shape of an overlay-phishing
app, and it is not a permission this one should ever have carried.

`android.allowBackup` is `false`. The default `true` lets Android auto-backup
copy app data off the device; the keystore-held key that decrypts
`expo-secure-store` does not leave the phone, so the copy would be inert — but a
wallet should not be exporting its secret store to cloud backup at all.

Final permission set: `INTERNET`, `USE_BIOMETRIC`, `USE_FINGERPRINT`.

Verify any of this yourself without building:

```bash
npx expo prebuild --platform android --no-install --clean
```

then read `android/app/src/main/AndroidManifest.xml` and delete the `android/`
directory again — this is a CNG project and that folder is generated, never
committed.
