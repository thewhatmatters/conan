// WHA-139 (B1): is this a Sagan project?
//
// Sagan installs as a `.sagan/` overlay at the root of an existing repo
// (thewhatmatters/sagan). Conan surfaces the Sagan UI only when the marker is
// there and readable — and, crucially, distinguishes "not a Sagan project" from
// "a Sagan project Conan cannot read". Those look identical to a user staring
// at a missing tab, which is why they are separate states here.
//
// Root is the REPO root, not the cwd: a spawn inside `repo/packages/api` is
// still inside the Sagan project rooted at `repo`.
import fs from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../agent/threads.js";

export type SaganState =
  /** No `.sagan/sagan.yaml` anywhere at the root. Not a Sagan project. */
  | "absent"
  /** Marker present, readable, and shaped like a Sagan manifest. */
  | "valid"
  /** Marker present but unreadable, empty, or not shaped like a manifest.
   *  Deliberately NOT `absent` — a broken overlay is a thing to fix, and
   *  silently hiding the surface would hide the reason. */
  | "invalid"
  /** Marker declares a schema version this build does not know. */
  | "unsupported-version";

export interface SaganCapability {
  state: SaganState;
  /** Repo root the marker was looked for in, or null when there is no root. */
  root: string | null;
  /** Absolute path to the marker, present whenever the state is not `absent`. */
  manifestPath: string | null;
  /** Declared schema version, or null — v0 declares none. */
  version: string | null;
  /** Why, for the non-valid states. Shown to a human, so it names the file. */
  reason?: string;
}

/** Marker path relative to the repo root. */
export const MARKER = path.join(".sagan", "sagan.yaml");

/** Schema versions this build understands. v0 declares no version field at
 *  all, so absence is the common case and is NOT unsupported. Add to this set
 *  when a version lands; anything else is refused rather than guessed at. */
const KNOWN_VERSIONS = new Set(["0", "v0", "1", "v1"]);

/** Top-level keys from the v0 manifest (`sagan.yaml` in the reference repo).
 *  v0 has no published schema, so this is a shape smell-test — "is this a
 *  Sagan manifest rather than a stray file" — not validation. */
const ANCHOR_KEYS = ["pm", "bindings", "rules", "critique", "providers", "gates"];

/**
 * Read the top-level keys and any declared version from a YAML document.
 *
 * NOT a YAML parser, and deliberately so: detection needs to know which keys
 * exist at column zero and nothing else, and the repo has no YAML dependency.
 * The moment anything needs to read *values* out of `sagan.yaml` — bindings,
 * role paths, round caps — this must be replaced by a real parser rather than
 * extended. It ignores comments and any line that is indented, which is what
 * makes it safe for key detection and useless for anything deeper.
 */
function readTopLevel(text: string): { keys: Set<string>; version: string | null } {
  const keys = new Set<string>();
  let version: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || /^\s/.test(line) || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    keys.add(key);
    if (key === "schemaVersion" || key === "version") {
      const value = match[2]!.split("#")[0]!.trim().replace(/^["']|["']$/g, "");
      if (value) version = value;
    }
  }
  return { keys, version };
}

/**
 * Sagan capability for a working directory. Pure and cheap — call it on project
 * open and project switch. There is no file watcher in v1 (WHA-139 AC5), so a
 * `.sagan/` created while a project is already open is not noticed until the
 * next switch; that is a deliberate scope line, not an oversight.
 */
export function detectSagan(cwd: string | null): SaganCapability {
  const none: SaganCapability = {
    state: "absent",
    root: null,
    manifestPath: null,
    version: null,
  };
  if (!cwd) return none;

  const root = findRepoRoot(cwd) ?? cwd;
  const manifestPath = path.join(root, MARKER);

  const base: SaganCapability = { state: "absent", root, manifestPath, version: null };

  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    // Only "there is no such file" is absent. Anything else — a directory
    // where the marker should be, a permission failure — is a Sagan overlay
    // Conan cannot read, and reporting that as `absent` would hide the one
    // fact that lets someone fix it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...none, root };
    return {
      ...base,
      state: "invalid",
      reason: `${MARKER} could not be read (${code ?? "unknown error"})`,
    };
  }

  if (!text.trim()) {
    return { ...base, state: "invalid", reason: `${MARKER} is empty` };
  }

  const { keys, version } = readTopLevel(text);
  if (!ANCHOR_KEYS.some((k) => keys.has(k))) {
    return {
      ...base,
      state: "invalid",
      version,
      reason: `${MARKER} has no recognisable Sagan keys`,
    };
  }
  if (version !== null && !KNOWN_VERSIONS.has(version)) {
    return {
      ...base,
      state: "unsupported-version",
      version,
      reason: `${MARKER} declares schema version ${version}, which this build does not support`,
    };
  }
  return { ...base, state: "valid", version };
}
