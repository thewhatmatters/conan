import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, HOME } from "../paths.js";

/**
 * Shell integration: make the pty's shell emit OSC 7 (the cwd-report escape,
 * `ESC ] 7 ; file://host/path ST`) on every prompt, so the gateway can follow
 * the active terminal's working directory as the user `cd`s around (US-002).
 *
 * Two shells are wired:
 *  - **zsh** (the macOS default) via a generated `ZDOTDIR`. zsh reads ALL of its
 *    startup files (`.zshenv`/`.zprofile`/`.zshrc`/`.zlogin`) from `$ZDOTDIR`,
 *    so we point it at a small generated dir whose files first source the user's
 *    real ones (preserving their config) and then register an OSC 7 `precmd`
 *    hook. Using `ZDOTDIR` (rather than editing the user's `.zshrc`) keeps the
 *    integration non-destructive and survives the `exec zsh -i -l` fallback the
 *    pty launches with, because the exec'd shell inherits `ZDOTDIR`.
 *  - **bash** via `PROMPT_COMMAND` — a plain env var bash runs before each
 *    prompt; we prepend the same OSC 7 printf. zsh ignores `PROMPT_COMMAND`, so
 *    setting both is harmless regardless of which shell actually runs.
 *
 * Everything here is best-effort: if the generated dir can't be written we
 * return no env additions and the pty launches exactly as before (the
 * process-cwd polling fallback in US-003 then covers shells without OSC 7).
 */

/** Where the generated zsh startup files live. */
const ZDOTDIR = path.join(DATA_DIR, "shell-integration", "zdotdir");

/**
 * The zsh `precmd` hook, appended to our generated `.zshrc`. Emits OSC 7 with
 * the current `$PWD` before each prompt (and once at startup so the initial cwd
 * is reported immediately). `$HOST` falls back to `localhost` so the URI is
 * always well-formed.
 */
// NOTE: plain double-quoted strings (not template literals) so the shell's own
// `${HOST:-localhost}` / `$PWD` survive verbatim instead of being interpreted as
// JS interpolation. Backslashes are escaped for JS; what reaches the file is the
// shell printf source (e.g. `\e]7;...\e\\`).
const ZSH_OSC7_HOOK =
  "\n# --- Conan shell integration (OSC 7 cwd reporting) -------------------------\n" +
  "_conan_emit_osc7() { printf '\\e]7;file://%s%s\\e\\\\' \"${HOST:-localhost}\" \"$PWD\" }\n" +
  "autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd _conan_emit_osc7\n" +
  "_conan_emit_osc7\n";

/**
 * The bash `PROMPT_COMMAND` snippet — same OSC 7 emit, expressed as a one-liner
 * bash runs before each prompt. Prepended to any inherited `PROMPT_COMMAND`.
 */
const BASH_OSC7_CMD =
  "printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"$PWD\"";

/** True once we've generated the ZDOTDIR for this process (idempotent guard). */
let zdotdirReady = false;

/**
 * Generate the zsh startup files under {@link ZDOTDIR}. Each sources the user's
 * real counterpart (from `$CONAN_REAL_ZDOTDIR`, set in the pty env) so their
 * config still loads; `.zshrc` additionally registers the OSC 7 hook. Returns
 * whether the dir is usable. Best-effort — any write failure disables the zsh
 * path for this process.
 */
function ensureZdotdir(): boolean {
  if (zdotdirReady) return true;
  try {
    fs.mkdirSync(ZDOTDIR, { recursive: true });
    // Source the user's real file (if present) then, for .zshrc, add our hook.
    const sourceReal = (name: string) =>
      `[ -f "$CONAN_REAL_ZDOTDIR/${name}" ] && source "$CONAN_REAL_ZDOTDIR/${name}"\n`;
    fs.writeFileSync(path.join(ZDOTDIR, ".zshenv"), sourceReal(".zshenv"));
    fs.writeFileSync(path.join(ZDOTDIR, ".zprofile"), sourceReal(".zprofile"));
    fs.writeFileSync(path.join(ZDOTDIR, ".zlogin"), sourceReal(".zlogin"));
    fs.writeFileSync(
      path.join(ZDOTDIR, ".zshrc"),
      sourceReal(".zshrc") + ZSH_OSC7_HOOK,
    );
    zdotdirReady = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment additions that turn on OSC 7 cwd reporting for the pty's shell.
 * Merged over the base pty env. Returns `{}` when the zsh integration couldn't
 * be set up (the bash `PROMPT_COMMAND` is still returned — it needs no files).
 */
export function shellIntegrationEnv(
  baseEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  // bash: prepend our OSC 7 emit to any inherited PROMPT_COMMAND.
  const existing = baseEnv.PROMPT_COMMAND;
  env.PROMPT_COMMAND = existing ? `${BASH_OSC7_CMD}; ${existing}` : BASH_OSC7_CMD;

  // zsh: redirect ZDOTDIR at our generated dir, remembering the real one so our
  // startup files can source the user's config.
  if (ensureZdotdir()) {
    env.CONAN_REAL_ZDOTDIR = baseEnv.ZDOTDIR ?? HOME;
    env.ZDOTDIR = ZDOTDIR;
  }

  return env;
}

/**
 * Parse OSC 7 directory-report sequences out of a pty output chunk's rolling
 * tail, returning the absolute path of the LAST complete sequence found (or null
 * when none has fully arrived yet). The sequence is
 * `ESC ] 7 ; file://<host>/<path> ST`, where ST is `BEL` (`\x07`) or `ESC \`.
 * The path is percent-decoded leniently; a malformed URI contributes nothing.
 */
export function parseOsc7Cwd(scan: string): string | null {
  // OSC 7 payload runs from `ESC ] 7 ;` to the next terminator (BEL or ESC \).
  const re = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let path: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scan)) !== null) {
    if (m[1] === undefined) continue;
    const parsed = uriToPath(m[1]);
    if (parsed) path = parsed; // keep the last complete one
  }
  return path;
}

/** Extract an absolute filesystem path from a `file://host/path` OSC 7 URI. */
function uriToPath(uri: string): string | null {
  // Accept both `file://host/abs/path` and a bare `file:///abs/path`.
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(uri);
  const raw = m?.[1];
  if (raw === undefined) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.startsWith("/") ? decoded : null;
  } catch {
    return raw.startsWith("/") ? raw : null;
  }
}
