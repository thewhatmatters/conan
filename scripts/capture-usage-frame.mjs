// Capture a raw /usage frame from a real `claude` for parser fixtures (US-006).
// Spawns the same controlled pty as src/usage/probe.ts but never cuts off early:
// it records everything until the post-windows detail section renders (or the
// deadline hits), so the last-rendered "Current week (Sonnet only)" window is
// included. ⚠ Makes one billed request — run by hand, never on a timer.
//
//   node scripts/capture-usage-frame.mjs [out-file]
//
// Default out-file: src/usage/__fixtures__/usage-frame.txt (raw, ANSI intact —
// the parser owns the stripping, so fixtures must exercise it).

import * as pty from "node-pty";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "src/usage/__fixtures__/usage-frame.txt");
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";
const BOOT_MS = 5_000; // let claude boot before typing /usage (matches probe.ts)
const DEADLINE_MS = 45_000; // hard ceiling on the whole capture
const SETTLE_MS = 3_000; // keep recording after the detail section appears

const shell = process.env.SHELL ?? "/bin/zsh";
const term = pty.spawn(shell, ["-l", "-c", CLAUDE_BIN], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: process.env.HOME ?? process.cwd(),
  env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
});

let buf = "";
let settleTimer = null;
let done = false;

function finish(reason) {
  if (done) return;
  done = true;
  try {
    term.kill();
  } catch {}
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, buf);
  const stripped = buf
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, "");
  console.log(`captured ${buf.length} bytes (${reason}) -> ${OUT}`);
  console.log(`  five-hour window:   ${/Currentsession/i.test(stripped) ? "present" : "MISSING"}`);
  console.log(`  week (all models):  ${/Currentweek\(allmodels\)|Currentweek[^(]/i.test(stripped) ? "present" : "MISSING"}`);
  console.log(`  week (Sonnet only): ${/Currentweek\(Sonnetonly\)/i.test(stripped) ? "present" : "MISSING"}`);
  const sonnet = /Currentweek\(Sonnetonly\)[^]*?(\d{1,3})%used/i.exec(stripped);
  if (sonnet) console.log(`  Sonnet window pct:  ${sonnet[1]}%`);
  process.exit(0);
}

term.onData((d) => {
  buf += d;
  // The Sonnet-only window is the LAST thing we need — once it has rendered a
  // "% used", let the screen settle briefly, then stop. (The "contributing"
  // detail header can render BEFORE the Sonnet window, so it is not a safe
  // stop signal — that's exactly the probe bug this fixture exists to catch.)
  const stripped = buf.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+/g, "");
  if (!settleTimer && /Currentweek\(Sonnetonly\)[^]*?\d{1,3}%used/i.test(stripped)) {
    settleTimer = setTimeout(() => finish("Sonnet window rendered"), SETTLE_MS);
  }
});
term.onExit(() => finish("claude exited"));

setTimeout(() => term.write("/usage\r"), BOOT_MS);
setTimeout(() => finish("deadline"), DEADLINE_MS);
