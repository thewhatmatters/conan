# Manual recovery — resuming after partial release failure

When `npm run release` crashes AFTER the `.app` is signed + notarized + stapled
but BEFORE `latest.json` is emitted, **do not re-run the full script**.
Re-running burns ~10 minutes re-notarizing an already-notarized .app, plus
re-zips and re-uploads the same bytes. Resume manually instead.

This file captures the exact commands. Verified live during the 0.1.0 build
on 2026-05-30 when the signer env-var bug bit (commit f170088 fixed it
forward).

## Step 0: confirm the .app is salvageable

The .app at `src-tauri/target/release/bundle/macos/Conan.app` must already
be notarized + stapled. Verify:

```bash
spctl --assess --type execute --verbose \
  src-tauri/target/release/bundle/macos/Conan.app
# expect:
#   .../Conan.app: accepted
#   source=Notarized Developer ID

stapler validate src-tauri/target/release/bundle/macos/Conan.app
# expect: The validate action worked!
```

If either fails, the .app needs to be rebuilt — restart from `npm run release`,
not from this recovery doc.

## Step 1: re-tar + re-sign the updater archive (was step 5a-updater)

The .app.tar.gz that `tauri build` auto-produces is from the **un-stapled**
.app (signing happens before notarization+staple). Replace it with one from
the stapled .app.

```bash
cd ~/Development/conan

APP=src-tauri/target/release/bundle/macos/Conan.app
TARGZ=src-tauri/target/release/bundle/macos/Conan_$(jq -r .version src-tauri/tauri.conf.json)_aarch64.app.tar.gz
SIG=$TARGZ.sig

# Delete BOTH the versioned and unversioned auto-builds so the signer doesn't
# accidentally sign the wrong one
rm -f "$TARGZ" "$SIG" \
      src-tauri/target/release/bundle/macos/Conan.app.tar.gz \
      src-tauri/target/release/bundle/macos/Conan.app.tar.gz.sig

# Re-tar from the stapled .app
tar czf "$TARGZ" -C "$(dirname "$APP")" "$(basename "$APP")"

# Sign — the env var must be the KEY CONTENTS, not a path. `tauri build`
# is lenient about this; `tauri signer sign` is strict.
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.conan/conan-updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npx --yes @tauri-apps/cli signer sign "$TARGZ"

# Confirm the .sig dropped next to it
ls -la "$SIG"
```

## Step 2: rebuild .dmg from stapled .app (was step 5b)

The Tauri-built .dmg also contains the un-stapled .app. Regenerate it.

```bash
DMG=src-tauri/target/release/bundle/dmg/Conan_$(jq -r .version src-tauri/tauri.conf.json)_aarch64.dmg
IDENT=$(security find-identity -v -p codesigning \
  | grep '4P6GX328VY' | head -1 \
  | sed -E 's/.*"([^"]+)".*/\1/')
VERSION=$(jq -r .version src-tauri/tauri.conf.json)

rm -f "$DMG"
hdiutil create -volname "Conan $VERSION" -srcfolder "$APP" -ov \
  -format UDZO -fs HFS+ "$DMG"

# Sign the .dmg with the same Developer ID identity
codesign --force -s "$IDENT" --timestamp "$DMG"
```

## Step 3: notarize + staple the .dmg (was step 5c)

The slow part — Apple round-trip is 5-10 min.

```bash
xcrun notarytool submit "$DMG" \
  --keychain-profile conan-notarize \
  --wait
# Expect: status: Accepted

xcrun stapler staple "$DMG"
# Expect: The staple and validate action worked!
```

## Step 4: Gatekeeper assess (was step 6)

```bash
spctl --assess --type execute --context context:primary-signature --verbose "$APP"
spctl --assess --type open --context context:primary-signature --verbose "$DMG"
# Both expect: accepted, source=Notarized Developer ID
```

If either is rejected, halt — re-run `npm run release` from scratch.

## Step 5: emit latest.json (was step 7)

```bash
LATEST=src-tauri/target/release/bundle/macos/latest.json
SIGNATURE=$(cat "$SIG")
PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$LATEST" <<EOF
{
  "version": "$VERSION",
  "pub_date": "$PUB_DATE",
  "notes": "Conan $VERSION — see https://github.com/thewhatmatters/conan/releases/tag/v$VERSION for the changelog.",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIGNATURE",
      "url": "https://github.com/thewhatmatters/conan/releases/download/v$VERSION/Conan_${VERSION}_aarch64.app.tar.gz"
    }
  }
}
EOF

cat "$LATEST"
```

## Step 6: publish (was step 8)

Identical to the happy-path post-release. Tag + push + `gh release create`:

```bash
git tag "v$VERSION"
git push origin "v$VERSION"

gh release create "v$VERSION" \
  --repo thewhatmatters/conan \
  --title "Conan $VERSION" \
  --notes "Recovered build (manual)." \
  "$DMG" \
  "$TARGZ" \
  "$SIG" \
  "$LATEST"
```

## Final sanity check

```bash
# The auto-updater URL should resolve and serve the manifest you just published
curl -s "https://github.com/thewhatmatters/conan/releases/latest/download/latest.json" | jq .
# Should match the latest.json you cat'd above
```

If the JSON matches, the auto-update path is live. Every installed
Conan ≥ 0.1.0 will see the toast within ~4 hours (the poll interval).
