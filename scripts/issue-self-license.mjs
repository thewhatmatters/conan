#!/usr/bin/env node
/**
 * scripts/issue-self-license.mjs — mint a creator/dev Premium JWT locally.
 *
 *   node scripts/issue-self-license.mjs --email randy@whatmatters.so
 *
 * The output is a Tauri-updater-shaped Premium license JWT signed with the
 * same Ed25519 key the conan-license/ Vercel issuer uses. Paste it into
 * Settings ▸ License → Apply, and the running Conan flips to Premium —
 * same code path real customers will run, no special creator-bypass.
 *
 * Use cases:
 *   - Smoke-testing the Premium state in the bundled .app without going
 *     through Polar
 *   - Issuing a permanent creator license for your own daily use
 *   - Re-issuing a license if you ever wipe local state
 *
 * Private key lookup order (FAIL HARD if none found — never invents a key):
 *   1. $CONAN_LICENSE_PRIVATE_KEY                      (base64url, 32 bytes)
 *   2. ~/.conan/license-private.key                    (one line, same format)
 *
 * The key MUST match the public key bundled in ui/src/lib/license.ts (which
 * is what the verifier checks against), or the JWT this script produces
 * won't unlock anything. If you've rotated the key, update both this
 * script's inputs and the bundled public key + ship a new app version
 * before any customer holds an old-key JWT.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// @noble/ed25519 v3 wants this wired explicitly for sync sign/verify
ed.hashes.sha512 = sha512;

/* ───── Configuration — matches the verifier in ui/src/lib/license.ts ──── */

const ISSUER = "conan.sh";
const EDITION = "v1";
/** ~2130-01-01 UTC. Same paranoia floor the real issuer uses — see
 *  docs/v4.7-licensing-design.md §1 "JWT exp: paranoia floor only". */
const EXP_PARANOIA_FLOOR_S = 5049129600;

const PRIVATE_KEY_ENV = "CONAN_LICENSE_PRIVATE_KEY";
const PRIVATE_KEY_FILE = path.join(homedir(), ".conan", "license-private.key");

/* ───── helpers ───────────────────────────────────────────────────────── */

function die(msg) {
  console.error(`[issue-self-license] FATAL: ${msg}`);
  process.exit(1);
}

function b64urlEncode(input) {
  const buf =
    typeof input === "string"
      ? Buffer.from(input)
      : Buffer.isBuffer(input)
        ? input
        : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecodeToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return new Uint8Array(Buffer.from(std, "base64"));
}

/** Find the Ed25519 32-byte seed. Returns Uint8Array(32). */
function loadPrivateKey() {
  const fromEnv = process.env[PRIVATE_KEY_ENV];
  let source;
  let seedB64;
  if (fromEnv && fromEnv.length > 0) {
    seedB64 = fromEnv.trim();
    source = `env $${PRIVATE_KEY_ENV}`;
  } else if (existsSync(PRIVATE_KEY_FILE)) {
    seedB64 = readFileSync(PRIVATE_KEY_FILE, "utf8").trim();
    source = PRIVATE_KEY_FILE;
  } else {
    die(
      `no private key found.\n\n` +
        `Set one of:\n` +
        `  export ${PRIVATE_KEY_ENV}='<base64url-encoded 32-byte seed>'\n` +
        `OR\n` +
        `  mkdir -p ${path.dirname(PRIVATE_KEY_FILE)} && chmod 700 ${path.dirname(PRIVATE_KEY_FILE)}\n` +
        `  echo '<base64url-encoded 32-byte seed>' > ${PRIVATE_KEY_FILE}\n` +
        `  chmod 600 ${PRIVATE_KEY_FILE}`,
    );
  }
  const seed = b64urlDecodeToBytes(seedB64);
  if (seed.length !== 32) {
    die(
      `private key from ${source} decoded to ${seed.length} bytes, expected 32 ` +
        `(Ed25519 seeds are exactly 32 bytes — check the format).`,
    );
  }
  return { seed, source };
}

/** Format the lifetime-paranoia exp as a human-readable ISO date for the
 *  printed summary, since the raw number reads as "ages from now" noise. */
function formatExp(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/* ───── main ─────────────────────────────────────────────────────────── */

const { values: args } = parseArgs({
  options: {
    email: { type: "string" },
    sub: { type: "string" }, // optional override for the sub claim
    "order-id": { type: "string" }, // optional override for polarOrderId
  },
});

if (!args.email) {
  die(
    `--email is required. Example:\n` +
      `  node scripts/issue-self-license.mjs --email randy@whatmatters.so`,
  );
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) {
  die(`--email "${args.email}" doesn't look like an email.`);
}

const { seed, source } = loadPrivateKey();

const nowS = Math.floor(Date.now() / 1000);
const sub = args.sub || `lic_creator_${nowS.toString(36)}`;
const polarOrderId = args["order-id"] || `creator-self-issued-${nowS}`;

const header = { alg: "EdDSA", typ: "JWT" };
const payload = {
  sub,
  email: args.email,
  tier: "premium",
  iat: nowS,
  exp: EXP_PARANOIA_FLOOR_S,
  edition: EDITION,
  iss: ISSUER,
  polarOrderId,
};

const headerB64 = b64urlEncode(JSON.stringify(header));
const payloadB64 = b64urlEncode(JSON.stringify(payload));
const signingInput = `${headerB64}.${payloadB64}`;

// @noble/ed25519's signAsync handles the SHA-512 + EdDSA dance.
const sig = await ed.signAsync(Buffer.from(signingInput, "utf8"), seed);
const sigB64 = b64urlEncode(Buffer.from(sig));

const jwt = `${signingInput}.${sigB64}`;

// Human-friendly summary first, then the JWT on its own line so it's
// trivial to pipe through pbcopy.
console.error(""); // blank to stderr to keep stdout = the JWT only
console.error(`[issue-self-license] minted Premium JWT`);
console.error(`  source:       ${source}`);
console.error(`  sub:          ${sub}`);
console.error(`  email:        ${args.email}`);
console.error(`  tier:         premium`);
console.error(`  edition:      ${EDITION}`);
console.error(`  exp:          ${EXP_PARANOIA_FLOOR_S} (${formatExp(EXP_PARANOIA_FLOOR_S)})`);
console.error(`  polarOrderId: ${polarOrderId}`);
console.error(``);
console.error(`Paste this into Settings ▸ License ▸ Apply:`);
console.error(``);
console.log(jwt);
console.error(``);
console.error(`(or pipe: node scripts/issue-self-license.mjs --email ... | pbcopy)`);
