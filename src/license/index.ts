/**
 * License storage — read/write the saved Premium license JWT to disk.
 *
 * The JWT itself is verified offline in the UI against the bundled Ed25519
 * public key ([ui/src/lib/license.ts](../../ui/src/lib/license.ts)); this
 * module is purely the persistence layer. The gateway exposes it via
 * `GET / PUT / DELETE /api/license`, called from the `useTier()` hook on
 * boot and from the Settings ▸ License paste tab.
 *
 * Storage shape (deliberate simplicity):
 *
 *   $CONAN_DATA_DIR/license.jwt    — one line, plain UTF-8, the JWT
 *
 * Why a plain file (not Keychain, not encrypted, not in the SQLite db):
 *
 *   - Survives app reinstall (the data dir persists across uninstalls).
 *   - Cross-machine is just file copy (legitimate use case per the design
 *     doc §6 — no per-device limit).
 *   - Easy to delete by users who want to revert to Free.
 *   - The JWT is the user's possession, not a secret FROM them — Keychain
 *     would suggest "Conan is hiding this from you" which is wrong.
 *
 * Per [docs/v4.7-licensing-design.md](../../docs/v4.7-licensing-design.md) §4.
 */
import fs from "node:fs";
import path from "node:path";
import { LICENSE_PATH } from "../paths.js";

/** Result envelope returned from every operation so the UI can render
 *  state without having to interpret `ENOENT` or other low-level errors. */
export interface LicenseFileState {
  /** The stored JWT, trimmed of whitespace. Null when no license is saved. */
  jwt: string | null;
  /** Absolute on-disk path. Surfaced so power users know where to back it up. */
  path: string;
}

/** Read the saved license JWT (or null when absent / unreadable). */
export function readLicense(): LicenseFileState {
  try {
    const raw = fs.readFileSync(LICENSE_PATH, "utf8").trim();
    // Defensive: an empty file is treated as "no license" rather than
    // "license = empty string", which would confuse the verifier.
    return { jwt: raw.length > 0 ? raw : null, path: LICENSE_PATH };
  } catch (e) {
    // ENOENT (no file) is the expected default state. Other errors
    // (permissions, IO) fall through to the same "no license" answer —
    // we'd rather show Free than crash on a flaky filesystem.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[license] read failed at ${LICENSE_PATH}:`, e);
    }
    return { jwt: null, path: LICENSE_PATH };
  }
}

/**
 * Persist the JWT to disk. The data dir is created if missing (matches the
 * pattern of every other file in DATA_DIR). The file is written with 0600
 * perms — same as `keypair.json` in conan-license — defence in depth.
 *
 * No validation here: the UI is the source of truth for "is this JWT
 * valid", and forcing validation backend-side would mean duplicating the
 * Ed25519 verifier in the gateway. Trusting the UI keeps the gateway
 * agnostic of license claims, which simplifies key rotation later.
 */
export function writeLicense(jwt: string): LicenseFileState {
  const trimmed = jwt.trim();
  if (!trimmed) throw new Error("refusing to write empty license");
  fs.mkdirSync(path.dirname(LICENSE_PATH), { recursive: true });
  fs.writeFileSync(LICENSE_PATH, trimmed + "\n", { mode: 0o600 });
  return { jwt: trimmed, path: LICENSE_PATH };
}

/**
 * Remove the saved license, dropping the user back to Free. Idempotent —
 * deleting a license that doesn't exist is fine and reported as success
 * (matches the user's intent: "be on Free").
 */
export function deleteLicense(): LicenseFileState {
  try {
    fs.unlinkSync(LICENSE_PATH);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[license] delete failed at ${LICENSE_PATH}:`, e);
    }
  }
  return { jwt: null, path: LICENSE_PATH };
}
