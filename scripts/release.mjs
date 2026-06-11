// scripts/release.mjs — produce a Developer-ID-signed + notarized Conan.app
// and Conan_<version>_<triple>.dmg ready for public distribution.
//
//   npm run release
//
// Prereqs (one-time, by the human running this):
//   1. Apple Developer Program membership, Developer ID Application cert
//      installed in the login Keychain. Verify with:
//        security find-identity -v -p codesigning
//      Expect a line: "Developer ID Application: <Name> (<TEAM_ID>)"
//   2. App-specific password stored in the Keychain under the notarytool
//      profile `conan-notarize`. One-time:
//        xcrun notarytool store-credentials conan-notarize \
//          --apple-id "<your-apple-id>" --team-id "<TEAM_ID>"
//      Verify with: xcrun notarytool history --keychain-profile conan-notarize
//      (a clean "No submission history" means auth works).
//
// What this script does, in order:
//   1. Resolves the Developer ID identity from the Keychain (errors loudly
//      if it isn't there — better than building unsigned and learning later).
//   2. Rebuilds the sidecar pre-signed with the Developer ID + hardened-
//      runtime entitlements (build-sidecar.mjs reads APPLE_SIGNING_IDENTITY).
//   3. Runs `tauri build` with APPLE_SIGNING_IDENTITY set so Tauri signs
//      the .app + .dmg. We deliberately do NOT set APPLE_ID/PASSWORD/
//      TEAM_ID here — Tauri's auto-notarization needs the raw password,
//      and ours lives in a notarytool-managed Keychain item we can't read.
//   4. Submits the .app to Apple's notarization service via `xcrun notarytool
//      submit --keychain-profile conan-notarize --wait` (~5–10 min).
//   5. Staples the notarization ticket onto the .app AND the .dmg so first-
//      launch works offline.
//   6. Verifies with `spctl --assess` that Gatekeeper accepts the bundle
//      (= signature + notarization both correct).
//
// Both signing AND notarization are required — Gatekeeper rejects either
// missing-signature OR missing-notarization. Don't skip step 6.

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTARYTOOL_PROFILE = "conan-notarize";
const TEAM_ID = "4P6GX328VY";
/** Tauri updater minisign-format private key. Generated one-time via
 *  `npx @tauri-apps/cli signer generate -w ~/.conan/conan-updater.key`,
 *  stored at 600 perms, backed up to 1Password. The public counterpart is
 *  bundled into the .app via `tauri.conf.json` plugins.updater.pubkey. */
const UPDATER_PRIVATE_KEY_PATH = path.join(
  homedir(),
  ".conan",
  "conan-updater.key",
);
/** Empty because the keypair was generated with --no-password. Switch to
 *  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD if/when we rotate to a
 *  passphrase-protected key. */
const UPDATER_PRIVATE_KEY_PASSWORD = "";
/** GitHub repo coordinates that `gh release create` targets. The updater's
 *  endpoint URL in tauri.conf.json points at `releases/latest/download/...`
 *  on this same repo, so the two must match. */
const GH_REPO = "thewhatmatters/conan";

function die(msg) {
  console.error(`\n[release] FATAL: ${msg}\n`);
  process.exit(1);
}

function step(n, title) {
  console.log(`\n━━ [release] ${n}. ${title} ━━`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0)
    die(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
  return r;
}

// ---- 0. Guardrails: no live Conan instance interfering with the bundle ---
// A running Conan.app keeps its gateway alive, whose cwd is inside
// Conan.app/Contents/Resources. The next claude session that bash-tools into
// that cwd will create `.claude/settings.local.json` there, post-signing —
// invalidating the .app's resource seal. Notarization then rejects the .dmg
// with "The signature of the binary is invalid." Kill any live instance up
// front so the build target is exclusively ours.

step(0, "guardrail: no running Conan.app");
{
  const r = spawnSync(
    "pgrep",
    ["-f", "Conan\\.app/Contents/MacOS/(app|conan-gateway)"],
    { encoding: "utf8" },
  );
  const pids = (r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pids.length) {
    console.log(`[release] killing ${pids.length} stale Conan process(es): ${pids.join(", ")}`);
    spawnSync("kill", pids);
    // Give the gateway a beat to exit and free the :3747 port.
    spawnSync("sleep", ["1"]);
  } else {
    console.log("[release] no live Conan.app — clean");
  }
}

// ---- 1. Resolve the Developer ID Application identity from Keychain ------

step(1, "resolving Developer ID identity");
const ident = (() => {
  const r = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (r.status !== 0) die(`security find-identity failed: ${r.stderr}`);
  const line = r.stdout
    .split("\n")
    .find(
      (l) =>
        l.includes("Developer ID Application:") && l.includes(`(${TEAM_ID})`),
    );
  if (!line)
    die(
      `No "Developer ID Application: … (${TEAM_ID})" cert in Keychain. ` +
        `Create one in Xcode ▸ Settings ▸ Accounts ▸ Manage Certificates ▸ + ▸ Developer ID Application.`,
    );
  const m = /"([^"]+)"/.exec(line);
  if (!m) die(`couldn't parse identity line: ${line}`);
  return m[1];
})();
console.log(`[release] identity: ${ident}`);

// Sanity-check the notarytool profile up-front so we fail fast on misconfig
// rather than after a 5-minute build.
{
  const r = spawnSync(
    "xcrun",
    ["notarytool", "history", "--keychain-profile", NOTARYTOOL_PROFILE],
    { encoding: "utf8" },
  );
  if (r.status !== 0)
    die(
      `notarytool can't auth with profile '${NOTARYTOOL_PROFILE}'. Run:\n` +
        `  xcrun notarytool store-credentials ${NOTARYTOOL_PROFILE} ` +
        `--apple-id "<your-apple-id>" --team-id "${TEAM_ID}"\n` +
        `stderr: ${r.stderr?.trim()}`,
    );
  console.log(`[release] notarytool profile '${NOTARYTOOL_PROFILE}' authenticates`);
}

// ---- 2. Rebuild the sidecar with Developer ID + entitlements -------------

step(2, "rebuilding sidecar (Developer ID + hardened runtime)");
const entitlements = path.join(ROOT, "src-tauri", "Conan.entitlements");
if (!existsSync(entitlements)) die(`entitlements missing: ${entitlements}`);

if (!existsSync(UPDATER_PRIVATE_KEY_PATH)) {
  die(
    `Tauri updater private key missing: ${UPDATER_PRIVATE_KEY_PATH}\n` +
      `Generate one-time:\n` +
      `  CI=true npx @tauri-apps/cli signer generate -p "" -w ${UPDATER_PRIVATE_KEY_PATH}\n` +
      `Then back it up to 1Password.`,
  );
}
// IMPORTANT: TAURI_SIGNING_PRIVATE_KEY must be the KEY CONTENTS (base64
// string), NOT a file path. `tauri build` is lenient and will auto-detect
// a path that happens to exist; `tauri signer sign` is strict and fails
// with "Invalid symbol 46, offset 24" (the `.` in the path) when handed a
// path. Read the file content here once and pass the contents.
const UPDATER_PRIVATE_KEY_CONTENTS = readFileSync(
  UPDATER_PRIVATE_KEY_PATH,
  "utf8",
);

const signEnv = {
  ...process.env,
  APPLE_SIGNING_IDENTITY: ident,
  APPLE_ENTITLEMENTS: entitlements,
  // tauri-plugin-updater minisign keys — passed via env, NOT in the
  // tauri.conf.json (the public key is bundled there). Tauri's build step
  // signs the auto-generated .app.tar.gz with this when
  // bundle.createUpdaterArtifacts is true; we also pass them through to
  // the manual re-sign in step 5a-updater after notarization+staple.
  TAURI_SIGNING_PRIVATE_KEY: UPDATER_PRIVATE_KEY_CONTENTS,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: UPDATER_PRIVATE_KEY_PASSWORD,
  // Tauri's bundler reads CI=true for headless DMG (skips AppleScript window
  // styling that hangs without a GUI session).
  CI: "true",
  PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH ?? ""}`,
};

run("node", ["scripts/build-sidecar.mjs"], { env: signEnv, cwd: ROOT });

// ---- 3. Tauri build (signs .app + .dmg) ----------------------------------

step(3, "tauri build (signing only — notarization is step 4)");
run("npm", ["run", "tauri:build"], { env: signEnv, cwd: ROOT });

// Resolve the freshly built artifacts.
const version = (() => {
  try {
    return (
      JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"))
        .version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
})();
const bundleDir = path.join(ROOT, "src-tauri", "target", "release", "bundle");
const appPath = path.join(bundleDir, "macos", "Conan.app");
const dmgPath = path.join(bundleDir, "dmg", `Conan_${version}_aarch64.dmg`);

for (const p of [appPath, dmgPath]) {
  if (!existsSync(p)) die(`expected artifact missing: ${p}`);
}

// 3b. Scrub stray state directories that any in-bundle gateway/Claude run
// might have created inside the .app (`.claude/` for permission grants,
// `.data/` for the gateway sqlite). Apple's verifier treats them as "files
// added since signing" and rejects notarization; cheaper to nuke them than
// to try to outrace the race. Empty-ish in normal runs; defensive only.
step("3b", "scrubbing stray state from .app");
for (const stray of [".claude", ".data", ".DS_Store"]) {
  const p = path.join(appPath, "Contents", "Resources", stray);
  if (existsSync(p)) {
    console.log(`[release] removing stray: ${path.relative(ROOT, p)}`);
    rmSync(p, { recursive: true, force: true });
  }
}
// Re-sign the .app since we just modified its contents (no-op when there
// was nothing to scrub).
run("codesign", [
  "--force",
  "-s",
  ident,
  "--options",
  "runtime",
  "--timestamp",
  "--entitlements",
  entitlements,
  appPath,
]);

// ---- 4. Notarize the .app via notarytool keychain profile ----------------

step(4, "notarizing .app (Apple round-trip ~5–10 min)");
// notarytool wants a ZIP for .app submissions (the .dmg is also valid, but
// zipping the .app + notarizing that lets us staple both .app and .dmg from
// the same ticket — and is the Apple-recommended flow).
const tmpDir = mkdtempSync(path.join(tmpdir(), "conan-notarize-"));
const appZip = path.join(tmpDir, "Conan.app.zip");
console.log(`[release] zipping .app for submission → ${appZip}`);
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, appZip]);

console.log("[release] submitting to notarytool (this is the slow step) …");
run("xcrun", [
  "notarytool",
  "submit",
  appZip,
  "--keychain-profile",
  NOTARYTOOL_PROFILE,
  "--wait",
]);

// ---- 5a. Staple the .app first (.dmg gets its own pass below) ------------

step("5a", "stapling .app");
run("xcrun", ["stapler", "staple", appPath]);

// ---- 5a-updater. Re-create + re-sign the .app.tar.gz from STAPLED .app ---
//
// `tauri build` already produced a .app.tar.gz at step 3, but from the
// pre-staple .app. The updater downloads this archive and replaces the
// running app — if the payload's .app isn't stapled, Gatekeeper has to
// fetch notarization status online on first launch (works, but breaks
// offline launches). Cheaper to regenerate the archive + signature now
// that the .app is stapled.

step("5a-updater", "regenerating updater archive from STAPLED .app");
const updaterArchive = path.join(
  bundleDir,
  "macos",
  `Conan_${version}_aarch64.app.tar.gz`,
);
const updaterSig = `${updaterArchive}.sig`;
rmSync(updaterArchive, { force: true });
rmSync(updaterSig, { force: true });
// COPYFILE_DISABLE + --no-mac-metadata: macOS bsdtar otherwise stores the
// xattrs that signing/stapling leave on bundle files as AppleDouble `._*`
// entries, which tauri-plugin-updater's unpacker rejects ("failed to unpack
// `._Conan.app`") — bricking the update for every installed client. Bit us
// on 1.0.1; `tar -t` HIDES these entries (bsdtar recombines them on read),
// so verify with Python's tarfile if you ever need to check an archive.
run(
  "tar",
  [
    "czf",
    updaterArchive,
    "--no-mac-metadata",
    "-C",
    path.dirname(appPath),
    path.basename(appPath),
  ],
  { env: { ...process.env, COPYFILE_DISABLE: "1" } },
);
// `tauri signer sign` reads TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] from env
// (set in signEnv above) and writes `<file>.sig` next to the input.
run("npx", ["--yes", "@tauri-apps/cli", "signer", "sign", updaterArchive], {
  env: signEnv,
  cwd: ROOT,
});
for (const p of [updaterArchive, updaterSig]) {
  if (!existsSync(p)) die(`updater artifact missing: ${p}`);
}

// ---- 5b. Rebuild + sign + notarize + staple the .dmg ---------------------
//
// Why: the .dmg Tauri built in step 3 contains the UN-stapled .app and its
// own hash predates the notarization, so `stapler` can't fetch a ticket for
// it. Regenerate the .dmg from the stapled .app so its contents are correct,
// then submit + staple it. We use hdiutil directly — CI=true Tauri DMGs are
// drag-to-install with no custom window, so hdiutil produces an equivalent
// volume.

step("5b", "rebuilding .dmg from stapled .app");
const newDmg = path.join(path.dirname(dmgPath), `Conan_${version}_aarch64.dmg`);
// hdiutil refuses to overwrite an existing path; remove the Tauri .dmg first.
rmSync(newDmg, { force: true });
run("hdiutil", [
  "create",
  "-volname",
  `Conan ${version}`,
  "-srcfolder",
  appPath,
  "-ov",
  "-format",
  "UDZO", // compressed read-only
  "-fs",
  "HFS+",
  newDmg,
]);
// Codesign the .dmg with the same identity (Tauri did this for the original).
run("codesign", [
  "--force",
  "-s",
  ident,
  "--timestamp",
  newDmg,
]);

step("5c", "notarizing .dmg (second Apple round-trip ~5–10 min)");
run("xcrun", [
  "notarytool",
  "submit",
  newDmg,
  "--keychain-profile",
  NOTARYTOOL_PROFILE,
  "--wait",
]);
run("xcrun", ["stapler", "staple", newDmg]);

// ---- 6. Verify Gatekeeper accepts both -----------------------------------

step(6, "Gatekeeper assessment (spctl)");
for (const target of [appPath, dmgPath]) {
  // spctl exit 0 = accepted; non-zero = rejected. Stderr carries the verdict.
  const r = spawnSync(
    "spctl",
    [
      "--assess",
      "--type",
      target.endsWith(".dmg") ? "open" : "execute",
      "--context",
      "context:primary-signature",
      "--verbose",
      target,
    ],
    { encoding: "utf8" },
  );
  const verdict = (r.stderr || r.stdout || "").trim().split("\n").pop();
  if (r.status === 0) {
    console.log(`[release] ✅ ${path.basename(target)} — ${verdict}`);
  } else {
    die(`spctl rejected ${target}: ${verdict}`);
  }
}

// ---- 6b. Stable-named DMG copy (the marketing site's Download link) -------
//
// conan.sh's Download button points at a version-LESS URL so it never needs
// updating per release:
//   https://github.com/<repo>/releases/latest/download/Conan_aarch64.dmg
// GitHub's `latest/download/<name>` resolves to whichever release is "latest"
// but requires the exact asset NAME to exist there — and Tauri bakes the
// version into the real DMG (Conan_<version>_aarch64.dmg), which would 404 the
// link on the next release. So we ship a byte-identical copy under the stable
// name alongside the versioned one. The copy preserves the embedded codesign
// signature AND the stapled notarization ticket (both live inside the .dmg
// file), so the stable asset is just as Gatekeeper-valid as the original.
const stableDmg = path.join(path.dirname(dmgPath), "Conan_aarch64.dmg");
copyFileSync(dmgPath, stableDmg);
console.log(`[release] wrote stable-named copy ${stableDmg}`);

// ---- 7. Emit latest.json (the updater manifest) --------------------------
//
// tauri-plugin-updater polls a URL like
// `https://github.com/<repo>/releases/latest/download/latest.json`. The JSON
// shape is fixed by Tauri's v2 spec; the `signature` field is the literal
// contents of the .sig file (a single line of base64). We write it next to
// the .dmg/.tar.gz so the `gh release create` invocation below picks it up.

step(7, "emitting latest.json (updater manifest)");
const latestJsonPath = path.join(path.dirname(updaterArchive), "latest.json");
const signature = readFileSync(updaterSig, "utf8").trim();
const releaseUrl = `https://github.com/${GH_REPO}/releases/download/v${version}/${path.basename(updaterArchive)}`;
const manifest = {
  version,
  pub_date: new Date().toISOString(),
  notes: `Conan ${version}. See https://github.com/${GH_REPO}/releases/tag/v${version} for the changelog.`,
  platforms: {
    "darwin-aarch64": { signature, url: releaseUrl },
  },
};
writeFileSync(latestJsonPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[release] wrote ${latestJsonPath}`);

// Clean up the temp zip.
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n[release] done. ✅ Signed, notarized, stapled, Gatekeeper-accepted.
  .app:           ${appPath}
  .dmg:           ${dmgPath}
  .dmg (stable):  ${stableDmg}
  updater .tar.gz:${updaterArchive}
  updater .sig:   ${updaterSig}
  manifest:       ${latestJsonPath}
`);

// Show what shipped (informational).
try {
  console.log(`\n[release] codesign details:`);
  execFileSync("codesign", ["-dv", "--verbose=2", appPath], { stdio: "inherit" });
} catch {
  /* informational only */
}

// ---- 8. Print the gh release create command ------------------------------
//
// Intentionally NOT auto-running gh — destructive operations stay manual so
// a stray re-run doesn't clobber a published release. Copy-paste this:
console.log(`
[release] next step — publish the release:

  git tag v${version} && git push origin v${version}
  gh release create v${version} \\
    --repo ${GH_REPO} \\
    --title "Conan ${version}" \\
    --notes "See CHANGELOG.md for details." \\
    "${dmgPath}" \\
    "${stableDmg}" \\
    "${updaterArchive}" \\
    "${updaterSig}" \\
    "${latestJsonPath}"

The updater client polls
  https://github.com/${GH_REPO}/releases/latest/download/latest.json
which 302-redirects to whichever release is marked "latest", so all currently
installed clients will auto-update once you publish.

The conan.sh Download button points at the stable-named copy:
  https://github.com/${GH_REPO}/releases/latest/download/Conan_aarch64.dmg
`);
