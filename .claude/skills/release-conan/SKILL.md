---
name: release-conan
description: Build, sign, notarize, and ship a new public Conan macOS release. Use whenever the user asks to "release Conan", "ship Conan vX.Y.Z", "cut a release", "publish a new build", "do a release build", or any phrasing that implies producing a versioned, signed, notarized Conan artifact for users to install. NOT for dev iteration — `npm run tauri:dev` is the day-to-day loop. This skill encodes the full happy path (`npm run release` → `gh release create`), every pre-flight check, the common failure modes + their recovery patterns, and the post-release smoke test for the auto-update path.
---

# /release-conan

Produce a signed + notarized + stapled Conan .app + .dmg + updater artifacts,
ready to publish to GitHub Releases so the auto-updater can pick them up.

## When to invoke

Anything producing a versioned, signed, notarized Conan build for **end-user
installs or auto-update**. Not for dev iteration.

Typical phrasings:
- "Release Conan 1.0.0"
- "Ship a new version"
- "Cut v1.0.1"
- "Build a release dmg"
- "Publish the next Conan release"

## Pre-flight (do EVERY single one — don't skip)

A failed `npm run release` halfway through is recoverable but painful. Catch
the failure conditions up front.

### 1. Working tree clean

```bash
git status --short
```

Must be empty. Uncommitted changes silently bake into the build artifact
under the wrong commit hash.

### 2. Version bumped consistently

The same version string must be set in BOTH:

```bash
grep '"version"' package.json src-tauri/tauri.conf.json
```

Edit both manually if they don't match. The release script derives the
output filenames from `tauri.conf.json`.

### 3. No stale Conan.app running

```bash
pgrep -fl 'Conan\.app/Contents/MacOS/(app|conan-gateway)'
```

If anything's listed, kill it. The script does this at step 0 too, but doing
it now avoids the "killed N stale processes" log noise and any race where
a running app writes to its own bundle between sign + notarize.

### 4. Updater signing key present at the canonical path

```bash
ls -la ~/.conan/conan-updater.key
```

Must exist, 600 perms. If missing, restore from 1Password OR generate
one-time (NOT for an already-shipped app):

```bash
CI=true npx @tauri-apps/cli signer generate -p "" -w ~/.conan/conan-updater.key
chmod 600 ~/.conan/conan-updater.key
```

⚠️ Generating a NEW key after any release has shipped invalidates every
installed app's auto-update path — they reject signatures from a different
key. ALWAYS restore from backup before regenerating.

### 5. Developer ID identity present in Keychain

```bash
security find-identity -v -p codesigning | grep '4P6GX328VY'
```

Expect a line like `Developer ID Application: RANDY MARLON DANIEL (4P6GX328VY)`.
If absent, the cert needs to be installed via Xcode ▸ Settings ▸ Accounts
▸ Manage Certificates ▸ + ▸ Developer ID Application.

### 6. Notarytool keychain profile authenticates

```bash
xcrun notarytool history --keychain-profile conan-notarize | head -3
```

Must NOT error. A clean "No submission history" is fine. If it errors:

```bash
xcrun notarytool store-credentials conan-notarize \
  --apple-id "<your-apple-id>" \
  --team-id "4P6GX328VY"
```

(Apple-ID password is an app-specific password from appleid.apple.com.)

### 7. `gh` CLI authenticated

```bash
gh auth status
```

Need this for the post-release publish step. If not authenticated:

```bash
gh auth login
```

## Happy path

```bash
npm run release
```

That's it. The script in `scripts/release.mjs` runs all 8 numbered steps:

0. Kill any stale Conan.app
1. Resolve Developer ID identity
2. Rebuild the sidecar with Developer ID + hardened runtime
3. `tauri build` (signs .app + .dmg + auto-signs initial .app.tar.gz)
3b. Scrub `.claude` / `.data` / `.DS_Store` from inside the .app
4. Notarize the .app via notarytool (Apple round-trip ~5-10 min)
5a. Staple the .app
5a-updater. Re-tar from STAPLED .app + re-sign the updater archive
5b. Rebuild .dmg from stapled .app
5c. Notarize the .dmg (second Apple round-trip ~5-10 min) + staple
6. Gatekeeper assessment (`spctl --assess`)
7. Emit `latest.json` (updater manifest)
8. Print the `gh release create` command (does NOT auto-run)

End-to-end timing: **15–20 minutes**, dominated by the two notarization waits.

Run this as a long-running background task so you can keep working. Output
goes to a logfile you can tail.

## Post-release

The release script prints the exact `gh release create` invocation. Copy +
paste + run. It uploads:

- `Conan_<version>_aarch64.dmg` — what conan.sh's Download button serves
- `Conan_<version>_aarch64.app.tar.gz` — the auto-updater payload
- `Conan_<version>_aarch64.app.tar.gz.sig` — minisign signature
- `latest.json` — updater manifest (the one tauri-plugin-updater polls)

Then:

```bash
# tag the commit
git tag v<version>
git push origin v<version>
```

The `latest.json` URL the app polls is:

```
https://github.com/thewhatmatters/conan/releases/latest/download/latest.json
```

`releases/latest` is a 302 to whichever tag is marked "Latest release" on
GitHub. By default `gh release create` marks the newly-published release
as latest, so the redirect resolves to the new manifest automatically.
Every installed app picks up the new version within its poll interval
(currently 4h; see `ui/src/components/UpdateBanner.tsx`).

**This skill only builds and ships the artifact — it does not announce it.**
Once the release is published, run the `announce-conan-release` skill (global,
`~/.claude/skills/announce-conan-release/`) with the version + highlights to
update the marketing changelog, the in-app What's New popup, and the draft
buyer email.

## Common failure modes + recovery

### `Invalid symbol 46, offset 24` (or any base64 decode error during `tauri signer sign`)

**Cause:** `TAURI_SIGNING_PRIVATE_KEY` is being interpreted as the literal
base64 key string but actually carries a file path. Path characters
(`.`, `/`) aren't valid base64 — `.` is ASCII 46.

**Fix:** Already in the script as of commit f170088 — it reads the file
content once and passes the contents. If you see this again, check
`signEnv.TAURI_SIGNING_PRIVATE_KEY` in `scripts/release.mjs` is set to
`UPDATER_PRIVATE_KEY_CONTENTS` (file contents) not `UPDATER_PRIVATE_KEY_PATH`.

### Notarization rejected (`status: Invalid` from notarytool)

**Diagnose:**
```bash
xcrun notarytool log <submission-id> --keychain-profile conan-notarize
```

Read the JSON `issues` array. Common patterns:

| Issue | Fix |
|---|---|
| "The signature of the binary is invalid" | Re-run `npm run release` — anti-footgun (step 3b) scrubs the usual culprits |
| "The binary is not signed with a valid Developer ID" | A bundled binary is missing the signature. Often a node-pty/sqlite native addon. Resign with `codesign -f -s "$IDENT" --timestamp --options runtime --entitlements <ent> <binary>` |
| "Sealed resource is missing or invalid" | Stray file added between sign + notarize. Look in `Conan.app/Contents/Resources/` for `.DS_Store`, `.claude/`, `.data/`. Script's step 3b scrubs known offenders |
| "The executable does not have the hardened runtime enabled" | Sidecar binary signed without `--options runtime`. Verify `scripts/build-sidecar.mjs` reads `APPLE_SIGNING_IDENTITY` |

### Stapler errors (`CloudKit returned not found`)

**Cause:** Trying to staple a binary whose notarization ticket isn't ready
yet. `notarytool --wait` should prevent this, but rare timing windows happen.

**Fix:** wait 2 minutes, then:

```bash
xcrun stapler staple <path>
```

### Partial failure after .app is notarized + stapled

If the script crashes AFTER step 5a (staple .app) but BEFORE step 7
(latest.json), **don't re-run `npm run release` from scratch** — you'll
waste ~10 min re-notarizing an already-notarized .app.

Verify the .app is good:
```bash
spctl --assess --type execute src-tauri/target/release/bundle/macos/Conan.app
# expect: accepted, source=Notarized Developer ID
```

Then manually run the remaining steps. The exact recipe (env vars, args,
paths) is at [references/manual-recovery.md](references/manual-recovery.md).

### Rust compile takes forever / appears stuck

First release after touching `Cargo.toml` triggers a clean recompile of
the entire dependency tree — `tauri`, `reqwest`, `rustls`, `wry`, ~150
crates. Expect 3–8 minutes on Apple Silicon, longer on cold builds.

Subsequent releases reuse `target/release/` incrementally and finish in
~30 seconds.

If genuinely stuck (CPU at 0, no progress for 5+ min), check `cargo`'s
spawned process — usually `linker` waiting on a missing system framework.
`rm -rf src-tauri/target/release/` + retry as a nuclear option.

## Anti-footguns

- **NEVER** edit `~/.conan/conan-updater.key` directly. Restore from 1Password
  if corrupted.
- **NEVER** commit the private key. `~/.conan/` is outside the repo for a
  reason; nothing in the build should write the key to a tracked file.
- **NEVER** swap the public key in `tauri.conf.json` (`plugins.updater.pubkey`)
  unless you also push an update signed with the OLD key first that points
  customers at the new manifest URL. Mismatched keys = bricked update path
  for every installed app.
- **NEVER** ship without verifying `spctl --assess` accepts BOTH the .app
  AND the .dmg. The script asserts this in step 6 and `die()`s if either
  fails — keep that gate in place.
- **NEVER** mark a release as "Latest" in GitHub UI without first verifying
  `latest.json` is one of the release assets. The auto-updater fetches via
  `releases/latest/download/latest.json`; a missing manifest = 404 = updater
  silently broken for every customer.

## Key files

| Path | What |
|---|---|
| `scripts/release.mjs` | The release pipeline. Read this; everything downstream is derived from it. |
| `scripts/build-sidecar.mjs` | Sidecar build with Developer ID signing |
| `src-tauri/Conan.entitlements` | Hardened runtime entitlements (allow-jit, allow-unsigned-executable-memory, disable-library-validation) |
| `src-tauri/tauri.conf.json` | Version + bundle config + `plugins.updater.pubkey` |
| `~/.conan/conan-updater.key` | Minisign signing key for updater artifacts (private) |
| `ui/src/components/UpdateBanner.tsx` | The toast that surfaces the update to users |
| `docs/launch-checklist.md` | The bigger-picture pre-1.0 status (Polar, marketing, etc.) |
