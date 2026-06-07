# Conan 1.0 — Launch Checklist

Last updated: 2026-05-30. Source of truth for every ship-critical surface
between here and the public `v1.0.0` release.

**Legend:**  ✅ done · 🟡 in flight / pending external · ❌ blocked · ⬜ todo

---

## 1. Apple Developer ID + macOS distribution

| | Item | Notes |
|---|---|---|
| ✅ | Apple Developer Team enrolled | `4P6GX328VY` |
| ✅ | Developer ID Application certificate in login Keychain | identity: `Developer ID Application: Randy WhatMatters (4P6GX328VY)` |
| ✅ | App-specific password stored under `notarytool` keychain profile | profile name: `conan-notarize` |
| ✅ | `npm run release` pipeline produces signed + notarized + stapled `.app` + `.dmg` | `scripts/release.mjs` |
| ✅ | `spctl --assess` reports `source=Notarized Developer ID` | verified |
| ✅ | Anti-footgun: `scripts/release.mjs` scrubs `.claude/.data/.DS_Store` before notarization | known race with running Conan.app writing to its own Resources dir |
| ⬜ | Apple Developer Program annual renewal date noted somewhere | so the cert doesn't expire silently |
| ⬜ | App-specific password rotation reminder | Apple aliases these to expire; rotate via appleid.apple.com |

---

## 2. Cryptography (license signing)

| | Item | Notes |
|---|---|---|
| ✅ | Ed25519 keypair generated | `ui/src/lib/license.ts` carries the public key bundled |
| ✅ | Private key in 1Password | + Vercel env var `ED25519_PRIVATE_KEY` |
| ✅ | Verifier shipped + tested | `verifyLicense()` round-trips all 7 claims |
| 🟡 | **Rotate the private key BEFORE the first real sale** | Was pasted in chat transcript 2026-05-29. Once a customer holds a JWT signed with the current key, rotation invalidates them — so do it now while the customer set is empty. New keypair → new public key → bundle into `ui/src/lib/license.ts` → tag new release. |

---

## 3. Polar (Merchant of Record)

| | Item | Notes |
|---|---|---|
| ✅ | Polar org `WhatMatters` created | |
| ⬜ | Product `Conan Premium` ($29 one-time) configured | ⚠ Polar product price still set to $39 — update in Polar dashboard to $29 |
| ✅ | Webhook → `license.conan.sh/api/polar-webhook` (`order.created` + `order.refunded`) | |
| ✅ | Organization Access Token created | Settings → Preferences → Developers (scroll to bottom) |
| ✅ | Synthetic-webhook end-to-end test passes | `scripts/test-webhook.mjs` in `conan-license/` repo |
| 🟡 | **Polar Go Live + Stripe Connect onboarding** | ~15–30 min KYC. Stripe Identity + business verification + bank info + tax info. THE blocker. |
| ⬜ | Real test sale with `4242 4242 4242 4242` after Go Live | Confirm Vercel logs show `issued license lic_…`; receipt email arrives |
| ⬜ | Customize Polar receipt email template | Embed `{{order.metadata.license}}` so the JWT lands in the customer's inbox |
| ⬜ | Capture the live checkout URL | Format: `https://buy.polar.sh/polar_cl_…` |
| 🟡 | Rotate `POLAR_WEBHOOK_SECRET` (chat-paste discipline) | Polar → Settings → Webhooks → Regenerate → update Vercel env → redeploy |

---

## 4. License issuance infrastructure (`conan-license/` repo)

| | Item | Notes |
|---|---|---|
| ✅ | Repo at github.com/thewhatmatters/conan-license | |
| ✅ | Vercel project deployed at `license.conan.sh` | |
| ✅ | Upstash KV attached (`KV_*` env vars auto-injected) | |
| ✅ | `POLAR_WEBHOOK_SECRET` + `ED25519_PRIVATE_KEY` env vars set | |
| ✅ | `POST /api/polar-webhook` verifies HMAC + mints JWT + writes KV | |
| ✅ | `GET /revoked.json` published as the revocation list | |
| ⬜ | Verify `order.refunded` webhook end-to-end revokes a license | After Go Live, refund the test sale via Polar customer portal, confirm `revoked.json` updates, confirm running Conan app flips back to Free on next boot |

---

## 5. Conan app — the build itself

### Freemium gates (all done)

| | Item | Notes |
|---|---|---|
| ✅ | US-101 `useTier()` hook + license loader | |
| ✅ | US-102 Timeline insight gating (50-row blur + Premium stubs + Conan-icon overlay) | |
| ✅ | US-102 Radio rickroll (60s grace, silenced + scrolling "Please Upgrade Conan" ticker) | |
| ✅ | US-103 Pulse live-data cap (60s grace, blur + Conan-icon overlay) | |
| ✅ | US-106 Settings ▸ License paste tab | |
| ✅ | US-107 license issuance pipeline | |
| ❌ | US-104 Skills `last fired` gating | **cut from v1.0** — insufficient WTP |
| ❌ | US-105 MCP auth watchdog | **cut from v1.0** — silent-prevention, low discoverability |

### Pre-ship wiring

| | Item | Notes |
|---|---|---|
| ⬜ | Wire real Polar checkout URL into `BUY_PREMIUM_URL` ([SettingsView.tsx:965](../ui/src/components/SettingsView.tsx#L965)) | Currently stubbed at `https://conan.sh` |
| ⬜ | Full smoke test: Free → paste JWT → Premium (all gates lift); Remove license → Free (all gates re-engage) | Verifies useTier → gate-react chain end-to-end |
| ⬜ | Bump version `0.1.0` → `1.0.0` | `package.json` + `src-tauri/tauri.conf.json` |
| ⬜ | `git tag v1.0.0` | |
| ⬜ | Branded DMG (background image + `/Applications` drop target) | Switch `release.mjs` from raw `hdiutil create` to Tauri's native DMG bundler (`bundle.macOS.dmg` config in `tauri.conf.json`) or `create-dmg`. Artwork ~660×400, Conan logo + "Drag to Applications →" cue. Currently bare. |
| ⬜ | `npm run release` → signed + notarized DMG | `Conan_1.0.0_aarch64.dmg` |
| ⬜ | GitHub Release attached to `v1.0.0` tag with the DMG + release notes | |
| ⬜ | Make `thewhatmatters/conan` repo public | Required for the auto-updater URL (`releases/latest/download/latest.json`) to resolve for end users. Until then, public CDN 404s on private-repo assets. |

---

## 6. conan.sh marketing site (`conan-marketing/` repo)

| | Item | Notes |
|---|---|---|
| ✅ | Domain `conan.sh` registered | |
| ✅ | Vercel project deployed (placeholder "coming soon") | |
| ⬜ | Real landing page | Hero, free/premium comparison, $29 lifetime pricing, screenshots / screencap |
| ⬜ | Download button → GitHub Release DMG | |
| ⬜ | Buy button → live Polar checkout URL | gated on Polar Go Live |
| ⬜ | (Optional) Privacy / Terms pages or link to Polar's | Polar handles transactional T&Cs as MoR |

---

## 7. App updates infrastructure

**Auto-update via tauri-plugin-updater is wired.** Backend = GitHub Releases
(no Cloudflare / R2 needed); manifest URL =
`https://github.com/thewhatmatters/conan/releases/latest/download/latest.json`.

| | Item | Notes |
|---|---|---|
| ✅ | Minisign-format keypair generated | `~/.conan/conan-updater.key` (600 perms, **back up to 1Password before shipping**) + `~/.conan/conan-updater.key.pub` |
| ✅ | Public key bundled into the app | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |
| ✅ | `tauri-plugin-updater` + `tauri-plugin-process` in Cargo + registered in `lib.rs` | |
| ✅ | `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process` in UI deps | |
| ✅ | `<UpdateBanner>` in app shell | Polls on boot + every 4h; surfaces "available → Update", "downloading → x%", "ready → Restart". Dismissible per-session. |
| ✅ | `scripts/release.mjs` produces signed updater artifacts | Re-creates `.app.tar.gz` + `.sig` from the STAPLED .app (so the payload carries the notary ticket), emits `latest.json`, prints the `gh release create` command at the end |
| ⬜ | **Back up the private key to 1Password** | Lose this and you can never push another auto-update to existing installs |
| ⬜ | (Optional) Run a dry release v0.1.0 → v0.1.1 to prove the full loop in practice before tagging v1.0.0 | Catches any glitch in the release pipeline while the customer count is zero |

---

## 9. Pre-launch discipline checklist (do these the day before)

- ⬜ Rotate Ed25519 private key (§2)
- ⬜ Rotate Polar webhook secret (§3)
- ⬜ Refund-flow end-to-end test (§4)
- ⬜ Full Free → Premium → Free smoke test in the bundled `.app` (not just `tauri:dev`)
- ⬜ Hit conan.sh from a clean browser (no cache, no extension) — every link resolves, Buy button opens Polar, Download button serves DMG
- ⬜ Read the listing on Hacker News' Show HN guidelines — schedule the post for Tuesday/Wednesday morning Pacific
- ⬜ Pre-write a launch announcement post for Twitter / Bluesky / wherever

---

## Quick-reference paths

| Surface | Path |
|---|---|
| App source | `/Users/digitalalchemist/Development/conan/` |
| Licensing issuer | `/Users/digitalalchemist/Development/conan-license/` (deployed: license.conan.sh) |
| Marketing | `/Users/digitalalchemist/Development/conan-marketing/` (deployed: conan.sh) |
| Apple Team ID | `4P6GX328VY` |
| Apple Developer ID identity | `Developer ID Application: Randy WhatMatters (4P6GX328VY)` |
| Notarytool keychain profile | `conan-notarize` |
| Polar org slug | `whatmatters` |
| Polar product | `Conan Premium` ($29 one-time) |
| Polar webhook target | `https://license.conan.sh/api/polar-webhook` |
| Webhook events | `order.created`, `order.refunded` |
| Public key bundled in app | `ui/src/lib/license.ts` |
| BUY_PREMIUM_URL location | [`ui/src/components/SettingsView.tsx:965`](../ui/src/components/SettingsView.tsx#L965) |
| Release script | `scripts/release.mjs` (`npm run release`) |
| JWT edition claim | `v1` (accepted via `ACCEPTED_EDITIONS = {"v1"}`) |
