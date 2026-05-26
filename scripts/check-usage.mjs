#!/usr/bin/env node
// check-usage.mjs — scrape Claude Code's /usage panel via a node-pty session and
// print the parsed plan-utilization as JSON. A one-off precursor to v3 US-005.
// Output: {"percents":[fiveHour,sevenDay,...],"resetText":"...","ok":true,...}
import { spawn } from "node-pty";

const SHELL = process.env.SHELL || "/bin/zsh";
const term = spawn(SHELL, ["-lc", "claude"], {
  name: "xterm-256color",
  cols: 100,
  rows: 40,
  cwd: process.cwd(),
  env: process.env,
});

let buf = "";
term.onData((d) => (buf += d));

const strip = (s) =>
  s
    .replace(/\x1B\][^\x07\x1B]*(\x07|\x1B\\)/g, "") // OSC
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "") // CSI
    .replace(/\x1B[()][AB0]/g, "")
    .replace(/\x1B[=>]/g, "");

// Send /usage once the TUI has had time to boot + load MCPs.
setTimeout(() => term.write("/usage\r"), 6500);

const finish = () => {
  const clean = strip(buf);
  // Headline utilization reads as "N% used" (the 5h + weekly windows). The
  // "what's contributing" section uses "N% of your usage came from …" — exclude
  // those by matching ONLY the "% used" headline form.
  const usedPercents = [...clean.matchAll(/(\d{1,3})\s*%\s*used/gi)]
    .map((m) => +m[1])
    .filter((n) => n >= 0 && n <= 100);
  const resetMatch = clean.match(/resets?[^\n]{0,40}?(\d{1,2}(:\d{2})?\s*[ap]\.?m\.?)/i);
  console.log(
    JSON.stringify({
      ok: usedPercents.length > 0,
      // Conservative "near a limit?" signal = highest headline window % used.
      maxUsedPercent: usedPercents.length ? Math.max(...usedPercents) : null,
      usedPercents,
      resetText: resetMatch ? resetMatch[1] : null,
      tail: clean.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").slice(-1400),
    }),
  );
  try {
    term.write("\x03"); // Ctrl-C
    term.write("/exit\r");
  } catch {}
  setTimeout(() => {
    try { term.kill(); } catch {}
    process.exit(0);
  }, 400);
};

setTimeout(finish, 17000); // allow the panel's "Refreshing…" to settle
// hard safety
setTimeout(() => { try { term.kill(); } catch {} process.exit(0); }, 24000);
