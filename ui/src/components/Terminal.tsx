import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme } from "../lib/terminalTheme.ts";
import type { Theme } from "../hooks/useTheme.ts";

interface TerminalProps {
  /** Gateway auth token (from /api/config) — required for the WS upgrade. */
  token: string;
  /** Current app theme; the xterm theme re-derives from CSS tokens on change. */
  theme: Theme;
}

/**
 * A live terminal (US-016): xterm.js in the right dock, sized by FitAddon,
 * rendered via WebGL when available, themed from the app's CSS tokens, and
 * bridged to the node-pty service over the authenticated /ws/terminal socket.
 */
export default function Terminal({ token, theme }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Xterm | null>(null);

  // Mount once: create xterm, connect WS, wire I/O + resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      cursorBlink: true,
      fontFamily:
        '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: getTerminalTheme(),
      allowProposedApi: true,
    });
    xtermRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* WebGL unavailable — fall back to the DOM/canvas renderer */
    }
    fit.fit();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({
      token,
      cols: String(term.cols),
      rows: String(term.rows),
    });
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?${params}`);

    ws.onmessage = (ev) => term.write(ev.data as string);
    ws.onclose = () => term.write("\r\n[conan] disconnected\r\n");

    const onData = term.onData((data) =>
      send(ws, { type: "input", data }),
    );

    const sendResize = () => {
      fit.fit();
      send(ws, { type: "resize", cols: term.cols, rows: term.rows });
    };
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);
    ws.addEventListener("open", sendResize);

    return () => {
      ro.disconnect();
      onData.dispose();
      ws.close();
      term.dispose();
      xtermRef.current = null;
    };
  }, [token]);

  // Re-apply the theme when the app theme toggles. Setting options.theme is the
  // supported path; refresh() forces a redraw so the WebGL renderer's glyph
  // atlas can't keep stale colors.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = getTerminalTheme();
    term.refresh(0, term.rows - 1);
  }, [theme]);

  return <div ref={hostRef} className="h-full w-full" />;
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
