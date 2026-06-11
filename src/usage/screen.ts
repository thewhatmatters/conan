// US-006 (1.0.2): reconstruct the rendered SCREEN from a raw pty stream.
//
// Claude Code's /usage TUI re-renders incrementally: when the slow-loading
// "Current week (Sonnet only)" window finally lands, the repaint is a DELTA —
// cells that already hold the right character are skipped with cursor moves,
// so the label never appears contiguously in the byte stream ("Sonnet only"
// arrives as e.g. "So…net…nly" interleaved with positioning sequences).
// Regex-parsing the ANSI-stripped stream therefore can NEVER see that window;
// only the reconstructed screen state can. We replay the stream through a
// headless xterm (the same terminal engine the UI renders with) and read the
// final buffer text, which the existing pure parsers then handle unchanged.

// @xterm/headless ships a UMD bundle whose named exports Node's CJS-ESM lexer
// can't see — import the module object and pull Terminal off it at runtime.
import xtermHeadless from "@xterm/headless";
import type { Terminal as TerminalType } from "@xterm/headless";

const { Terminal } = xtermHeadless as unknown as typeof import("@xterm/headless");

/** Matches the probe pty's geometry; passive captures pass the real pty's. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

/** Keep the whole /usage frame even when it scrolls past the viewport. */
const SCROLLBACK_LINES = 5_000;

/**
 * Replay a raw (ANSI-intact) pty stream through a headless terminal and return
 * the resulting screen text — every buffer line (scrollback included), joined
 * with newlines, right-trimmed. Geometry should match the pty that produced
 * the stream so wrapping lands where it really did. A stream that starts
 * mid-sequence (e.g. a rolling tail slice) is fine: the VT parser resyncs on
 * the next complete sequence. Never rejects — a write failure resolves to "".
 */
export function reconstructScreenText(
  raw: string,
  cols: number = DEFAULT_COLS,
  rows: number = DEFAULT_ROWS,
): Promise<string> {
  return new Promise((resolve) => {
    let term: TerminalType;
    try {
      term = new Terminal({
        cols: Math.max(2, Math.floor(cols)),
        rows: Math.max(2, Math.floor(rows)),
        scrollback: SCROLLBACK_LINES,
        allowProposedApi: true,
      });
    } catch {
      resolve("");
      return;
    }
    try {
      term.write(raw, () => {
        const buf = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        term.dispose();
        resolve(lines.join("\n"));
      });
    } catch {
      try {
        term.dispose();
      } catch {
        /* already gone */
      }
      resolve("");
    }
  });
}
