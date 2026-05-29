#!/usr/bin/env node
// spike-mcp-tui.mjs — US-010 spike. Drive the /mcp TUI in a throwaway claude pty
// and capture the rendered frame after each scripted keypress, so we can document
// a deterministic navigation recipe for the auth driver (US-011).
//
// Usage:
//   node scripts/spike-mcp-tui.mjs                 # default step script
//   node scripts/spike-mcp-tui.mjs "down,down,enter"   # custom keys
//
// Keys: up,down,left,right,enter,esc,tab,q,<literal text>. Each step waits
// STEP_MS, captures the current screen (last frame), strips ANSI, and prints it
// boxed with a label. Frames are also written raw to scripts/fixtures/mcp-tui/.

import { spawn } from "node-pty";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHELL = process.env.SHELL || "/bin/zsh";
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";
const BOOT_MS = 6500;
const STEP_MS = 1800;
const OUT_DIR = join(process.cwd(), "scripts", "fixtures", "mcp-tui");

const KEYMAP = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  space: " ",
};

const stepArg = process.argv[2] ?? "capture,down,down,enter,capture";
const steps = stepArg.split(",").map((s) => s.trim()).filter(Boolean);

mkdirSync(OUT_DIR, { recursive: true });

const strip = (s) =>
  s
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][\dAB]/g, "")
    .replace(/\x1b[=>78Mc]/g, "");

const term = spawn(SHELL, ["-l", "-c", CLAUDE_BIN], {
  name: "xterm-256color",
  cols: 120,
  rows: 45,
  cwd: process.env.HOME || process.cwd(),
  env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
});

let buf = "";
term.onData((d) => (buf += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const captureLabel = (label, raw) => {
  const clean = strip(raw)
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  writeFileSync(join(OUT_DIR, `frame-${label}.raw`), raw);
  writeFileSync(join(OUT_DIR, `frame-${label}.txt`), clean);
  console.log(`\n========== FRAME: ${label} ==========`);
  console.log(clean);
  console.log(`========== /${label} (${clean.length} chars) ==========\n`);
};

async function run() {
  console.log(`Booting claude (${BOOT_MS}ms)…`);
  await sleep(BOOT_MS);

  console.log("Sending /mcp …");
  term.write("/mcp\r");
  await sleep(STEP_MS * 2);
  captureLabel("00-mcp-open", buf);

  let i = 1;
  for (const step of steps) {
    if (step === "capture") {
      captureLabel(`${String(i).padStart(2, "0")}-capture`, buf);
      i++;
      continue;
    }
    const seq = KEYMAP[step.toLowerCase()] ?? step;
    console.log(`Step ${i}: key "${step}"`);
    const before = buf.length;
    term.write(seq);
    await sleep(STEP_MS);
    // Show only what was emitted since this keypress (the redraw delta).
    captureLabel(`${String(i).padStart(2, "0")}-${step}`, buf.slice(before));
    i++;
  }

  // Exit cleanly.
  try {
    term.write("\x1b");
    await sleep(300);
    term.write("\x03");
    await sleep(200);
    term.write("/exit\r");
  } catch {}
  await sleep(500);
  try { term.kill(); } catch {}
  process.exit(0);
}

setTimeout(() => { try { term.kill(); } catch {} process.exit(1); }, BOOT_MS + STEP_MS * (steps.length + 4) + 8000);
run();
